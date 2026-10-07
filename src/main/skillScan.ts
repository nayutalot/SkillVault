// 导入自动扫描：把「用户去各 agent 的 skills 目录里翻文件夹」变成一次自动枚举。
// 纯逻辑 + 注入式 fs（风格同 importer.ts / agentDiscover.ts），vitest 无头可测。
//
// 铁律（与 importer.ts 同一套判定，避免扫描说「可导入」而真正导入时被拒）：
// - 只把「真实目录或 junction/symlink 且含 SKILL.md」的子目录当候选；缺 SKILL.md 的子目录静默跳过
//   （agent 的 skills 目录下常混放 README、缓存、临时目录，报错会淹没真正有用的信息）。
// - 解析后落在 vault/skills 内部的目录 = 已入库（原位置就是指向库的快捷方式），标 linked 不算候选。
// - 扫描只做 readdir + lstat + 存在性判断，绝不在候选目录里做整树遍历：
//   文件数/体积由导入预览阶段（planImport 的 walkFiles）算，候选多时不能把 IO 放大成 N 棵树。
import fs from 'node:fs'
import path from 'node:path'
import type { Registry, RegistryAgent, SkillScanResult, SkillScanStatus } from '../shared/types'
import { isAgentActive } from '../shared/registry'
import { resolveRealDir } from './importer'
import { lstatSafe, normalizeWinPath, vaultSkillsDir } from './winLinks'

/** 扫描用的最小 fs 原语（默认真实 fs；测试注入内存树） */
export type SkillScanDeps = {
  exists: (p: string) => boolean
  /** 列子目录与链接（不存在的目录返回空数组，绝不抛） */
  readdir: (dir: string) => { name: string; isDir: boolean; isLink: boolean }[]
}

export function realScanDeps(): SkillScanDeps {
  return {
    exists: (p) => lstatSafe(p) !== null,
    readdir: (dir) => {
      try {
        // 与 agentDiscover.realDiscoverDeps 同口径：只回子目录与链接（skill 目录常是 junction），
        // 普通文件不进候选；单个目录读失败返回空数组，由调用方按「目录不存在」记 errors。
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() || e.isSymbolicLink())
          .map((e) => ({ name: e.name, isDir: e.isDirectory(), isLink: e.isSymbolicLink() }))
          .sort((a, b) => a.name.localeCompare(b.name))
      } catch {
        return []
      }
    }
  }
}

export type ScanImportDeps = {
  io?: SkillScanDeps
  /** 额外目录递归深度（缺省 2：额外目录本身算 0 层，其子目录 1 层，孙目录 2 层） */
  extraDepth?: number
}

export const EXTRA_DIR_MAX_DEPTH = 2

type Ctx = {
  io: SkillScanDeps
  vaultSkills: string
  vaultNames: Set<string>
  candidates: SkillScanResult['candidates']
  errors: SkillScanResult['errors']
  /** 已见过的真实路径（同一目录被两个 agent 共享时只报一次，避免重复导入同一份数据） */
  seenReal: Set<string>
}

/** 判定候选状态：先看是否已入库（链接真身在库里），再看 vault 是否已有同名 skill */
function statusOf(ctx: Ctx, realPath: string, skillName: string): SkillScanStatus {
  const real = normalizeWinPath(realPath)
  if (real === ctx.vaultSkills || real.startsWith(ctx.vaultSkills + '\\')) return 'linked'
  return ctx.vaultNames.has(skillName) ? 'conflict' : 'importable'
}

/**
 * 处理一个候选目录：解析真身 → 查 SKILL.md → 落状态。
 * 返回是否登记为候选（缺 SKILL.md 返回 false，由调用方决定要不要继续往里翻）。
 */
function consider(ctx: Ctx, rawDir: string, sourceAgent: string, depth: number): boolean {
  let realPath: string
  let isLink: boolean
  try {
    const r = resolveRealDir(rawDir)
    realPath = r.realPath
    isLink = r.isLink
  } catch (e) {
    // 断链（junction 指向的目标被删/移动）：不能当候选，也不能静默吞掉 —— 用户得知道这里坏了一个
    ctx.errors.push({ dir: rawDir, reason: e instanceof Error ? e.message : String(e) })
    return false
  }
  if (!ctx.io.exists(path.join(realPath, 'SKILL.md'))) return false

  const key = normalizeWinPath(realPath)
  if (ctx.seenReal.has(key)) return true
  ctx.seenReal.add(key)
  const skillName = path.basename(realPath)
  ctx.candidates.push({
    dir: rawDir,
    skillName,
    hasSkillMd: true,
    isLink,
    vaultConflict: ctx.vaultNames.has(skillName),
    sourceAgent,
    depth,
    status: statusOf(ctx, realPath, skillName)
  })
  return true
}

/** 扫一个 skillsDir 的直接子目录（只下潜一层，符合各 agent 的 skills/<name>/SKILL.md 布局） */
function scanSkillsDir(ctx: Ctx, agent: RegistryAgent): number {
  let entries: ReturnType<SkillScanDeps['readdir']>
  try {
    entries = ctx.io.readdir(agent.skillsDir)
  } catch (e) {
    ctx.errors.push({ dir: agent.skillsDir, reason: e instanceof Error ? e.message : String(e) })
    return 0
  }
  let dirCount = 0
  for (const e of entries) {
    dirCount++
    consider(ctx, path.join(agent.skillsDir, e.name), agent.name, 1)
  }
  return dirCount
}

/** 额外目录：自身是 skill 就当候选；否则向下递归至多 extraDepth 层（UI 让用户临时补一个目录用） */
function scanExtraDir(ctx: Ctx, dir: string, depth: number, maxDepth: number): void {
  const st = lstatSafe(dir)
  if (!st) {
    ctx.errors.push({ dir, reason: '目录不存在或无法访问' })
    return
  }
  if (consider(ctx, dir, '额外目录', depth)) return
  if (depth >= maxDepth) return
  let entries: ReturnType<SkillScanDeps['readdir']>
  try {
    entries = ctx.io.readdir(dir)
  } catch (e) {
    ctx.errors.push({ dir, reason: e instanceof Error ? e.message : String(e) })
    return
  }
  for (const e of entries) scanExtraDir(ctx, path.join(dir, e.name), depth + 1, maxDepth)
}

/**
 * 扫描导入候选。
 * 数据源 = 注册表里 active 且 enabled 的 Windows 侧 agent 的 skillsDir（builtin + discovered 都算）
 *        + 可选的额外目录（UI 传入）。
 * 个别 skillsDir 不存在只记 errors 不中断整体（某个 agent 没装不该让整页空白）。
 */
export function scanImportCandidates(
  vaultPath: string,
  registry: Registry,
  extraDir?: string,
  deps: ScanImportDeps = {}
): SkillScanResult {
  const io = deps.io ?? realScanDeps()
  const ctx: Ctx = {
    io,
    vaultSkills: normalizeWinPath(vaultSkillsDir(vaultPath)),
    vaultNames: new Set<string>(),
    candidates: [],
    errors: [],
    seenReal: new Set<string>()
  }

  // vault 侧同名清单：只 readdir 一层，用于标「重名冲突」
  for (const e of io.readdir(vaultSkillsDir(vaultPath))) ctx.vaultNames.add(e.name)

  const agents = registry.agents.filter((a) => a.platform === 'windows' && isAgentActive(a))
  const scannedAgents: SkillScanResult['scannedAgents'] = []
  for (const agent of agents) {
    if (!io.exists(agent.skillsDir)) {
      ctx.errors.push({ dir: agent.skillsDir, reason: '目录不存在（该 Agent 可能未安装或已改路径）' })
      continue
    }
    const dirCount = scanSkillsDir(ctx, agent)
    scannedAgents.push({
      name: agent.name,
      label: agent.label ?? agent.name,
      skillsDir: agent.skillsDir,
      dirCount
    })
  }

  const extra = typeof extraDir === 'string' ? extraDir.trim() : ''
  if (extra) scanExtraDir(ctx, extra, 0, deps.extraDepth ?? EXTRA_DIR_MAX_DEPTH)

  return { candidates: ctx.candidates, scannedAgents, errors: ctx.errors }
}
