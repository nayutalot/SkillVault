// native 通道（kimi/grok）：带「自带更新器」的 CLI。
// 已装版本 = `<bin> --version` 首行原始文本（前缀噪声由 versionCompare 在比较时剥离）；
// 更新 = `<bin> update`（其自带更新器负责探测并更新，用户点按钮即视为同意，UI 文案注明「调用其自带更新器」）。
// bin 实测为 .exe（~/.kimi-code/bin/kimi.exe），但也兼容 .cmd/.bat shim（shim 经 cmd.exe 执行）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execAsync, execCmdLine, type ExecHandle, type ExecOptions, type Spawner } from './exec'

export const NATIVE_CHECK_TIMEOUT_MS = 90_000
export const NATIVE_UPDATE_TIMEOUT_MS = 20 * 60_000

/** 解析自带更新器可执行文件：支持 ~ 开头路径；依次探测无后缀/.exe/.cmd/.bat */
export function resolveNativeBin(binPath: string): string | null {
  const full = binPath.startsWith('~') ? path.join(os.homedir(), binPath.slice(1)) : binPath
  for (const c of [full, `${full}.exe`, `${full}.cmd`, `${full}.bat`]) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    } catch {
      /* 探测失败继续下一个候选 */
    }
  }
  return null
}

function runNative(bin: string, args: string[], opts: ExecOptions): ExecHandle {
  const lower = bin.toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return execCmdLine(`"${bin}" ${args.join(' ')}`, opts)
  }
  return execAsync(bin, args, opts)
}

/** `--version` 首行非空文本（原样返回，比较时再剥离前缀） */
export function firstVersionLine(stdout: string): string | null {
  return (
    String(stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? null
  )
}

export async function nativeInstalledVersion(
  binPath: string,
  deps: { spawner?: Spawner; timeoutMs?: number } = {}
): Promise<{ version?: string; error?: string }> {
  const bin = resolveNativeBin(binPath)
  if (!bin) return { error: `未找到自带更新器可执行文件: ${binPath}` }
  const r = await runNative(bin, ['--version'], {
    timeoutMs: deps.timeoutMs ?? NATIVE_CHECK_TIMEOUT_MS,
    spawner: deps.spawner
  }).done
  const version = firstVersionLine(r.stdout)
  if (version) return { version }
  return { error: `${path.basename(bin)} --version 无版本输出: ${(r.stderr || `退出码 ${r.status}`).slice(0, 200)}` }
}

/** 启动其自带更新器 `<bin> update`（detached 可取消），返回命令展示文本供 job 日志 */
export function nativeUpdateHandle(
  bin: string,
  opts: ExecOptions
): { handle: ExecHandle; commandText: string } {
  const lower = bin.toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const commandText = `"${bin}" update`
    return { handle: execCmdLine(commandText, opts), commandText }
  }
  return { handle: execAsync(bin, ['update'], opts), commandText: `${bin} update` }
}
