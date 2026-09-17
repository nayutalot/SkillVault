// wslBridge：从 Windows 侧调用 WSL companion CLI（node /root/skill-vault/bin/skm.mjs ... --json）
// 防御性处理：UTF-16 空字节、BOM、wsl.exe 自身的告警文本（stderr 或混入 stdout 的非 JSON 行）
// 全异步（spawn 而非 spawnSync）：WSL 冷启动可达数秒～数十秒，绝不能冻结主进程事件循环。
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { WSL_VAULT } from '../shared/paths'

export type WslRaw = { ok: boolean; status: number; stdout: string; stderr: string }

export type WslResult = WslRaw & { parsed?: unknown; parseError?: string }

/** 可注入的 spawn 依赖（单测用 fake 子进程；默认真实 spawn） */
export type Spawner = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess

function realSpawn(cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess {
  return spawn(cmd, args, opts)
}

/** 去掉 UTF-16 空字节与 BOM */
export function cleanWslOutput(s: string): string {
  return String(s ?? '')
    .replace(/\0/g, '')
    .replace(/^\uFEFF/, '')
}

/** 从可能带告警噪声的输出中提取第一个完整 JSON 对象 */
export function extractJson<T = unknown>(text: string): T | null {
  const clean = cleanWslOutput(text)
  const start = clean.indexOf('{')
  if (start < 0) return null
  const end = clean.lastIndexOf('}')
  if (end <= start) return null
  try {
    return JSON.parse(clean.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

/**
 * 异步执行 `wsl.exe -d <distro> -e bash -c <command>`。
 * - 输出经 cleanWslOutput 清洗；WSL_UTF8=1 与同步版保持一致。
 * - spawn 'error' 事件（如 ENOENT）不 reject，与 spawnSync 语义对齐：以 ok:false 结构返回（错误信息并入 stderr）。
 * - 超时到点 kill 子进程并以 ok:false 结构返回（含超时说明），绝不悬挂、绝不阻塞事件循环。
 */
export function wslBash(distro: string, command: string, timeoutMs = 120000, spawner: Spawner = realSpawn): Promise<WslRaw> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawner(
        'wsl.exe',
        ['-d', distro, '-e', 'bash', '-c', command],
        { windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } }
      )
    } catch (e) {
      resolve({ ok: false, status: -1, stdout: '', stderr: String(e) })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (r: WslRaw): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }

    const decode = (bufs: Buffer[]): string => cleanWslOutput(Buffer.concat(bufs).toString('utf8'))

    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))

    child.once('error', (e: Error) => {
      finish({ ok: false, status: -1, stdout: decode(out), stderr: decode(err) + String(e) })
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
        stderr: `${decode(err)}wsl.exe 超时（${timeoutMs}ms），已终止子进程`
      })
    }, timeoutMs)

    child.unref?.()
  })
}

function shellQuote(a: string): string {
  return /^[\w./=:-]+$/.test(a) ? a : `'` + a.replace(/'/g, `'\\''`) + `'`
}

/** 调用 companion 子命令并解析 --json 输出（异步；spawner 可注入便于单测） */
export async function runCompanion(
  distro: string,
  args: string[],
  timeoutMs = 120000,
  spawner: Spawner = realSpawn
): Promise<WslResult> {
  const quoted = args.map(shellQuote).join(' ')
  const cmd = `node ${WSL_VAULT}/bin/skm.mjs ${quoted} --json`.trim()
  const r = await wslBash(distro, cmd, timeoutMs, spawner)
  const parsed = extractJson(r.stdout)
  return {
    ...r,
    parsed: parsed ?? undefined,
    parseError: parsed ? undefined : `无法从 companion 输出解析 JSON: ${(r.stdout || r.stderr).slice(0, 300)}`
  }
}
