// registry.json 的纯逻辑（无 IO），主进程与 companion 共用（companion 由 esbuild 打包内联）；默认注册表按 os.homedir 派生（环境相关，无盘 IO）
// v3：条目新增 label/source/enabled/sigId/status（agent 自动发现引擎的落点）；
// v1 / v2 文件仍可读（缺失字段按默认补齐），解析结果统一归一化为 version: 3。
import os from 'node:os'
import path from 'node:path'
import type { DiscoveredCandidate } from './agentSignatures'
import type { Registry, RegistryAgent } from './types'

export const REGISTRY_VERSION = 3

/**
 * 默认注册表。Windows 侧目录按当前用户主目录派生（os.homedir），绝不硬编码机器专属用户名——
 * 硬编码换电脑/换用户名安装即失效（skillsDir/agentsDir 全部指向不存在的路径）。linux 侧 /root 固定不变。
 */
export function defaultRegistry(): Registry {
  const home = os.homedir()
  return {
    version: REGISTRY_VERSION,
    agents: [
      {
        name: 'zcode-win',
        label: 'ZCode（Windows）',
        platform: 'windows',
        skillsDir: path.join(home, '.zcode', 'skills'),
        agentsDir: path.join(home, '.zcode', 'agents'),
        include: ['*'],
        source: 'builtin',
        enabled: true
      },
      {
        name: 'codex-win',
        label: 'Codex（Windows）',
        platform: 'windows',
        skillsDir: path.join(home, '.codex', 'skills'),
        include: ['*'],
        source: 'builtin',
        enabled: true
      },
      {
        name: 'agents-win',
        label: '共享目录 .agents（Windows）',
        platform: 'windows',
        skillsDir: path.join(home, '.agents', 'skills'),
        include: ['*'],
        source: 'builtin',
        enabled: true
      },
      {
        name: 'zcode-wsl',
        label: 'ZCode（WSL）',
        platform: 'linux',
        skillsDir: '/root/.zcode/skills',
        agentsDir: '/root/.zcode/agents',
        include: ['*'],
        source: 'builtin',
        enabled: true
      }
    ]
  }
}

function isPlatform(v: unknown): v is 'windows' | 'linux' {
  return v === 'windows' || v === 'linux'
}

export type RegistryParseResult =
  | { ok: true; registry: Registry }
  | { ok: false; error: string }

export function parseRegistry(text: string): RegistryParseResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `registry.json 不是合法 JSON: ${String(e)}` }
  }
  if (typeof data !== 'object' || data === null) return { ok: false, error: 'registry.json 根节点必须是对象' }
  const obj = data as Record<string, unknown>
  // 向后兼容：v1 / v2 / v3 均可读，其它版本拒绝
  if (obj.version !== 1 && obj.version !== 2 && obj.version !== REGISTRY_VERSION) {
    return {
      ok: false,
      error: `registry.json version 必须为 1、2 或 ${REGISTRY_VERSION}，实际: ${String(obj.version)}`
    }
  }
  if (!Array.isArray(obj.agents)) return { ok: false, error: 'registry.json 缺少 agents 数组' }
  const agents: RegistryAgent[] = []
  const seen = new Set<string>()
  for (const raw of obj.agents) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'agents 数组存在非对象元素' }
    const a = raw as Record<string, unknown>
    if (typeof a.name !== 'string' || !a.name.trim()) return { ok: false, error: 'agent.name 必须是非空字符串' }
    if (seen.has(a.name)) return { ok: false, error: `agent 名重复: ${a.name}` }
    seen.add(a.name)
    if (!isPlatform(a.platform)) return { ok: false, error: `agent ${a.name} platform 必须为 windows|linux` }
    if (typeof a.skillsDir !== 'string' || !a.skillsDir.trim())
      return { ok: false, error: `agent ${a.name} skillsDir 必须是非空字符串` }
    if (
      !Array.isArray(a.include) ||
      a.include.length === 0 ||
      !a.include.every((x) => typeof x === 'string' && x.trim())
    )
      return { ok: false, error: `agent ${a.name} include 必须是非空字符串数组（["*"] 或技能名列表）` }
    // agentsDir 可选：缺省 / undefined 保留 undefined；有值必须是非空字符串
    let agentsDir: string | undefined
    if (a.agentsDir !== undefined) {
      if (typeof a.agentsDir !== 'string' || !a.agentsDir.trim()) {
        return { ok: false, error: `agent ${a.name} agentsDir 必须是非空字符串或缺省` }
      }
      agentsDir = a.agentsDir
    }
    // v3 新字段：非法值一律拒绝（与上面同风格的中文错误），缺省按默认补齐
    let label: string | undefined
    if (a.label !== undefined) {
      if (typeof a.label !== 'string' || !a.label.trim()) return { ok: false, error: `agent ${a.name} label 必须是非空字符串或缺省` }
      label = a.label
    }
    let source: RegistryAgent['source'] = 'builtin'
    if (a.source !== undefined) {
      if (a.source !== 'builtin' && a.source !== 'discovered' && a.source !== 'manual') {
        return { ok: false, error: `agent ${a.name} source 必须为 builtin|discovered|manual 或缺省` }
      }
      source = a.source
    }
    let enabled = true
    if (a.enabled !== undefined) {
      if (typeof a.enabled !== 'boolean') return { ok: false, error: `agent ${a.name} enabled 必须是布尔值或缺省` }
      enabled = a.enabled
    }
    let sigId: string | undefined
    if (a.sigId !== undefined) {
      if (typeof a.sigId !== 'string' || !a.sigId.trim()) return { ok: false, error: `agent ${a.name} sigId 必须是非空字符串或缺省` }
      sigId = a.sigId
    }
    // status 无默认值：builtin 条目不参与 missing 标记，缺省 undefined（只有显式 missing 才代表目录消失）
    let status: RegistryAgent['status']
    if (a.status !== undefined) {
      if (a.status !== 'active' && a.status !== 'missing') return { ok: false, error: `agent ${a.name} status 必须为 active|missing 或缺省` }
      status = a.status
    }
    agents.push({
      name: a.name,
      platform: a.platform,
      skillsDir: a.skillsDir,
      include: a.include,
      ...(agentsDir !== undefined ? { agentsDir } : {}),
      ...(label !== undefined ? { label } : {}),
      source,
      enabled,
      ...(sigId !== undefined ? { sigId } : {}),
      ...(status !== undefined ? { status } : {})
    })
  }
  return { ok: true, registry: { version: REGISTRY_VERSION, agents } }
}

/** include 为 ["*"] 或技能名列表 */
export function agentIncludes(agent: RegistryAgent, skillName: string): boolean {
  return agent.include.includes('*') || agent.include.includes(skillName)
}

/**
 * 条目是否参与扫描 / 建链 / 修复：显式 enabled:false 或本轮扫描标 missing 的一律排除。
 * 只做过滤、绝不删除条目——目录可能只是临时被卸载/重命名，删条目等于丢用户配置。
 */
export function isAgentActive(agent: RegistryAgent): boolean {
  return agent.enabled !== false && agent.status !== 'missing'
}

/** 路径匹配键：Windows 不区分大小写与斜杠方向；Linux 保留大小写（POSIX 大小写敏感） */
function pathKey(p: string, platform: 'windows' | 'linux'): string {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'windows' ? s.toLowerCase() : s
}

/** 新条目名：<sanitized sigId>-win|wsl（与现有 zcode-win 命名风格一致）；重名追加序号 */
function uniqueName(sigId: string | undefined, platform: 'windows' | 'linux', taken: Set<string>): string {
  const base = (sigId ?? 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent'
  const stem = `${base}-${platform === 'windows' ? 'win' : 'wsl'}`
  let name = stem
  for (let i = 2; taken.has(name); i++) name = `${stem}-${i}`
  return name
}

export type MergeDiscoveredReport = {
  registry: Registry
  /** 本轮新增条目名 */
  added: string[]
  /** 上轮 missing、本轮重新发现的条目名 */
  reactivated: string[]
  /** 本轮未发现、被标 missing 的条目名 */
  missing: string[]
}

/**
 * 把某一平台的发现结果合并进注册表（幂等）：
 * - 匹配键：sigId+platform 优先，其次 skillsDir+platform（后者让发现结果并进 builtin 的 zcode-win / zcode-wsl，
 *   而不是另起重复条目；用户手改过 skillsDir 的条目靠 sigId 仍能命中）。
 * - 命中：回填 sigId、缺省时回填 label，标回 active；**绝不覆盖用户改过的 skillsDir / enabled / include / label**。
 * - 未命中的 discovered/manual 条目：标 status:'missing'（条目保留，UI 可提示或一键清理）；builtin 不改 status。
 * - 新条目：source:'discovered'、enabled:true、status:'active'、include:['*']。
 */
export function mergeDiscovered(
  registry: Registry,
  discovered: DiscoveredCandidate[],
  platform: 'windows' | 'linux'
): MergeDiscoveredReport {
  const agents = registry.agents.map((a) => ({ ...a }))
  const added: string[] = []
  const reactivated: string[] = []
  const missing: string[] = []
  const found = new Set<string>()
  const taken = new Set(agents.map((a) => a.name))

  for (const d of discovered) {
    if (!d || typeof d.skillsDir !== 'string' || !d.skillsDir.trim()) continue
    const skillsKey = pathKey(d.skillsDir, platform)
    const existing = agents.find(
      (a) =>
        a.platform === platform &&
        ((!!d.sigId && !!a.sigId && a.sigId === d.sigId) || pathKey(a.skillsDir, platform) === skillsKey)
    )
    if (existing) {
      found.add(existing.name)
      // label 只在缺省时回填：builtin 的「ZCode（Windows）/ZCode（WSL）」比签名 label 更能区分双端，
      // 用户自定义 label 同样不该被扫描覆盖（sigId 则始终回填，它是匹配键，越准越好）
      if (d.label && !existing.label) existing.label = d.label
      if (d.sigId) existing.sigId = d.sigId
      // builtin 条目不参与 status 标记（内置条目即使目录不在也不该被判 missing —— 用户可能稍后安装）
      if (existing.source !== 'builtin') {
        if (existing.status === 'missing') reactivated.push(existing.name)
        existing.status = 'active'
      }
      continue
    }
    const name = uniqueName(d.sigId, platform, taken)
    taken.add(name)
    agents.push({
      name,
      platform,
      skillsDir: d.skillsDir,
      include: ['*'],
      ...(d.agentsDir ? { agentsDir: d.agentsDir } : {}),
      label: d.label || d.sigId || name,
      source: 'discovered',
      enabled: true,
      ...(d.sigId ? { sigId: d.sigId } : {}),
      status: 'active'
    })
    added.push(name)
    found.add(name)
  }

  // 本轮未发现的 discovered/manual 条目：标 missing（不删除）。只在「本轮确实拿到了该平台的发现结果」时才会走到这里，
  // WSL companion 掉线时上层会整段跳过 linux 合并，绝不把掉线误判成目录消失。
  for (const a of agents) {
    if (a.platform !== platform) continue
    if (a.source !== 'discovered' && a.source !== 'manual') continue
    if (found.has(a.name) || a.status === 'missing') continue
    a.status = 'missing'
    missing.push(a.name)
  }

  return { registry: { version: REGISTRY_VERSION, agents }, added, reactivated, missing }
}
