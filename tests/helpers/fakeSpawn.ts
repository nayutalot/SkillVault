// 测试共用 fake spawner：与 wslbridge.test.ts 同款模式抽出复用。
// 子进程按 spec 异步发数据；记录调用参数与 kill 次数，供 argv 断言。
import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { vi } from 'vitest'
import type { Spawner } from '../../src/main/wslBridge'

export type FakeSpec = {
  stdout?: string
  stderr?: string
  code?: number | null
  error?: Error
  closeDelayMs?: number
  /** 永不发 close（模拟卡死，只能靠超时兜底） */
  neverClose?: boolean
  /** kill 后仍不退出（配合 neverClose 验证超时路径） */
  ignoreKill?: boolean
}

export type FakeCalls = { spawnArgs: unknown[][]; kills: number }

/** 构造可注入的 fake spawner（execAsync / wslBash / startEngine 通吃） */
export function fakeSpawner(spec: FakeSpec = {}, calls: FakeCalls = { spawnArgs: [], kills: 0 }): Spawner {
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

/** 按「第 N 次调用的命令」做多个 spec 的 fake spawner（dockerContainers 等 ps+stats 两次调用场景用） */
export function seqSpawner(specs: FakeSpec[], calls: FakeCalls = { spawnArgs: [], kills: 0 }): Spawner {
  let i = 0
  return (cmd, args, opts) => {
    const spec = specs[Math.min(i, specs.length - 1)]
    i++
    return fakeSpawner(spec, calls)(cmd, args, opts)
  }
}
