// git() 文本参数注入：每次调用向 git 注入 core.quotepath=false 与 i18n.logOutputEncoding=UTF-8，
// 防止中文系统默认 gitconfig 下中文文件名输出为 \346 八进制转义（同步冲突清单/日志乱码）。
// fake spawnSync 注入，不真调 git（依赖注入便于单测，同 wslbridge.test.ts 风格）。
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { git } from '../src/main/git'

type CapturedOpts = {
  cwd: string
  encoding: string
  timeout: number
  windowsHide: boolean
  env: Record<string, string | undefined>
}
type Captured = { cmd: string; args: string[]; opts: CapturedOpts }

/** 注入 fake spawnSync：捕获调用参数并返回成功结果 */
function fakeSpawnSync(calls: Captured[]): typeof spawnSync {
  const fn = (cmd: string, args: string[], opts: CapturedOpts): unknown => {
    calls.push({ cmd, args: [...args], opts })
    return { status: 0, stdout: '', stderr: '', error: undefined }
  }
  return fn as unknown as typeof spawnSync
}

describe('git() 注入文本参数（core.quotepath / i18n.logOutputEncoding）', () => {
  it('args 以两个 -c 配置开头，用户 args 完整跟在后面', () => {
    const calls: Captured[] = []
    const r = git('C:\\vault', ['status', '--porcelain'], 1000, fakeSpawnSync(calls))
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    const { cmd, args, opts } = calls[0]
    expect(cmd).toBe('git')
    expect(args.slice(0, 4)).toEqual(['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8'])
    expect(args.slice(4)).toEqual(['status', '--porcelain'])
    expect(opts.cwd).toBe('C:\\vault')
    expect(opts.timeout).toBe(1000)
    expect(opts.encoding).toBe('utf8')
  })

  it('env 仍含 LC_ALL=C 与 GIT_TERMINAL_PROMPT=0（本地化输出 + 防认证挂起）', () => {
    const calls: Captured[] = []
    git('C:\\vault', ['diff', '--name-only', '--diff-filter=U'], undefined, fakeSpawnSync(calls))
    expect(calls[0].opts.env.LC_ALL).toBe('C')
    expect(calls[0].opts.env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('timeoutMs 缺省为 120000；结果按 status 透传（status 非 0 → ok:false）', () => {
    const calls: Captured[] = []
    git('C:\\vault', ['log', '-1'], undefined, fakeSpawnSync(calls))
    expect(calls[0].opts.timeout).toBe(120000)

    const failCalls: Captured[] = []
    const failing = ((cmd: string, args: string[], opts: CapturedOpts): unknown => {
      failCalls.push({ cmd, args: [...args], opts })
      return { status: 128, stdout: '', stderr: 'fatal: bad' }
    }) as unknown as typeof spawnSync
    const r = git('C:\\vault', ['rev-parse', 'HEAD'], undefined, failing)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(128)
    expect(r.stderr).toBe('fatal: bad')
  })
})
