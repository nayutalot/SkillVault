// exec：版本中心共用的异步子进程执行器（与 wslBridge 同一防御模式：全异步 spawn，绝不用 spawnSync，绝不冻结主进程事件循环）。
// - spawn 'error' 事件（如 ENOENT）不 reject：以 ok:false 结构体返回；
// - 超时到点杀整棵进程树（taskkill /t /f + child.kill 兜底），绝不悬挂；
// - 支持 onLine 增量日志回调（更新 job 的日志窗口）与 cancel（用户取消更新）；
// - npm/kimi/grok 等在 Windows 上可能是 .cmd shim → execCmdLine 统一经 cmd.exe /d /s /c 执行（引号语义可预期）。
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { cleanWslOutput, type Spawner } from '../wslBridge'

export type { Spawner }

export type ExecResult = { ok: boolean; status: number; stdout: string; stderr: string }

export type ExecHandle = { done: Promise<ExecResult>; cancel: () => void }

export type ExecOptions = {
  /** 超时毫秒；到点杀进程树并以 ok:false 返回（stderr 含超时说明） */
  timeoutMs: number
  /** 可注入 spawner（单测用 fake 子进程；默认真实 spawn） */
  spawner?: Spawner
  /** 覆盖环境变量（ProgramFiles / APPDATA 候选解析；测试注入） */
  env?: Record<string, string>
  shell?: boolean
  /** 子进程工作目录（github 通道在 staging 目录内跑 npm install 时使用） */
  cwd?: string
  /** 更新命令使用 detached（可终止、不随父进程退出） */
  detached?: boolean
  /** 每收到一行（stdout/stderr）回调；空行不回调 */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
}

/** 与 wslBridge 一致的可注入 spawn 依赖签名（结构兼容，直接复用） */

export function defaultSpawner(cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess {
  return spawn(cmd, args, opts)
}

/** 杀整棵进程树：taskkill /t /f（cmd shim 场景仅 child.kill 会留下孤儿 npm/node），再 kill 兜底 */
export function killTree(child: ChildProcess, spawner: Spawner = defaultSpawner): void {
  if (child.pid) {
    try {
      spawner('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    } catch {
      /* taskkill 极端缺失时忽略 */
    }
  }
  try {
    child.kill()
  } catch {
    /* 已退出的子进程 kill 报错可忽略 */
  }
}

/** 行切分器：按 \r?\n 切增量输出；close 时 flush 残余半行 */
function makeFeeder(stream: 'stdout' | 'stderr', onLine: ExecOptions['onLine']) {
  let buf = ''
  const emit = (line: string): void => {
    const t = line.trim()
    if (t) onLine?.(t, stream)
  }
  return {
    feed(chunk: string): void {
      if (!onLine) return
      buf += chunk
      const parts = buf.split(/\r?\n/)
      buf = parts.pop() ?? ''
      for (const p of parts) emit(p)
    },
    flush(): void {
      if (!onLine) return
      if (buf.trim()) emit(buf)
      buf = ''
    }
  }
}

/** 异步执行一个命令并收集结果；返回 { done, cancel } 便于更新 job 可取消 */
export function execAsync(cmd: string, args: readonly string[], opts: ExecOptions): ExecHandle {
  const spawner = opts.spawner ?? defaultSpawner
  let cancelled = false
  let child: ChildProcess | null = null
  let timer: NodeJS.Timeout | null = null

  const done = new Promise<ExecResult>((resolve) => {
    let settled = false
    const finish = (r: ExecResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    const decode = (bufs: Buffer[]): string => cleanWslOutput(Buffer.concat(bufs).toString('utf8'))
    // 增量日志用 StringDecoder：chunk 边界切开多字节 UTF-8 序列时逐 chunk 解码会产生 U+FFFD 乱码
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    const feedOut = makeFeeder('stdout', opts.onLine)
    const feedErr = makeFeeder('stderr', opts.onLine)

    try {
      child = spawner(cmd, args, {
        windowsHide: true,
        shell: opts.shell ?? false,
        detached: opts.detached ?? false,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: { ...process.env, ...(opts.env ?? {}) }
      })
    } catch (e) {
      finish({ ok: false, status: -1, stdout: '', stderr: `spawn 失败: ${String(e)}` })
      return
    }

    child.stdout?.on('data', (d: Buffer) => {
      out.push(d)
      feedOut.feed(outDecoder.write(d))
    })
    child.stderr?.on('data', (d: Buffer) => {
      err.push(d)
      feedErr.feed(errDecoder.write(d))
    })
    child.once('error', (e: Error) => {
      finish({ ok: false, status: -1, stdout: decode(out), stderr: `${decode(err)}${String(e)}` })
    })
    child.once('close', (code) => {
      feedOut.flush()
      feedErr.flush()
      finish({
        ok: !cancelled && code === 0,
        status: code ?? -1,
        stdout: decode(out),
        stderr: cancelled ? `${decode(err)}已被用户取消` : decode(err)
      })
    })

    timer = setTimeout(() => {
      if (child) killTree(child, spawner)
      finish({ ok: false, status: -1, stdout: decode(out), stderr: `${decode(err)}超时（${opts.timeoutMs}ms），已终止子进程` })
    }, opts.timeoutMs)
  })

  return {
    done,
    cancel: () => {
      cancelled = true
      if (child) killTree(child, spawner)
    }
  }
}

/**
 * 经 cmd.exe /d /s /c 执行一行命令（.cmd/.bat shim 与 PATH 内命令的统一通道；/s 保证引号剥离语义可预期）。
 * 命令统一加前缀 chcp 65001 >nul &&：中文系统 cmd 的 OEM 代码页（936/GBK）输出按 UTF-8 解码会乱码，
 * 且乱码会掩盖真实错误（如 "'npm' 不是内部或外部命令"）—— 让 cmd 侧先切到 UTF-8 再执行目标命令。
 */
export function execCmdLine(commandLine: string, opts: ExecOptions): ExecHandle {
  return execAsync('cmd.exe', ['/d', '/s', '/c', 'chcp 65001 >nul && ' + commandLine], opts)
}

/**
 * 经 cmd.exe /d /s /c 执行参数数组（chcp 65001 前缀同上）。
 * 绝对路径含空格时必须走本通道而非 execCmdLine：单行字符串里的内嵌引号会被 libuv 转义成 \"，
 * cmd /s 剥掉外层引号后 \" 仍留在命令名里 → cmd 报“不是内部或外部命令”；参数数组由系统按需加纯引号，无此问题。
 */
export function execCmdArgs(args: readonly string[], opts: ExecOptions): ExecHandle {
  return execAsync('cmd.exe', ['/d', '/s', '/c', 'chcp', '65001', '>nul', '&&', ...args], opts)
}
