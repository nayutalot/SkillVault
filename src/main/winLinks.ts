// Windows 侧 agent 扫描 / junction 建删 / LinkState 判定（纯 Node，可被 vitest 与无头脚本复用）
import fs from 'node:fs'
import path from 'node:path'
import type { AgentScan, AgentsRepairResult, LinkState, Registry, RegistryAgent, SkillMeta } from '../shared/types'
import { agentIncludes, isAgentActive } from '../shared/registry'
import { parseFrontmatter } from '../shared/frontmatter'
import { decodeTextBuffer } from '../shared/textDecode'

/** 去掉 \\?\ / \??\ 前缀，统一反斜杠（保留大小写，用于真实路径解析） */
export function stripWinPrefix(p: string): string {
  let s = String(p ?? '').replace(/\//g, '\\')
  if (s.startsWith('\\\\?\\')) s = s.slice(4)
  else if (s.startsWith('\\??\\')) s = s.slice(4)
  return s
}

/** 归一化用于比较：去前缀 + normalize + 小写 + 去尾部反斜杠（保留盘根），Windows 路径不区分大小写 */
export function normalizeWinPath(p: string): string {
  let n = path.normalize(stripWinPrefix(p)).toLowerCase()
  if (n.length > 3 && n.endsWith('\\')) n = n.slice(0, -1)
  return n
}

export function lstatSafe(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

export function pathExists(p: string): boolean {
  return lstatSafe(p) !== null
}

export function isLinkPath(p: string): boolean {
  const st = lstatSafe(p)
  return !!st && st.isSymbolicLink()
}

/**
 * LinkState 判定：
 * - linked         链接存在且指向 vault 目标，且目标存在
 * - vault-missing  链接指向 vault 目标但 vault 目录缺失（悬空）
 * - wrong-target   链接指向其它位置，或该位置是普通文件
 * - real-dir       同名真实目录（非链接）
 * - missing        路径不存在
 */
export function getLinkState(linkPath: string, expectedTarget: string): LinkState {
  const st = lstatSafe(linkPath)
  if (!st) return 'missing'
  if (!st.isSymbolicLink()) return st.isDirectory() ? 'real-dir' : 'wrong-target'
  let target = ''
  try {
    target = fs.readlinkSync(linkPath)
  } catch {
    return 'wrong-target'
  }
  const matches = normalizeWinPath(target) === normalizeWinPath(expectedTarget)
  if (!matches) return 'wrong-target'
  return pathExists(expectedTarget) ? 'linked' : 'vault-missing'
}

// ---------- agentsDir 专属判定：junction/symlink 之外，识别「真实目录 + 硬链接共享」形态 ----------
// 背景：Windows junction 会在 ZCode 重启时被替换成空目录，.zcode\agents 的正确形态是
// 真实目录 + 指向 vault agents/*.md 的硬链接（同一 dev+ino）。getLinkState 只认链接，会把这种
// 状态报成 real-dir 冲突 —— agentsDir 的扫描一律改走 agentsDirStateOf。

/** agentsDir 状态为 linked 时的附注：真实目录形态的硬链接共享（与 junction/symlink 形态区分开） */
export const AGENTS_DIR_HARDLINK_NOTE = '硬链接共享'

export type AgentsDirState = { state: LinkState; note?: string }

/** 同一文件判定：stat 的 dev+ino 相等（Windows NTFS 上可用；硬链接即同一文件） */
export function sameFileByIno(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a)
    const sb = fs.statSync(b)
    return sa.dev === sb.dev && sa.ino === sb.ino
  } catch {
    return false
  }
}

/**
 * 真实目录是否为指向 vault agents 的硬链接共享目录：
 * vault agents/ 每个 .md 在目录中有同名同 inode 文件，且目录里没有 vault 缺名的多余 .md。
 * 任何 stat/读目录异常（文件被占用等）一律返回 false（从冲突处理，可修复）。
 * 参数为 vault 根目录（内部自行取 agents/ 子目录）。
 */
export function isHardlinkSharedAgentsDir(agentsDir: string, vaultPath: string): boolean {
  let vaultFiles: string[]
  try {
    vaultFiles = listVaultAgentFiles(vaultPath)
  } catch {
    return false
  }
  const vaultSet = new Set(vaultFiles)
  let dirEntries: fs.Dirent[]
  try {
    dirEntries = fs.readdirSync(agentsDir, { withFileTypes: true })
  } catch {
    return false
  }
  // 只统计 .md；symlink/junction 形态（即便指向 vault 文件）不算硬链接共享 —— 交给修复流程重建为硬链接
  const dirFiles = dirEntries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
  for (const f of dirFiles) {
    if (!vaultSet.has(f)) return false
  }
  const vaultAgents = vaultAgentsDir(vaultPath)
  for (const f of vaultFiles) {
    const dst = path.join(agentsDir, f)
    if (isLinkPath(dst)) return false
    if (!sameFileByIno(path.join(vaultAgents, f), dst)) return false
  }
  return true
}

/**
 * agentsDir 的状态判定（扫描专用，不用于 skill 逐目录链接）：
 * - junction/symlink → getLinkState 语义（现状不变）
 * - 真实目录 + 硬链接共享 → linked（附注「硬链接共享」）
 * - 其余真实目录 / stat 异常 → real-dir（冲突，可一键修复）
 */
export function agentsDirStateOf(vaultPath: string, agentsDir: string): AgentsDirState {
  const target = vaultAgentsDir(vaultPath)
  const st = lstatSafe(agentsDir)
  if (!st) return { state: 'missing' }
  if (st.isSymbolicLink()) return { state: getLinkState(agentsDir, target) }
  if (!st.isDirectory()) return { state: 'wrong-target' }
  if (isHardlinkSharedAgentsDir(agentsDir, vaultPath)) return { state: 'linked', note: AGENTS_DIR_HARDLINK_NOTE }
  return { state: 'real-dir' }
}

// ---------- agentsDir 一键修复（vault 为源，重建硬链接共享目录） ----------

export type AgentsRepairOptions = {
  /** 备份/回收目录时间戳时钟（测试固定命名） */
  now?: () => Date
  /** 回收根目录覆写（缺省 = vault 同级 .trash-<ts>/；测试注入临时目录） */
  trashRoot?: string
}

/** 把文件移入回收目录；同卷 rename 直移，跨卷/失败降级 copy+unlink；返回回收后的绝对路径。
 *  同名备份不覆盖（追加 .N 序号）——覆盖会让先移入的备份永久丢失。 */
function trashMove(file: string, trashDir: string): string {
  fs.mkdirSync(trashDir, { recursive: true })
  const base = path.basename(file)
  let dest = path.join(trashDir, base)
  for (let i = 1; fs.existsSync(dest); i++) {
    const ext = path.extname(base)
    const stem = ext ? base.slice(0, base.length - ext.length) : base
    dest = path.join(trashDir, `${stem}.${i}${ext}`)
  }
  try {
    fs.renameSync(file, dest)
    return dest
  } catch {
    fs.copyFileSync(file, dest)
    fs.unlinkSync(file)
    return dest
  }
}

/** 回收后回迁（修复中途失败时恢复原状）：同卷 rename，失败降级 copy+unlink */
function untrashMove(trashed: string, originalPath: string): void {
  try {
    fs.renameSync(trashed, originalPath)
  } catch {
    fs.copyFileSync(trashed, originalPath)
    fs.unlinkSync(trashed)
  }
}

/**
 * 以 vault agents/ 为源，把 agentsDir 重建为硬链接共享目录，返回步骤日志与修复后状态：
 * 1) agentsDir 是 junction/symlink → 先解除；是文件 → 拒绝（不自动删除非预期形态）
 * 2) 确保目录存在（含 junction 被替换成空目录后仍存在的常态）
 * 3) vault 每个 .md：同名同 inode 跳过；同名不同文件先移入回收目录再 fs.linkSync；缺失则直接硬链接
 * 4) 目录里 vault 没有的多余 .md → 移入回收目录（不直接删除，可人工找回）
 * vault agents 目录不存在时抛错（无源可链，属 vault 缺失而非 agentsDir 冲突）。
 * 跨卷（vault 与 agentsDir 不在同一 NTFS 卷）时 linkSync 必抛 EXDEV —— 在任何变更前预检并整体拒绝（零副作用）。
 */
export function repairAgentsDirHardlinks(vaultPath: string, agentsDir: string, opts: AgentsRepairOptions = {}): AgentsRepairResult {
  const vaultAgents = vaultAgentsDir(vaultPath)
  if (!pathExists(vaultAgents)) throw new Error(`vault 中不存在 agents 目录，无源可链接: ${vaultAgents}`)
  const now = opts.now ?? (() => new Date())
  const ts = now().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const trashDir = opts.trashRoot ?? path.join(path.dirname(path.resolve(vaultPath)), '.trash-' + ts)
  const steps: string[] = []

  const st = lstatSafe(agentsDir)
  if (st?.isSymbolicLink()) {
    removeLink(agentsDir)
    steps.push('已移除既有链接（junction/symlink），改为真实目录 + 硬链接')
  } else if (st && !st.isDirectory()) {
    throw new Error(`目标是文件，拒绝自动修复: ${agentsDir}`)
  }
  if (!st) {
    fs.mkdirSync(agentsDir, { recursive: true })
    steps.push('已创建目录: ' + agentsDir)
  }

  // 跨卷预检：硬链接要求同卷。此时尚未动任何文件，直接拒绝不产生副作用
  // （trashMove 的跨卷降级只救得了「移入回收」，救不了 linkSync 的 EXDEV）。
  let vaultDev = -1
  let dirDev = -1
  try {
    vaultDev = fs.statSync(vaultAgents).dev
    dirDev = fs.statSync(agentsDir).dev
  } catch {
    /* stat 失败留 -1，交给后续 linkSync 抛出真实错误 */
  }
  if (vaultDev !== -1 && dirDev !== -1 && vaultDev !== dirDev) {
    throw new Error(`vault 与 agentsDir 不在同一磁盘卷，无法硬链接共享: ${vaultAgents} ↔ ${agentsDir}（可改用 junction 整目录链接）`)
  }

  const vaultFiles = listVaultAgentFiles(vaultPath)
  for (const f of vaultFiles) {
    const src = path.join(vaultAgents, f)
    const dst = path.join(agentsDir, f)
    if (sameFileByIno(src, dst) && !isLinkPath(dst)) {
      steps.push('同名同 inode，已一致，跳过: ' + f)
      continue
    }
    let trashed: string | null = null
    if (pathExists(dst)) {
      // 先移回收再建链；建链失败立即回迁，绝不留「旧文件已移走、新链接没建上」的丢文件状态
      const wasLink = isLinkPath(dst)
      trashed = trashMove(dst, trashDir)
      steps.push((wasLink ? '旧形态是链接，移入 ' : '同名但非同一文件，旧文件移入 ') + trashed)
    }
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.linkSync(src, dst)
    } catch (e) {
      if (trashed) {
        try {
          untrashMove(trashed, dst)
          steps.push('硬链接失败，已把旧文件回迁原位: ' + f)
        } catch {
          /* 回迁也失败只能报告回收路径 */
        }
      }
      throw new Error(`建立硬链接失败: ${f}: ${e instanceof Error ? e.message : String(e)}${trashed ? '（旧文件已移入 ' + trashed + '）' : ''}`)
    }
    steps.push('已建立硬链接: ' + f)
  }

  const dirEntries = fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.toLowerCase().endsWith('.md'))
  for (const e of dirEntries) {
    if (vaultFiles.includes(e.name)) continue
    const trashed = trashMove(path.join(agentsDir, e.name), trashDir)
    steps.push('vault 没有的多余文件，移入 ' + trashed + ': ' + e.name)
  }

  const after = agentsDirStateOf(vaultPath, agentsDir)
  steps.push('修复后状态: ' + after.state + (after.note ? `（${after.note}）` : ''))
  return { steps, state: after.state, ...(after.note ? { note: after.note } : {}) }
}

/** 创建 junction（免管理员权限），target 用绝对路径 */
export function createJunction(targetDir: string, linkPath: string): void {
  if (!pathExists(targetDir)) throw new Error(`junction 目标不存在: ${targetDir}`)
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(path.resolve(targetDir), linkPath, 'junction')
}

/** 仅删除链接本身；拒绝删除真实目录/文件 */
export function removeLink(linkPath: string): void {
  const st = lstatSafe(linkPath)
  if (!st) return
  if (!st.isSymbolicLink()) throw new Error(`拒绝删除：${linkPath} 不是链接（junction/symlink）`)
  fs.rmSync(linkPath, { force: true })
}

export function vaultSkillsDir(vaultPath: string): string {
  return path.join(vaultPath, 'skills')
}

export function vaultSkillDir(vaultPath: string, skillName: string): string {
  return path.join(vaultSkillsDir(vaultPath), skillName)
}

/** vault 内子智能体集合目录（registry v2 agentsDir 的链接目标） */
export function vaultAgentsDir(vaultPath: string): string {
  return path.join(vaultPath, 'agents')
}

/** vault agents/ 下的 .md 文件清单（排序；目录不存在返回空） */
export function listVaultAgentFiles(vaultPath: string): string[] {
  const dir = vaultAgentsDir(vaultPath)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

/** 读取 skill 目录下 SKILL.md 的 frontmatter description（缺失/解析失败/不可解码均为空串） */
export function readSkillDescription(skillDir: string): string {
  try {
    // 另一台中文 Windows 上 SKILL.md 可能是 GBK（记事本 ANSI）或 UTF-16LE（PowerShell ISE），
    // 按 UTF-8 强解会在仪表盘显示乱码；decodeTextBuffer 按 BOM → 严格 UTF-8 → GBK 兜底。
    // 铁律：解码结果只用于展示（description），绝不写回磁盘——写回等于静默转码，二进制误判会把文件写坏。
    const decoded = decodeTextBuffer(fs.readFileSync(path.join(skillDir, 'SKILL.md')))
    return decoded ? parseFrontmatter(decoded.text).description ?? '' : ''
  } catch {
    return ''
  }
}

export function listVaultSkills(vaultPath: string): SkillMeta[] {
  const dir = vaultSkillsDir(vaultPath)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => ({
      name: e.name,
      hasSkillMd: fs.existsSync(path.join(dir, e.name, 'SKILL.md')),
      description: readSkillDescription(path.join(dir, e.name))
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function scanWindowsAgent(vaultPath: string, agent: RegistryAgent): AgentScan {
  const links: Record<string, LinkState> = {}
  for (const meta of listVaultSkills(vaultPath)) {
    if (!agentIncludes(agent, meta.name)) continue
    links[meta.name] = getLinkState(path.join(agent.skillsDir, meta.name), vaultSkillDir(vaultPath, meta.name))
  }
  // agentsDir（子智能体整目录链接）：registry 配置了才扫描；agentFiles 对所有配置了 agentsDir 的 agent 相同（vault 侧清单）
  // 状态走 agentsDirStateOf：junction/symlink 语义不变，真实目录 + 硬链接共享识别为 linked（附注区分）
  const agentFiles = listVaultAgentFiles(vaultPath)
  const base: AgentScan = { name: agent.name, platform: 'windows', skillsDir: agent.skillsDir, links }
  if (agent.agentsDir) {
    const s = agentsDirStateOf(vaultPath, agent.agentsDir)
    return {
      ...base,
      agentsDir: agent.agentsDir,
      agentsDirState: s.state,
      ...(s.note ? { agentsDirNote: s.note } : {}),
      agentFiles
    }
  }
  return base
}

export function scanWindowsAgents(vaultPath: string, registry: Registry): AgentScan[] {
  // 停用（enabled:false）或本轮标 missing 的条目不进扫描结果；条目本身保留在 registry.json
  return registry.agents
    .filter((a) => a.platform === 'windows' && isAgentActive(a))
    .map((a) => scanWindowsAgent(vaultPath, a))
}
