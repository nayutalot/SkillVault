// agent 签名表 + 自动发现（纯逻辑：禁止 import node:fs —— companion 由 esbuild 内联本模块，
// 主进程 / companion / vitest 一律经注入的 { exists, list } 做 IO，保证无头可测且跨端同源）。
import path from 'node:path'
import type { Registry } from './types'

/** 已知 agent 签名：dotDirs 为 home 下候选目录（兼容多布局），命中第一个存在者即认为该 agent 已安装 */
export type AgentSignature = {
  sigId: string
  label: string
  /** home 相对候选目录（用 '/' 分段，交给 path.join 归一化）；多布局按数组顺序取第一个存在者 */
  dotDirs: string[]
  /** skills 子目录候选（当前统一 ['skills']，保留数组以便将来适配布局变化） */
  skillsSubdirs: string[]
  /** 子智能体子目录候选（只有部分 agent 有）；缺省 = 该 agent 无子智能体目录概念 */
  agentsSubdirs?: string[]
  /** 仅供展示/诊断（探测一律走目录签名，绝不依赖 PATH/CLI 探测，避免跨端差异） */
  cliNames: string[]
}

/**
 * 已知 agent 签名表。只认 home 下的配置目录：这是跨 Windows/WSL 唯一稳定的安装证据
 * （CLI 可能装在 nvm/volta/pnpm 等任意路径，PATH 探测在 companion 的 bash -c 里也不可靠）。
 */
export const AGENT_SIGNATURES: AgentSignature[] = [
  { sigId: 'claude', label: 'Claude Code', dotDirs: ['.claude'], skillsSubdirs: ['skills'], agentsSubdirs: ['agents'], cliNames: ['claude'] },
  { sigId: 'codex', label: 'Codex', dotDirs: ['.codex'], skillsSubdirs: ['skills'], cliNames: ['codex'] },
  { sigId: 'zcode', label: 'ZCode', dotDirs: ['.zcode'], skillsSubdirs: ['skills'], agentsSubdirs: ['agents'], cliNames: ['zcode'] },
  { sigId: 'kimi', label: 'Kimi Code', dotDirs: ['.kimi-code'], skillsSubdirs: ['skills'], cliNames: ['kimi'] },
  { sigId: 'dsh', label: 'DeepSeek Harness', dotDirs: ['.dsh'], skillsSubdirs: ['skills'], cliNames: ['dsh'] },
  { sigId: 'grok', label: 'Grok CLI', dotDirs: ['.grok'], skillsSubdirs: ['skills'], cliNames: ['grok'] },
  { sigId: 'gemini', label: 'Gemini CLI', dotDirs: ['.gemini'], skillsSubdirs: ['skills'], cliNames: ['gemini'] },
  { sigId: 'qwen', label: 'Qwen Code', dotDirs: ['.qwen'], skillsSubdirs: ['skills'], cliNames: ['qwen'] },
  // opencode / crush / goose 走 XDG 式 .config/<name> 布局，同时保留顶层 .<name> 兼容旧版
  { sigId: 'opencode', label: 'OpenCode', dotDirs: ['.opencode', '.config/opencode'], skillsSubdirs: ['skills'], cliNames: ['opencode'] },
  { sigId: 'kilo', label: 'Kilo Code', dotDirs: ['.kilo'], skillsSubdirs: ['skills'], cliNames: ['kilo'] },
  { sigId: 'pi', label: 'Pi', dotDirs: ['.pi'], skillsSubdirs: ['skills'], cliNames: ['pi'] },
  { sigId: 'crush', label: 'Crush', dotDirs: ['.config/crush'], skillsSubdirs: ['skills'], cliNames: ['crush'] },
  { sigId: 'goose', label: 'Goose', dotDirs: ['.config/goose'], skillsSubdirs: ['skills'], cliNames: ['goose'] },
  { sigId: 'copilot', label: 'GitHub Copilot CLI', dotDirs: ['.copilot'], skillsSubdirs: ['skills'], cliNames: ['copilot'] },
  { sigId: 'cursor', label: 'Cursor CLI', dotDirs: ['.cursor'], skillsSubdirs: ['skills'], cliNames: ['cursor'] },
  { sigId: 'agents-shared', label: '通用共享目录', dotDirs: ['.agents'], skillsSubdirs: ['skills'], agentsSubdirs: ['agents'], cliNames: [] }
]

/**
 * 发现候选（本模块内定义，双侧共用）：
 * dotDir 为 home 相对命中目录；WSL companion 回传时不含 dotDir（只回 sigId/label/skillsDir/agentsDir）。
 */
export type DiscoveredCandidate = {
  sigId: string
  label: string
  dotDir?: string
  skillsDir: string
  agentsDir?: string
  /** genericSweep 兜底命中（未知框架，sigId 形如 generic:<dirname>） */
  generic?: boolean
}

/** 发现结果 + 平台（主进程 mergeDiscovered 的输入） */
export type DiscoveredAgent = DiscoveredCandidate & { platform: 'windows' | 'linux' }

/** agents:discover 的合并报告（registry 为合并后注册表，UI 可直接刷新，无需二次读取） */
export type AgentDiscoverReport = {
  /** 本轮新加入的条目名 */
  added: string[]
  /** 上轮标 missing、本轮重新发现的条目名 */
  reactivated: string[]
  /** 本轮未发现、被标 missing 的条目名（条目本身保留，绝不删除） */
  missing: string[]
  windowsFound: number
  wslFound: number
  /** WSL 侧本轮未取到（companion 不可达/超时）：Linux 条目一律不改 status，避免把掉线误判成目录消失 */
  wslStale: boolean
  wslReason?: string
  registry: Registry
}

/** 发现过程只用这两个 IO 原语，便于 vitest 用内存 fake 全覆盖 */
export type DiscoverDeps = {
  exists: (p: string) => boolean
  /** 返回目录下的子目录名（实现负责过滤文件；符号链接目录按目录计入，skill 目录常为 symlink） */
  list: (dir: string) => string[]
}

/** 签名 dotDir 的顶层段（.claude / .config 等）：genericSweep 用它跳过签名已覆盖的目录，避免同一 agent 重复上报 */
const SIGNATURE_TOP_SEGMENTS = new Set(AGENT_SIGNATURES.flatMap((s) => s.dotDirs.map((d) => d.split('/')[0])))

/** 取 base 下第一个已存在的子目录（都没建时返回 undefined，由调用方回落首个声明路径） */
function firstExisting(base: string, subs: string[], deps: DiscoverDeps): string | undefined {
  for (const sub of subs) {
    const p = path.join(base, sub)
    if (deps.exists(p)) return p
  }
  return undefined
}

/**
 * 按签名表发现：每个 agent 只认第一个真实存在的 dotDir 布局。
 * skills 子目录尚不存在时仍返回候选（skillsDir 指向首个声明路径）——目录可后建，
 * 但「已安装」的判断只看 dotDir 本身，否则新装的 agent 永远发现不到。
 */
export function discoverFromHome(homeDir: string, deps: DiscoverDeps): DiscoveredCandidate[] {
  const out: DiscoveredCandidate[] = []
  for (const sig of AGENT_SIGNATURES) {
    for (const rel of sig.dotDirs) {
      const base = path.join(homeDir, rel)
      if (!deps.exists(base)) continue
      const skillsDir = firstExisting(base, sig.skillsSubdirs, deps) ?? path.join(base, sig.skillsSubdirs[0])
      const agentsDir = sig.agentsSubdirs ? firstExisting(base, sig.agentsSubdirs, deps) : undefined
      out.push({
        sigId: sig.sigId,
        label: sig.label,
        dotDir: rel,
        skillsDir,
        ...(agentsDir !== undefined ? { agentsDir } : {})
      })
      break
    }
  }
  return out
}

/**
 * 兜底扫描：home 下点开头目录里、签名表未覆盖的未知框架。
 * IO 轻量——只 readdir(home) + 判断 skills/ 存在 + readdir(skills) + 判断 skills/<name>/SKILL.md，
 * 深度绝不超过 skills/<name>/SKILL.md 一层，绝不整树遍历（家目录可达数十万文件）。
 */
export function genericSweep(homeDir: string, deps: DiscoverDeps): DiscoveredCandidate[] {
  const out: DiscoveredCandidate[] = []
  for (const name of [...deps.list(homeDir)].sort()) {
    if (!name.startsWith('.') || name === '.' || name === '..') continue
    if (SIGNATURE_TOP_SEGMENTS.has(name)) continue
    const skillsDir = path.join(homeDir, name, 'skills')
    if (!deps.exists(skillsDir)) continue
    const hasSkill = [...deps.list(skillsDir)].some((n) => deps.exists(path.join(skillsDir, n, 'SKILL.md')))
    if (!hasSkill) continue
    out.push({ sigId: `generic:${name}`, label: name, dotDir: name, skillsDir, generic: true })
  }
  return out
}
