import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'

export type GitResult = { ok: boolean; status: number; stdout: string; stderr: string }

// 中文文件名在默认 core.quotepath=true 下输出为 \346 八进制转义（换新电脑没配全局 gitconfig 必现"乱码"）；
// i18n.logOutputEncoding 保证 log/diff 类输出按 UTF-8。每次调用注入，不依赖用户全局 gitconfig。
const GIT_TEXT_ARGS = ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8'] as const

/**
 * 可注入的 spawn 依赖（单测用 fake 子进程；默认真实 spawn）。
 * 结构与 wslBridge.ts 的 Spawner 完全一致，因此两处可共用同一个 fake spawner。
 */
export type GitSpawner = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess

function realSpawn(cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess {
  return spawn(cmd, args, opts)
}

/** 在 cwd 下执行 git 子命令（不涉及任何网络抓取；push/pull 仅指向本地裸仓 origin） */
// spawnSyncFn 仅为单测注入 fake 用（依赖注入便于单测，同 wslBridge 的 Spawner 惯例），生产调用方无需关心。
export function git(cwd: string, args: string[], timeoutMs = 120000, spawnSyncFn: typeof spawnSync = spawnSync): GitResult {
  const r = spawnSyncFn('git', [...GIT_TEXT_ARGS, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
  })
  if (r.error) {
    return { ok: false, status: -1, stdout: r.stdout ?? '', stderr: String(r.error) }
  }
  return {
    ok: r.status === 0,
    status: r.status ?? -1,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString()
  }
}

/**
 * 异步执行 git 子命令（spawn 而非 spawnSync）。
 *
 * WHY：spawnSync 会独占主进程事件循环 —— 一次慢 git（大仓库 / 冷盘 / 推远端）足以让整个 Electron
 *   主进程卡死，窗口无响应、菜单点不动。wslBridge.ts 早已为此改用 spawn，这里同款处理。
 * 语义与同步版保持一致（同样的文本参数注入、同样的 env、同样的默认超时、同样的返回结构），
 * 便于调用方逐个替换而不改行为。
 *
 * - 'error' 事件（如 git 不在 PATH）：不 reject，以 ok:false 结构返回（错误信息并入 stderr）。
 * - 超时：kill 子进程并以 ok:false 结构返回（含超时说明），绝不悬挂、绝不阻塞事件循环。
 * - settled 守卫：超时/error 之后的迟到 'close' 不得覆盖已经确定的结果。
 * - spawner 可注入：单测不需要真实 git 二进制（同 wslBridge 的 Spawner 惯例）。
 */
export function gitAsync(
  cwd: string,
  args: string[],
  timeoutMs = 120000,
  spawner: GitSpawner = realSpawn
): Promise<GitResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawner('git', [...GIT_TEXT_ARGS, ...args], {
        cwd,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
      })
    } catch (e) {
      resolve({ ok: false, status: -1, stdout: '', stderr: String(e) })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (r: GitResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }

    const decode = (bufs: Buffer[]): string => Buffer.concat(bufs).toString('utf8')

    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))

    child.once('error', (e: Error) => {
      finish({ ok: false, status: -1, stdout: decode(out), stderr: String(e) })
    })

    child.once('close', (code) => {
      const stdout = decode(out)
      const stderr = decode(err)
      finish({ ok: code === 0, status: code ?? -1, stdout, stderr })
    })

    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出的子进程 kill 报错可忽略 */
      }
      finish({
        ok: false,
        status: -1,
        stdout: decode(out),
        stderr: `${decode(err)}git 超时（${timeoutMs}ms），已终止子进程`
      })
    }, timeoutMs)

    child.unref?.()
  })
}
