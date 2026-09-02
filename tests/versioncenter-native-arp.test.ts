import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  firstVersionLine,
  nativeInstalledVersion,
  nativeUpdateHandle,
  resolveNativeBin
} from '../src/main/versionCenter/native'
import { ARP_QUERY_TARGETS, arpInstalledVersion, findArpVersion, parseArpBlocks } from '../src/main/versionCenter/arp'
import type { Spawner } from '../src/main/wslBridge'

// ---------- native（kimi/grok 自带更新器） ----------

const tmpFiles: string[] = []

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      fs.rmSync(f, { force: true })
    } catch {
      /* 清理失败忽略 */
    }
  }
})

type ArpFakeSpec = { stdout?: string; stderr?: string; code?: number; error?: Error }

function fakeSpawner(spec: ArpFakeSpec = {}, calls: { spawnArgs: unknown[][] } = { spawnArgs: [] }): Spawner {
  return (cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess => {
    calls.spawnArgs.push([cmd, args, opts])
    const child = new EventEmitter() as unknown as ChildProcess
    child.stdout = new EventEmitter() as unknown as ChildProcess['stdout']
    child.stderr = new EventEmitter() as unknown as ChildProcess['stderr']
    child.kill = vi.fn(() => true)
    child.unref = vi.fn()
    queueMicrotask(() => {
      if (spec.stdout !== undefined) child.stdout!.emit('data', Buffer.from(spec.stdout))
      if (spec.stderr !== undefined) child.stderr!.emit('data', Buffer.from(spec.stderr))
      if (spec.error) {
        child.emit('error', spec.error)
        return
      }
      child.emit('close', spec.code ?? 0)
    })
    return child
  }
}

describe('resolveNativeBin / firstVersionLine', () => {
  it('~ 路径展开 + 后缀候选探测（.exe 优先命中）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-native-'))
    const exe = path.join(dir, 'kimi.exe')
    fs.writeFileSync(exe, 'binary')
    tmpFiles.push(exe)
    const resolved = resolveNativeBin(path.join(dir, 'kimi'))
    expect(resolved).toBe(exe)
  })

  it('不存在任何候选 → null', () => {
    expect(resolveNativeBin(path.join(os.tmpdir(), 'vc-不存在的bin-xyz'))).toBeNull()
  })

  it('首行非空文本原样返回（前缀噪声由 versionCompare 剥离）', () => {
    expect(firstVersionLine('0.36.0\r\nnext\r\n')).toBe('0.36.0')
    expect(firstVersionLine('grok 1.0.5 (5115b46bc9)\r\n')).toBe('grok 1.0.5 (5115b46bc9)')
    expect(firstVersionLine('')).toBeNull()
  })
})

describe('nativeInstalledVersion / nativeUpdateHandle', () => {
  /** 造一个真实存在的假 exe（fs 探测需要）；返回绝对路径 */
  function makeFakeBin(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-native-run-'))
    const exe = dir + path.sep + name
    fs.writeFileSync(exe, 'binary')
    tmpFiles.push(exe)
    return exe
  }

  it('真实 .exe 直启 --version → 首行版本', async () => {
    const exe = makeFakeBin('kimi.exe')
    const calls = { spawnArgs: [] as unknown[][] }
    const r = await nativeInstalledVersion(exe, { spawner: fakeSpawner({ stdout: '0.36.0\n' }, calls) })
    expect(r).toEqual({ version: '0.36.0' })
    const [cmd, args] = calls.spawnArgs[0] as [string, string[]]
    expect(cmd).toBe(exe)
    expect(args).toEqual(['--version'])
  })

  it('grok --version 带前缀 → 原样返回；更新 handle 用 `update` 子命令', async () => {
    const exe = makeFakeBin('grok.exe')
    const calls = { spawnArgs: [] as unknown[][] }
    const r = await nativeInstalledVersion(exe, { spawner: fakeSpawner({ stdout: 'grok 1.0.5 (5115b46bc9)\n' }, calls) })
    expect(r).toEqual({ version: 'grok 1.0.5 (5115b46bc9)' })
    const handle = nativeUpdateHandle(exe, {
      timeoutMs: 1000,
      spawner: fakeSpawner({ stdout: 'already latest' }, calls)
    })
    await handle.handle.done
    const last = calls.spawnArgs[calls.spawnArgs.length - 1] as [string, string[]]
    expect(last[0]).toBe(exe)
    expect(last[1]).toEqual(['update'])
    expect(handle.commandText).toContain('update')
  })

  it('bin 不存在 → error（不 spawn）', async () => {
    const calls = { spawnArgs: [] as unknown[][] }
    const r = await nativeInstalledVersion('~/.no-such-dir-xyz/bin/tool', { spawner: fakeSpawner({}, calls) })
    expect(r.error).toContain('未找到自带更新器可执行文件')
    expect(calls.spawnArgs.length).toBe(0)
  })

  it('--version 无输出且失败 → error 含退出码', async () => {
    const exe = makeFakeBin('silent.exe')
    const r = await nativeInstalledVersion(exe, {
      spawner: fakeSpawner({ code: 1, stderr: 'crash' })
    })
    expect(r.error).toContain('无版本输出')
  })
})

// ---------- arp（DeepSeek Harness 注册表检测） ----------

/** 本机实测 reg query /s 输出片段（HKCU，含 ZCode 与 DeepSeek Harness 两个块） */
const REG_SAMPLE = [
  '',
  'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\268ce9e6-a30b-5890-ad18-d4b3ebba5377',
  '    DisplayName    REG_SZ    ZCode 3.10.2',
  '    DisplayVersion    REG_SZ    3.10.2',
  '    Publisher    REG_SZ    ZCode',
  '',
  'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\c330d982aee38d3ec1bea31c8d549b98',
  '    DisplayIcon    REG_SZ    C:\\Users\\sakuya\\AppData\\Local\\Google\\Chrome\\DeepSeek Harness.ico',
  '    DisplayName    REG_SZ    DeepSeek Harness',
  '    DisplayVersion    REG_SZ    1.0',
  '    InstallDate    REG_SZ    20260814',
  '    Publisher    REG_SZ    Google\\Chrome',
  '',
  ''
].join('\r\n')

describe('parseArpBlocks / findArpVersion', () => {
  it('按 HKEY_ 行分块，取行尾整段值（值内可含空格）', () => {
    const blocks = parseArpBlocks(REG_SAMPLE)
    expect(blocks.length).toBe(2)
    expect(blocks[0]).toMatchObject({ displayName: 'ZCode 3.10.2', displayVersion: '3.10.2' })
    expect(blocks[1]).toMatchObject({ displayName: 'DeepSeek Harness', displayVersion: '1.0' })
  })

  it('displayName 子串匹配（大小写不敏感）→ DisplayVersion', () => {
    expect(findArpVersion(REG_SAMPLE, 'deepseek harness')).toBe('1.0')
    expect(findArpVersion(REG_SAMPLE, 'DeepSeek')).toBe('1.0')
  })

  it('未命中 / 命中但无 DisplayVersion → null', () => {
    expect(findArpVersion(REG_SAMPLE, 'Not Existing App')).toBeNull()
    expect(findArpVersion('HKEY_X\r\n    DisplayName    REG_SZ    Foo\r\n', 'Foo')).toBeNull()
  })
})

describe('arpInstalledVersion（三处根键并行枚举，经 cmd chcp 65001 通道防 GBK 乱码）', () => {
  /** 从 cmd.exe 参数数组里取 reg query 的根键参数（args = [/d,/s,/c,chcp,65001,>nul,&&,reg,query,<key>,/s]） */
  const keyOfArgs = (args: readonly string[]): string => {
    const i = args.indexOf('query')
    return i >= 0 ? (args[i + 1] as string) : ''
  }

  it('按根键路由 reg query 样本 → 命中 HKCU 返回 1.0', async () => {
    const calls = { spawnArgs: [] as unknown[][] }
    const spawner: Spawner = (cmd, args, opts) => {
      const key = keyOfArgs(args)
      const spec = key.startsWith('HKCU') ? { stdout: REG_SAMPLE } : { stdout: '\r\n' }
      return fakeSpawner(spec, calls)(cmd, args, opts)
    }
    const r = await arpInstalledVersion('DeepSeek Harness', { spawner })
    expect(r).toEqual({ version: '1.0' })
    // 三处根键都被查询过，且统一经 cmd.exe chcp 65001 通道
    const keys = calls.spawnArgs.map((c) => keyOfArgs((c as [string, string[]])[1]))
    for (const t of ARP_QUERY_TARGETS) expect(keys).toContain(t)
    expect(keys.length).toBe(3)
    for (const c of calls.spawnArgs) {
      expect((c as [string])[0]).toBe('cmd.exe')
      expect(((c as [string, string[]])[1] as string[]).slice(3, 7)).toEqual(['chcp', '65001', '>nul', '&&'])
    }
  })

  it('全部未命中且查询成功 → {}（不是错误）', async () => {
    const r = await arpInstalledVersion('Not Existing App', { spawner: fakeSpawner({ stdout: '\r\n' }) })
    expect(r).toEqual({})
  })

  it('部分根键失败但其余成功且未命中 → {}（不误报「全部失败」）', async () => {
    const spawner: Spawner = (cmd, args, opts) => {
      const key = keyOfArgs(args)
      const spec = key.startsWith('HKCU') ? { code: 1, error: new Error('timeout') } : { stdout: '\r\n' }
      return fakeSpawner(spec)(cmd, args, opts)
    }
    const r = await arpInstalledVersion('DeepSeek Harness', { spawner })
    expect(r).toEqual({})
  })

  it('reg 完全不可用（spawn error）→ error', async () => {
    const r = await arpInstalledVersion('DeepSeek Harness', {
      spawner: fakeSpawner({ code: 1, error: new Error('spawn reg ENOENT') })
    })
    expect(r.error).toContain('reg query 全部')
    expect(r.error).toContain('根键查询失败')
  })
})
