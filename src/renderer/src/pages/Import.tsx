// 导入页：进入即自动扫描各 Agent 的技能文件夹，列出可导入项让用户勾选。
// 设计取舍：
// - 扫描不阻塞页面（异步 + 扫描中状态），失败只提示不白屏；
// - 候选默认只勾「可导入」项；已入库 / 重名冲突 / 异常一律不预勾（勾了也必然失败或被跳过）；
// - 逐个走现有 import:run 真实执行，单项失败不影响后续（绝不假装成功）；
// - 「手动选择目录…」保留为兜底入口（扫不到的目录仍可手工导入），逻辑与旧版一致。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImportPlan, SkillScanCandidate, SkillScanResult, SkillScanStatus } from '../../../shared/types'
import type { Notify } from '../App'

/** 候选状态徽标文案（白话：说清「现在什么情况」+「会怎么处理」） */
const STATUS_LABEL: Record<SkillScanStatus, string> = {
  importable: '可导入',
  linked: '已入库（跳过）',
  conflict: '库里有同名（不会覆盖）',
  error: '异常'
}

const STATUS_TAG_CLASS: Record<SkillScanStatus, string> = {
  importable: 'tag',
  linked: 'tag',
  conflict: 'tag warn',
  error: 'tag err'
}

type RunState = { status: 'ok' | 'err'; text: string }

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} 字节`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 一句话描述一条候选（给小白看的：这是什么、在哪、会怎么处理） */
function describe(c: SkillScanCandidate): string {
  const where = `来自 ${c.sourceAgent}`
  if (c.status === 'linked') return `${where} · 这个位置已经是指向库里的快捷方式，真正的文件在库中，无需重复导入`
  if (c.status === 'conflict') return `${where} · 库里已经有同名技能，导入会被拒绝（绝不覆盖已有内容）`
  if (c.status === 'error') return `${where} · 这个目录读不了或链接已断，跳过`
  return `${where}${c.isLink ? ' · 这是快捷方式，导入的是它指向的真实目录' : ''}`
}

export default function ImportPage({ notify }: { notify: Notify }): React.JSX.Element {
  const [scan, setScan] = useState<SkillScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [runs, setRuns] = useState<Record<string, RunState>>({})
  const [importing, setImporting] = useState(false)
  /** 最新请求获胜：连点「重新扫描」时，慢的旧响应后到不能覆盖新结果 */
  const seqRef = useRef(0)

  // 手动兜底入口（旧版路径，保持可用）
  const [dir, setDir] = useState('')
  const [preview, setPreview] = useState<ImportPlan | null>(null)
  const [steps, setSteps] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  const runScan = useCallback(
    async (extraDir?: string): Promise<void> => {
      const seq = ++seqRef.current
      setScanning(true)
      const r = await window.api.scanImportCandidates(extraDir)
      if (seq !== seqRef.current) return
      setScanning(false)
      if (!r.ok) {
        setScan(null)
        notify('err', r.error || '扫描失败')
        return
      }
      setScan(r.data)
      // 默认只勾「可导入」：其它状态勾了也必然失败或被跳过，预勾只会制造挫败感
      setSelected(new Set(r.data.candidates.filter((c) => c.status === 'importable').map((c) => c.dir)))
    },
    [notify]
  )

  useEffect(() => {
    void runScan()
  }, [runScan])

  const toggle = (d: string): void => {
    setSelected((p) => {
      const next = new Set(p)
      if (next.has(d)) next.delete(d)
      else next.add(d)
      return next
    })
  }

  /** 逐个真实导入：单项失败不影响后续，每项结果如实显示 */
  const importSelected = async (): Promise<void> => {
    if (!scan) return
    const picked = scan.candidates.filter((c) => selected.has(c.dir))
    if (!picked.length) return
    if (
      !window.confirm(
        `将导入 ${picked.length} 个技能。导入会把技能文件复制进库（用户目录下的 SkillVault），校验无误后把原位置变成指向库的快捷方式，原目录本身不再保留。过程中任何一步失败都会中止该项并保留现场，不会先删后复制。继续？`
      )
    )
      return
    setImporting(true)
    let failed = 0
    for (const c of picked) {
      setRuns((p) => ({ ...p, [c.dir]: { status: 'ok', text: '导入中…' } }))
      const r = await window.api.runImport(c.dir, false)
      if (!r.ok) {
        failed++
        setRuns((p) => ({ ...p, [c.dir]: { status: 'err', text: r.error || '导入失败' } }))
        continue
      }
      const last = r.data.plan.steps[r.data.plan.steps.length - 1] ?? '完成'
      setRuns((p) => ({ ...p, [c.dir]: { status: 'ok', text: last } }))
    }
    setImporting(false)
    notify(failed ? 'err' : 'ok', failed ? `导入结束：${failed} 个失败，结果见列表` : `已导入 ${picked.length} 个技能`)
    // 重扫：成功项原位置已变成指向库的快捷方式，状态应更新为「已入库」；runs 里逐项结果保留不覆盖
    await runScan()
  }

  const importableCount = scan?.candidates.filter((c) => c.status === 'importable').length ?? 0
  const selectAllImportable = (): void => {
    if (!scan) return
    setSelected(new Set(scan.candidates.filter((c) => c.status === 'importable').map((c) => c.dir)))
  }

  /** 手动重扫：清掉上一轮的逐项结果（导入后的自动重扫保留结果，供用户回看） */
  const rescan = (): void => {
    setRuns({})
    void runScan()
  }

  // ---------- 手动兜底入口（与旧版行为一致） ----------

  const pick = async (): Promise<void> => {
    const r = await window.api.pickDirectory()
    if (r.ok && r.data) {
      setDir(r.data)
      setSteps(null)
      await rePreview(r.data)
    }
  }

  const rePreview = async (d: string): Promise<void> => {
    const p = await window.api.previewImport(d)
    if (!p.ok) {
      setPreview(null)
      notify('err', p.error || '预览失败')
      return
    }
    setPreview(p.data)
  }

  const run = async (dryRun: boolean): Promise<void> => {
    if (!dir) return
    if (
      !dryRun &&
      !window.confirm(
        '确认导入这个技能？技能文件会被复制进库并校验；校验通过后，原位置会变成指向库的快捷方式（原目录本身不再保留）。'
      )
    )
      return
    setBusy(true)
    const r = await window.api.runImport(dir, dryRun)
    setBusy(false)
    if (!r.ok) {
      setSteps(null)
      notify('err', r.error || '导入失败')
      return
    }
    setSteps(r.data.plan.steps)
    if (dryRun) {
      await rePreview(dir)
      return
    }
    // 导入成功后原位置已是指向 vault 的 junction：再 preview 必然命中 vaultConflict（红标冲突），
    // 误导用户 —— 清掉预览卡，只保留成功步骤日志
    setPreview(null)
    notify('ok', `导入完成: ${r.data.plan.skillName}`)
  }

  return (
    <div>
      <div className="card">
        <h3>自动扫描到的技能</h3>
        <p className="hint">
          扫描的是各 Agent 的技能文件夹（就是它们在设置页里登记的那个目录），已入库的会自动跳过。扫描只看每个文件夹里有没有
          SKILL.md，不会改动任何文件；导入要等你点按钮才会开始。
        </p>
        <div className="toolbar">
          <button className="btn" disabled={scanning || importing} onClick={rescan}>
            {scanning ? '扫描中…' : '重新扫描'}
          </button>
          <button className="btn" disabled={scanning || importing || importableCount === 0} onClick={selectAllImportable}>
            全选可导入（{importableCount}）
          </button>
          <button
            className="btn primary"
            disabled={scanning || importing || selected.size === 0}
            onClick={() => void importSelected()}
          >
            {importing ? '导入中…' : `导入选中（${selected.size}）`}
          </button>
          <span className="hint">
            {scanning
              ? '正在查看各 Agent 的技能文件夹…'
              : scan
                ? `扫了 ${scan.scannedAgents.length} 个 Agent 的技能文件夹`
                : '尚未扫描'}
          </span>
        </div>

        {scan && scan.scannedAgents.length > 0 && (
          <div className="hint scan-locations">
            <span>扫到的位置：</span>
            {scan.scannedAgents.map((a) => (
              <span key={a.label} className="tag" title={a.skillsDir}>
                {a.label} · {a.dirCount} 个文件夹
              </span>
            ))}
          </div>
        )}

        {scan && scan.candidates.length === 0 && (
          <div className="empty">
            没有扫到可导入的技能。可能这些 Agent 还没装技能，或者技能放在别处 —— 可以用下面的「手动选择目录…」自己指定。
          </div>
        )}

        {scan && scan.candidates.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>导入</th>
                <th>技能名</th>
                <th>状态</th>
                <th>说明</th>
                <th>位置</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {scan.candidates.map((c) => {
                const run = runs[c.dir]
                return (
                  <tr key={c.dir}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(c.dir)}
                        disabled={importing}
                        onChange={() => toggle(c.dir)}
                      />
                    </td>
                    <td>
                      <strong>{c.skillName}</strong>
                    </td>
                    <td>
                      <span className={STATUS_TAG_CLASS[c.status]}>{STATUS_LABEL[c.status]}</span>
                    </td>
                    <td className="hint">{describe(c)}</td>
                    <td className="hint" title={c.dir}>
                      {c.dir}
                    </td>
                    <td className={run?.status === 'err' ? 'hint err-text' : 'hint'}>
                      {run ? `${run.status === 'err' ? '✗ ' : '✓ '}${run.text}` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {scan && scan.errors.length > 0 && (
          <div className="hint err-text">
            以下位置没扫成功（不影响其它位置）：
            {scan.errors.map((e, i) => (
              <div key={i}>
                {e.dir} —— {e.reason}
              </div>
            ))}
          </div>
        )}
      </div>

      <details className="card">
        <summary>手动选择目录…（自动扫描没找到时用这个）</summary>
        <div className="toolbar">
          <button className="btn primary" onClick={() => void pick()}>
            选择源目录…
          </button>
          <input
            className="input grow"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="或手动输入目录路径"
          />
          <button className="btn" disabled={!dir} onClick={() => void rePreview(dir)}>
            重新预览
          </button>
        </div>

        {preview && (
          <div className="card">
            <h3>导入预览</h3>
            <table className="kv">
              <tbody>
                <tr>
                  <th>技能名</th>
                  <td>
                    {preview.skillName}
                    {!preview.nameOk && <span className="tag err">名字不合规范（只能用 a-z、0-9 和 -）</span>}
                  </td>
                </tr>
                <tr>
                  <th>SKILL.md</th>
                  <td>{preview.hasSkillMd ? '存在' : <span className="tag err">缺失（拒绝导入）</span>}</td>
                </tr>
                <tr>
                  <th>真实位置</th>
                  <td>
                    {preview.sourceRealPath}
                    {preview.sourceIsLink && <span className="tag">这是快捷方式，导入它指向的真实目录</span>}
                  </td>
                </tr>
                <tr>
                  <th>规模</th>
                  <td>
                    {preview.fileCount} 个文件 / {fmtBytes(preview.totalBytes)}
                  </td>
                </tr>
                <tr>
                  <th>重名</th>
                  <td>
                    {preview.vaultConflict ? (
                      <span className="tag err">库里已有同名技能，不会覆盖</span>
                    ) : (
                      '无'
                    )}
                  </td>
                </tr>
                <tr>
                  <th>状态</th>
                  <td>{preview.ok ? '可以导入' : <span className="tag err">{preview.error}</span>}</td>
                </tr>
              </tbody>
            </table>
            <div className="toolbar">
              <button className="btn" disabled={!preview.ok || busy} onClick={() => void run(true)}>
                先试一遍（不改文件）
              </button>
              <button className="btn danger" disabled={!preview.ok || busy} onClick={() => void run(false)}>
                确认导入
              </button>
            </div>
            <div className="hint">
              安全顺序：先复制进库 → 再逐个文件核对大小 → 核对通过才删原位置并建快捷方式。核对失败会立刻中止，库里的副本会保留，
              绝不会出现「原文件已删、新文件没到位」。
            </div>
          </div>
        )}

        {steps && (
          <div className="card">
            <h3>执行结果</h3>
            {steps.map((s, i) => (
              <pre key={i} className="step-line">
                {s}
              </pre>
            ))}
          </div>
        )}
      </details>
    </div>
  )
}
