// importSkill：拷贝 → 校验 → 删原 → 建链 → 本地 commit
// 铁律：删除原目录之前必须完成校验；校验失败则中止，vault 副本保留待人工处理，绝不先删后验。
import fs from 'node:fs'
import path from 'node:path'
import type { ImportPlan } from '../shared/types'
import { git } from './git'
import {
  createJunction,
  lstatSafe,
  normalizeWinPath,
  removeLink,
  stripWinPrefix,
  vaultSkillDir,
  vaultSkillsDir
} from './winLinks'

/** Windows 保留设备名（con/nul/aux/prn/com1-9/lpt1-9）：正则合法但 NTFS 无法创建目录，preview 阶段就拒绝 */
const WIN_RESERVED_NAME = /^(con|nul|aux|prn|com[1-9]|lpt[1-9])$/

export function validateSkillName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && !WIN_RESERVED_NAME.test(name)
}

/** 解析 junction/symlink 到真身目录；返回原始路径是否本身是链接 */
export function resolveRealDir(p: string): { realPath: string; isLink: boolean } {
  let cur = path.resolve(p)
  let wasLink = false
  for (let i = 0; i < 16; i++) {
    const st = lstatSafe(cur)
    if (!st) throw new Error(`路径不存在: ${cur}`)
    if (!st.isSymbolicLink()) return { realPath: cur, isLink: wasLink }
    wasLink = true
    let target = stripWinPrefix(fs.readlinkSync(cur))
    if (!path.isAbsolute(target)) target = path.resolve(path.dirname(cur), target)
    cur = path.resolve(target)
  }
  throw new Error(`junction/symlink 解析深度超限: ${p}`)
}

/** 递归列出源内嵌的链接（junction/symlink，含指向源内子目录的）：walkFiles 会跳过它们，
 *  若静默放行，删除原目录时这些链接会一并消失且 vault 副本中不存在 —— 必须先拒绝并要求人工处理 */
export function findEmbeddedLinks(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const full = path.join(dir, e.name)
      if (e.isSymbolicLink()) {
        out.push(path.relative(root, full).replace(/\\/g, '/'))
        continue
      }
      if (e.isDirectory()) visit(full)
    }
  }
  visit(root)
  return out.sort()
}

export type WalkedFile = { rel: string; size: number }

/**
 * 校验拷贝结果：文件数一致 + 逐文件字节数一致。
 * 任何不一致都抛错 —— 调用方必须在校验通过后才允许删除原目录。
 */
export function verifyCopy(sourceRealPath: string, targetDir: string): void {
  const srcFiles = walkFiles(sourceRealPath)
  const dstFiles = walkFiles(targetDir)
  if (srcFiles.length !== dstFiles.length) {
    throw new Error(
      `校验失败：文件数不一致（源 ${srcFiles.length} / vault ${dstFiles.length}）。vault 副本保留待人工处理: ${targetDir}`
    )
  }
  for (const f of srcFiles) {
    const s = lstatSafe(relJoin(sourceRealPath, f.rel))
    const d = lstatSafe(relJoin(targetDir, f.rel))
    if (!s || !d || s.size !== d.size) {
      throw new Error(`校验失败：文件字节不一致: ${f.rel}。vault 副本保留待人工处理: ${targetDir}`)
    }
  }
}

/** 递归列出普通文件（排除 .git；跳过源内嵌链接以防越界复制） */
export function walkFiles(root: string): WalkedFile[] {
  const out: WalkedFile[] = []
  const visit = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const full = path.join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) visit(full)
      else if (e.isFile())
        out.push({ rel: path.relative(root, full).replace(/\\/g, '/'), size: lstatSafe(full)?.size ?? 0 })
    }
  }
  visit(root)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

function relJoin(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'))
}

export function planImport(sourceDir: string, vaultPath: string): ImportPlan {
  const plan: ImportPlan = {
    ok: false,
    sourceDir,
    sourceRealPath: '',
    sourceIsLink: false,
    skillName: '',
    nameOk: false,
    hasSkillMd: false,
    targetDir: '',
    fileCount: 0,
    totalBytes: 0,
    vaultConflict: false,
    actions: []
  }
  if (!lstatSafe(sourceDir)) {
    plan.error = `源目录不存在: ${sourceDir}`
    return plan
  }
  const { realPath, isLink } = resolveRealDir(sourceDir)
  plan.sourceRealPath = realPath
  plan.sourceIsLink = isLink
  plan.skillName = path.basename(realPath)
  plan.nameOk = validateSkillName(plan.skillName)
  plan.hasSkillMd = fs.existsSync(path.join(realPath, 'SKILL.md'))
  plan.targetDir = vaultSkillDir(vaultPath, plan.skillName)
  plan.vaultConflict = lstatSafe(plan.targetDir) !== null

  if (!plan.hasSkillMd) {
    plan.error = `源目录缺少 SKILL.md，拒绝导入: ${realPath}`
    return plan
  }
  if (!plan.nameOk) {
    plan.error = `skill 名 "${plan.skillName}" 不符合小写 kebab-case 规范（a-z0-9 与 -）`
    return plan
  }
  const vaultSkills = normalizeWinPath(vaultSkillsDir(vaultPath))
  const src = normalizeWinPath(realPath)
  if (src === vaultSkills || src.startsWith(vaultSkills + '\\')) {
    plan.error = '源目录位于 vault 内部，拒绝导入'
    return plan
  }

  const files = walkFiles(realPath)
  plan.fileCount = files.length
  plan.totalBytes = files.reduce((s, f) => s + f.size, 0)

  if (plan.vaultConflict) {
    plan.error = `vault 已存在同名 skill: ${plan.targetDir}，请先处理冲突（不会覆盖）`
    return plan
  }

  // 源内嵌链接预检：walkFiles 跳过链接（防越界复制），删除原目录会连带删掉它们 → 数据静默丢失，拒绝导入
  const links = findEmbeddedLinks(realPath)
  if (links.length) {
    plan.error = `源目录内含 ${links.length} 个链接（junction/symlink，示例: ${links.slice(0, 3).join(', ')}），导入会先删原位置导致链接丢失。请先人工处理（移除或实体化）后重试`
    return plan
  }
  // Windows MAX_PATH 预检：未开启 LongPathsEnabled 时 >260 字符路径 mkdir/copy 必失败
  if (plan.targetDir.length > 240) {
    plan.error = `目标路径过长（${plan.targetDir.length} 字符 > 240）：${plan.targetDir}。请缩短 vault 路径或 skill 名`
    return plan
  }

  plan.ok = true
  if (isLink) plan.actions.push(`源路径是链接，解析到真身目录: ${realPath}`)
  plan.actions.push(`递归拷贝 ${files.length} 个文件（共 ${plan.totalBytes} 字节）→ ${plan.targetDir}`)
  plan.actions.push('校验：文件数一致 + 逐文件字节数一致（校验通过后才删除原位置）')
  plan.actions.push(
    isLink ? `删除原链接（仅链接本身，不动真身）: ${sourceDir}` : `删除原目录: ${realPath}`
  )
  plan.actions.push(`在原位置创建 junction: ${sourceDir} → ${plan.targetDir}`)
  plan.actions.push(`vault 内 git add -A + commit（skill-manager: import ${plan.skillName}，仅本地不 push）`)
  return plan
}

export type ImportOptions = { dryRun?: boolean; commit?: boolean }

export function executeImport(sourceDir: string, vaultPath: string, opts?: ImportOptions): ImportPlan & { steps: string[] } {
  const dryRun = opts?.dryRun === true
  const doCommit = opts?.commit !== false
  const plan = planImport(sourceDir, vaultPath)
  if (!plan.ok) throw new Error(plan.error || '导入计划失败')
  const steps: string[] = []

  if (dryRun) {
    return { ...plan, steps: plan.actions.map((a) => `[干跑] ${a}`) }
  }

  // 1) 递归拷贝（字节保真）
  fs.mkdirSync(plan.targetDir, { recursive: true })
  for (const f of walkFiles(plan.sourceRealPath)) {
    const dest = relJoin(plan.targetDir, f.rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(relJoin(plan.sourceRealPath, f.rel), dest)
  }
  steps.push(`已复制 ${plan.fileCount} 个文件 → ${plan.targetDir}`)

  // 2) 校验：文件数 + 逐文件字节数（必须全部通过才进入删除步骤）
  verifyCopy(plan.sourceRealPath, plan.targetDir)
  steps.push('校验通过：文件数与逐文件字节数一致')

  // 3) 删除原位置（链接 → 仅删链接本身；真实目录 → 递归删除）
  if (plan.sourceIsLink) {
    removeLink(sourceDir)
    steps.push(`已删除原链接: ${sourceDir}`)
  } else {
    fs.rmSync(plan.sourceRealPath, { recursive: true, force: true })
    steps.push(`已删除原目录: ${plan.sourceRealPath}`)
  }

  // 4) 原位置建 junction 指向 vault
  createJunction(plan.targetDir, sourceDir)
  steps.push(`已创建 junction: ${sourceDir} → ${plan.targetDir}`)

  // 5) vault 内 git add + commit（仅本地）。数据此刻已安全入 vault 并建链，commit 失败只降级为警告，不当作导入失败
  if (doCommit) {
    git(vaultPath, ['add', '-A'])
    const st = git(vaultPath, ['status', '--porcelain'])
    if (st.stdout.trim()) {
      const c = git(vaultPath, ['commit', '-m', `skill-manager: import ${plan.skillName}`])
      if (c.ok) steps.push('git commit 完成（仅本地，未 push）')
      else steps.push(`警告：git commit 失败（${(c.stderr || c.stdout).trim().slice(0, 200)}），变更已留在暂存区，可在同步页重试提交`)
    } else {
      steps.push('vault 无变更，跳过 commit')
    }
  }
  return { ...plan, steps }
}
