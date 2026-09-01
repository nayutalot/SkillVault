// 双侧同步编排：
// 1. Windows: add -A → (有 diff) commit "skill-manager sync <ISO时间>" → push origin main
// 2. WSL    : companion sync（add -A → commit → pull --rebase origin main → push origin main）
// 3. Windows: pull origin main
// 冲突原样收集进 conflicts，绝不 force。
import type { SyncResult, SyncStep } from '../shared/types'
import type { AppSettings } from './settings'
import { git } from './git'
import { runCompanion } from './wslBridge'

export async function syncAll(settings: AppSettings): Promise<SyncResult> {
  const steps: SyncStep[] = []
  const conflicts: string[] = []
  const vault = settings.vaultPath

  const record = (side: 'windows' | 'wsl', cmd: string, r: { ok: boolean; stdout: string; stderr: string }): void => {
    steps.push({ side, cmd, ok: r.ok, detail: (r.stderr || r.stdout || '').trim().slice(-600) })
  }

  // ---- 1. Windows ----
  let r = git(vault, ['add', '-A'])
  record('windows', 'git add -A', r)
  const st = git(vault, ['status', '--porcelain'])
  if (st.stdout.trim()) {
    r = git(vault, ['commit', '-m', `skillvault sync ${new Date().toISOString()}`])
    record('windows', 'git commit', r)
    if (!r.ok) conflicts.push(`windows commit 失败:\n${(r.stderr || r.stdout).trim()}`)
  } else {
    steps.push({ side: 'windows', cmd: 'git status（无变更，跳过 commit）', ok: true, detail: 'clean' })
  }
  r = git(vault, ['push', 'origin', 'main'])
  record('windows', 'git push origin main', r)
  if (!r.ok) conflicts.push(`windows push 失败:\n${(r.stderr || r.stdout).trim()}`)

  // ---- 2. WSL（companion sync，异步调用不阻塞事件循环）----
  const c = await runCompanion(settings.wslDistro, ['sync'], 180000)
  const p = c.parsed as { ok?: boolean; steps?: { cmd: string; ok: boolean; detail?: string }[]; conflicts?: string[] } | undefined
  if (c.ok && p && typeof p === 'object') {
    for (const s of p.steps ?? []) {
      steps.push({ side: 'wsl', cmd: s.cmd, ok: s.ok, detail: (s.detail ?? '').slice(-600) })
    }
    for (const cf of p.conflicts ?? []) conflicts.push(`wsl: ${cf}`)
  } else {
    const detail = (c.stderr || c.parseError || 'companion 调用失败').slice(-600)
    steps.push({ side: 'wsl', cmd: 'skm sync', ok: false, detail })
    conflicts.push(`wsl companion 调用失败: ${detail}`)
  }

  // ---- 3. Windows pull ----
  // 显式 --no-rebase：git ≥2.34 在分支分叉且未配置 pull 策略时直接 fatal（"Need to specify how to
  // reconcile divergent branches"），双端各自提交后必触发 → pull 永久失败。--no-edit 避免 merge 时弹编辑器。
  r = git(vault, ['pull', '--no-rebase', '--no-edit', 'origin', 'main'])
  record('windows', 'git pull --no-rebase origin main', r)
  if (!r.ok) {
    // merge 冲突会留下 MERGE_HEAD + 冲突标记：原样收集冲突文件后立即 abort，
    // 绝不把冲突状态留给下一轮 sync 的 add -A 静默 commit 进历史
    const mergeHead = git(vault, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
    if (mergeHead.ok) {
      const uf = git(vault, ['diff', '--name-only', '--diff-filter=U'])
      const files = uf.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
      git(vault, ['merge', '--abort'])
      conflicts.push(`windows pull 遇到合并冲突，已中止 merge 并保留双方改动待人工处理:\n${files.join('\n')}`)
    } else {
      conflicts.push(`windows pull 失败:\n${(r.stderr || r.stdout).trim()}`)
    }
  }

  return { steps, conflicts }
}
