// 版本中心：检测全部 agent harness 的已装版本 vs 最新版本，一键更新（仅用户点击触发，绝不自动更新）。
// 交互流：进页先读缓存秒回 → 自动跑一轮实时检查 → 「一键更新」先经主进程预检（进程在运行则弹确认框）→
// job 轮询增量日志（滚动到底 + 可取消）→ 完成后 toast 并用回查结果刷新行内版本。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CheckAllResult, UpdateStartResult, VersionJobSnapshot, VersionStatus } from '../../../shared/types'
import type { Notify } from '../App'

const KIND_LABEL: Record<VersionStatus['channelKind'], string> = {
  npm: 'npm',
  winget: 'winget',
  native: '自带更新器',
  arp: '仅检测',
  github: 'GitHub Releases'
}

const STATE_BADGE: Record<VersionStatus['state'], { cls: string; label: string }> = {
  'up-to-date': { cls: 'ok', label: '✓ 已是最新' },
  upgradable: { cls: 'warn', label: '↑ 可升级' },
  unknown: { cls: 'info', label: '? 未知' },
  'check-failed': { cls: 'err', label: '✗ 检测失败' },
  'detect-only': { cls: 'info', label: 'ⓘ 仅检测' },
  checking: { cls: 'muted', label: '… 检查中' }
}

type JobView = {
  jobId: string
  log: string[]
  status: VersionJobSnapshot['status']
  error?: string
  after?: VersionStatus
}

type ConfirmState = { status: VersionStatus; processName?: string }

export default function VersionCenterPage({ notify }: { notify: Notify }): React.JSX.Element {
  const [result, setResult] = useState<CheckAllResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [rowChecking, setRowChecking] = useState<Record<string, boolean>>({})
  const [jobs, setJobs] = useState<Record<string, JobView>>({})
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  /** 每个 job 一个日志框 ref（共享单个 ref 时只有最后挂载的日志框能自动滚动） */
  const logRefs = useRef<Map<string, HTMLPreElement>>(new Map())
  const setLogRef = useCallback((entryId: string, el: HTMLPreElement | null): void => {
    if (el) logRefs.current.set(entryId, el)
    else logRefs.current.delete(entryId)
  }, [])
  /** 全量检查 vs 行内检查的「最新请求获胜」防护：进页自动 checkAllFresh 在飞时点单行「检查」，
   *  后到的旧全量快照会把行内最新结果整体覆盖 */
  const checkSeqRef = useRef(0)

  const patchStatus = useCallback((next: VersionStatus): void => {
    setResult((p) => (p ? { ...p, statuses: p.statuses.map((s) => (s.id === next.id ? next : s)) } : p))
  }, [])

  const loadCache = useCallback(async (): Promise<void> => {
    const r = await window.api.versionsCheckAll({ useCache: true })
    if (r.ok) setResult(r.data)
  }, [])

  const checkAllFresh = useCallback(async (): Promise<void> => {
    const seq = ++checkSeqRef.current
    setChecking(true)
    const r = await window.api.versionsCheckAll()
    setChecking(false)
    if (seq !== checkSeqRef.current) return
    if (!r.ok) {
      notify('err', r.error || '版本检查失败')
      return
    }
    setResult(r.data)
  }, [notify])

  const checkOne = useCallback(
    async (id: string): Promise<void> => {
      const seq = ++checkSeqRef.current
      setRowChecking((p) => ({ ...p, [id]: true }))
      const r = await window.api.versionsCheckAll({ id })
      setRowChecking((p) => ({ ...p, [id]: false }))
      if (seq !== checkSeqRef.current) return
      if (!r.ok) {
        notify('err', r.error || '检查失败')
        return
      }
      for (const s of r.data.statuses) patchStatus(s)
    },
    [notify, patchStatus]
  )

  // 进页：先渲染缓存，再自动跑一轮实时检查（绝不触发更新）
  useEffect(() => {
    void loadCache()
    void checkAllFresh()
  }, [loadCache, checkAllFresh])

  // 更新 job 轮询：有 running job 时每 800ms 拉一次增量日志与状态；done → toast + 回查结果刷新行。
  // 自续依赖 setJobs 产生新 state 触发 effect 重跑 —— 失败 tick 也必须触发下一轮（哪怕只是浅拷贝 jobs），
  // 否则 jobStatus 一次失败轮询就永久停摆，UI 卡在「更新中…」。stale 标志拦住已卸载/被替换的旧异步循环
  // （多 job 并发时防重复 toast 与旧日志覆盖新日志）。
  useEffect(() => {
    const running = Object.entries(jobs).filter(([, j]) => j.status === 'running')
    if (!running.length) return
    let stale = false
    const t = window.setTimeout(async () => {
      for (const [entryId, j] of running) {
        if (stale) return
        const r = await window.api.versionsJobStatus(j.jobId)
        if (stale) return
        if (r.ok) {
          setJobs((p) => ({
            ...p,
            [entryId]: { jobId: j.jobId, log: r.data.log, status: r.data.status, error: r.data.error, after: r.data.after }
          }))
          if (r.data.status === 'done') {
            notify('ok', `${r.data.after?.name ?? entryId} 更新完成${r.data.after?.installed ? `，当前版本 ${r.data.after.installed}` : ''}`)
            if (r.data.after) patchStatus(r.data.after)
          } else if (r.data.status === 'failed') {
            notify('err', `更新失败：${(r.data.error || '未知错误').slice(0, 120)}`)
          }
        }
      }
      if (!stale) {
        // 失败 tick（r.ok 全 false 时上面没有 setJobs）也要触发下一轮调度
        setJobs((p) => ({ ...p }))
      }
    }, 800)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
  }, [jobs, notify, patchStatus])

  // 日志窗口自动滚动到底（每个 job 各自的日志框）
  useEffect(() => {
    for (const el of logRefs.current.values()) el.scrollTop = el.scrollHeight
  })

  const beginJob = (entryId: string, jobId: string): void => {
    setJobs((p) => ({ ...p, [entryId]: { jobId, log: [], status: 'running' } }))
  }

  const requestUpdate = async (id: string): Promise<void> => {
    const r = await window.api.versionsUpdateOne({ id })
    if (!r.ok) {
      notify('err', r.error || '无法启动更新')
      return
    }
    const d: UpdateStartResult = r.data
    if (d.blocked) {
      const st = result?.statuses.find((s) => s.id === id)
      if (st) setConfirm({ status: st, processName: d.processName })
      return
    }
    if (d.jobId) beginJob(id, d.jobId)
  }

  const confirmUpdate = async (): Promise<void> => {
    if (!confirm) return
    const { status } = confirm
    setConfirm(null)
    const r = await window.api.versionsUpdateOne({ id: status.id, confirmed: true })
    if (!r.ok) {
      notify('err', r.error || '无法启动更新')
      return
    }
    if (r.data.jobId) beginJob(status.id, r.data.jobId)
  }

  const cancelJob = async (entryId: string): Promise<void> => {
    const j = jobs[entryId]
    if (!j) return
    const r = await window.api.versionsCancel(j.jobId)
    if (!r.ok) notify('err', r.error || '取消失败')
  }

  const statuses = result?.statuses ?? null
  const upgradable = statuses?.filter((s) => s.state === 'upgradable').length ?? 0

  return (
    <div>
      <div className="toolbar">
        <button className="btn primary" disabled={checking} onClick={() => void checkAllFresh()}>
          {checking ? (
            <>
              <span className="spinner" />
              检查中…
            </>
          ) : (
            '全部检查'
          )}
        </button>
        <span className="hint">
          {result?.ts ? `上次检查：${new Date(result.ts).toLocaleString()}${result.stale ? '（缓存）' : ''}` : '尚未检查'}
          {statuses ? ` · 共 ${statuses.length} 项 · 可升级 ${upgradable} 项` : ''}
        </span>
      </div>

      <div className="card">
        <h3>Agent Harness 版本</h3>
        {!statuses && <div className="hint">检查中…</div>}
        {statuses?.map((s) => {
          const job = jobs[s.id]
          const busy = job?.status === 'running'
          const canUpdate = s.state === 'upgradable' || s.channelKind === 'native'
          return (
            <div key={s.id} className="vc-row">
              <span className="vc-name">{s.name}</span>
              <span className="tag">{KIND_LABEL[s.channelKind]}</span>
              <span className="vc-ver">{s.installed ?? '?'}</span>
              <span className="vc-arrow">→</span>
              <span className="vc-ver">{s.latest ?? (s.channelKind === 'native' ? '由自带更新器探测' : '未知')}</span>
              <span className={`badge ${STATE_BADGE[s.state].cls}`}>{STATE_BADGE[s.state].label}</span>
              <span className="vc-actions">
                <button className="btn small" disabled={rowChecking[s.id] || checking} onClick={() => void checkOne(s.id)}>
                  {rowChecking[s.id] ? '检查中…' : '检查'}
                </button>
                {s.channelKind === 'arp' ? (
                  <button className="btn small" disabled title="无自动升级通道，请手动更新">
                    手动
                  </button>
                ) : canUpdate ? (
                  <button
                    className="btn small primary"
                    disabled={busy}
                    title={
                      s.channelKind === 'native'
                        ? '调用其自带更新器'
                        : s.channelKind === 'github'
                          ? '下载 GitHub 源码包并重建（约需数分钟，旧目录自动备份）'
                          : undefined
                    }
                    onClick={() => void requestUpdate(s.id)}
                  >
                    {busy ? '更新中…' : s.channelKind === 'native' ? '更新（自带更新器）' : '一键更新'}
                  </button>
                ) : null}
              </span>
              {s.hint && <div className="vc-note">ⓘ {s.hint}</div>}
              {s.note && <div className="vc-note">{s.note}</div>}
              {job && (
                <div className="vc-logwrap">
                  <pre className="vc-log" ref={(el) => setLogRef(s.id, el)}>
                    {job.log.join('\n') || '等待输出…'}
                  </pre>
                  {busy && (
                    <button className="btn small danger" onClick={() => void cancelJob(s.id)}>
                      取消
                    </button>
                  )}
                  {job.status === 'failed' && <div className="hint err-text">✗ {(job.error || '更新失败').slice(0, 300)}</div>}
                  {job.status === 'cancelled' && <div className="hint">已取消</div>}
                  {job.status === 'done' && <div className="hint">✓ 更新完成</div>}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="card">
        <h3>说明</h3>
        <p className="hint">
          版本检测全部经由各通道自身完成（winget list / winget upgrade、npm ls / npm view、各 CLI 自带 --version、注册表
          ARP 与 GitHub Releases API），网络访问仅经 curl.exe 子进程。「一键更新」仅在你点击后执行，更新命令可随时取消；
          Kimi / Grok 走其自带更新器；DeepSeek Harness 从 GitHub 拉取源码包并在本地重建后原子换目录。
        </p>
      </div>

      {confirm && (
        <div className="menu-mask" onClick={() => setConfirm(null)}>
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-title">确认更新 {confirm.status.name}</div>
            {(confirm.status.installed || confirm.status.latest) && (
              <div className="menu-path">
                {confirm.status.installed ?? '?'} → {confirm.status.latest ?? '最新版（由更新器确认）'}
              </div>
            )}
            {confirm.status.channelKind === 'github' && (
              <div className="menu-note">
                将下载 GitHub 源码包并在本地重建（npm install），约需数分钟；旧目录备份为
                安装目录.bak-时间戳；数据目录 ~/.dsh 不受影响。更新过程中请勿运行 DeepSeek Harness。
              </div>
            )}
            {confirm.processName && (
              <div className="menu-note">
                该应用正在运行（{confirm.processName}），更新将需要关闭它。
                {confirm.status.id === 'zcode' ? '注意：ZCode 承载本应用所在的会话环境，更新会导致其退出。' : ''}
              </div>
            )}
            <div className="drawer-actions">
              <button className="btn" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button className="btn danger" onClick={() => void confirmUpdate()}>
                确认更新
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
