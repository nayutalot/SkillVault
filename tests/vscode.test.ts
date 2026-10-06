import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchVsCode, cleanLaunchEnv, resolveVsCode, resolveVsCodeFrom, type VscodeIo } from '../src/main/vscode'

// 只 mock spawnSync（node:child_process 在本文件的唯一运行时入口）：
// resolveVsCode 的真实实现要覆盖「where 走 cmd chcp 65001 通道」的参数断言，绝不真调子进程。
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))

const CANDIDATES = [
  'D:\\Apps\\Microsoft VS Code\\Code.exe',
  'C:\\Users\\sakuya\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
  'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe'
]

function io(exists: string[], where: Record<string, string[] | null>): VscodeIo {
  const set = new Set(exists.map((p) => p.toLowerCase()))
  return {
    exists: (p) => set.has(p.toLowerCase()),
    where: (name) => (name in where ? where[name] : null)
  }
}

function fakeChild(): ChildProcess {
  const c = new EventEmitter() as unknown as ChildProcess
  ;(c as unknown as { unref: ChildProcess['unref'] }).unref = vi.fn(() => c)
  return c
}

describe('resolveVsCodeFrom（注入候选列表，不真调 where.exe / 不真读盘）', () => {
  it('候选路径按序直查：第一个存在即命中，且不再调 where', () => {
    const where = vi.fn(() => null)
    const vio = io([CANDIDATES[1]], {})
    vio.where = where
    expect(resolveVsCodeFrom(CANDIDATES, vio)).toBe(CANDIDATES[1])
    expect(where).not.toHaveBeenCalled()
  })

  it('前面的候选缺席 → 落到后面的候选', () => {
    expect(resolveVsCodeFrom(CANDIDATES, io([CANDIDATES[2]], {}))).toBe(CANDIDATES[2])
  })

  it('本机非标准位（D 盘）命中', () => {
    expect(resolveVsCodeFrom(CANDIDATES, io([CANDIDATES[0]], {}))).toBe('D:\\Apps\\Microsoft VS Code\\Code.exe')
  })

  it('候选全缺席 → where code.cmd 命中：取 bin 上级目录的 Code.exe', () => {
    const whereOut = { 'code.cmd': ['D:\\Apps\\Microsoft VS Code\\bin\\code.cmd'] }
    expect(resolveVsCodeFrom(CANDIDATES, io(['D:\\Apps\\Microsoft VS Code\\Code.exe'], whereOut))).toBe(
      'D:\\Apps\\Microsoft VS Code\\Code.exe'
    )
  })

  it('where code.cmd 失败 → 再试 where code', () => {
    const whereOut = { 'code.cmd': null, code: ['C:\\Install\\vscode\\bin\\code'] }
    expect(resolveVsCodeFrom(CANDIDATES, io(['C:\\Install\\vscode\\Code.exe'], whereOut))).toBe(
      'C:\\Install\\vscode\\Code.exe'
    )
  })

  it('where 输出对应的 Code.exe 不存在 → 继续找，最终 null', () => {
    const whereOut = { 'code.cmd': ['C:\\ghost\\bin\\code.cmd'] }
    expect(resolveVsCodeFrom(CANDIDATES, io([], whereOut))).toBeNull()
  })

  it('候选与 where 全部失败 → null（调用方走 shell.openPath 兜底）', () => {
    expect(resolveVsCodeFrom(CANDIDATES, io([], { 'code.cmd': null, code: null }))).toBeNull()
  })

  it('路径比较不区分大小写（Windows 语义）', () => {
    expect(resolveVsCodeFrom([CANDIDATES[0]], io(['d:\\apps\\MICROSOFT VS CODE\\code.EXE'], {}))).toBe(
      CANDIDATES[0]
    )
  })
})

describe('launchVsCode（直 spawn，绝不经 shell；async 等待 error 事件）', () => {
  it('spawn(exe, [filePath], { detached, stdio ignore, env 清洗 }) 且 unref；参数是数组而非命令行串', async () => {
    const spawn = vi.fn((_c: string, _a: readonly string[], _o: SpawnOptions) => fakeChild())
    const p = launchVsCode({ spawn, confirmDelayMs: 1 }, 'D:\\Apps\\Microsoft VS Code\\Code.exe', 'C:\\v\\skills\\foo\\SKILL.md')
    const r = await p
    expect(r.ok).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawn.mock.calls[0]
    expect(cmd).toBe('D:\\Apps\\Microsoft VS Code\\Code.exe')
    expect(args).toEqual(['C:\\v\\skills\\foo\\SKILL.md'])
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    expect((opts as SpawnOptions).shell).toBeUndefined()
    // env 清洗：即便父进程被污染，子进程也不能带上这两个变量
    expect((opts as SpawnOptions).env).toBeDefined()
    expect((opts as SpawnOptions).env!['ELECTRON_RUN_AS_NODE']).toBeUndefined()
    expect((opts as SpawnOptions).env!['ELECTRON_NO_ATTACH_CONSOLE']).toBeUndefined()
  })

  it('spawn error 事件 → { ok:false, error }（不再静默吞掉，交由调用方兜底）', async () => {
    const child = new EventEmitter() as unknown as ChildProcess
    const unref = vi.fn()
    ;(child as unknown as { unref: ChildProcess['unref'] }).unref = unref
    const spawn = vi.fn(() => child)
    const p = launchVsCode({ spawn, confirmDelayMs: 5000 }, 'C:\\x\\Code.exe', path.resolve('C:\\x\\a.md'))
    child.emit('error', new Error('ENOENT'))
    const r = await p
    expect(r).toEqual({ ok: false, error: 'ENOENT' })
    expect(unref).toHaveBeenCalled()
  })

  it('窗口期内无 error → { ok:true }（默认视为启动成功）', async () => {
    const spawn = vi.fn(() => fakeChild())
    const r = await launchVsCode({ spawn, confirmDelayMs: 1 }, 'C:\\x\\Code.exe', 'C:\\x\\a.md')
    expect(r).toEqual({ ok: true })
  })

  it('error 后到达的 resolve 竞态被吞（settled 只取第一个结果）', async () => {
    const child = new EventEmitter() as unknown as ChildProcess
    ;(child as unknown as { unref: ChildProcess['unref'] }).unref = vi.fn()
    const spawn = vi.fn(() => child)
    const p = launchVsCode({ spawn, confirmDelayMs: 1 }, 'C:\\x\\Code.exe', 'C:\\x\\a.md')
    child.emit('error', new Error('boom'))
    const r = await p
    expect(r.ok).toBe(false)
    // 迟到的成功判定不会覆盖已确定的失败
    await new Promise((res) => setTimeout(res, 10))
    expect(r.ok).toBe(false)
  })
})

describe('cleanLaunchEnv（env 污染清洗：修复「VS Code 点了没反应」）', () => {
  it('剔除 ELECTRON_RUN_AS_NODE / ELECTRON_NO_ATTACH_CONSOLE，其余保留', () => {
    const env = {
      PATH: 'C:\\Windows',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      WSL_UTF8: '1'
    }
    const clean = cleanLaunchEnv(env)
    expect(clean.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(clean.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined()
    expect(clean.PATH).toBe('C:\\Windows')
    expect(clean.WSL_UTF8).toBe('1')
  })

  it('不修改传入的 env（纯函数语义）', () => {
    const env = { ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' }
    cleanLaunchEnv(env)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.KEEP).toBe('yes')
  })

  it('干净 env 原样保留全部键', () => {
    const env = { A: '1', B: '2' }
    expect(cleanLaunchEnv(env)).toEqual({ A: '1', B: '2' })
  })
})

/** resolveVsCode 真实实现里 spawnSync 的结构化 mock 视图（绕开 spawnSync 多重载的 mockImplementation 类型摩擦） */
type SpawnSyncMock = {
  mockImplementation: (
    fn: (cmd: string, args: readonly string[] | undefined) => { status: number; stdout: string }
  ) => void
  mock: { calls: Array<[string, readonly string[] | undefined]> }
}
const spawnSyncMock = (): SpawnSyncMock => spawnSync as unknown as SpawnSyncMock

describe('resolveVsCode（真实实现：where.exe 经 cmd chcp 65001 通道，防 OEM 代码页乱码）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('候选全缺席落到 where：走 cmd.exe /d /s /c chcp 65001 >nul && where.exe，中文安装路径可命中', () => {
    const exe = 'C:\\安装 目录\\vscode\\Code.exe'
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).toLowerCase() === exe.toLowerCase())
    const m = spawnSyncMock()
    m.mockImplementation((_cmd, args) =>
      args?.[args.length - 1] === 'code.cmd'
        ? { status: 0, stdout: 'C:\\安装 目录\\vscode\\bin\\code.cmd\r\n' }
        : { status: 1, stdout: '' }
    )
    expect(resolveVsCode()).toBe(exe)
    expect(m.mock.calls.length).toBe(1)
    const [cmd, args] = m.mock.calls[0]
    // 与 versionCenter/exec.ts 的 execCmdArgs 同款前缀：cmd 会话先切 UTF-8，where 输出按 UTF-8 解才不乱码
    expect(cmd).toBe('cmd.exe')
    expect(args?.slice(0, 8)).toEqual(['/d', '/s', '/c', 'chcp', '65001', '>nul', '&&', 'where.exe'])
    expect(args?.[8]).toBe('code.cmd')
  })

  it('where code.cmd 失败 → 同一通道再试 where code；全失败返回 null（不直接调裸 where.exe）', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const m = spawnSyncMock()
    m.mockImplementation(() => ({ status: 1, stdout: '' }))
    expect(resolveVsCode()).toBeNull()
    expect(m.mock.calls.map(([, a]) => a?.[a.length - 1])).toEqual(['code.cmd', 'code'])
    for (const [cmd, args] of m.mock.calls) {
      expect(cmd).toBe('cmd.exe')
      expect(args?.slice(0, 8)).toEqual(['/d', '/s', '/c', 'chcp', '65001', '>nul', '&&', 'where.exe'])
    }
  })
})
