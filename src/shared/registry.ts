// registry.json 的纯逻辑（无 IO），主进程与 companion 共用（companion 由 esbuild 打包内联）
// v2：agents 每项新增可选 agentsDir（子智能体共享目录）；v1 文件可读（agentsDir 缺省 undefined），
// 解析结果统一归一化为 version: 2。
import type { Registry, RegistryAgent } from './types'

export const REGISTRY_VERSION = 2

export const DEFAULT_REGISTRY: Registry = {
  version: REGISTRY_VERSION,
  agents: [
    {
      name: 'zcode-win',
      platform: 'windows',
      skillsDir: 'C:\\Users\\sakuya\\.zcode\\skills',
      agentsDir: 'C:\\Users\\sakuya\\.zcode\\agents',
      include: ['*']
    },
    { name: 'codex-win', platform: 'windows', skillsDir: 'C:\\Users\\sakuya\\.codex\\skills', include: ['*'] },
    { name: 'agents-win', platform: 'windows', skillsDir: 'C:\\Users\\sakuya\\.agents\\skills', include: ['*'] },
    {
      name: 'zcode-wsl',
      platform: 'linux',
      skillsDir: '/root/.zcode/skills',
      agentsDir: '/root/.zcode/agents',
      include: ['*']
    }
  ]
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
  // 向后兼容：v1 / v2 均可读，其它版本拒绝
  if (obj.version !== 1 && obj.version !== REGISTRY_VERSION) {
    return { ok: false, error: `registry.json version 必须为 1 或 ${REGISTRY_VERSION}，实际: ${String(obj.version)}` }
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
    agents.push({
      name: a.name,
      platform: a.platform,
      skillsDir: a.skillsDir,
      include: a.include,
      ...(agentsDir !== undefined ? { agentsDir } : {})
    })
  }
  return { ok: true, registry: { version: REGISTRY_VERSION, agents } }
}

/** include 为 ["*"] 或技能名列表 */
export function agentIncludes(agent: RegistryAgent, skillName: string): boolean {
  return agent.include.includes('*') || agent.include.includes(skillName)
}
