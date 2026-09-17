import { useCallback, useEffect, useState } from 'react'
import type { DoctorItem } from '../../../shared/types'
import type { Notify } from '../App'

const SEV_LABEL = { error: '错误', warn: '警告', info: '提示' } as const

export default function DoctorPage({ notify }: { notify: Notify }): React.JSX.Element {
  const [items, setItems] = useState<DoctorItem[] | null>(null)
  /** 并发修复防护：多个条目同时修复时各自独立记录（单值会互踩，先完成的会把仍在飞行中的按钮恢复可点） */
  const [fixing, setFixing] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    const r = await window.api.doctor()
    if (!r.ok) {
      notify('err', r.error || '体检失败')
      return
    }
    setItems(r.data)
  }, [notify])

  useEffect(() => {
    void load()
  }, [load])

  const fix = async (item: DoctorItem): Promise<void> => {
    setFixing((p) => new Set(p).add(item.id))
    const r = await window.api.doctorFix(item)
    setFixing((p) => {
      const next = new Set(p)
      next.delete(item.id)
      return next
    })
    if (r.ok) {
      notify('ok', r.data?.message ?? '修复成功')
      await load()
    } else {
      notify('err', r.error || '修复失败')
    }
  }

  return (
    <div>
      <div className="toolbar">
        <button className="btn" onClick={() => void load()}>
          重新体检
        </button>
      </div>
      <div className="card">
        <h3>体检项</h3>
        {!items && <div className="hint">检查中…</div>}
        {items && items.length === 0 && <div className="banner ok">一切正常，没有发现问题。</div>}
        {items?.map((it) => (
          <div key={it.id} className={`doctor-item sev-${it.severity}`}>
            <span className={`badge ${it.severity}`}>{SEV_LABEL[it.severity]}</span>
            <span className="doctor-msg">{it.message}</span>
            {it.fixable && (
              <button className="btn small" disabled={fixing.has(it.id)} onClick={() => void fix(it)}>
                {fixing.has(it.id) ? '修复中…' : '一键修复'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
