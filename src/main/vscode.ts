// VS Code 可执行文件解析与启动（安全边界）。
// - resolveVsCode：候选路径直查 → where.exe 定位 bin 上级 → null（由调用方走 shell.openPath 兜底）
// - launchVsCode：spawn(ResolvedExe, [filePath], { detached, stdio:'ignore', env 清洗 }).unref()，args 数组传参、绝不经 shell；
//   异步等待 'error' 事件并把失败原因传回调用方（shell.openPath 兜底 + UI 透出），不再静默吞错
// 解析核心（resolveVsCodeFrom）依赖可注入，vitest 无头覆盖，不真调 where.exe / 不真读盘。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'

/** 候选路径（按序直查）。覆盖本机非标准安装位与官方默认位。 */
export function vscodeCandidates(): string[] {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Public', 'AppData', 'Local')
  return [
    'D:\\Apps\\Microsoft VS Code\\Code.exe',
    path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe'
  ]
}

export type VscodeIo = {
  exists: (p: string) => boolean
  /** where.exe 等价物：返回非空输出行；命令失败返回 null */
  where: (name: string) => string[] | null
}

/**
 * 解析核心：候选路径按序直查；都缺席时依次 `where code.cmd` → `where code`，
 * 由输出的 bin 目录（…\bin\code.cmd）取上级安装根下的 Code.exe。全失败返回 null。
 */
export function resolveVsCodeFrom(candidates: readonly string[], io: VscodeIo): string | null {
  for (const c of candidates) {
    if (c && io.exists(c)) return c
  }
  for (const cmd of ['code.cmd', 'code']) {
    const lines = io.where(cmd)
    if (!lines || !lines.length) continue
    for (const raw of lines) {
      const binDir = path.dirname(path.normalize(raw.trim()))
      const exe = path.join(path.dirname(binDir), 'Code.exe')
      if (io.exists(exe)) return exe
    }
  }
  return null
}

/** 真实解析：fs 存在性检查 + where.exe（失败/无输出视为未命中） */
export function resolveVsCode(): string | null {
  return resolveVsCodeFrom(vscodeCandidates(), {
    exists: (p) => {
      try {
        return fs.existsSync(p)
      } catch {
        return false
      }
    },
    where: (name) => {
      try {
        const r = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
        if (r.status !== 0 || !r.stdout) return null
        return r.stdout.split(/\r?\n/).filter((l) => l.trim())
      } catch {
        return null
      }
    }
  })
}

export type LaunchDeps = {
  spawn: (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess
  /** 判定「启动成功」的等待窗口（默认 2500ms）；可注入便于测试 */
  confirmDelayMs?: number
}

/**
 * 子进程 env 清洗：剔除会把 Code.exe（Electron 应用）变成无界面 Node 进程的继承变量。
 * 应用从某些终端/Agent 环境启动时会继承 ELECTRON_RUN_AS_NODE=1，子进程继承后静默退出（表现为「点了没反应」）。
 */
export function cleanLaunchEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env }
  delete clean.ELECTRON_RUN_AS_NODE
  delete clean.ELECTRON_NO_ATTACH_CONSOLE
  return clean
}

/**
 * 用解析到的 exe 直接打开文件：args 数组传参、绝不经 shell；
 * detached + stdio ignore + unref（进程交还系统），并传入清洗后的 env。
 * 返回 Promise：窗口期内 spawn 'error' 事件 → { ok:false, error }；2.5s（可注入）无 error → { ok:true }。
 */
export function launchVsCode(
  deps: LaunchDeps,
  exe: string,
  filePath: string
): Promise<{ ok: boolean; error?: string }> {
  const child = deps.spawn(exe, [filePath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: cleanLaunchEnv()
  })
  child.unref()
  return new Promise((resolve) => {
    let settled = false
    const done = (r: { ok: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      resolve(r)
    }
    child.once('error', (e: Error) => {
      // 未找到 exe / 启动失败：不再静默吞掉，交由调用方兜底（shell.openPath）并向 UI 透出原因
      done({ ok: false, error: e instanceof Error ? e.message : String(e) })
    })
    setTimeout(() => done({ ok: true }), deps.confirmDelayMs ?? 2500)
  })
}
