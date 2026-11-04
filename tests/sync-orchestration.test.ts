// syncAll() 的 fail-fast 编排约束（依赖注入，全程不依赖真实 git 二进制与真实 WSL）：
// 目标 —— Windows 侧任一 git 步骤失败后，绝不继续往下跑（add 失败不 commit/push；commit 失败不 push；
// push 失败不叫 WSL、不回拉），并且没跑的步骤必须逐条显式记成「已跳过」，让用户看得到「什么没有跑」。
// 与 WSL 侧 companion 的 cmdSync 语义对称（pull 失败时不再 push）。
import { describe, expect, it } from 'vitest'
import { syncAll, type SyncAllDeps } from '../src/main/sync'
import type { GitResult } from '../src/main/git'
import type { WslResult } from '../src/main/wslBridge'
import type { AppSettings } from '../src/shared/types'

const SETTINGS: AppSettings = {
  vaultPath: 'C:\\vault',
  barePath: 'C:\\vault.git',
  wslDistro: 'Ubuntu',
  deepseekHarnessRoot: 'D:\\Apps\\deepseek-harness',
  remoteTargets: []
}

type Call = { cwd: string; args: string[] }

/** fake git：按「args 首段 + 关键标志」路由到预设结果，并记录全部调用 */
type GitRoute = (args: string[]) => GitResult | undefined

function makeGit(routes: GitRoute[]): { gitFn: SyncAllDeps['gitFn']; calls: Call[] } {
  const calls: Call[] = []
  const gitFn = async (cwd: string, args: string[]): Promise<GitResult> => {
    calls.push({ cwd, args: [...args] })
    for (const r of routes) {
      const hit = r(args)
      if (hit) return hit
    }
    return { ok: true, status: 0, stdout: '', stderr: '' }
  }
  return { gitFn, calls }
}

const ok = (stdout = ''): GitResult => ({ ok: true, status: 0, stdout, stderr: '' })
const fail = (stderr = 'fatal: boom'): GitResult => ({ ok: false, status: 128, stdout: '', stderr })

/** 记录调用的 args 序列（用于断言「某步是否执行」） */
function argSeq(calls: Call[]): string[] {
  return calls.map((c) => c.args.join(' '))
}

function ran(calls: Call[], needle: string): boolean {
  return argSeq(calls).some((a) => a.startsWith(needle))
}

const COMPANION_OK: WslResult = {
  ok: true,
  status: 0,
  stdout: '',
  stderr: '',
  parsed: { ok: true, steps: [{ cmd: 'wsl git add -A', ok: true, detail: '' }], conflicts: [] }
}

const COMPANION_FAIL: WslResult = {
  ok: false,
  status: 255,
  stdout: '',
  stderr: 'wsl.exe 不可达'
}

describe('syncAll() fail-fast：add -A 失败', () => {
  it('add 失败 → 不 commit / 不 push / 不调 WSL / 不 pull，且 aborted=true 并记录被跳过的步骤', async () => {
    const { gitFn, calls } = makeGit([(args) => (args[0] === 'add' ? fail('fatal: Unable to create index.lock') : undefined)])
    const companionCalls: string[] = []
    const companionFn = async (distro: string, args: string[]): Promise<WslResult> => {
      companionCalls.push(args.join(' '))
      return COMPANION_OK
    }
    const res = await syncAll(SETTINGS, { gitFn, companionFn })

    expect(res.aborted).toBe(true)
    expect(res.abortReason).toContain('index.lock')
    // 只跑了 add -A
    expect(argSeq(calls)).toEqual(['add -A'])
    expect(ran(calls, 'commit')).toBe(false)
    expect(ran(calls, 'push')).toBe(false)
    expect(ran(calls, 'pull')).toBe(false)
    expect(companionCalls).toHaveLength(0)

    // 被跳过的步骤必须逐条出现在日志里（skipped=true），而不是静默省略
    const skipped = res.steps.filter((s) => s.skipped).map((s) => s.cmd)
    expect(skipped).toContain('git commit')
    expect(skipped).toContain('git push origin main')
    expect(skipped).toContain('skm sync')
    expect(skipped).toContain('git pull --no-rebase origin main')
    // 失败的那一步本身不能标成 skipped
    const addStep = res.steps.find((s) => s.cmd === 'git add -A')
    expect(addStep?.ok).toBe(false)
    expect(addStep?.skipped).toBeUndefined()
  })
})

describe('syncAll() fail-fast：commit 失败', () => {
  it('commit 失败 → 不 push，aborted=true', async () => {
    const { gitFn, calls } = makeGit([
      (args) => (args[0] === 'commit' ? fail('nothing to commit') : args[0] === 'status' ? ok('?? a.md\n') : undefined)
    ])
    const companionCalls: string[] = []
    const companionFn = async (_d: string, args: string[]): Promise<WslResult> => {
      companionCalls.push(args.join(' '))
      return COMPANION_OK
    }
    const res = await syncAll(SETTINGS, { gitFn, companionFn })

    expect(res.aborted).toBe(true)
    expect(ran(calls, 'push')).toBe(false)
    expect(companionCalls).toHaveLength(0)
    const skipped = res.steps.filter((s) => s.skipped).map((s) => s.cmd)
    expect(skipped).toContain('git push origin main')
    expect(skipped).toContain('skm sync')
  })
})

describe('syncAll() fail-fast：push 失败', () => {
  it('push 失败 → 不调 WSL companion、不做最终 pull，aborted=true', async () => {
    const { gitFn, calls } = makeGit([
      (args) => (args[0] === 'push' ? fail('rejecting non-fast-forward') : args[0] === 'status' ? ok('?? a.md\n') : undefined)
    ])
    const companionCalls: string[] = []
    const companionFn = async (_d: string, args: string[]): Promise<WslResult> => {
      companionCalls.push(args.join(' '))
      return COMPANION_OK
    }
    const res = await syncAll(SETTINGS, { gitFn, companionFn })

    expect(res.aborted).toBe(true)
    expect(ran(calls, 'pull')).toBe(false)
    expect(companionCalls).toHaveLength(0)
    const skipped = res.steps.filter((s) => s.skipped).map((s) => s.cmd)
    expect(skipped).toContain('skm sync')
    expect(skipped).toContain('git pull --no-rebase origin main')
  })
})

describe('syncAll() 正常路径与 WSL 失败', () => {
  it('全部成功 → aborted=false，步骤顺序正确（add → status → commit → push → WSL → pull）', async () => {
    const { gitFn, calls } = makeGit([(args) => (args[0] === 'status' ? ok('?? a.md\n') : undefined)])
    const companionCalls: string[] = []
    const companionFn = async (_d: string, args: string[]): Promise<WslResult> => {
      companionCalls.push(args.join(' '))
      return COMPANION_OK
    }
    const res = await syncAll(SETTINGS, { gitFn, companionFn })

    expect(res.aborted).toBe(false)
    expect(res.abortReason).toBeUndefined()
    expect(res.conflicts).toEqual([])
    // 步骤顺序：add → status → commit → push → (WSL) → pull
    const seq = argSeq(calls)
    expect(seq).toHaveLength(5)
    expect(seq[0]).toBe('add -A')
    expect(seq[1]).toBe('status --porcelain')
    expect(seq[2].startsWith('commit -m ')).toBe(true)
    expect(seq[3]).toBe('push origin main')
    expect(seq[4]).toBe('pull --no-rebase --no-edit origin main')
    expect(companionCalls).toEqual(['sync'])
    // 步骤日志：WSL 侧步骤来自 companion 回包
    expect(res.steps.some((s) => s.side === 'wsl' && s.cmd === 'wsl git add -A')).toBe(true)
    expect(res.steps.every((s) => s.skipped !== true)).toBe(true)
  })

  it('WSL companion 失败 → Windows 侧仍执行最终 pull，且 aborted=false（pull 不是致命失败）', async () => {
    const { gitFn, calls } = makeGit([(args) => (args[0] === 'status' ? ok('?? a.md\n') : undefined)])
    const companionFn = async (): Promise<WslResult> => COMPANION_FAIL
    const res = await syncAll(SETTINGS, { gitFn, companionFn })

    expect(res.aborted).toBe(false)
    expect(ran(calls, 'pull')).toBe(true)
    // WSL 失败必须被记录并报告（不能假装 WSL 也同步好了）
    const wslStep = res.steps.find((s) => s.side === 'wsl')
    expect(wslStep?.ok).toBe(false)
    expect(res.conflicts.some((c) => c.includes('wsl companion 调用失败'))).toBe(true)
  })

  it('companion 回包里的 skipped 标记原样透传（WSL 侧「没执行 push」≠「push 失败」）', async () => {
    const { gitFn } = makeGit([(args) => (args[0] === 'status' ? ok('?? a.md\n') : undefined)])
    const companionFn = async (): Promise<WslResult> => ({
      ok: true,
      status: 0,
      stdout: '',
      stderr: '',
      parsed: {
        ok: false,
        steps: [{ cmd: 'git push（pull 失败，跳过）', ok: false, detail: 'pull 未成功，本轮不推送', skipped: true }],
        conflicts: ['wsl pull 冲突']
      }
    })
    const res = await syncAll(SETTINGS, { gitFn, companionFn })
    const wslSkip = res.steps.find((s) => s.side === 'wsl')
    expect(wslSkip?.skipped).toBe(true)
    expect(wslSkip?.ok).toBe(false)
  })
})

describe('syncAll() 合并冲突路径', () => {
  it('pull 冲突 → 收集未合并文件 → merge --abort，冲突写进 conflicts 且不残留合并状态', async () => {
    const { gitFn, calls } = makeGit([
      (args) => {
        if (args[0] === 'status') return ok('?? a.md\n')
        if (args[0] === 'pull') return fail('CONFLICT (content): Merge conflict in a.md')
        if (args[0] === 'rev-parse') return ok('abc123\n') // MERGE_HEAD 存在
        if (args[0] === 'diff') return ok('a.md\nb.md\n')
        return undefined
      }
    ])
    const companionFn = async (): Promise<WslResult> => COMPANION_OK
    const res = await syncAll(SETTINGS, { gitFn, companionFn })

    // pull 失败不算致命失败（其余阶段都已跑完），但冲突必须如实收集
    expect(res.aborted).toBe(false)
    expect(ran(calls, 'merge --abort')).toBe(true)
    const conflictText = res.conflicts.join('\n')
    expect(conflictText).toContain('合并冲突')
    expect(conflictText).toContain('a.md')
    expect(conflictText).toContain('b.md')
  })
})
