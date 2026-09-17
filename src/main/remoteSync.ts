// 基于 git bundle 的远程同步传输抽象（先行框架：真实目标出现时即可用）。
// 流程：本地 `git bundle create <tmp> --all` → transport.writeFile 上传 bundle → 远端 `git -C ~/skill-vault pull <bundle> main`
// → 返回步骤日志。Transport 接口注入（单测用 fake 全覆盖）；真实 ssh/docker transport 仅在配置了目标后可达。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { RemoteTarget } from '../shared/types'
import { git } from './git'
import { sshArgs, type RemoteSpawner } from './remote'

export type RemoteStep = { cmd: string; ok: boolean; detail: string }

export type RemoteSyncResult = { ok: boolean; steps: RemoteStep[] }

/** 传输抽象：writeFile 把本地 bundle 上传到远端（返回远端路径）；execRemote 在远端执行命令 */
export type RemoteTransport = {
  writeFile: (t: RemoteTarget, localFile: string) => Promise<string>
  execRemote: (t: RemoteTarget, cmd: string) => Promise<{ ok: boolean; detail: string }>
}

export const REMOTE_BUNDLE_PATH_SSH = '~/skillvault.bundle'
export const REMOTE_BUNDLE_PATH_DOCKER = '/root/skillvault.bundle'
/** 远端 vault 工作克隆（SSH 主机） */
export const REMOTE_VAULT_DIR = '~/skill-vault'

// ---------- 真实 transport（仅配置目标后由 IPC 调用；测试用 fake 注入，不真跑） ----------

/** 一次性子进程（stdin 可写）；与 remote.runOnce 同风格但需要管道上传时复用 */
function runWithStdin(
  spawner: RemoteSpawner,
  cmd: string,
  args: readonly string[],
  localFile: string,
  timeoutMs: number
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawner(cmd, args, { windowsHide: true })
    } catch (e) {
      resolve({ ok: false, detail: String(e) })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    let timer: NodeJS.Timeout | null = null
    let stream: fs.ReadStream | null = null
    const finish = (r: { ok: boolean; detail: string }): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      // 尽快停掉读流：子进程已退出/被杀时继续 pipe 只会往已关闭的管道写（EPIPE）
      stream?.destroy()
      resolve(r)
    }
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.once('error', (e: Error) => finish({ ok: false, detail: e instanceof Error ? e.message : String(e) }))
    child.once('close', (code) => {
      finish({
        ok: code === 0,
        detail: (Buffer.concat(err).toString('utf8') || Buffer.concat(out).toString('utf8') || `exit ${code ?? 'null'}`).trim().slice(0, 500)
      })
    })
    // 流式上传本地 bundle 到远端 stdin（ssh 'cat > path' 管道），错误时销毁子进程。
    // stdin 的 'error' 必须监听：ssh 提前退出（认证失败/不可达）后流继续写 → EPIPE 无监听会崩掉主进程
    stream = fs.createReadStream(localFile)
    child.stdin?.on('error', (e: Error) => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, detail: `上传管道中断（远端提前退出）: ${e instanceof Error ? e.message : String(e)}` })
    })
    stream.pipe(child.stdin!)
    stream.on('error', (e) => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, detail: `读取本地 bundle 失败: ${String(e)}` })
    })
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, detail: `超时（${timeoutMs}ms），已终止子进程` })
    }, timeoutMs)
    child.unref?.()
  })
}

function plainRun(spawner: RemoteSpawner, cmd: string, args: readonly string[], timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawner(cmd, args, { windowsHide: true })
    } catch (e) {
      resolve({ ok: false, detail: String(e) })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const finish = (r: { ok: boolean; detail: string }): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.once('error', (e: Error) => finish({ ok: false, detail: e instanceof Error ? e.message : String(e) }))
    child.once('close', (code) => {
      finish({
        ok: code === 0,
        detail: (Buffer.concat(err).toString('utf8') || Buffer.concat(out).toString('utf8') || `exit ${code ?? 'null'}`).trim().slice(0, 500)
      })
    })
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, detail: `超时（${timeoutMs}ms），已终止子进程` })
    }, timeoutMs)
    child.unref?.()
  })
}

export type RealTransportDeps = { spawner?: RemoteSpawner; timeoutMs?: number }

/** SSH transport：bundle 经 `ssh ... 'cat > ~/skillvault.bundle'` 管道上传；远端命令经 ssh 执行 */
export function sshTransport(deps: RealTransportDeps = {}): RemoteTransport {
  const spawner = deps.spawner ?? ((cmd, args, opts: SpawnOptions) => spawn(cmd, args, opts))
  const timeoutMs = deps.timeoutMs ?? 120000
  return {
    writeFile: async (t, localFile) => {
      const args = sshArgs(t, `cat > ${REMOTE_BUNDLE_PATH_SSH}`)
      const r = await runWithStdin(spawner, 'ssh', args, localFile, timeoutMs)
      if (!r.ok) throw new Error(`bundle 上传失败: ${r.detail}`)
      return REMOTE_BUNDLE_PATH_SSH
    },
    execRemote: async (t, cmd) => plainRun(spawner, 'ssh', sshArgs(t, cmd), timeoutMs)
  }
}

/** Docker transport：bundle 经 `docker cp` 拷入容器；远端命令经 `docker exec <c> sh -c` 执行 */
export function dockerTransport(deps: RealTransportDeps = {}): RemoteTransport {
  const spawner = deps.spawner ?? ((cmd, args, opts: SpawnOptions) => spawn(cmd, args, opts))
  const timeoutMs = deps.timeoutMs ?? 120000
  return {
    writeFile: async (t, localFile) => {
      const r = await plainRun(spawner, 'docker', ['cp', localFile, `${String(t.container)}:${REMOTE_BUNDLE_PATH_DOCKER}`], timeoutMs)
      if (!r.ok) throw new Error(`bundle 拷入容器失败: ${r.detail}`)
      return REMOTE_BUNDLE_PATH_DOCKER
    },
    execRemote: async (t, cmd) => plainRun(spawner, 'docker', ['exec', String(t.container), 'sh', '-c', cmd], timeoutMs)
  }
}

/** 由目标类型选择真实 transport */
export function transportFor(t: RemoteTarget, deps?: RealTransportDeps): RemoteTransport {
  return t.kind === 'ssh' ? sshTransport(deps) : dockerTransport(deps)
}

// ---------- 编排（transport 注入；单测 fake 全覆盖） ----------

export type SyncToRemoteDeps = {
  /** 本地 git 命令执行（默认 git.ts 的同步实现；测试可不注入用真实 tmp 仓库） */
  gitFn?: (cwd: string, args: string[]) => { ok: boolean; stdout: string; stderr: string }
  /** bundle 临时目录（默认 os.tmpdir()；测试可注入固定目录） */
  tmpDir?: string
}

/**
 * 把 vault 当前状态同步到远端（git bundle 单向传输，绝不 force、绝不删远端历史）：
 * 1) git bundle create <tmp> --all   2) transport.writeFile 上传   3) 远端 git -C ~/skill-vault pull <bundle> main
 * 返回逐仓步骤日志；任一步失败即停，失败原因原样透出（不存在「假成功」）。
 */
export async function syncToRemote(
  t: RemoteTarget,
  vaultPath: string,
  transport: RemoteTransport,
  deps: SyncToRemoteDeps = {}
): Promise<RemoteSyncResult> {
  const gitFn = deps.gitFn ?? git
  const steps: RemoteStep[] = []
  // 自建临时目录要在 finally 整体回收（只删 bundle 文件会每次在 %TEMP% 残留一个空目录壳）
  const ownsTmpDir = !deps.tmpDir
  const tmpDir = deps.tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'skm-bundle-'))
  const bundle = path.join(tmpDir, 'skillvault.bundle')
  try {
    // 1) 本地 bundle（--all 含全部分支/标签）
    const r = gitFn(vaultPath, ['bundle', 'create', bundle, '--all'])
    steps.push({
      cmd: `git bundle create ${bundle} --all`,
      ok: r.ok,
      detail: (r.stderr || r.stdout || '').trim().slice(-600)
    })
    if (!r.ok) return { ok: false, steps }

    // 2) 上传 bundle
    let remotePath = ''
    try {
      remotePath = await transport.writeFile(t, bundle)
      steps.push({ cmd: `transport.writeFile → ${remotePath}`, ok: true, detail: `${fs.statSync(bundle).size} bytes` })
    } catch (e) {
      steps.push({ cmd: 'transport.writeFile', ok: false, detail: e instanceof Error ? e.message : String(e) })
      return { ok: false, steps }
    }

    // 3) 远端 pull（ssh 与 docker 的远端 vault 均约定为 ~/skill-vault；docker exec 走 sh -c，~ 由远端 shell 展开）
    const pull = `git -C ${REMOTE_VAULT_DIR} pull ${remotePath} main`
    const pr = await transport.execRemote(t, pull)
    steps.push({ cmd: pull, ok: pr.ok, detail: pr.detail })
    return { ok: pr.ok, steps }
  } finally {
    try {
      fs.rmSync(bundle, { force: true })
    } catch {
      /* 临时 bundle 清理失败可忽略 */
    }
    if (ownsTmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* 目录回收失败可忽略 */
      }
    }
  }
}
