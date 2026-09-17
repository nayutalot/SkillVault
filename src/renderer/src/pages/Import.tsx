import { useState } from 'react'
import type { ImportPlan } from '../../../shared/types'
import type { Notify } from '../App'

export default function ImportPage({ notify }: { notify: Notify }): React.JSX.Element {
  const [dir, setDir] = useState('')
  const [preview, setPreview] = useState<ImportPlan | null>(null)
  const [steps, setSteps] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

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
    if (!dryRun && !window.confirm('确认执行导入？将复制到 vault、校验、删除原位置并建立 junction。')) return
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
      <div className="toolbar">
        <button className="btn primary" onClick={() => void pick()}>
          选择源目录…
        </button>
        <input className="input grow" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="或手动输入目录路径" />
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
                <th>skill 名</th>
                <td>
                  {preview.skillName}
                  {!preview.nameOk && <span className="tag err">不符合 kebab-case</span>}
                </td>
              </tr>
              <tr>
                <th>SKILL.md</th>
                <td>{preview.hasSkillMd ? '存在' : <span className="tag err">缺失（拒绝导入）</span>}</td>
              </tr>
              <tr>
                <th>源真实路径</th>
                <td>
                  {preview.sourceRealPath}
                  {preview.sourceIsLink && <span className="tag">源路径是链接，将导入真身</span>}
                </td>
              </tr>
              <tr>
                <th>规模</th>
                <td>
                  {preview.fileCount} 个文件 / {preview.totalBytes} 字节
                </td>
              </tr>
              <tr>
                <th>冲突</th>
                <td>
                  {preview.vaultConflict ? (
                    <span className="tag err">vault 已存在同名 skill，拒绝覆盖</span>
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
              干跑预演
            </button>
            <button className="btn danger" disabled={!preview.ok || busy} onClick={() => void run(false)}>
              执行导入
            </button>
          </div>
          <div className="hint">
            安全顺序：复制 → 校验（文件数 + 逐文件字节）→ 校验通过后才删除原位置并建链；校验失败会中止并保留 vault
            副本，绝不先删后验。
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
    </div>
  )
}
