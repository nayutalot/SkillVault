// 同步日志展示（同步页与总览页共用）：
// - skipped=true 的步骤 = 因前序致命失败而「没有执行」，必须与「失败」区分开显示（中性灰/黄「已跳过」），
//   否则用户会以为程序跑过了但失败了，白白去排查不存在的问题。
// - aborted=true 的轮次绝不能显示成「成功」：标题与横幅都要如实说明「本轮已中止」。
import type { SyncResult, SyncStep } from '../../../shared/types'

/** 单条步骤的展示形态：正常 / 失败 / 已跳过 */
export function stepTone(s: SyncStep): 'ok' | 'fail' | 'skip' {
  if (s.skipped) return 'skip'
  return s.ok ? 'ok' : 'fail'
}

/** 步骤徽章文案（白话，用户一眼能懂） */
export function stepBadgeText(s: SyncStep): string {
  if (s.skipped) return '已跳过'
  return s.ok ? 'OK' : '失败'
}

/** 本轮结果的标题（一句话白话，绝不把中止说成成功） */
export function syncHeadline(res: SyncResult): string {
  if (res.aborted) return '本轮已中止'
  if (res.conflicts.length) return '有冲突'
  return '全部成功'
}

/** 本轮结果的横幅文案（可空表示无需横幅） */
export function syncBannerText(res: SyncResult): string | null {
  if (res.aborted) return res.abortReason || '本轮因前一步失败已中止，后面的步骤没有执行'
  if (res.conflicts.length) return `有 ${res.conflicts.length} 处需要你人工处理，程序不会强行覆盖`
  return null
}

/** 同步步骤日志（行内展示；skipped 用独立徽章） */
export function SyncSteps({ steps }: { steps: SyncStep[] }): React.JSX.Element {
  return (
    <>
      {steps.map((s, i) => {
        const tone = stepTone(s)
        return (
          <div key={i} className={`step ${tone}`}>
            <span className="step-side">{s.side === 'windows' ? 'Win' : 'WSL'}</span>
            <span className="step-cmd">{s.cmd}</span>
            <span className={`step-badge ${tone}`}>{stepBadgeText(s)}</span>
            {s.detail && <pre className="step-detail">{s.detail}</pre>}
          </div>
        )
      })}
    </>
  )
}
