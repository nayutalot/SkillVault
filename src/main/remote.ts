// 远程目标探测（SSH / Docker）—— 先行框架：真实目标出现前绝不伪造连通状态。
// - probeRemote：ssh 用 BatchMode=yes（绝不挂起等密码）+ ConnectTimeout=5；docker 用 exec node -v。
// - 返回 { ok, detail }，失败原因原样透出；8s 超时 kill，绝不悬挂。
// - spawn 依赖可注入（单测用 fake 子进程），argv 数组传参、绝不经 shell。
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { RemoteTarget } from '../shared/types'

export type ProbeResult = { ok: boolean; detail: string }

/** 可注入的 spawn 依赖（与 wslBridge.Spawner 同形） */
export type RemoteSpawner = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess

function realSpawn(cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess {
  return spawn(cmd, args, opts)
}

export type ProbeDeps = {
  spawner?: RemoteSpawner
  /** 超时毫秒数（默认 8s；测试可缩短） */
  timeoutMs?: number
}

/** 目标字段校验：ssh 需要 host；docker 需要 container。缺配置是合法状态（如实报告，不尝试连接） */
export function targetConfigError(t: RemoteTarget): string | null {
  if (t.kind === 'ssh' && !t.host) return '未配置 host（SSH 主机名/IP），无法探测'
  if (t.kind === 'docker' && !t.container) return '未配置 container（容器名），无法探测'
  return null
}

/** 组装 ssh argv：端口可加 -p；BatchMode 禁止交互式密码提示 */
export function sshArgs(t: RemoteTarget, remoteCmd: string): string[] {
  const args = ['-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes']
  if (t.port && Number.isFinite(t.port)) args.push('-p', String(t.port))
  args.push(t.user ? `${t.user}@${t.host}` : String(t.host), remoteCmd)
  return args
}

/** 一次性子进程执行：收集 stdout/stderr，超时 kill；spawn error 事件并入失败结果 */
function runOnce(
  spawner: RemoteSpawner,
  cmd: string,
  args: readonly string[],
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
    const finish = (r: { ok: boolean; detail: string }): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    const text = (bufs: Buffer[]): string => Buffer.concat(bufs).toString('utf8').trim()

    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.once('error', (e: Error) => {
      finish({ ok: false, detail: `${e instanceof Error ? e.message : String(e)}（命令不可用或启动失败）` })
    })
    child.once('close', (code) => {
      const detail = (text(err) || text(out) || `exit ${code ?? 'null'}`).slice(0, 500)
      finish({ ok: code === 0, detail })
    })
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出的子进程 kill 报错可忽略 */
      }
      finish({ ok: false, detail: `超时（${timeoutMs}ms），已终止子进程` })
    }, timeoutMs)
    child.unref?.()
  })
}

/**
 * 探测远程目标可达性：
 * - ssh: `ssh -o ConnectTimeout=5 -o BatchMode=yes [user@]host echo ok`（退出码 0 即可达）
 * - docker: `docker exec <container> node -v`（stdout 为 node 版本）
 * 未配置必填字段 → { ok:false, detail: 原因 }；探测失败原因原样透出。
 */
export async function probeRemote(t: RemoteTarget, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const cfgErr = targetConfigError(t)
  if (cfgErr) return { ok: false, detail: cfgErr }
  const spawner = deps.spawner ?? realSpawn
  const timeoutMs = deps.timeoutMs ?? 8000
  if (t.kind === 'ssh') {
    const r = await runOnce(spawner, 'ssh', sshArgs(t, 'echo ok'), timeoutMs)
    return r.ok ? { ok: true, detail: r.detail || 'ok' } : { ok: false, detail: r.detail || 'ssh 连接失败' }
  }
  const r = await runOnce(spawner, 'docker', ['exec', String(t.container), 'node', '-v'], timeoutMs)
  return r.ok ? { ok: true, detail: r.detail || 'ok' } : { ok: false, detail: r.detail || 'docker exec 失败' }
}
