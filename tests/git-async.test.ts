// gitAsync()：异步执行 git（spawn 而非 spawnSync）的行为约束。
// 目的：主进程再也不会被一次慢 git 冻住；同时保证与同步版 git() 语义一致（同样的参数注入 / env / 返回结构）。
// 全部用共享 fake spawner（不真调 git 二进制），与 tests/helpers/fakeSpawn.ts 同款风格。
import { describe, expect, it } from 'vitest'
import { gitAsync } from '../src/main/git'
import { fakeSpawner, type FakeCalls } from './helpers/fakeSpawn'

type Captured = { cmd: string; args: string[]; opts: Record<string, unknown> }[]

/** 把共享 fake spawner 的记录转成便于断言的形态 */
function captured(calls: FakeCalls): Captured {
  return calls.spawnArgs.map(([cmd, args, opts]) => ({
    cmd: String(cmd),
    args: [...(args as string[])],
    opts: opts as Record<string, unknown>
  }))
}

describe('gitAsync() 参数与环境（与同步版 git() 一致）', () => {
  it('args 以两个 -c 开头，用户 args 完整跟在后面', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const r = await gitAsync('C:\\vault', ['status', '--porcelain'], 1000, fakeSpawner({}, calls))
    expect(r.ok).toBe(true)
    const [call] = captured(calls)
    expect(call.cmd).toBe('git')
    expect(call.args.slice(0, 4)).toEqual(['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8'])
    expect(call.args.slice(4)).toEqual(['status', '--porcelain'])
    expect(call.opts.cwd).toBe('C:\\vault')
    expect(call.opts.windowsHide).toBe(true)
    const env = call.opts.env as Record<string, string | undefined>
    expect(env.LC_ALL).toBe('C')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('正常退出 status 0 → ok:true 且 stdout 原样返回', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const r = await gitAsync(
      'C:\\vault',
      ['status', '--porcelain'],
      1000,
      fakeSpawner({ stdout: '?? 中文名.md\n' }, calls)
    )
    expect(r.ok).toBe(true)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('?? 中文名.md\n')
    expect(r.stderr).toBe('')
  })

  it('非零退出 → ok:false，status 与 stderr 原样透传', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const r = await gitAsync(
      'C:\\vault',
      ['rev-parse', 'HEAD'],
      1000,
      fakeSpawner({ code: 128, stderr: 'fatal: bad' }, calls)
    )
    expect(r.ok).toBe(false)
    expect(r.status).toBe(128)
    expect(r.stderr).toBe('fatal: bad')
  })
})

describe('gitAsync() 失败路径（绝不 reject，绝不悬挂）', () => {
  it("spawn 'error' 事件（git 不在 PATH）→ ok:false、status -1、不抛异常", async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const r = await gitAsync(
      'C:\\vault',
      ['status'],
      1000,
      fakeSpawner({ error: new Error('spawn git ENOENT') }, calls)
    )
    expect(r.ok).toBe(false)
    expect(r.status).toBe(-1)
    expect(r.stderr).toContain('ENOENT')
  })

  it('超时 → kill 子进程并以 ok:false 返回，stderr 含超时说明', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const r = await gitAsync(
      'C:\\vault',
      ['push', 'origin', 'main'],
      30,
      fakeSpawner({ neverClose: true, ignoreKill: true }, calls)
    )
    expect(r.ok).toBe(false)
    expect(r.status).toBe(-1)
    expect(calls.kills).toBe(1)
    expect(r.stderr).toContain('超时')
    expect(r.stderr).toContain('30ms')
    expect(r.stderr).toContain('已终止子进程')
  })

  it('迟到的 close 不会覆盖已经确定的超时结果', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    // close 迟到（超时之后才发）；ignoreKill 保证只有这一次迟到 close
    const r = await gitAsync(
      'C:\\vault',
      ['push'],
      30,
      fakeSpawner({ closeDelayMs: 120, code: 0, ignoreKill: true }, calls)
    )
    expect(r.ok).toBe(false)
    expect(r.status).toBe(-1)
    expect(r.stderr).toContain('超时')
    // 等迟到的 close 真正发出后再确认结果没被改写
    await new Promise((r2) => setTimeout(r2, 220))
    expect(r.ok).toBe(false)
    expect(r.status).toBe(-1)
    expect(r.stderr).toContain('超时')
  })
})
