import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { cleanWslOutput, extractJson, runCompanion, wslBash, type Spawner } from '../src/main/wslBridge'

describe('cleanWslOutput', () => {
  it('去除 UTF-16 空字节', () => {
    expect(cleanWslOutput('a\0b\0c')).toBe('abc')
  })

  it('去除 BOM', () => {
    expect(cleanWslOutput('\uFEFF{"ok":true}')).toBe('{"ok":true}')
  })
})

describe('extractJson', () => {
  it('从带告警噪声与空字节的输出中提取 JSON', () => {
    const noisy = 'ws l :\u0000 \u0000 代理警告 jumbled \u0000text\n{"ok":true,"steps":[{"cmd":"git add -A"}]}\n'
    const r = extractJson<{ ok: boolean; steps: { cmd: string }[] }>(noisy)
    expect(r).not.toBeNull()
    expect(r?.ok).toBe(true)
    expect(r?.steps[0].cmd).toBe('git add -A')
  })

  it('容忍 JSON 内部嵌套大括号（取首 { 到末 }）', () => {
    const r = extractJson('{"a":{"b":"}{"},"c":1}')
    expect(r).toEqual({ a: { b: '}{' }, c: 1 })
  })

  it('无 JSON 时返回 null', () => {
    expect(extractJson('no json here \0')).toBeNull()
  })

  it('损坏 JSON 返回 null 而不抛错', () => {
    expect(extractJson('{"ok":true,,}')).toBeNull()
  })
})

// ---------- 异步 wslBash / runCompanion（fake spawner，不真调 wsl.exe） ----------

type FakeSpec = {
  stdout?: string
  stderr?: string
  code?: number | null
  error?: Error
  closeDelayMs?: number
  /** 永不发 close（模拟 wsl.exe 卡死，只能靠超时兜底） */
  neverClose?: boolean
  /** kill 后仍不退出（配合 neverClose 验证超时路径） */
  ignoreKill?: boolean
}

/** 构造可注入的 fake spawner：子进程按 spec 异步发数据；记录调用参数与 kill 次数 */
function fakeSpawner(spec: FakeSpec = {}, calls: { spawnArgs: unknown[][]; kills: number } = { spawnArgs: [], kills: 0 }): Spawner {
  return (cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess => {
    calls.spawnArgs.push([cmd, args, opts])
    const child = new EventEmitter() as unknown as ChildProcess
    child.stdout = new EventEmitter() as unknown as ChildProcess['stdout']
    child.stderr = new EventEmitter() as unknown as ChildProcess['stderr']
    child.kill = vi.fn(() => {
      calls.kills++
      if (spec.ignoreKill) return true
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
      if (spec.closeDelayMs) {
        setTimeout(() => child.emit('close', spec.code ?? 0), spec.closeDelayMs)
      } else {
        child.emit('close', spec.code ?? 0)
      }
    })
    return child
  }
}

describe('wslBash（异步 Promise 版，可注入 spawner）', () => {
  it('成功路径：status 0 → ok:true，stdout 经清洗；args/env 符合 wsl.exe 调用约定', async () => {
    const calls = { spawnArgs: [] as unknown[][], kills: 0 }
    const r = await wslBash('Ubuntu', 'echo hi', 1000, fakeSpawner({ stdout: 'h\0i' }, calls))
    expect(r).toMatchObject({ ok: true, status: 0, stdout: 'hi' })
    const [cmd, args, opts] = calls.spawnArgs[0] as [string, string[], { env: Record<string, string> }]
    expect(cmd).toBe('wsl.exe')
    expect(args).toEqual(['-d', 'Ubuntu', '-e', 'bash', '-c', 'echo hi'])
    expect(opts.env!.WSL_UTF8).toBe('1')
  })

  it('非零退出 → ok:false 且保留 stderr', async () => {
    const r = await wslBash('Ubuntu', 'exit 3', 1000, fakeSpawner({ code: 3, stderr: 'boom' }))
    expect(r.ok).toBe(false)
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('boom')
  })

  it("spawn 'error' 事件 → resolve ok:false（错误并入 stderr），绝不 reject", async () => {
    const r = await wslBash('Ubuntu', 'x', 1000, fakeSpawner({ error: new Error('spawn ENOENT') }))
    expect(r.ok).toBe(false)
    expect(r.status).toBe(-1)
    expect(r.stderr).toContain('spawn ENOENT')
  })

  it('超时到点 kill 子进程并以 ok:false 返回（含超时说明）；迟到的 close 不覆盖结果', async () => {
    vi.useFakeTimers()
    try {
      const calls = { spawnArgs: [] as unknown[][], kills: 0 }
      const p = wslBash('Ubuntu', 'sleep 999', 50, fakeSpawner({ neverClose: true, ignoreKill: true }, calls))
      await vi.advanceTimersByTimeAsync(60)
      expect(calls.kills).toBe(1)
      const r = await p
      expect(r.ok).toBe(false)
      expect(r.status).toBe(-1)
      expect(r.stderr).toContain('超时')
    } finally {
      vi.useRealTimers()
    }
  })

  it('子进程永不退出且 kill 失败 → 仍按超时返回，不悬挂', async () => {
    vi.useFakeTimers()
    try {
      const base = fakeSpawner({ neverClose: true })
      const p = wslBash('Ubuntu', 'hang', 30, (c, a, o) => {
        const child = base(c, a, o)
        child.kill = vi.fn(() => {
          throw new Error('kill failed')
        })
        return child
      })
      await vi.advanceTimersByTimeAsync(40)
      const r = await p
      expect(r.ok).toBe(false)
      expect(r.stderr).toContain('超时')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runCompanion（异步 Promise 版）', () => {
  it('解析 companion --json 输出为 parsed；命令带引号拼接', async () => {
    const calls = { spawnArgs: [] as unknown[][], kills: 0 }
    const r = await runCompanion('Ubuntu', ['scan'], 1000, fakeSpawner({ stdout: 'noise\n{"ok":true,"agents":[]}\n' }, calls))
    expect(r.ok).toBe(true)
    expect(r.parsed).toEqual({ ok: true, agents: [] })
    expect(r.parseError).toBeUndefined()
    const args = calls.spawnArgs[0][1] as string[]
    expect(args[5]).toContain('node /root/skill-vault/bin/skm.mjs scan --json')
  })

  it('无 JSON 输出 → parsed 缺席并给出 parseError', async () => {
    const r = await runCompanion('Ubuntu', ['scan'], 1000, fakeSpawner({ code: 1, stderr: 'wsl: 找不到' }))
    expect(r.ok).toBe(false)
    expect(r.parsed).toBeUndefined()
    expect(r.parseError).toContain('无法从 companion 输出解析 JSON')
  })
})
