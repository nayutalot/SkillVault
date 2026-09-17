// 远程目标探测与 bundle 同步（fake spawner / fake transport，无网络、无 docker）
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { probeRemote, sshArgs, targetConfigError } from '../src/main/remote'
import {
  dockerTransport,
  REMOTE_VAULT_DIR,
  sshTransport,
  syncToRemote,
  type RemoteTransport
} from '../src/main/remoteSync'
import { git } from '../src/main/git'
import type { RemoteTarget } from '../src/shared/types'

const SSH_TARGET: RemoteTarget = { id: 't1', kind: 'ssh', label: 'box', enabled: true, host: '10.0.0.8', user: 'root', port: 2222 }
const DOCKER_TARGET: RemoteTarget = { id: 't2', kind: 'docker', label: 'ctr', enabled: true, container: 'dev-container' }

type FakeSpec = { stdout?: string; stderr?: string; code?: number; error?: Error; hang?: boolean }
type Recorded = { cmd: string; args: string[] }[]

function fakeSpawner(spec: FakeSpec, calls: Recorded): (cmd: string, args: readonly string[], _o: SpawnOptions) => ChildProcess {
  return (cmd, args, _opts) => {
    calls.push({ cmd, args: [...args] })
    const child = new EventEmitter() as unknown as ChildProcess
    child.stdout = new EventEmitter() as unknown as ChildProcess['stdout']
    child.stderr = new EventEmitter() as unknown as ChildProcess['stderr']
    child.stdin = new EventEmitter() as unknown as ChildProcess['stdin']
    // 让 pipe() 不抛错：stdin 需要可写端的最小形态
    ;(child.stdin as unknown as { write: unknown; end: unknown }).write = vi.fn()
    ;(child.stdin as unknown as { write: unknown; end: unknown }).end = vi.fn()
    child.kill = vi.fn(() => true)
    child.unref = vi.fn()
    queueMicrotask(() => {
      if (spec.hang) return
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

describe('targetConfigError / sshArgs', () => {
  it('ssh 缺 host、docker 缺 container 都报告未配置（合法状态，不尝试连接）', () => {
    expect(targetConfigError({ id: 'x', kind: 'ssh', label: 'a', enabled: true })).toContain('host')
    expect(targetConfigError({ id: 'x', kind: 'docker', label: 'a', enabled: true })).toContain('container')
    expect(targetConfigError(SSH_TARGET)).toBeNull()
    expect(targetConfigError(DOCKER_TARGET)).toBeNull()
  })

  it('sshArgs：ConnectTimeout=5 + BatchMode=yes + 可选 -p + user@host + 远端命令', () => {
    expect(sshArgs(SSH_TARGET, 'echo ok')).toEqual([
      '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', '-p', '2222', 'root@10.0.0.8', 'echo ok'
    ])
    // 无 user / 无 port 的形态
    expect(sshArgs({ id: 'x', kind: 'ssh', label: 'a', enabled: true, host: 'h' }, 'cmd')).toEqual([
      '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', 'h', 'cmd'
    ])
  })
})

describe('probeRemote（fake spawner，无网络）', () => {
  it('ssh 成功：命令构造正确，ok:true', async () => {
    const calls: Recorded = []
    const r = await probeRemote(SSH_TARGET, { spawner: fakeSpawner({ stdout: 'ok\n' }, calls), timeoutMs: 500 })
    expect(r.ok).toBe(true)
    expect(calls[0].cmd).toBe('ssh')
    expect(calls[0].args).toEqual(sshArgs(SSH_TARGET, 'echo ok'))
  })

  it('ssh 失败（非零退出 + stderr）→ ok:false 且原因透出', async () => {
    const calls: Recorded = []
    const r = await probeRemote(SSH_TARGET, {
      spawner: fakeSpawner({ code: 255, stderr: 'Permission denied (publickey)' }, calls),
      timeoutMs: 500
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('Permission denied')
  })

  it('docker 成功：docker exec <container> node -v，stdout 为版本号', async () => {
    const calls: Recorded = []
    const r = await probeRemote(DOCKER_TARGET, { spawner: fakeSpawner({ stdout: 'v20.11.0\n' }, calls), timeoutMs: 500 })
    expect(r.ok).toBe(true)
    expect(r.detail).toBe('v20.11.0')
    expect(calls[0].cmd).toBe('docker')
    expect(calls[0].args).toEqual(['exec', 'dev-container', 'node', '-v'])
  })

  it('spawn error 事件（命令不存在）→ ok:false 且原因透出', async () => {
    const r = await probeRemote(DOCKER_TARGET, {
      spawner: fakeSpawner({ error: new Error('spawn docker ENOENT') }, []),
      timeoutMs: 500
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('ENOENT')
  })

  it('真实超时路径（hang + 极短超时）→ ok:false 且带超时说明', async () => {
    const r = await probeRemote(SSH_TARGET, { spawner: fakeSpawner({ hang: true }, []), timeoutMs: 30 })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('超时')
  })

  it('未配置字段 → 直接返回未配置说明，不 spawn（calls 为空）', async () => {
    const calls: Recorded = []
    const r = await probeRemote({ id: 'x', kind: 'ssh', label: 'a', enabled: true }, { spawner: fakeSpawner({}, calls), timeoutMs: 500 })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('host')
    expect(calls).toHaveLength(0)
  })
})

// ---------- syncToRemote：真实 tmp git 仓库 + fake transport ----------

function initTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-remote-test-'))
  expect(git(dir, ['init', '-b', 'main']).ok).toBe(true)
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n', 'utf8')
  expect(git(dir, ['add', '-A']).ok).toBe(true)
  expect(git(dir, ['commit', '-m', 'init']).ok).toBe(true)
  return dir
}

describe('syncToRemote（fake transport 全覆盖）', () => {
  it('成功路径：bundle 真实生成（transport 收到存在的本地文件）→ 上传 → 远端 pull 命令正确', async () => {
    const repo = initTmpRepo()
    const seen: { exists: boolean; size: number }[] = []
    const transport: RemoteTransport = {
      writeFile: async (_t, localFile) => {
        seen.push({ exists: fs.existsSync(localFile), size: fs.statSync(localFile).size })
        return '~/skillvault.bundle'
      },
      execRemote: async (_t, cmd) => ({ ok: true, detail: cmd })
    }
    const r = await syncToRemote(SSH_TARGET, repo, transport)
    expect(r.ok).toBe(true)
    expect(r.steps).toHaveLength(3)
    expect(r.steps[0].ok).toBe(true)
    expect(r.steps[0].cmd).toContain('git bundle create')
    expect(seen[0].exists).toBe(true)
    expect(seen[0].size).toBeGreaterThan(0)
    expect(r.steps[1].ok).toBe(true)
    expect(r.steps[1].cmd).toContain('transport.writeFile')
    expect(r.steps[2].cmd).toBe(`git -C ${REMOTE_VAULT_DIR} pull ~/skillvault.bundle main`)
    expect(r.steps[2].ok).toBe(true)
  })

  it('bundle 创建失败（非 git 目录）→ ok:false，步骤停在第一步，不调用 transport', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-remote-empty-'))
    const calls: { op: string }[] = []
    const transport: RemoteTransport = {
      writeFile: async () => {
        calls.push({ op: 'write' })
        return 'x'
      },
      execRemote: async () => {
        calls.push({ op: 'exec' })
        return { ok: true, detail: '' }
      }
    }
    const r = await syncToRemote(SSH_TARGET, empty, transport)
    expect(r.ok).toBe(false)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('上传失败 → ok:false，步骤含失败原因，不再执行远端 pull', async () => {
    const repo = initTmpRepo()
    const transport: RemoteTransport = {
      writeFile: async () => {
        throw new Error('network unreachable')
      },
      execRemote: async () => ({ ok: true, detail: '' })
    }
    const r = await syncToRemote(SSH_TARGET, repo, transport)
    expect(r.ok).toBe(false)
    expect(r.steps).toHaveLength(2)
    expect(r.steps[1].ok).toBe(false)
    expect(r.steps[1].detail).toContain('network unreachable')
  })

  it('远端 pull 失败（远端无克隆等）→ 如实 ok:false，绝不伪造成功', async () => {
    const repo = initTmpRepo()
    const transport: RemoteTransport = {
      writeFile: async () => '~/skillvault.bundle',
      execRemote: async (_t, cmd) => ({ ok: false, detail: `fatal: ${cmd} not a repository` })
    }
    const r = await syncToRemote(SSH_TARGET, repo, transport)
    expect(r.ok).toBe(false)
    expect(r.steps).toHaveLength(3)
    expect(r.steps[2].ok).toBe(false)
    expect(r.steps[2].detail).toContain('not a repository')
  })

  it('真实 sshTransport/dockerTransport 构造：writeFile 失败（非零退出）抛错且信息透出（fake spawner）', async () => {
    const bundle = path.join(os.tmpdir(), `skm-remote-bundle-${process.pid}.tmp`)
    fs.writeFileSync(bundle, 'bundle-bytes\n', 'utf8')
    try {
      const calls: Recorded = []
      const ssh = sshTransport({ spawner: fakeSpawner({ code: 1, stderr: 'ssh: connect refused' }, calls), timeoutMs: 2000 })
      await expect(ssh.writeFile(SSH_TARGET, bundle)).rejects.toThrow(/bundle 上传失败/)
      expect(calls[0].cmd).toBe('ssh')
      expect(calls[0].args[calls[0].args.length - 1]).toBe('cat > ~/skillvault.bundle')

      const calls2: Recorded = []
      const docker = dockerTransport({ spawner: fakeSpawner({ code: 125, stderr: 'No such container' }, calls2), timeoutMs: 2000 })
      await expect(docker.writeFile(DOCKER_TARGET, bundle)).rejects.toThrow(/拷入容器失败/)
      expect(calls2[0].cmd).toBe('docker')
      expect(calls2[0].args[0]).toBe('cp')
      expect(calls2[0].args[2]).toBe('dev-container:/root/skillvault.bundle')
    } finally {
      fs.rmSync(bundle, { force: true })
    }
  })
})
