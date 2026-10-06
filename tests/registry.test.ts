import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentIncludes, defaultRegistry, parseRegistry, REGISTRY_VERSION } from '../src/shared/registry'

describe('parseRegistry', () => {
  it('解析默认 registry（v2，zcode 双端带 agentsDir）', () => {
    const r = parseRegistry(JSON.stringify(defaultRegistry()))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.registry.version).toBe(REGISTRY_VERSION)
      expect(r.registry.version).toBe(2)
      expect(r.registry.agents).toHaveLength(4)
      const wsl = r.registry.agents.find((a) => a.name === 'zcode-wsl')
      expect(wsl?.platform).toBe('linux')
      expect(wsl?.skillsDir).toBe('/root/.zcode/skills')
      expect(wsl?.agentsDir).toBe('/root/.zcode/agents')
      const win = r.registry.agents.find((a) => a.name === 'zcode-win')
      // Windows 侧目录按当前用户主目录派生，不硬编码机器专属用户名
      expect(win?.skillsDir).toBe(path.join(os.homedir(), '.zcode', 'skills'))
      expect(win?.agentsDir).toBe(path.join(os.homedir(), '.zcode', 'agents'))
      // 未配置 agentsDir 的 agent 保持 undefined（字段缺省，不写 null）
      expect(r.registry.agents.find((a) => a.name === 'codex-win')?.agentsDir).toBeUndefined()
    }
  })

  it('v1 文件可读（向后兼容）：agentsDir 缺省 undefined，归一化为 version 2', () => {
    const v1 = {
      version: 1,
      agents: [{ name: 'legacy', platform: 'linux', skillsDir: '/x', include: ['*'] }]
    }
    const r = parseRegistry(JSON.stringify(v1))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.registry.version).toBe(2)
      expect(r.registry.agents[0].name).toBe('legacy')
      expect(r.registry.agents[0].agentsDir).toBeUndefined()
    }
  })

  it('v2 文件可读：agentsDir 为非空字符串', () => {
    const v2 = {
      version: 2,
      agents: [{ name: 'a', platform: 'linux', skillsDir: '/x', agentsDir: '/root/.zcode/agents', include: ['*'] }]
    }
    const r = parseRegistry(JSON.stringify(v2))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.registry.agents[0].agentsDir).toBe('/root/.zcode/agents')
  })

  it('agentsDir 为空串/非字符串 → 拒绝（只能缺省或非空字符串）', () => {
    const bad = { version: 2, agents: [{ name: 'a', platform: 'linux', skillsDir: '/x', agentsDir: '', include: ['*'] }] }
    expect(parseRegistry(JSON.stringify(bad)).ok).toBe(false)
    const bad2 = { version: 2, agents: [{ name: 'a', platform: 'linux', skillsDir: '/x', agentsDir: 42, include: ['*'] }] }
    expect(parseRegistry(JSON.stringify(bad2)).ok).toBe(false)
  })

  it('拒绝非法 JSON', () => {
    const r = parseRegistry('{not json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('JSON')
  })

  it('拒绝 v1/v2 以外的 version', () => {
    const r = parseRegistry(JSON.stringify({ version: 3, agents: [] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('version')
  })

  it('拒绝缺失 include 或空 include', () => {
    const bad = { version: 2, agents: [{ name: 'a', platform: 'windows', skillsDir: 'C:\\x', include: [] }] }
    const r = parseRegistry(JSON.stringify(bad))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('include')
  })

  it('拒绝非法 platform', () => {
    const bad = { version: 2, agents: [{ name: 'a', platform: 'macos', skillsDir: '/x', include: ['*'] }] }
    const r = parseRegistry(JSON.stringify(bad))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('platform')
  })

  it('拒绝重复 agent 名', () => {
    const a = { name: 'dup', platform: 'windows', skillsDir: 'C:\\x', include: ['*'] }
    const r = parseRegistry(JSON.stringify({ version: 2, agents: [a, a] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('重复')
  })
})

describe('agentIncludes', () => {
  const star = defaultRegistry().agents[0]
  const listed = { name: 'x', platform: 'linux' as const, skillsDir: '/x', include: ['foo', 'bar'] }

  it('["*"] 包含所有 skill', () => {
    expect(agentIncludes(star, 'anything')).toBe(true)
  })

  it('列表模式精确匹配', () => {
    expect(agentIncludes(listed, 'foo')).toBe(true)
    expect(agentIncludes(listed, 'baz')).toBe(false)
  })
})
