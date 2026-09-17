import { spawnSync } from 'node:child_process'

export type GitResult = { ok: boolean; status: number; stdout: string; stderr: string }

/** 在 cwd 下执行 git 子命令（不涉及任何网络抓取；push/pull 仅指向本地裸仓 origin） */
export function git(cwd: string, args: string[], timeoutMs = 120000): GitResult {
  const r = spawnSync('git', args, {
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
