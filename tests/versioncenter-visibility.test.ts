// 版本中心可见性测试：注册表驱动显示/隐藏（active+enabled 才默认显示）、固定显示（pin）持久化、
// 注册表读不到时保守显示全部，以及 checkAll 只遍历可见条目（空可见集不回落缓存、不冒充结果）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildVersionCatalog,
  emptyVersionPrefs,
  loadVersionPrefs,
  saveVersionPrefs,
  setVersionPinned,
  setVersionShowHidden,
  versionCatalogFromDisk,
  versionPrefsFile,
  visibleVersionIds,
  type VersionPrefs
} from '../src/main/versionCenter/visibility'
import { VERSION_CATALOG } from '../src/main/versionCenter/catalog'
import { runVersionCheckAll } from '../src/main/versionCenter/jobs'
import type { RegistryAgent } from '../src/shared/types'
import { fakeSpawner } from './helpers/fakeSpawn'

const tmpDirs: string[] = []

function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言 */
    }
  }
})

function agent(partial: Partial<RegistryAgent> & { name: string }): RegistryAgent {
  return {
    platform: 'windows',
    skillsDir: 'C:\\Users\\t\\.x\\skills',
    include: ['*'],
    source: 'discovered',
    enabled: true,
    status: 'active',
    ...partial
  }
}

function prefs(partial: Partial<VersionPrefs> = {}): VersionPrefs {
  return { ...emptyVersionPrefs(), ...partial }
}

describe('buildVersionCatalog（可见性规则）', () => {
  it('只显示注册表里 active 且 enabled 的工具；其余默认隐藏', () => {
    const r = buildVersionCatalog({
      agents: [agent({ name: 'claude-win', sigId: 'claude' })],
      prefs: prefs()
    })
    const byId = new Map(r.entries.map((e) => [e.id, e]))
    expect(byId.get('claude-code-npm')?.visible).toBe(true)
    expect(byId.get('claude-code-winget')?.visible).toBe(true)
    expect(byId.get('claude-desktop')?.visible).toBe(true)
    expect(byId.get('codex-desktop')?.visible).toBe(false)
    expect(byId.get('zcode')?.visible).toBe(false)
    expect(r.hiddenCount).toBe(VERSION_CATALOG.length - 3)
    expect(r.degraded).toBe(false)
  })

  it('停用 / missing / 无签名 → 该工具全部条目隐藏', () => {
    for (const a of [
      agent({ name: 'kimi-win', sigId: 'kimi', enabled: false }),
      agent({ name: 'kimi-win', sigId: 'kimi', status: 'missing' }),
      agent({ name: 'kimi-win' })
    ]) {
      const r = buildVersionCatalog({ agents: [a], prefs: prefs() })
      expect(r.entries.find((e) => e.id === 'kimi-cli')?.visible).toBe(false)
      expect(r.entries.find((e) => e.id === 'kimi-cli')?.detected).toBe(false)
    }
  })

  it('固定显示（pinned）的条目即使没检测到也可见', () => {
    const r = buildVersionCatalog({ agents: [], prefs: prefs({ pinned: ['zcode'] }) })
    const z = r.entries.find((e) => e.id === 'zcode')
    expect(z?.visible).toBe(true)
    expect(z?.pinned).toBe(true)
    expect(z?.detected).toBe(false)
    expect(r.hiddenCount).toBe(VERSION_CATALOG.length - 1)
  })

  it('注册表读不到（agents=null）→ 保守显示全部，detected 一律 false（我们并不知道）', () => {
    const r = buildVersionCatalog({ agents: null, prefs: prefs() })
    expect(r.degraded).toBe(true)
    expect(r.entries.every((e) => e.visible)).toBe(true)
    expect(r.entries.every((e) => !e.detected)).toBe(true)
    expect(r.hiddenCount).toBe(0)
  })

  it('版本目录每条都带 sigId（可见性规则的依据）', () => {
    const r = buildVersionCatalog({ agents: null, prefs: prefs() })
    for (const e of r.entries) expect(e.sigId).toMatch(/^(claude|codex|kimi|grok|dsh|zcode)$/)
  })

  it('visibleVersionIds：默认只回可见条目；开了「显示全部」回 null（表示不限制）', () => {
    const only = buildVersionCatalog({ agents: [agent({ name: 'grok-win', sigId: 'grok' })], prefs: prefs() })
    expect(visibleVersionIds(only)).toEqual(['grok-cli'])
    const all = buildVersionCatalog({ agents: [agent({ name: 'grok-win', sigId: 'grok' })], prefs: prefs({ showHidden: true }) })
    expect(visibleVersionIds(all)).toBeNull()
  })
})

describe('版本中心偏好持久化（pin / 显示全部）', () => {
  it('pin → 落盘 → 重新读出仍在；取消 pin 后消失', () => {
    const ud = mkTmp('sv-vc-prefs-')
    expect(loadVersionPrefs(ud)).toEqual({ version: 1, pinned: [], showHidden: false })
    setVersionPinned(ud, 'zcode', true, fs)
    expect(loadVersionPrefs(ud).pinned).toEqual(['zcode'])
    setVersionPinned(ud, 'zcode', false, fs)
    expect(loadVersionPrefs(ud).pinned).toEqual([])
  })

  it('pin 未知条目 id → 抛错（不把垃圾 id 写进偏好）', () => {
    const ud = mkTmp('sv-vc-prefs-')
    expect(() => setVersionPinned(ud, 'not-a-real-entry', true, fs)).toThrow('版本目录中不存在该条目')
    expect(fs.existsSync(versionPrefsFile(ud))).toBe(false)
  })

  it('「显示全部」开关持久化', () => {
    const ud = mkTmp('sv-vc-prefs-')
    setVersionShowHidden(ud, true, fs)
    expect(loadVersionPrefs(ud).showHidden).toBe(true)
    setVersionShowHidden(ud, false, fs)
    expect(loadVersionPrefs(ud).showHidden).toBe(false)
  })

  it('偏好文件损坏 → 回落默认值（pin 丢了顶多多显示几条，绝不炸）', () => {
    const ud = mkTmp('sv-vc-prefs-')
    fs.writeFileSync(versionPrefsFile(ud), '{ 坏文件', 'utf8')
    expect(loadVersionPrefs(ud)).toEqual({ version: 1, pinned: [], showHidden: false })
  })

  it('偏好文件里的非法 pin id 被过滤掉', () => {
    const ud = mkTmp('sv-vc-prefs-')
    saveVersionPrefs(ud, { version: 1, pinned: ['zcode', 'ghost-entry'], showHidden: false }, fs)
    expect(loadVersionPrefs(ud).pinned).toEqual(['zcode'])
  })
})

describe('versionCatalogFromDisk（读盘 + 合成）', () => {
  it('真实 registry.json + 偏好 → 目录视图（kimi 显示、其余隐藏）', () => {
    const vault = mkTmp('sv-vc-vault-')
    const ud = mkTmp('sv-vc-ud-')
    fs.writeFileSync(
      path.join(vault, 'registry.json'),
      JSON.stringify({ version: 3, agents: [agent({ name: 'kimi-win', sigId: 'kimi', skillsDir: path.join(vault, '.kimi-code', 'skills') })] }),
      'utf8'
    )
    const r = versionCatalogFromDisk({ vaultPath: vault, userDataDir: ud })
    expect(r.degraded).toBe(false)
    expect(r.entries.filter((e) => e.visible).map((e) => e.id)).toEqual(['kimi-cli'])
  })

  it('注册表缺失 → degraded + 全部显示 + 原因（保守降级）', () => {
    const r = versionCatalogFromDisk({ vaultPath: mkTmp('sv-vc-novault-'), userDataDir: mkTmp('sv-vc-ud-') })
    expect(r.degraded).toBe(true)
    expect(r.reason).toContain('registry.json')
    expect(r.entries.every((e) => e.visible)).toBe(true)
  })
})

describe('runVersionCheckAll（只遍历可见条目）', () => {
  it('visibleIds 指定时只检查这些条目', async () => {
    const calls = { spawnArgs: [] as unknown[][], kills: 0 }
    const spawner = fakeSpawner({ stdout: '', code: 1 }, calls)
    const r = await runVersionCheckAll({ spawner, visibleIds: ['claude-code-npm', 'kimi-cli'] })
    expect(r.statuses.map((s) => s.id)).toEqual(['claude-code-npm', 'kimi-cli'])
    expect(r.stale).toBe(false)
  })

  it('可见集为空 → 一条都不查，也不回落缓存（0 条可见 ≠ 检查全挂）', async () => {
    const ud = mkTmp('sv-vc-cache-')
    const cacheFile = path.join(ud, 'version-cache.json')
    fs.writeFileSync(cacheFile, JSON.stringify({ ts: 1, statuses: [{ id: 'zcode', name: 'ZCode', channel: 'x', channelKind: 'winget', state: 'up-to-date' }] }), 'utf8')
    const calls = { spawnArgs: [] as unknown[][], kills: 0 }
    const r = await runVersionCheckAll({ spawner: fakeSpawner({ stdout: '', code: 1 }, calls), cacheFile, visibleIds: [] })
    expect(r.statuses).toEqual([])
    expect(r.stale).toBe(false)
    expect(calls.spawnArgs).toHaveLength(0)
  })

  it('visibleIds 缺省 = 全部条目（保持旧行为，单测与「显示全部」依赖）', async () => {
    const r = await runVersionCheckAll({ spawner: fakeSpawner({ stdout: '', code: 1 }) })
    expect(r.statuses.map((s) => s.id)).toEqual(VERSION_CATALOG.map((e) => e.id))
  })

  it('从偏好算出的可见集直接喂给 checkAll：pin 过的隐藏条目也会被检查', async () => {
    const vault = mkTmp('sv-vc-vault-')
    const ud = mkTmp('sv-vc-ud-')
    fs.writeFileSync(
      path.join(vault, 'registry.json'),
      JSON.stringify({ version: 3, agents: [agent({ name: 'grok-win', sigId: 'grok' })] }),
      'utf8'
    )
    setVersionPinned(ud, 'deepseek-harness', true, fs)
    const catalog = versionCatalogFromDisk({ vaultPath: vault, userDataDir: ud })
    const r = await runVersionCheckAll({ spawner: fakeSpawner({ stdout: '', code: 1 }), visibleIds: visibleVersionIds(catalog) })
    expect(r.statuses.map((s) => s.id)).toEqual(['grok-cli', 'deepseek-harness'])
  })
})
