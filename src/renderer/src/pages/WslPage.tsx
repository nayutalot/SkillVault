// WSL 页：任务管理器风格的资源监控。
// - 顶部主机卡：宿主 vmmemWSL 内存（16GB 满刻度参照）+ 发行版计数 + 刷新 + 自动刷新（10s 轮询，默认关）；
// - 每发行版一张卡：运行中的卡给 内存/loadavg/磁盘/uptime；已停止的卡灰态；docker-desktop 只显示状态（由 Docker Desktop 管理）；
// - 危险动作全部确认框：terminate 单次确认，shutdownAll 双重确认（警告会关闭所有发行版）；
//   boot（启动发行版）永远只由用户点击触发，绝不为了取数而启动已停止的发行版。
import { useCallback, useEffect, useState } from 'react'
import type { WslDistroStats, WslDistroView, WslOverview } from '../../../shared/types'
import type { Notify } from '../App'

const MB = 1024 * 1024
/** vmmem 内存进度条满刻度参照：16GB（WSL2 默认约分到宿主一半，16GB 是常见上限量级） */
const HOST_VM_SCALE_MB = 16 * 1024

const AUTO_REFRESH_MS = 10_000

const MB_IN_KB = 1024
const GB_IN_KB = 1024 * 1024

/** KB → 人类可读（任务管理器风格） */
function fmtKb(kb: number | null): string {
  if (kb == null) return '?'
  if (kb >= GB_IN_KB) return `${(kb / GB_IN_KB).toFixed(1)} GB`
  if (kb >= MB_IN_KB) return `${Math.round(kb / MB_IN_KB)} MB`
  return `${Math.round(kb)} KB`
}

/** uptime 秒 → 人类可读（3d 4h / 1h 51m / 12m） */
function fmtUptime(sec: number | null): string {
  if (sec == null) return '?'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function pct(used: number | null, total: number | null): number | null {
  if (used == null || total == null || total <= 0) return null
  return Math.min(100, Math.round((used / total) * 100))
}

/** 内存进度条配色：<70% 绿 / <90% 黄 / 其余红（任务管理器直觉） */
function barCls(p: number): string {
  if (p < 70) return 'ok'
  if (p < 90) return 'warn'
  return 'err'
}

function MemBar({ label, usedKb, totalKb }: { label: string; usedKb: number | null; totalKb: number | null }): React.JSX.Element {
  const p = pct(usedKb, totalKb)
  return (
    <div className="wsl-meter-row">
      <span className="wsl-meter-label">{label}</span>
      <div className="meter">
        <div className={`meter-fill ${p == null ? '' : barCls(p)}`} style={{ width: `${p ?? 0}%` }} />
      </div>
      <span className="wsl-meter-value">
        {fmtKb(usedKb)} / {fmtKb(totalKb)}（{p == null ? '?' : `${p}%`}）
      </span>
    </div>
  )
}

/** 发行版卡内统计区（stats 为 null 时给占位不报错） */
function StatsView({ stats }: { stats: WslDistroStats | null }): React.JSX.Element {
  if (!stats) return <div className="hint">暂时读不到资源占用（子系统可能刚启动或读取超时），稍后刷新再看</div>
  // 任务管理器口径的「已用内存」= total - available
  const memUsed = stats.memTotalKb != null && stats.memAvailKb != null ? stats.memTotalKb - stats.memAvailKb : null
  return (
    <div className="wsl-stats">
      <MemBar label="内存" usedKb={memUsed} totalKb={stats.memTotalKb} />
      <div className="wsl-meter-row">
        <span className="wsl-meter-label">系统负载</span>
        <span className="wsl-meter-value">loadavg {stats.load1 == null ? '?' : stats.load1.toFixed(2)}</span>
      </div>
      <MemBar label="磁盘(/) " usedKb={stats.diskUsed ? parseSizeToKb(stats.diskUsed) : null} totalKb={stats.diskTotal ? parseSizeToKb(stats.diskTotal) : null} />
      <div className="wsl-meter-row">
        <span className="wsl-meter-label">已运行</span>
        <span className="wsl-meter-value">{fmtUptime(stats.uptimeSec)} · 磁盘已用 {stats.diskPct == null ? '?' : `${stats.diskPct}%`}</span>
      </div>
    </div>
  )
}

/** df -h 的 "20G" / "1007G" 估算为 KB（仅用于进度条比例；精确值仍以原始文本展示） */
function parseSizeToKb(s: string): number | null {
  const m = /^([\d.]+)([KMGTP])$/i.exec(s.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2].toUpperCase()
  const mult: Record<string, number> = { K: 1, M: MB_IN_KB, G: GB_IN_KB, T: GB_IN_KB * 1024, P: GB_IN_KB * 1024 * 1024 }
  return Math.round(n * (mult[unit] ?? 1))
}

type ConfirmAction =
  | { action: 'terminate' | 'boot'; name: string }
  | { action: 'shutdownAll'; stage: 1 | 2 }

export default function WslPage({ notify }: { notify: Notify }): React.JSX.Element {
  const [data, setData] = useState<WslOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [auto, setAuto] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = await window.api.wslDistros()
    setLoading(false)
    if (!r.ok) {
      notify('err', r.error || 'WSL 状态获取失败')
      return
    }
    setData(r.data)
  }, [notify])

  useEffect(() => {
    void load()
  }, [load])

  // 自动刷新：10s 轮询，默认关（开关由用户打开）
  useEffect(() => {
    if (!auto) return
    const t = window.setInterval(() => void load(), AUTO_REFRESH_MS)
    return () => window.clearInterval(t)
  }, [auto, load])

  const runConfirm = async (): Promise<void> => {
    if (!confirm) return
    // shutdownAll 走两段确认：stage 1 → stage 2 → 执行
    if (confirm.action === 'shutdownAll') {
      if (confirm.stage === 1) {
        setConfirm({ action: 'shutdownAll', stage: 2 })
        return
      }
      setConfirm(null)
      const r = await window.api.wslAction('shutdownAll')
      if (!r.ok) {
        notify('err', r.error || '关闭失败')
        return
      }
      notify('ok', '已关闭所有 Linux 子系统')
      void load()
      return
    }
    const c = confirm
    setConfirm(null)
    const r = await window.api.wslAction(c.action, c.name)
    if (!r.ok) {
      notify('err', r.error || '操作失败')
      return
    }
    notify('ok', c.action === 'terminate' ? `已终止 ${c.name}` : `正在启动 ${c.name}…`)
    void load()
  }

  const distros = data?.distros ?? []
  const runningCount = distros.filter((d) => d.state === 'Running').length
  const hostMb = data?.host ? data.host.wsBytes / MB : null
  const hostPct = hostMb == null ? null : Math.min(100, Math.round((hostMb / HOST_VM_SCALE_MB) * 100))

  return (
    <div>
      <div className="toolbar">
        <button className="btn primary" disabled={loading} onClick={() => void load()}>
          {loading ? (
            <>
              <span className="spinner" />
              刷新中…
            </>
          ) : (
            '刷新'
          )}
        </button>
        <label className="hint wsl-toggle">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          每 10 秒自动刷新
        </label>
        <button className="btn small danger" onClick={() => setConfirm({ action: 'shutdownAll', stage: 1 })}>
          关闭所有 Linux 子系统
        </button>
      </div>

      {/* 主机卡：vmmemWSL 内存 + 发行版计数 */}
      <div className="card wsl-host-card">
        <h3>Linux 子系统共用的虚拟机（运行在你的 Windows 上）</h3>
        <div className="wsl-meter-row">
          <span className="wsl-meter-label">已用内存</span>
          <div className="meter">
            <div className={`meter-fill ${hostPct == null ? 'muted' : barCls(hostPct)}`} style={{ width: `${hostPct ?? 0}%` }} />
          </div>
          <span className="wsl-meter-value">
            {data?.host ? `${data.host.name} · ${(data.host.wsBytes / MB).toFixed(0)} MB` : '当前没有 Linux 子系统在运行（内存占用为 0）'}
            <span className="hint">（进度条按 {HOST_VM_SCALE_MB / 1024} GB 满格估算）</span>
          </span>
        </div>
        <div className="hint">
          共 {distros.length} 个 Linux 子系统，其中 {runningCount} 个正在运行
          {data?.error ? ` · ${data.error}` : ''}
        </div>
      </div>

      {/* 发行版卡片栅格 */}
      <div className="wsl-grid">
        {distros.map((d: WslDistroView) => (
          <div key={d.name} className={`card wsl-card${d.state === 'Stopped' ? ' stopped' : ''}`}>
            <div className="wsl-card-head">
              <span className="wsl-card-name">{d.name}</span>
              {d.isDefault && <span className="tag">默认</span>}
              <span className={`badge ${d.state === 'Running' ? 'ok' : 'muted'}`}>
                {d.state === 'Running' ? '运行中' : d.state === 'Stopped' ? '已停止' : '过渡态'}
              </span>
              <span className="tag">WSL {d.version}</span>
            </div>
            {d.managedByDocker && <div className="hint">（由 Docker Desktop 管理，本页不改动它）</div>}
            {d.state === 'Running' && !d.managedByDocker && <StatsView stats={d.stats} />}
            {d.state === 'Running' && d.managedByDocker && <div className="hint">不读取它的资源占用，避免影响 Docker Desktop。</div>}
            {d.state === 'Stopped' && <div className="hint">已停止。这里只显示状态，不会为了看数据把它启动起来。</div>}
            {d.state === 'Other' && <div className="hint">正在安装/转换等过程中，稍后刷新再看。</div>}
            {d.statsError && <div className="hint err-text">读取失败：{d.statsError}</div>}
            <div className="wsl-card-actions">
              {d.state === 'Stopped' && (
                <button className="btn small primary" onClick={() => setConfirm({ action: 'boot', name: d.name })}>
                  启动
                </button>
              )}
              <button className="btn small" onClick={() => setConfirm({ action: 'terminate', name: d.name })}>
                终止
              </button>
            </div>
          </div>
        ))}
        {distros.length === 0 && <div className="card empty">没有检测到任何 Linux 子系统（WSL）。</div>}
      </div>

      <div className="card">
        <h3>说明</h3>
        <p className="hint">
          运行中的子系统，程序会进去一次性读取内存、负载、磁盘和运行时长；已停止的子系统不会被读取，更不会被自动启动。
          由 Docker Desktop 管理的子系统只显示状态。
          「终止」= 立刻结束这个子系统里的所有程序（文件不受影响）；「启动」= 把它开起来；「关闭所有 Linux 子系统」= 全部关掉。
        </p>
      </div>

      {/* 确认框：terminate / boot 单次；shutdownAll 双重（stage 1 警告 → stage 2 再确认） */}
      {confirm && (
        <div className="menu-mask" onClick={() => setConfirm(null)}>
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            {confirm.action === 'shutdownAll' ? (
              <>
                <div className="menu-title">
                  {confirm.stage === 1 ? '确定关闭所有 Linux 子系统吗？' : '最后确认：立刻关闭全部？'}
                </div>
                <div className="menu-note">
                  所有子系统里的程序都会被结束，正在进行的操作会中断（文件不受影响）。
                  {confirm.stage === 2 ? ' 这是最后一次确认，点击后立即执行。' : ''}
                </div>
              </>
            ) : confirm.action === 'terminate' ? (
              <>
                <div className="menu-title">确定终止 {confirm.name}？</div>
                <div className="menu-note">
                  这个子系统里正在运行的所有程序会被立刻结束（文件不受影响）。之后可以再点「启动」把它开回来。
                </div>
              </>
            ) : (
              <>
                <div className="menu-title">启动 {confirm.name}？</div>
                <div className="menu-note">会把这个 Linux 子系统启动起来（需要几秒到几十秒）。</div>
              </>
            )}
            <div className="drawer-actions">
              <button className="btn" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button className={`btn ${confirm.action === 'shutdownAll' || confirm.action === 'terminate' ? 'danger' : 'primary'}`} onClick={() => void runConfirm()}>
                {confirm.action === 'shutdownAll' && confirm.stage === 1 ? '继续' : '确认执行'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
