// 双侧同步编排（fail-fast）：
// 1. Windows: add -A → (有 diff) commit "skillvault sync <ISO时间>" → push origin main
// 2. WSL    : companion sync（add -A → commit → pull --rebase origin main → push origin main）
// 3. Windows: pull origin main
// 冲突原样收集进 conflicts，绝不 force。
//
// 错误分级（WHY —— 与 WSL 侧 companion 的 cmdSync 对称）：
//   add -A / status / commit / push 任一失败 = 本轮致命失败，后续阶段全部不再执行，
//   并把没跑的阶段逐条记成「已跳过」——绝不静默省略（用户必须看得到「什么没跑」）。
//     - add -A 失败（常见是残留 index.lock）：继续 commit/push 等于拿不确定的暂存区去发布。
//     - commit 失败：push 只会把陈旧 HEAD 推上裸仓，还把 commit 失败掩盖掉。
//     - push 失败：本轮无法完成，WSL 侧不该再拉/推，Windows 侧最终 pull 也不做。
//   WSL companion 失败不算致命：拉裸仓仍然有意义，Windows 侧最终 pull 照常执行，
//   但失败必须被记录并报告（绝不假装 WSL 也同步好了）。
import type { SyncResult, SyncStep } from '../shared/types'
import type { AppSettings } from './settings'
import { gitAsync, type GitResult } from './git'
import { runCompanion, type WslResult } from './wslBridge'

/** 可注入的 git 执行依赖（默认 gitAsync；单测注入 fake，不依赖真实 git 二进制） */
export type SyncGitFn = (cwd: string, args: string[]) => GitResult | Promise<GitResult>

/** 可注入的 WSL companion 调用依赖（默认 runCompanion；单测注入 fake，不依赖真实 WSL） */
export type SyncCompanionFn = (distro: string, args: string[], timeoutMs: number) => Promise<WslResult>

export type SyncAllDeps = {
  gitFn?: SyncGitFn
  companionFn?: SyncCompanionFn
}

/** 待执行阶段清单：致命失败时把还没跑到的阶段逐条记成「已跳过」 */
type PendingStage = { side: 'windows' | 'wsl'; cmd: string }

const STAGE_STATUS = 'git status --porcelain'
const STAGE_COMMIT = 'git commit'
const STAGE_PUSH = 'git push origin main'
const STAGE_WSL = 'skm sync'
const STAGE_PULL = 'git pull --no-rebase origin main'

export async function syncAll(settings: AppSettings, deps: SyncAllDeps = {}): Promise<SyncResult> {
  const steps: SyncStep[] = []
  const conflicts: string[] = []
  const vault = settings.vaultPath
  const gitFn: SyncGitFn = deps.gitFn ?? gitAsync
  const companionFn: SyncCompanionFn = deps.companionFn ?? runCompanion

  const record = (side: 'windows' | 'wsl', cmd: string, r: { ok: boolean; stdout: string; stderr: string }): void => {
    steps.push({ side, cmd, ok: r.ok, detail: (r.stderr || r.stdout || '').trim().slice(-600) })
  }

  // 尚未执行的阶段（成功跑完一个就从清单里摘掉；致命失败时剩下的全部记成「已跳过」）
  const pending: PendingStage[] = [
    { side: 'windows', cmd: STAGE_STATUS },
    { side: 'windows', cmd: STAGE_COMMIT },
    { side: 'windows', cmd: STAGE_PUSH },
    { side: 'wsl', cmd: STAGE_WSL },
    { side: 'windows', cmd: STAGE_PULL }
  ]
  const done = (cmd: string): void => {
    const i = pending.findIndex((s) => s.cmd === cmd)
    if (i >= 0) pending.splice(i, 1)
  }
  /** 前序致命失败 → 未执行的阶段逐条显式记录（skipped=true），用户能看到「什么没有跑」 */
  const skipRest = (detail: string): void => {
    for (const s of pending) steps.push({ side: s.side, cmd: s.cmd, ok: false, detail, skipped: true })
    pending.length = 0
  }

  // ---- 1. Windows ----
  const add = await gitFn(vault, ['add', '-A'])
  record('windows', 'git add -A', add)
  if (!add.ok) {
    conflicts.push(`windows add 失败（可能残留 index.lock，请人工处理）:\n${(add.stderr || add.stdout).trim()}`)
    skipRest('前序步骤失败，本轮未执行')
    return {
      steps,
      conflicts,
      aborted: true,
      abortReason: 'git add -A 失败（可能残留 index.lock，请人工处理），本轮已中止'
    }
  }

  const st = await gitFn(vault, ['status', '--porcelain'])
  done(STAGE_STATUS)
  if (!st.ok) {
    record('windows', STAGE_STATUS, st)
    conflicts.push(`windows status 失败:\n${(st.stderr || st.stdout).trim()}`)
    skipRest('前序步骤失败，本轮未执行')
    return { steps, conflicts, aborted: true, abortReason: 'git status 失败，本轮已中止' }
  }
  if (st.stdout.trim()) {
    const c = await gitFn(vault, ['commit', '-m', `skillvault sync ${new Date().toISOString()}`])
    record('windows', STAGE_COMMIT, c)
    done(STAGE_COMMIT)
    if (!c.ok) {
      conflicts.push(`windows commit 失败:\n${(c.stderr || c.stdout).trim()}`)
      skipRest('前序步骤失败，本轮未执行')
      return {
        steps,
        conflicts,
        aborted: true,
        abortReason: 'git commit 失败（未推送，本轮已中止）'
      }
    }
  } else {
    done(STAGE_COMMIT)
    steps.push({ side: 'windows', cmd: 'git status（无变更，跳过 commit）', ok: true, detail: 'clean' })
  }

  const push = await gitFn(vault, ['push', 'origin', 'main'])
  record('windows', STAGE_PUSH, push)
  done(STAGE_PUSH)
  if (!push.ok) {
    conflicts.push(`windows push 失败:\n${(push.stderr || push.stdout).trim()}`)
    skipRest('前序步骤失败，本轮未执行')
    return {
      steps,
      conflicts,
      aborted: true,
      abortReason: 'git push 失败（未同步 WSL、未回拉，本轮已中止）'
    }
  }

  // ---- 2. WSL（companion sync，异步调用不阻塞事件循环）----
  done(STAGE_WSL)
  const c = await companionFn(settings.wslDistro, ['sync'], 180000)
  const p = c.parsed as
    | { ok?: boolean; steps?: { cmd: string; ok: boolean; detail?: string; skipped?: boolean }[]; conflicts?: string[] }
    | undefined
  if (c.ok && p && typeof p === 'object') {
    for (const s of p.steps ?? []) {
      // companion 侧的 skipped 标记必须原样透传：WSL 侧「没有执行 push」不等于「push 失败」
      steps.push({ side: 'wsl', cmd: s.cmd, ok: s.ok, detail: (s.detail ?? '').slice(-600), skipped: s.skipped === true })
    }
    for (const cf of p.conflicts ?? []) conflicts.push(`wsl: ${cf}`)
  } else {
    // WSL 侧失败不是致命失败：裸仓仍可拉，Windows 侧最终 pull 照常执行；但失败必须记录并报告
    const detail = (c.stderr || c.parseError || 'companion 调用失败').slice(-600)
    steps.push({ side: 'wsl', cmd: STAGE_WSL, ok: false, detail })
    conflicts.push(`wsl companion 调用失败: ${detail}`)
  }

  // ---- 3. Windows pull ----
  // 显式 --no-rebase：git ≥2.34 在分支分叉且未配置 pull 策略时直接 fatal（"Need to specify how to
  // reconcile divergent branches"），双端各自提交后必触发 → pull 永久失败。--no-edit 避免 merge 时弹编辑器。
  const pull = await gitFn(vault, ['pull', '--no-rebase', '--no-edit', 'origin', 'main'])
  record('windows', STAGE_PULL, pull)
  done(STAGE_PULL)
  if (!pull.ok) {
    // merge 冲突会留下 MERGE_HEAD + 冲突标记：原样收集冲突文件后立即 abort，
    // 绝不把冲突状态留给下一轮 sync 的 add -A 静默 commit 进历史
    const mergeHead = await gitFn(vault, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
    if (mergeHead.ok) {
      const uf = await gitFn(vault, ['diff', '--name-only', '--diff-filter=U'])
      const files = uf.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
      await gitFn(vault, ['merge', '--abort'])
      conflicts.push(`windows pull 遇到合并冲突，已中止 merge 并保留双方改动待人工处理:\n${files.join('\n')}`)
    } else {
      conflicts.push(`windows pull 失败:\n${(pull.stderr || pull.stdout).trim()}`)
    }
  }

  return { steps, conflicts, aborted: false }
}
