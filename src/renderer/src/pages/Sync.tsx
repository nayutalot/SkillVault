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
    notify(r.data.conflicts.length ? 'err' : 'ok', r.data.conflicts.length ? '同步完成，但有冲突需要处理' : 'Windows 和 WSL 都已同步')
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
          {busy ? '同步中…' : '开始同步'}
        </button>
      </div>

      <div className="card">
        <h3>数据存在哪？会上传云端吗？</h3>
        <p className="hint">
          所有技能都保存在你自己电脑上的一个仓库里（用户目录下的 SkillVault 文件夹）。Windows 和 WSL
          两边通过它互相同步，全程不经过任何云服务，也不会把内容发到网上。
        </p>
        <ol className="hint">
          <li>第一步（Windows）：把这里的改动存档，然后推送到中转仓库。</li>
          <li>第二步（WSL）：把 WSL 里的改动存档，先取回 Windows 的最新版本，再推送自己的改动。</li>
          <li>第三步（Windows）：把 WSL 推上来的最新版本取回来。</li>
        </ol>
        <p className="hint">
          两边同时改了同一个文件才会出现冲突。真冲突时不会强推覆盖，而是把原始输出原样列在下方，按提示人工处理。
        </p>
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
        <h3>推送到别的电脑（SSH / Docker）</h3>
        {!settings && <div className="empty">正在读取设置…</div>}
        {settings && settings.remoteTargets.length === 0 && (
          <div className="empty">
            还没有配置远程电脑。如果你想把技能库也放到另一台电脑或容器里，可以到设置页添加一个 SSH 主机或 Docker 容器。
          </div>
        )}
        {settings && settings.remoteTargets.length > 0 && enabledTargets.length === 0 && (
          <div className="empty">
            共 {settings.remoteTargets.length} 个远程目标，但都被停用了（到设置页勾选「启用」即可使用）。
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
          <div className="hint">已停用（不会参与推送）：{disabledTargets.map((t) => t.label).join('、')}</div>
        )}
        <p className="hint">
          推送过程：先把本地技能库打包成一个文件，传到对方电脑，再让对方把这个文件里的内容合并进它自己的技能库。对方需要已经有一份
          技能库副本（设置过的路径）。连接用的密码由系统自带的 SSH 工具管理，本软件不保存密码。
        </p>
      </div>
    </div>
  )
}
