// agentDiscover：主进程发现编排（临时 vault 真实写盘 + 注入的 Windows/WSL 发现结果）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverWindowsAgents,
  discoverWslAgents,
  realDiscoverDeps,
  refreshRegistry,
  registryFilePath,
  setAgentEnabled,
  writeRegistryFile
} from '../src/main/agentDiscover'
import { parseRegistry } from '../src/shared/registry'
import type { WslResult } from '../src/main/wslBridge'
import type { DiscoveredAgent } from '../src/shared/agentSignatures'
import type { AppSettings, Registry } from '../src/shared/types'

function tmpVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skm-discover-'))
}

function settingsFor(vaultPath: string): AppSettings {
  return { vaultPath, barePath: vaultPath + '.git', wslDistro: 'Ubuntu', deepseekHarnessRoot: 'D:\\Apps\\deepseek-harness', remoteTargets: [] }
}

function winCandidate(sigId: string, label: string, dotDir: string): DiscoveredAgent {
  return { sigId, label, dotDir, skillsDir: path.join('C:\\home', dotDir, 'skills'), platform: 'windows' }
}

function linuxCandidate(sigId: string, label: string, dotDir: string): DiscoveredAgent {
  return { sigId, label, dotDir, skillsDir: `/root/${dotDir}/skills`, platform: 'linux' }
}

function readRegistryFile(file: string): Registry {
  const r = parseRegistry(fs.readFileSync(file, 'utf8'))
  if (!r.ok) throw new Error(r.error)
  return r.registry
}

describe('discoverWindowsAgents / realDiscoverDeps', () => {
  it('真实 fs 发现：只认存在的 dotDir（注入 home 目录树，不碰真实家目录）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-home-'))
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true })
    fs.mkdirSync(path.join(home, '.agents', 'agents'), { recursive: true })
    const out = discoverWindowsAgents({ homeDir: home })
    expect(out.map((c) => c.sigId).sort()).toEqual(['agents-shared', 'claude'])
    expect(out.every((c) => c.platform === 'windows')).toBe(true)
  })

  it('realDiscoverDeps.list 只回子目录（文件与非目录项不算，符号链接目录计入）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-io-'))
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x', 'utf8')
    const io = realDiscoverDeps()
    expect(io.list(dir)).toEqual(['sub'])
    expect(io.list(path.join(dir, 'absent'))).toEqual([])
    expect(io.exists(path.join(dir, 'file.txt'))).toBe(true)
  })
})

describe('refreshRegistry', () => {
  it('首次扫描：vault 无 registry.json 时以默认注册表为基底新增发现条目并写盘', async () => {
    const vault = tmpVault()
    const file = registryFilePath(vault)
    const found = [winCandidate('claude', 'Claude Code', '.claude')]
    const r = await refreshRegistry(settingsFor(vault), { discoverWin: () => found, discoverWsl: async () => null })

    expect(r.added).toEqual(['claude-win'])
    expect(r.missing).toEqual([])
    expect(r.windowsFound).toBe(1)
    expect(r.wslStale).toBe(true)
    expect(r.wslReason).toBeTruthy()
    // 内置 4 条与发现条目并存，不是只写发现项
    expect(r.registry.agents.map((a) => a.name)).toEqual(['zcode-win', 'codex-win', 'agents-win', 'zcode-wsl', 'claude-win'])
    const added = r.registry.agents.find((a) => a.name === 'claude-win')
    expect(added).toMatchObject({ source: 'discovered', enabled: true, status: 'active', include: ['*'], label: 'Claude Code', sigId: 'claude' })
    // 落盘内容可被 parseRegistry 原样读回
    expect(readRegistryFile(file)).toEqual(r.registry)
  })

  it('二次扫描幂等：不重复新增、不误标 missing', async () => {
    const vault = tmpVault()
    const found = [winCandidate('claude', 'Claude Code', '.claude'), winCandidate('gemini', 'Gemini CLI', '.gemini')]
    const deps = { discoverWin: () => found, discoverWsl: async () => null }
    const first = await refreshRegistry(settingsFor(vault), deps)
    const second = await refreshRegistry(settingsFor(vault), deps)
    expect(first.added).toEqual(['claude-win', 'gemini-win'])
    expect(second.added).toEqual([])
    expect(second.missing).toEqual([])
    expect(second.registry.agents).toHaveLength(first.registry.agents.length)
  })

  it('本轮未发现 → 标 missing（条目保留）；再次发现 → reactivated', async () => {
    const vault = tmpVault()
    const s = settingsFor(vault)
    let found = [winCandidate('claude', 'Claude Code', '.claude')]
    const run = () => refreshRegistry(s, { discoverWin: () => found, discoverWsl: async () => null })

    await run()
    found = []
    const gone = await run()
    expect(gone.missing).toEqual(['claude-win'])
    expect(gone.registry.agents.find((a) => a.name === 'claude-win')?.status).toBe('missing')

    found = [winCandidate('claude', 'Claude Code', '.claude')]
    const back = await run()
    expect(back.reactivated).toEqual(['claude-win'])
    expect(back.registry.agents.find((a) => a.name === 'claude-win')?.status).toBe('active')
  })

  it('builtin 条目按 skillsDir 命中：不新增重复条目，只回填 label/sigId（status 不变）', async () => {
    const vault = tmpVault()
    const file = registryFilePath(vault)
    const builtinSkills = path.join('C:\\home', '.claude', 'skills')
    writeRegistryFile(file, {
      version: 3,
      agents: [{ name: 'builtin-claude', platform: 'windows', skillsDir: builtinSkills, include: ['*'], source: 'builtin', enabled: true }]
    })
    const r = await refreshRegistry(settingsFor(vault), {
      discoverWin: () => [winCandidate('claude', 'Claude Code', '.claude')],
      discoverWsl: async () => null
    })
    expect(r.added).toEqual([])
    expect(r.registry.agents).toHaveLength(1)
    expect(r.registry.agents[0]).toMatchObject({
      name: 'builtin-claude',
      source: 'builtin',
      enabled: true,
      label: 'Claude Code',
      sigId: 'claude'
    })
    expect(r.registry.agents[0].status).toBeUndefined()
  })

  it('用户字段保留：enabled:false / 自定义 include / 手改 skillsDir 不被覆盖（靠 sigId 命中）', async () => {
    const vault = tmpVault()
    const file = registryFilePath(vault)
    writeRegistryFile(file, {
      version: 3,
      agents: [
        {
          name: 'claude-win',
          platform: 'windows',
          skillsDir: 'D:\\custom\\claude-skills',
          include: ['only-this'],
          label: '我的 Claude',
          source: 'discovered',
          enabled: false,
          sigId: 'claude',
          status: 'missing'
        }
      ]
    })
    const r = await refreshRegistry(settingsFor(vault), {
      discoverWin: () => [winCandidate('claude', 'Claude Code', '.claude')],
      discoverWsl: async () => null
    })
    expect(r.added).toEqual([])
    // 目录重新出现 → reactivated；但 skillsDir/include/enabled/label 一律保持用户值
    expect(r.reactivated).toEqual(['claude-win'])
    expect(r.registry.agents[0]).toMatchObject({
      skillsDir: 'D:\\custom\\claude-skills',
      include: ['only-this'],
      enabled: false,
      label: '我的 Claude',
      status: 'active'
    })
  })

  it('builtin 的平台标签不被扫描覆盖（ZCode（Windows）/ZCode（WSL）双端可区分），sigId 照常回填', async () => {
    const vault = tmpVault()
    const home = 'C:\\home'
    writeRegistryFile(registryFilePath(vault), {
      version: 3,
      agents: [
        {
          name: 'zcode-win',
          label: 'ZCode（Windows）',
          platform: 'windows',
          skillsDir: path.join(home, '.zcode', 'skills'),
          include: ['*'],
          source: 'builtin',
          enabled: true
        }
      ]
    })
    const r = await refreshRegistry(settingsFor(vault), {
      discoverWin: () => [{ sigId: 'zcode', label: 'ZCode', skillsDir: path.join(home, '.zcode', 'skills'), platform: 'windows' }],
      discoverWsl: async () => null
    })
    expect(r.added).toEqual([])
    expect(r.registry.agents[0]).toMatchObject({ label: 'ZCode（Windows）', sigId: 'zcode', source: 'builtin' })
  })

  it('WSL companion 失败 → wslStale:true 且 Linux 条目绝不误标 missing', async () => {
    const vault = tmpVault()
    const file = registryFilePath(vault)
    writeRegistryFile(file, {
      version: 3,
      agents: [
        { name: 'claude-wsl', platform: 'linux', skillsDir: '/root/.claude/skills', include: ['*'], source: 'discovered', enabled: true, sigId: 'claude', status: 'active' }
      ]
    })
    const r = await refreshRegistry(settingsFor(vault), { discoverWin: () => [], discoverWsl: async () => null })
    expect(r.wslStale).toBe(true)
    expect(r.wslReason).toContain('WSL')
    expect(r.missing).toEqual([])
    expect(r.registry.agents[0].status).toBe('active')
  })

  it('WSL 发现抛异常 → 不向外抛，降级为 wslStale', async () => {
    const vault = tmpVault()
    const r = await refreshRegistry(settingsFor(vault), {
      discoverWin: () => [],
      discoverWsl: async () => {
        throw new Error('wsl.exe 超时')
      }
    })
    expect(r.wslStale).toBe(true)
    expect(r.wslReason).toBe('wsl.exe 超时')
  })

  it('WSL 成功：Linux 条目命名 <sigId>-wsl 且 platform=linux', async () => {
    const vault = tmpVault()
    const r = await refreshRegistry(settingsFor(vault), {
      discoverWin: () => [],
      discoverWsl: async () => [linuxCandidate('claude', 'Claude Code', '.claude')]
    })
    expect(r.wslStale).toBe(false)
    expect(r.wslFound).toBe(1)
    expect(r.registry.agents.find((a) => a.name === 'claude-wsl')).toMatchObject({ platform: 'linux', source: 'discovered' })
  })

  it('registry.json 损坏 → 拒绝覆盖（抛中文错误）', async () => {
    const vault = tmpVault()
    fs.writeFileSync(registryFilePath(vault), '{not json', 'utf8')
    await expect(
      refreshRegistry(settingsFor(vault), { discoverWin: () => [], discoverWsl: async () => null })
    ).rejects.toThrow(/已损坏/)
  })

  it('写盘为原子替换：不残留 .tmp 临时文件', async () => {
    const vault = tmpVault()
    await refreshRegistry(settingsFor(vault), { discoverWin: () => [], discoverWsl: async () => null })
    expect(fs.readdirSync(vault).filter((f) => f.includes('.tmp'))).toEqual([])
  })
})

describe('discoverWslAgents（companion scan --agents 解析与降级）', () => {
  const okResult = (parsed: unknown) => ({ ok: true, status: 0, stdout: '{}', stderr: '', parsed })

  it('成功：解析 sigId/label/skillsDir/agentsDir/generic，platform 固定 linux，且命令为 scan --agents', async () => {
    const calls: string[][] = []
    const runner = async (_d: string, args: string[]): Promise<WslResult> => {
      calls.push(args)
      return okResult({
        ok: true,
        agents: [
          { sigId: 'claude', label: 'Claude Code', skillsDir: '/root/.claude/skills', agentsDir: '/root/.claude/agents' },
          { sigId: 'generic:.acme', label: '.acme', skillsDir: '/root/.acme/skills', generic: true }
        ],
        skills: []
      })
    }
    const out = await discoverWslAgents({ distro: 'Ubuntu', runner })
    expect(calls).toEqual([['scan', '--agents']])
    expect(out).toEqual([
      { sigId: 'claude', label: 'Claude Code', skillsDir: '/root/.claude/skills', agentsDir: '/root/.claude/agents', platform: 'linux' },
      { sigId: 'generic:.acme', label: '.acme', skillsDir: '/root/.acme/skills', generic: true, platform: 'linux' }
    ])
  })

  it('降级：进程失败 / ok:false / 缺 agents 数组 / 解析失败 / runner 抛异常 → 一律 null，绝不抛', async () => {
    const cases: (() => Promise<WslResult>)[] = [
      async () => ({ ok: false, status: 1, stdout: '', stderr: 'wsl.exe 超时', parseError: '无法解析 JSON' }),
      async () => okResult({ ok: false, error: 'vault missing' }),
      async () => okResult({ ok: true }),
      async () => ({ ok: true, status: 0, stdout: 'junk', stderr: '', parseError: '无法解析 JSON' })
    ]
    for (const runner of cases) {
      expect(await discoverWslAgents({ distro: 'Ubuntu', runner })).toBeNull()
    }
    const throwing = async (): Promise<WslResult> => {
      throw new Error('spawn ENOENT')
    }
    expect(await discoverWslAgents({ distro: 'Ubuntu', runner: throwing })).toBeNull()
  })

  it('字段不合法的条目被跳过（sigId/skillsDir 缺失），label 缺省回落 sigId', async () => {
    const runner = async (): Promise<WslResult> =>
      okResult({ ok: true, agents: [{ sigId: '', skillsDir: '/x' }, { sigId: 'kimi', skillsDir: '' }, { sigId: 'pi', skillsDir: '/root/.pi/skills' }, 42] })
    const out = await discoverWslAgents({ distro: 'Ubuntu', runner })
    expect(out).toEqual([{ sigId: 'pi', label: 'pi', skillsDir: '/root/.pi/skills', platform: 'linux' }])
  })
})

describe('setAgentEnabled', () => {
  it('改 enabled 并持久化，其它字段不动', async () => {
    const vault = tmpVault()
    const s = settingsFor(vault)
    await refreshRegistry(s, { discoverWin: () => [winCandidate('claude', 'Claude Code', '.claude')], discoverWsl: async () => null })

    const after = setAgentEnabled(s, 'claude-win', false)
    expect(after.agents.find((a) => a.name === 'claude-win')?.enabled).toBe(false)
    expect(readRegistryFile(registryFilePath(vault)).agents.find((a) => a.name === 'claude-win')?.enabled).toBe(false)

    const back = setAgentEnabled(s, 'claude-win', true)
    expect(back.agents.find((a) => a.name === 'claude-win')?.enabled).toBe(true)
  })

  it('未知条目 / 空名字 → 抛错（不静默新建）', async () => {
    const vault = tmpVault()
    const s = settingsFor(vault)
    await refreshRegistry(s, { discoverWin: () => [], discoverWsl: async () => null })
    expect(() => setAgentEnabled(s, 'nope', false)).toThrow(/找不到/)
    expect(() => setAgentEnabled(s, '', false)).toThrow(/非空字符串/)
  })

  it('损坏 registry.json → 拒绝写入', async () => {
    const vault = tmpVault()
    fs.writeFileSync(registryFilePath(vault), '{not json', 'utf8')
    expect(() => setAgentEnabled(settingsFor(vault), 'x', false)).toThrow(/已损坏/)
  })
})
