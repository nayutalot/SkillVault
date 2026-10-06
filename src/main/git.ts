import { spawnSync } from 'node:child_process'

export type GitResult = { ok: boolean; status: number; stdout: string; stderr: string }

// 中文文件名在默认 core.quotepath=true 下输出为 \346 八进制转义（换新电脑没配全局 gitconfig 必现"乱码"）；
// i18n.logOutputEncoding 保证 log/diff 类输出按 UTF-8。每次调用注入，不依赖用户全局 gitconfig。
const GIT_TEXT_ARGS = ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8'] as const

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
