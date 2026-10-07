// registry v3：旧版本归一化 / 非法输入 / mergeDiscovered 各分支 / enabled+missing 过滤
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAgentActive, mergeDiscovered, parseRegistry, REGISTRY_VERSION } from '../src/shared/registry'
import { scanWindowsAgents } from '../src/main/winLinks'
import type { DiscoveredCandidate } from '../src/shared/agentSignatures'
import type { Registry, RegistryAgent } from '../src/shared/types'

const WIN = (name: string, skillsDir: string, extra: Partial<RegistryAgent> = {}): RegistryAgent => ({
  name,
  platform: 'windows',
  skillsDir,
  include: ['*'],
  ...extra
})

const CAND = (sigId: string, skillsDir: string, extra: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate => ({
  sigId,
  label: sigId,
  skillsDir,
  ...extra
})

describe('parseRegistry v3 归一化', () => {
  it('v1 文件：source 缺省 builtin、enabled 缺省 true，version 归一化为 3', () => {
    const r = parseRegistry(
      JSON.stringify({ version: 1, agents: [{ name: 'legacy', platform: 'linux', skillsDir: '/x', include: ['*'] }] })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.registry.version).toBe(REGISTRY_VERSION)
    expect(r.registry.version).toBe(3)
    expect(r.registry.agents[0]).toMatchObject({ source: 'builtin', enabled: true })
    expect(r.registry.agents[0].label).toBeUndefined()
    expect(r.registry.agents[0].sigId).toBeUndefined()
    expect(r.registry.agents[0].status).toBeUndefined()
  })

  it('v2 文件：agentsDir 保留，新字段按默认补齐', () => {
    const r = parseRegistry(
      JSON.stringify({
        version: 2,
        agents: [{ name: 'a', platform: 'windows', skillsDir: 'C:\\x', agentsDir: 'C:\\x\\agents', include: ['*'] }]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.registry.agents[0]).toMatchObject({ agentsDir: 'C:\\x\\agents', source: 'builtin', enabled: true })
  })

  it('v3 全字段往返一致', () => {
    const reg: Registry = {
      version: 3,
      agents: [
        WIN('claude-win', 'C:\\h\\.claude\\skills', {
          agentsDir: 'C:\\h\\.claude\\agents',
          label: 'Claude Code',
          source: 'discovered',
          enabled: false,
          sigId: 'claude',
          status: 'missing'
        })
      ]
    }
    const r = parseRegistry(JSON.stringify(reg))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.registry).toEqual(reg)
  })

  it('显式 enabled:false / status:missing / manual 来源均保留', () => {
    const r = parseRegistry(
      JSON.stringify({
        version: 3,
        agents: [WIN('m', 'C:\\m', { source: 'manual', enabled: false, status: 'missing', label: '手加' })]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.registry.agents[0]).toMatchObject({ source: 'manual', enabled: false, status: 'missing', label: '手加' })
  })

  it('非法新字段一律拒绝（中文错误信息）', () => {
    const cases: [string, unknown][] = [
      ['version', { version: 4, agents: [] }],
      ['label', { version: 3, agents: [WIN('a', 'C:\\a', { label: '' })] }],
      ['source', { version: 3, agents: [WIN('a', 'C:\\a', { source: 'cloud' as never })] }],
      ['enabled', { version: 3, agents: [WIN('a', 'C:\\a', { enabled: 'yes' as never })] }],
      ['sigId', { version: 3, agents: [WIN('a', 'C:\\a', { sigId: 42 as never })] }],
      ['status', { version: 3, agents: [WIN('a', 'C:\\a', { status: 'gone' as never })] }]
    ]
    for (const [field, payload] of cases) {
      const r = parseRegistry(JSON.stringify(payload))
      expect(r.ok, `${field} 应被拒绝`).toBe(false)
      if (!r.ok) expect(r.error).toContain(field === 'version' ? 'version' : field)
    }
  })
})

describe('isAgentActive 过滤', () => {
  it('缺省字段视为启用；enabled:false 或 status:missing 一律停用', () => {
    expect(isAgentActive(WIN('a', 'C:\\a'))).toBe(true)
    expect(isAgentActive(WIN('a', 'C:\\a', { enabled: true, status: 'active' }))).toBe(true)
    expect(isAgentActive(WIN('a', 'C:\\a', { enabled: false }))).toBe(false)
    expect(isAgentActive(WIN('a', 'C:\\a', { status: 'missing' }))).toBe(false)
    expect(isAgentActive(WIN('a', 'C:\\a', { enabled: false, status: 'missing' }))).toBe(false)
  })

  it('scanWindowsAgents 不出停用/消失条目（条目仍在 registry 中）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-regv3-'))
    const vault = path.join(tmp, 'vault')
    fs.mkdirSync(path.join(vault, 'skills', 'foo'), { recursive: true })
    for (const d of ['a1', 'a2', 'a3']) fs.mkdirSync(path.join(tmp, d), { recursive: true })
    const registry: Registry = {
      version: 3,
      agents: [
        WIN('a1', path.join(tmp, 'a1')),
        WIN('a2', path.join(tmp, 'a2'), { enabled: false }),
        WIN('a3', path.join(tmp, 'a3'), { status: 'missing' }),
        { name: 'l1', platform: 'linux', skillsDir: '/root/x', include: ['*'] }
      ]
    }
    const scans = scanWindowsAgents(vault, registry)
    expect(scans.map((s) => s.name)).toEqual(['a1'])
  })
})

describe('mergeDiscovered', () => {
  const empty: Registry = { version: 3, agents: [] }

  it('新增条目：命名 <sigId>-win、source discovered、enabled true、status active、include ["*"]', () => {
    const r = mergeDiscovered(empty, [CAND('claude', 'C:\\h\\.claude\\skills', { label: 'Claude Code', dotDir: '.claude' })], 'windows')
    expect(r.added).toEqual(['claude-win'])
    expect(r.registry.agents[0]).toEqual({
      name: 'claude-win',
      platform: 'windows',
      skillsDir: 'C:\\h\\.claude\\skills',
      include: ['*'],
      label: 'Claude Code',
      source: 'discovered',
      enabled: true,
      sigId: 'claude',
      status: 'active'
    })
  })

  it('幂等：同结果重复合并不新增、不改条数', () => {
    const cands = [CAND('claude', 'C:\\h\\.claude\\skills'), CAND('codex', 'C:\\h\\.codex\\skills')]
    const first = mergeDiscovered(empty, cands, 'windows')
    const second = mergeDiscovered(first.registry, cands, 'windows')
    expect(second.added).toEqual([])
    expect(second.missing).toEqual([])
    expect(second.registry.agents).toHaveLength(2)
    expect(second.registry.agents).toEqual(first.registry.agents)
  })

  it('Linux 平台命名 <sigId>-wsl 且不与 Windows 条目互串', () => {
    const win = mergeDiscovered(empty, [CAND('claude', 'C:\\h\\.claude\\skills')], 'windows')
    const both = mergeDiscovered(win.registry, [CAND('claude', '/root/.claude/skills')], 'linux')
    expect(both.added).toEqual(['claude-wsl'])
    expect(both.registry.agents.map((a) => [a.name, a.platform])).toEqual([
      ['claude-win', 'windows'],
      ['claude-wsl', 'linux']
    ])
  })

  it('Windows 路径匹配不区分大小写与斜杠方向（并进 builtin 条目而非另起一条）', () => {
    const reg: Registry = { version: 3, agents: [WIN('builtin-claude', 'c:/h/.claude/skills', { source: 'builtin' })] }
    const r = mergeDiscovered(reg, [CAND('claude', 'C:\\h\\.claude\\skills', { label: 'Claude Code' })], 'windows')
    expect(r.added).toEqual([])
    expect(r.registry.agents).toHaveLength(1)
    expect(r.registry.agents[0]).toMatchObject({ name: 'builtin-claude', source: 'builtin', label: 'Claude Code', sigId: 'claude' })
    expect(r.registry.agents[0].status).toBeUndefined()
  })

  it('sigId 命中优先于路径：用户手改 skillsDir 后仍命中且用户字段不被覆盖', () => {
    const reg: Registry = {
      version: 3,
      agents: [
        WIN('claude-win', 'D:\\mine', {
          include: ['only-this'],
          enabled: false,
          source: 'discovered',
          sigId: 'claude',
          status: 'missing'
        })
      ]
    }
    const r = mergeDiscovered(reg, [CAND('claude', 'C:\\h\\.claude\\skills', { label: 'Claude Code' })], 'windows')
    expect(r.added).toEqual([])
    expect(r.reactivated).toEqual(['claude-win'])
    expect(r.registry.agents[0]).toMatchObject({
      skillsDir: 'D:\\mine',
      include: ['only-this'],
      enabled: false,
      label: 'Claude Code',
      status: 'active'
    })
  })

  it('无 sigId 的候选按 skillsDir 匹配（sigId 空串视为无）', () => {
    const reg: Registry = { version: 3, agents: [WIN('manual-a', 'C:\\a', { source: 'manual' })] }
    const r = mergeDiscovered(reg, [CAND('', 'C:\\a', { label: '手加' })], 'windows')
    expect(r.added).toEqual([])
    expect(r.registry.agents[0]).toMatchObject({ name: 'manual-a', status: 'active', source: 'manual' })
  })

  it('本轮未发现的 discovered/manual 标 missing，builtin 不动，跨平台不误伤', () => {
    const reg: Registry = {
      version: 3,
      agents: [
        WIN('builtin-x', 'C:\\bx', { source: 'builtin' }),
        WIN('disc-x', 'C:\\dx', { source: 'discovered' }),
        WIN('manual-x', 'C:\\mx', { source: 'manual' }),
        { name: 'wsl-disc', platform: 'linux', skillsDir: '/root/d', include: ['*'], source: 'discovered' }
      ]
    }
    const r = mergeDiscovered(reg, [CAND('claude', 'C:\\h\\.claude\\skills')], 'windows')
    expect(r.missing).toEqual(['disc-x', 'manual-x'])
    const byName = new Map(r.registry.agents.map((a) => [a.name, a]))
    expect(byName.get('builtin-x')?.status).toBeUndefined()
    expect(byName.get('disc-x')?.status).toBe('missing')
    expect(byName.get('manual-x')?.status).toBe('missing')
    expect(byName.get('wsl-disc')?.status).toBeUndefined()
    expect(r.registry.agents).toHaveLength(5)
  })

  it('已标 missing 的条目再次发现 → reactivated；重复 missing 不重复报告', () => {
    const reg: Registry = { version: 3, agents: [WIN('claude-win', 'C:\\a', { source: 'discovered', sigId: 'claude', status: 'missing' })] }
    const gone = mergeDiscovered(reg, [], 'windows')
    expect(gone.missing).toEqual([])
    const back = mergeDiscovered(gone.registry, [CAND('claude', 'C:\\a')], 'windows')
    expect(back.reactivated).toEqual(['claude-win'])
    expect(back.registry.agents[0].status).toBe('active')
  })

  it('generic 兜底候选：名字经 sanitize，重名追加序号', () => {
    const r = mergeDiscovered(
      empty,
      [CAND('generic:.acme', 'C:\\h\\.acme\\skills', { label: '.acme', generic: true }), CAND('generic:.acme.x', 'C:\\h\\.acme.x\\skills')],
      'windows'
    )
    expect(r.added).toEqual(['generic-acme-win', 'generic-acme-x-win'])
  })

  it('非法候选（skillsDir 为空）跳过，不影响其它候选', () => {
    const r = mergeDiscovered(empty, [CAND('bad', '  '), CAND('claude', 'C:\\a')], 'windows')
    expect(r.added).toEqual(['claude-win'])
  })
})
