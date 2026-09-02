import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  parseWingetTable,
  wingetCheckInstalled,
  wingetListUpgrades,
  wingetUpgradeArgs,
  type WingetRow
} from '../src/main/versionCenter/winget'
import type { Spawner } from '../src/main/wslBridge'

// ---------- 表格解析（真实格式样本：多空格对齐 / 单空格塌缩 / 中英文表头 / 虚线与表尾） ----------

/** winget upgrade 实测样本（重定向输出，多空格列对齐，含中文名行与虚线分隔行） */
const PADDED_UPGRADE = [
  'Name                                                         Id                               Version          Available        Source',
  '--------------------------------------------------------------------------------------------------------------------------------------',
  'App Installer                                                Microsoft.AppInstaller           1.29.289.0       1.29.290         winget',
  'Claude                                                       Anthropic.Claude                 1.26832.0.0      1.30096.1        winget',
  'Claude Code                                                  Anthropic.ClaudeCode             2.1.143          2.1.248          winget',
  'Microsoft OneDrive                                           Microsoft.OneDrive               26.074.0420.0001 26.134.0713.0007 winget',
  '网易云音乐                                                   NetEase.CloudMusic               3.1.38.205386    3.1.39.205426    winget',
  '',
  '40 upgrades available.',
  '1 package(s) have version numbers that cannot be determined. Use --include-unknown to see all results.',
  ''
].join('\r\n')

/** winget list --id Anthropic.Claude -e 实测样本：表头有对齐但数据行为单空格塌缩 */
const COLLAPSED_LIST = [
  'Name   Id               Version     Available Source',
  '----------------------------------------------------',
  'Claude Anthropic.Claude 1.26832.0.0 1.30096.1 winget',
  ''
].join('\r\n')

/** 中文表头 + 无升级（Available 空）行 */
const CHINESE_HEADER_NO_AVAILABLE = [
  '名称                Id                  版本        可用            源',
  '------------------------------------------------------------------------------',
  'ZCode               ZhipuAI.ZCode       3.10.2                      winget',
  ''
].join('\r\n')

function ids(rows: WingetRow[]): string[] {
  return rows.map((r) => r.id)
}

describe('parseWingetTable（中英文表头 / 列对齐与塌缩兼容）', () => {
  it('多空格对齐的 upgrade 全表：提取 id/installed/available，跳过表头/虚线/表尾统计行', () => {
    const rows = parseWingetTable(PADDED_UPGRADE)
    expect(ids(rows)).toEqual([
      'Microsoft.AppInstaller',
      'Anthropic.Claude',
      'Anthropic.ClaudeCode',
      'Microsoft.OneDrive',
      'NetEase.CloudMusic'
    ])
    expect(rows[1]).toEqual({ id: 'Anthropic.Claude', installed: '1.26832.0.0', available: '1.30096.1' })
    expect(rows[2]).toEqual({ id: 'Anthropic.ClaudeCode', installed: '2.1.143', available: '2.1.248' })
    expect(rows[4].installed).toBe('3.1.38.205386')
  })

  it('单空格塌缩的 list 数据行（名称含空格也无碍）', () => {
    const rows = parseWingetTable(COLLAPSED_LIST)
    expect(rows).toEqual([{ id: 'Anthropic.Claude', installed: '1.26832.0.0', available: '1.30096.1' }])
  })

  it('名称含点号 token（Node.js）时取最后一个「ID+紧跟版本」候选，不误判名称', () => {
    const rows = parseWingetTable('Node.js 20 LTS OpenJS.NodeJS.LTS 24.15.0 24.19.0 winget\r\n')
    expect(rows).toEqual([{ id: 'OpenJS.NodeJS.LTS', installed: '24.15.0', available: '24.19.0' }])
  })

  it('中文表头 + Available 为空的行：available 缺省', () => {
    const rows = parseWingetTable(CHINESE_HEADER_NO_AVAILABLE)
    expect(rows).toEqual([{ id: 'ZhipuAI.ZCode', installed: '3.10.2', available: undefined }])
  })

  it('空输出 / 纯噪声 → 空数组，绝不抛错', () => {
    expect(parseWingetTable('')).toEqual([])
    expect(parseWingetTable('没有可安装的升级。')).toEqual([])
    expect(parseWingetTable('\uFEFF\r\n')).toEqual([])
  })

  it('商店系 MSIX 行（id 为完整包名、无 Available/Source 列）→ 取完整包名为 id、末段版本为 installed', () => {
    const rows = parseWingetTable('ChatGPT      MSIX\\OpenAI.Codex_26.825.6671.0_x64__2p2nqsd0c76g0 26.825.6671.0\r\n')
    expect(rows).toEqual([
      { id: 'MSIX\\OpenAI.Codex_26.825.6671.0_x64__2p2nqsd0c76g0', installed: '26.825.6671.0', available: undefined }
    ])
  })
})

// ---------- 通道函数（fake spawner，不真调 winget） ----------

type FakeSpec = { stdout?: string; stderr?: string; code?: number; error?: Error; neverClose?: boolean }

/** 构造可注入 fake spawner；记录调用参数与 kill 次数（含 taskkill 树杀） */
function fakeSpawner(spec: FakeSpec = {}, calls: { spawnArgs: unknown[][]; kills: number } = { spawnArgs: [], kills: 0 }): Spawner {
  return (cmd: string, args: readonly string[], _opts: SpawnOptions): ChildProcess => {
    calls.spawnArgs.push([cmd, args, _opts])
    const child = new EventEmitter() as unknown as ChildProcess
    child.stdout = new EventEmitter() as unknown as ChildProcess['stdout']
    child.stderr = new EventEmitter() as unknown as ChildProcess['stderr']
    ;(child as { pid?: number }).pid = 4242
    child.kill = vi.fn(() => {
      calls.kills++
      queueMicrotask(() => child.emit('close', null))
      return true
    })
    child.unref = vi.fn()
    queueMicrotask(() => {
      if (spec.stdout !== undefined) child.stdout!.emit('data', Buffer.from(spec.stdout))
      if (spec.stderr !== undefined) child.stderr!.emit('data', Buffer.from(spec.stderr))
      if (spec.error) {
        child.emit('error', spec.error)
        return
      }
      if (spec.neverClose) return
      child.emit('close', spec.code ?? 0)
    })
    return child
  }
}

describe('wingetCheckInstalled', () => {
  it('解析到匹配行 → version；winget 调用参数符合约定', async () => {
    const calls = { spawnArgs: [] as unknown[][], kills: 0 }
    const r = await wingetCheckInstalled('Anthropic.Claude', { spawner: fakeSpawner({ stdout: COLLAPSED_LIST }, calls) })
    expect(r).toEqual({ version: '1.26832.0.0' })
    const [cmd, args] = calls.spawnArgs[0] as [string, string[]]
    expect(cmd).toBe('winget')
    expect(args).toEqual(['list', '--id', 'Anthropic.Claude', '-e', '--disable-interactivity'])
  })

  it('id 匹配大小写不敏感；未安装（有输出无匹配行）→ {}，不是错误', async () => {
    const r = await wingetCheckInstalled('anthropic.claude', {
      spawner: fakeSpawner({ stdout: 'Name Id Version\r\nFoo Bar.Baz 1.0.0\r\n' })
    })
    expect(r).toEqual({})
  })

  it('exact=false（商店系 MSIX）：不加 -e、行 id 子串匹配 → version', async () => {
    const calls = { spawnArgs: [] as unknown[][], kills: 0 }
    const msixOut = [
      'Name         Id                                                 Version       Available Source',
      '--------------------------------------------------------------------------------------',
      'ChatGPT      MSIX\\OpenAI.Codex_26.825.6671.0_x64__2p2nqsd0c76g0 26.825.6671.0',
      ''
    ].join('\r\n')
    const r = await wingetCheckInstalled('OpenAI.Codex', { spawner: fakeSpawner({ stdout: msixOut }, calls), exact: false })
    expect(r).toEqual({ version: '26.825.6671.0' })
    const args = (calls.spawnArgs[0] as [string, string[]])[1]
    expect(args).toEqual(['list', '--id', 'OpenAI.Codex', '--disable-interactivity'])
  })

  it('spawn ENOENT（无输出且非零）→ error', async () => {
    const r = await wingetCheckInstalled('Anthropic.Claude', {
      spawner: fakeSpawner({ code: 1, error: new Error('spawn winget ENOENT') })
    })
    expect(r.error).toContain('winget list 失败')
    expect(r.error).toContain('spawn winget ENOENT')
  })

  it('超时 → error 含超时说明，且 kill 了子进程', async () => {
    vi.useFakeTimers()
    try {
      const calls = { spawnArgs: [] as unknown[][], kills: 0 }
      const p = wingetCheckInstalled('Anthropic.Claude', {
        spawner: fakeSpawner({ neverClose: true }, calls),
        timeoutMs: 50
      })
      await vi.advanceTimersByTimeAsync(60)
      const r = await p
      expect(r.error).toContain('超时')
      expect(calls.kills).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('wingetListUpgrades / wingetUpgradeArgs', () => {
  it('全表 → Map（key 小写化）', async () => {
    const r = await wingetListUpgrades({ spawner: fakeSpawner({ stdout: PADDED_UPGRADE }) })
    if (!('map' in r)) throw new Error('应当成功')
    expect(r.map.get('anthropic.claude')).toEqual({ installed: '1.26832.0.0', available: '1.30096.1' })
    expect(r.map.get('anthropic.claudecode')).toBeTruthy()
  })

  it('成功但零升级 → 空 Map（不算错误）', async () => {
    const r = await wingetListUpgrades({ spawner: fakeSpawner({ stdout: 'Name Id Version Available Source\r\n' }) })
    if (!('map' in r)) throw new Error('应当成功')
    expect(r.map.size).toBe(0)
  })

  it('失败且无输出 → error', async () => {
    const r = await wingetListUpgrades({ spawner: fakeSpawner({ code: 1, stderr: 'boom' }) })
    if ('map' in r) throw new Error('应当失败')
    expect(r.error).toContain('winget upgrade 失败')
  })

  it('更新参数带 -e/--silent/双 accept', () => {
    expect(wingetUpgradeArgs('ZhipuAI.ZCode')).toEqual([
      'upgrade',
      '--id',
      'ZhipuAI.ZCode',
      '-e',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements'
    ])
  })
})
