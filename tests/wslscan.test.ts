// runWslScan：两阶段扫描第二阶段——companion 成功写缓存 / 失败与超时回落缓存（fake spawner + 真实 tmp 文件）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { readWslScanCache, runWslScan, SCAN_WSL_TIMEOUT_MS, writeWslScanCache } from '../src/main/wslScan'
import type { Spawner } from '../src/main/wslBridge'
import type { AppSettings, WslScanPayload } from '../src/shared/types'

const SETTINGS: AppSettings = {
  vaultPath: 'C:\\v',
  barePath: 'C:\\v.git',
  wslDistro: 'Ubuntu',
  deepseekHarnessRoot: 'D:\Apps\deepseek-harness',
  remoteTargets: []
}

type FakeSpec = {
  stdout?: string
  stderr?: string
  code?: number
  ignoreKill?: boolean
}

function fakeSpawner(spec: FakeSpec): Spawner {
  return (cmd: string, args: readonly string[], _opts: SpawnOptions): ChildProcess => {
    void cmd
    void args
    const child = new EventEmitter() as unknown as ChildProcess
    child.stdout = new EventEmitter() as unknown as ChildProcess['stdout']
    child.stderr = new EventEmitter() as unknown as ChildProcess['stderr']
    child.kill = vi.fn(() => {
      if (spec.ignoreKill) return true
      queueMicrotask(() => child.emit('close', null))
      return true
    })
    child.unref = vi.fn()
    queueMicrotask(() => {
      if (spec.stdout !== undefined) child.stdout!.emit('data', Buffer.from(spec.stdout))
      if (spec.stderr !== undefined) child.stderr!.emit('data', Buffer.from(spec.stderr))
      child.emit('close', spec.code ?? 0)
    })
    return child
  }
}

/** 永不退出的 fake 子进程（配合极短 timeoutMs 验证真实超时降级路径） */
function hangingSpawner(): Spawner {
  return (cmd: string, args: readonly string[], _opts: SpawnOptions): ChildProcess => {
    void cmd
    void args
    const child = new EventEmitter() as unknown as ChildProcess
    child.stdout = new EventEmitter() as unknown as ChildProcess['stdout']
    child.stderr = new EventEmitter() as unknown as ChildProcess['stderr']
    child.kill = vi.fn(() => true)
    child.unref = vi.fn()
    return child
  }
}

const OK_PAYLOAD = { ok: true, agents: [{ name: 'zcode-wsl', platform: 'linux', skillsDir: '/root/.zcode/skills', links: { a: 'linked' } }], skills: [{ name: 'a', hasSkillMd: true, description: '来自 WSL' }] }

function tmpCacheFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skm-wslscan-')), 'wsl-scan-cache.json')
}

const CACHED: WslScanPayload = { ts: 1700000000000, agents: [{ name: 'zcode-wsl', platform: 'linux', skillsDir: '/root/.zcode/skills', links: {} }], skills: [{ name: 'a', hasSkillMd: true, description: '缓存描述' }] }

describe('wsl-scan-cache 读写（tmp 文件）', () => {
  it('write → read 往返一致', () => {
    const f = tmpCacheFile()
    writeWslScanCache(f, CACHED)
    expect(readWslScanCache(f)).toEqual(CACHED)
  })

  it('文件不存在 / 损坏 JSON / 形状不符 → null（按无缓存处理）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-wslscan-'))
    expect(readWslScanCache(path.join(dir, 'absent.json'))).toBeNull()
    const corrupt = path.join(dir, 'corrupt.json')
    fs.writeFileSync(corrupt, '{not json', 'utf8')
    expect(readWslScanCache(corrupt)).toBeNull()
    const bad = path.join(dir, 'bad.json')
    fs.writeFileSync(bad, '{"ts":"no","agents":{}}', 'utf8')
    expect(readWslScanCache(bad)).toBeNull()
  })
})

describe('runWslScan（两阶段扫描第二阶段）', () => {
  it('companion 成功 → stale:false，且负载写入缓存文件（ts 用注入的 now）', async () => {
    const f = tmpCacheFile()
    const r = await runWslScan(SETTINGS, { spawner: fakeSpawner({ stdout: `junk ${JSON.stringify(OK_PAYLOAD)}` }), cacheFile: f, now: () => 1234567890 })
    expect(r.stale).toBe(false)
    expect(r.reason).toBeUndefined()
    expect(r.report).toEqual({ ts: 1234567890, agents: OK_PAYLOAD.agents, skills: OK_PAYLOAD.skills })
    expect(readWslScanCache(f)).toEqual(r.report)
  })

  it('companion 失败 + 缓存命中 → 返回缓存 payload 且 stale:true、携带 reason', async () => {
    const f = tmpCacheFile()
    writeWslScanCache(f, CACHED)
    const r = await runWslScan(SETTINGS, { spawner: fakeSpawner({ code: 1, stderr: 'wsl 不可用' }), cacheFile: f })
    expect(r.stale).toBe(true)
    expect(r.report).toEqual(CACHED)
    expect(r.reason).toContain('WSL companion 不可达')
  })

  it('companion 失败 + 无缓存 → report:null、stale:false（UI 走「不可达 + 重试」分支）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-wslscan-'))
    const r = await runWslScan(SETTINGS, {
      spawner: fakeSpawner({ code: 1, stderr: 'wsl 不可用' }),
      cacheFile: path.join(dir, 'absent.json')
    })
    expect(r).toMatchObject({ report: null, stale: false })
    expect(r.reason).toContain('WSL companion 不可达')
  })

  it('真实超时路径（短超时 + 永不退出的子进程）→ 超时后回落缓存 stale:true', async () => {
    const f = tmpCacheFile()
    writeWslScanCache(f, CACHED)
    const r = await runWslScan(SETTINGS, { spawner: hangingSpawner(), cacheFile: f, timeoutMs: 30 })
    expect(r.stale).toBe(true)
    expect(r.report).toEqual(CACHED)
    expect(r.reason).toContain('超时')
  })

  it('companion ok:false（JSON 合法但未成功）→ 走失败降级路径', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-wslscan-'))
    const r = await runWslScan(SETTINGS, {
      spawner: fakeSpawner({ stdout: '{"ok":false,"error":"vault missing"}' }),
      cacheFile: path.join(dir, 'absent.json')
    })
    expect(r.report).toBeNull()
    expect(r.stale).toBe(false)
  })

  it('不注入 cacheFile → 成功也不写盘、失败也不读盘', async () => {
    const ok = await runWslScan(SETTINGS, { spawner: fakeSpawner({ stdout: JSON.stringify(OK_PAYLOAD) }) })
    expect(ok.stale).toBe(false)
    expect(ok.report).not.toBeNull()
    const bad = await runWslScan(SETTINGS, { spawner: fakeSpawner({ code: 1, stderr: 'x' }) })
    expect(bad.report).toBeNull()
  })

  it('生产默认超时为 20s', () => {
    expect(SCAN_WSL_TIMEOUT_MS).toBe(20000)
  })
})
