import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, RemoteTarget, SyncResult } from '../../../shared/types'
import type { RemoteSyncResult } from '../../../preload'
import type { Notify } from '../App'

type SyncRow = { busy: boolean; result: RemoteSyncResult | null; error?: string }

export default function SyncPage({ notify }: { notify: Notify }): React.JSX.Element {
  const [res, setRes] = useState<SyncResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [rows, setRows] = useState<Record<string, SyncRow>>({})

  const load = useCallback(async (): Promise<void> => {
    const s = await window.api.getSettings()
    if (s.ok) setSettings(s.data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (): Promise<void> => {
    setBusy(true)
    const r = await window.api.sync()
    setBusy(false)
    if (!r.ok) {
      notify('err', r.error || '同步失败')
      return
    }
    setRes(r.data)
    notify(r.data.conflicts.length ? 'err' : 'ok', r.data.conflicts.length ? '同步完成但有冲突' : '双侧同步完成')
  }

  /** git bundle 单向同步到单个远程目标（目标必须已保存且启用；结果如实显示，绝不伪造成功） */
  const runRemote = async (t: RemoteTarget): Promise<void> => {
    setRows((p) => ({ ...p, [t.id]: { busy: true, result: null } }))
    const r = await window.api.syncRemote(t.id)
    if (!r.ok) {
      setRows((p) => ({ ...p, [t.id]: { busy: false, result: null, error: r.error || '同步失败' } }))
      notify('err', `远程同步失败（${t.label}）：${r.error || '未知错误'}`)
      return
    }
    setRows((p) => ({ ...p, [t.id]: { busy: false, result: r.data } }))
    notify(r.data.ok ? 'ok' : 'err', r.data.ok ? `远程同步完成（${t.label}）` : `远程同步未完成（${t.label}），详见步骤日志`)
  }

  const enabledTargets = settings?.remoteTargets.filter((t) => t.enabled) ?? []
  const disabledTargets = settings?.remoteTargets.filter((t) => !t.enabled) ?? []

  return (
    <div>
      <div className="toolbar">
        <button className="btn primary" disabled={busy} onClick={() => void run()}>
          {busy ? '同步中…' : '开始双侧同步'}
        </button>
      </div>

      <div className="card">
        <h3>同步机制（零云远端）</h3>
        <p className="hint">
          数据面只有本地裸仓 <code>用户目录下 SkillVault.git</code> 作为唯一 origin：Windows 工作克隆
          <code>用户目录下 SkillVault</code> 与 WSL 工作克隆 <code>/root/skill-vault</code> 互为对端，全部 push/pull
          都指向本地裸仓，不涉及任何云仓库。
        </p>
        <ol className="hint">
          <li>Windows：add -A →（有差异才）commit “skillvault sync &lt;ISO时间&gt;” → push origin main</li>
          <li>WSL（companion sync）：add -A → commit → pull --rebase origin main → push origin main</li>
          <li>Windows：pull origin main</li>
        </ol>
        <p className="hint">冲突时 git 输出原样展示在下方，绝不使用 force。</p>
      </div>

      {res && (
        <div className={`card ${res.conflicts.length ? 'card-err' : ''}`}>
          <h3>同步日志（{res.conflicts.length ? '有冲突' : '全部成功'}）</h3>
          {res.steps.map((s, i) => (
            <div key={i} className={`step ${s.ok ? 'ok' : 'fail'}`}>
              <span className="step-side">{s.side === 'windows' ? 'Win' : 'WSL'}</span>
              <span className="step-cmd">{s.cmd}</span>
              <span className={`step-badge ${s.ok ? 'ok' : 'fail'}`}>{s.ok ? 'OK' : '失败'}</span>
              {s.detail && <pre className="step-detail">{s.detail}</pre>}
            </div>
          ))}
          {res.conflicts.length > 0 && (
            <div>
              <h4>冲突（原样输出）</h4>
              {res.conflicts.map((c, i) => (
                <pre key={i} className="conflict">
                  {c}
                </pre>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3>远程目标（SSH / Docker）</h3>
        {!settings && <div className="empty">设置读取中…</div>}
        {settings && settings.remoteTargets.length === 0 && (
          <div className="empty">尚未配置远程目标，可在设置中添加 SSH 主机或 Docker 容器。</div>
        )}
        {settings && settings.remoteTargets.length > 0 && enabledTargets.length === 0 && (
          <div className="empty">
            共 {settings.remoteTargets.length} 个远程目标，但全部处于停用状态（可在设置页启用）。
          </div>
        )}
        {enabledTargets.map((t) => {
          const row = rows[t.id]
          return (
            <div key={t.id} className="remote-target">
              <div className="remote-head">
                <strong>{t.label}</strong>
                <span className="tag">{t.kind === 'ssh' ? `ssh ${t.user ? t.user + '@' : ''}${t.host ?? ''}${t.port ? ':' + t.port : ''}` : `docker ${t.container ?? ''}`}</span>
                <button className="btn small primary" disabled={row?.busy} onClick={() => void runRemote(t)}>
                  {row?.busy ? '同步中…' : '同步'}
                </button>
              </div>
              {row?.error && <div className="hint err-text">✗ {row.error}</div>}
              {row?.result && (
                <div>
                  {row.result.steps.map((s, i) => (
                    <div key={i} className={`step ${s.ok ? 'ok' : 'fail'}`}>
                      <span className="step-side">远端</span>
                      <span className="step-cmd">{s.cmd}</span>
                      <span className={`step-badge ${s.ok ? 'ok' : 'fail'}`}>{s.ok ? 'OK' : '失败'}</span>
                      {s.detail && <pre className="step-detail">{s.detail}</pre>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {disabledTargets.length > 0 && (
          <div className="hint">停用中的目标：{disabledTargets.map((t) => t.label).join('、')}</div>
        )}
        <p className="hint">
          远程同步为 git bundle 单向传输：本地 <code>git bundle create --all</code> → 上传 bundle → 远端{' '}
          <code>git -C ~/skill-vault pull &lt;bundle&gt; main</code>。远端需已存在 ~/skill-vault 克隆；凭据走系统
          ssh-agent，本应用不存储密码。
        </p>
      </div>
    </div>
  )
}
