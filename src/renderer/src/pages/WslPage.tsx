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
  if (!stats) return <div className="hint">指标不可用（发行版可能刚启动或读取超时）</div>
  // 任务管理器口径的「已用内存」= total - available
  const memUsed = stats.memTotalKb != null && stats.memAvailKb != null ? stats.memTotalKb - stats.memAvailKb : null
  return (
    <div className="wsl-stats">
      <MemBar label="内存" usedKb={memUsed} totalKb={stats.memTotalKb} />
      <div className="wsl-meter-row">
        <span className="wsl-meter-label">负载</span>
        <span className="wsl-meter-value">loadavg {stats.load1 == null ? '?' : stats.load1.toFixed(2)}</span>
      </div>
      <MemBar label="磁盘(/)" usedKb={stats.diskUsed ? parseSizeToKb(stats.diskUsed) : null} totalKb={stats.diskTotal ? parseSizeToKb(stats.diskTotal) : null} />
      <div className="wsl-meter-row">
        <span className="wsl-meter-label">运行</span>
        <span className="wsl-meter-value">已运行 {fmtUptime(stats.uptimeSec)} · 磁盘 {stats.diskPct == null ? '?' : `${stats.diskPct}%`}</span>
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
        notify('err', r.error || 'wsl --shutdown 失败')
        return
      }
      notify('ok', '已执行 wsl --shutdown')
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
    notify('ok', c.action === 'terminate' ? `已终止 ${c.name}` : `已发出启动指令：${c.name}`)
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
          自动刷新（10 秒）
        </label>
        <button className="btn small danger" onClick={() => setConfirm({ action: 'shutdownAll', stage: 1 })}>
          关机全部（wsl --shutdown）
        </button>
      </div>

      {/* 主机卡：vmmemWSL 内存 + 发行版计数 */}
      <div className="card wsl-host-card">
        <h3>WSL 虚拟机（宿主侧）</h3>
        <div className="wsl-meter-row">
          <span className="wsl-meter-label">vmmem 内存</span>
          <div className="meter">
            <div className={`meter-fill ${hostPct == null ? 'muted' : barCls(hostPct)}`} style={{ width: `${hostPct ?? 0}%` }} />
          </div>
          <span className="wsl-meter-value">
            {data?.host ? `${data.host.name} · ${(data.host.wsBytes / MB).toFixed(0)} MB` : 'vmmemWSL 进程未运行（WSL 空闲或已关闭）'}
            <span className="hint">（满刻度参照 {HOST_VM_SCALE_MB / 1024} GB）</span>
          </span>
        </div>
        <div className="hint">
          发行版：{runningCount} 运行 / {distros.length} 总数
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
            {d.managedByDocker && <div className="hint">（由 Docker Desktop 管理）</div>}
            {d.state === 'Running' && !d.managedByDocker && <StatsView stats={d.stats} />}
            {d.state === 'Running' && d.managedByDocker && <div className="hint">不读取指标，避免干扰 Docker Desktop。</div>}
            {d.state === 'Stopped' && <div className="hint">已停止（不读取指标，也绝不因此拉起发行版）</div>}
            {d.state === 'Other' && <div className="hint">过渡态（Installing/Converting 等），操作请稍候重试。</div>}
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
        {distros.length === 0 && <div className="card empty">未检测到任何 WSL 发行版（wsl -l -v 无输出）。</div>}
      </div>

      <div className="card">
        <h3>说明</h3>
        <p className="hint">
          运行中发行版的指标通过一次 <code>wsl -d &lt;name&gt; -e sh -c …</code> 复合读取 /proc（meminfo、loadavg、df、uptime），
          已停止的发行版不会被读取或启动；docker-desktop 由 Docker Desktop 管理只显示状态。
          「终止」= wsl --terminate；「启动」= wsl -d &lt;name&gt; -e true；「关机全部」= wsl --shutdown（会影响所有发行版）。
        </p>
      </div>

      {/* 确认框：terminate / boot 单次；shutdownAll 双重（stage 1 警告 → stage 2 再确认） */}
      {confirm && (
        <div className="menu-mask" onClick={() => setConfirm(null)}>
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            {confirm.action === 'shutdownAll' ? (
              <>
                <div className="menu-title">{confirm.stage === 1 ? '确认关闭全部 WSL？' : '再次确认：立即执行 wsl --shutdown？'}</div>
                <div className="menu-note">
                  会关闭所有发行版，包括正在进行的 WSL 操作。
                  {confirm.stage === 2 ? ' 这是最后一次确认，点击后立即执行。' : ''}
                </div>
              </>
            ) : confirm.action === 'terminate' ? (
              <>
                <div className="menu-title">确认终止 {confirm.name}？</div>
                <div className="menu-note">将执行 wsl --terminate {confirm.name}，该发行版内所有进程会被结束（文件不受影响）。</div>
              </>
            ) : (
              <>
                <div className="menu-title">启动发行版 {confirm.name}？</div>
                <div className="menu-note">将执行 wsl -d {confirm.name} -e true 拉起该发行版。</div>
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
