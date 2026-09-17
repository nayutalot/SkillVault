// Docker 页：容器/镜像管理（交互参考 Portainer，风格沿用本应用浅色主题）。
// - 引擎未运行是常态：横幅给出 pipe 错误摘要 + 「启动 Docker Desktop」按钮，容器/镜像区显示占位不报错；
// - 空容器/空镜像也是常态：文案引导 docker run 或 Docker Desktop 拉起；
// - 危险动作（删除容器 / stop / restart / 删除镜像）全部弹确认框，删除注明「将强制移除」；日志走抽屉。
import { useCallback, useEffect, useState } from 'react'
import type {
  DockerActionName,
  DockerContainer,
  DockerContainersResult,
  DockerImagesResult,
  DockerInfo
} from '../../../shared/types'
import type { Notify } from '../App'

/** 容器状态徽章归类：running 绿 / exited·created 灰 / 其他（paused 等）黄 */
function stateBadge(state: string): { cls: string; label: string } {
  if (state === 'running') return { cls: 'ok', label: '运行中' }
  if (state === 'exited' || state === 'created' || state === 'dead') return { cls: 'muted', label: state }
  return { cls: 'warn', label: state }
}

type ConfirmAction =
  | { kind: 'container'; action: DockerActionName; name: string }
  | { kind: 'image'; id: string }

type LogsDrawer = { name: string; text: string; loading: boolean }

export default function DockerPage({ notify }: { notify: Notify }): React.JSX.Element {
  const [info, setInfo] = useState<DockerInfo | null>(null)
  const [containers, setContainers] = useState<DockerContainer[]>([])
  const [images, setImages] = useState<DockerImagesResult['images']>([])
  const [loading, setLoading] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const [logs, setLogs] = useState<LogsDrawer | null>(null)
  const [startingEngine, setStartingEngine] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    // info / containers / images 并行取数；引擎下线时后两者本就返回空列表，由 info 决定占位
    const [ri, rc, rg] = await Promise.all([
      window.api.dockerInfo(),
      window.api.dockerContainers(),
      window.api.dockerImages()
    ])
    setLoading(false)
    setInfo(ri.ok ? ri.data : { state: 'error', error: ri.error })
    const emptyContainers: DockerContainersResult = { containers: [] }
    setContainers(rc.ok ? rc.data.containers : emptyContainers.containers)
    setImages(rg.ok ? rg.data.images : [])
    if (!rc.ok && ri.ok && ri.data.state === 'online') notify('err', rc.error || '容器列表获取失败')
  }, [notify])

  useEffect(() => {
    void load()
  }, [load])

  const engineDown = info?.state === 'engine-down'

  const startEngine = async (): Promise<void> => {
    setStartingEngine(true)
    const r = await window.api.dockerStartEngine()
    setStartingEngine(false)
    if (!r.ok) {
      notify('err', r.error || '启动失败')
      return
    }
    notify('ok', r.data.hint || 'Docker Desktop 已拉起')
  }

  const openLogs = async (name: string): Promise<void> => {
    setLogs({ name, text: '', loading: true })
    const r = await window.api.dockerLogs(name)
    setLogs((p) => (p && p.name === name ? { name, text: r.ok ? r.data.text : '', loading: false } : p))
    const errMsg = r.ok ? r.data.error : r.error
    if (errMsg) notify('err', errMsg)
  }

  const refreshLogs = async (): Promise<void> => {
    if (logs) void openLogs(logs.name)
  }

  const runConfirm = async (): Promise<void> => {
    if (!confirm) return
    const c = confirm
    setConfirm(null)
    if (c.kind === 'container') {
      const r = await window.api.dockerAction(c.name, c.action)
      if (!r.ok) {
        notify('err', r.error || '操作失败')
        return
      }
      notify('ok', `容器 ${c.name} ${ACTION_LABEL[c.action]}完成`)
    } else {
      const r = await window.api.dockerImageRemove(c.id)
      if (!r.ok) {
        notify('err', r.error || '镜像删除失败')
        return
      }
      notify('ok', '镜像已删除')
    }
    void load()
  }

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
        <span className="hint">容器 {containers.length} 个 · 镜像 {images.length} 个</span>
      </div>

      {/* 引擎状态横幅：在线给版本，未运行给 pipe 错误摘要 + 拉起按钮 */}
      {!info && <div className="banner warn">正在检测 Docker 引擎…</div>}
      {info?.state === 'online' && (
        <div className="banner ok">
          Docker 引擎在线 · Client {info.clientVersion ?? '?'} · Server {info.serverVersion ?? '?'}
        </div>
      )}
      {engineDown && (
        <div className="banner err">
          <div>Docker 引擎未运行：{info.error}</div>
          <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn small primary" disabled={startingEngine} onClick={() => void startEngine()}>
              {startingEngine ? '启动中…' : '启动 Docker Desktop'}
            </button>
            <span>引擎启动约需 10-30 秒，稍后点上方「刷新」。</span>
          </div>
        </div>
      )}
      {info?.state === 'error' && <div className="banner err">docker 命令失败：{info.error}</div>}

      {/* 容器表：引擎未运行时显示占位，不报错 */}
      <div className="card">
        <h3>容器</h3>
        {engineDown ? (
          <div className="empty">引擎未运行，容器列表暂不可用。启动 Docker Desktop 后点「刷新」。</div>
        ) : containers.length === 0 ? (
          <div className="empty">还没有任何容器（docker run 或 Docker Desktop 拉起后这里会出现）</div>
        ) : (
          <table className="table docker-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>镜像</th>
                <th>状态</th>
                <th>status</th>
                <th>端口</th>
                <th>CPU</th>
                <th>内存</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => {
                const badge = stateBadge(c.state)
                const running = c.state === 'running'
                return (
                  <tr key={c.id || c.name}>
                    <td className="dock-name">{c.name}</td>
                    <td className="dock-mono">{c.image}</td>
                    <td>
                      <span className={`badge ${badge.cls}`}>{badge.label}</span>
                    </td>
                    <td className="dock-status">{c.status}</td>
                    <td className="dock-mono">{c.ports || '—'}</td>
                    <td className="dock-mono">{c.cpuPerc ?? '—'}</td>
                    <td className="dock-mono">{c.memUsage ?? '—'}</td>
                    <td>
                      <span className="dock-actions">
                        {!running && (
                          <button className="btn small" onClick={() => setConfirm({ kind: 'container', action: 'start', name: c.name })}>
                            启动
                          </button>
                        )}
                        {running && (
                          <button className="btn small" onClick={() => setConfirm({ kind: 'container', action: 'stop', name: c.name })}>
                            停止
                          </button>
                        )}
                        {running && (
                          <button className="btn small" onClick={() => setConfirm({ kind: 'container', action: 'restart', name: c.name })}>
                            重启
                          </button>
                        )}
                        <button className="btn small" onClick={() => void openLogs(c.name)}>
                          日志
                        </button>
                        <button
                          className="btn small danger"
                          onClick={() => setConfirm({ kind: 'container', action: 'remove', name: c.name })}
                        >
                          删除
                        </button>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 镜像表 */}
      <div className="card">
        <h3>镜像</h3>
        {engineDown ? (
          <div className="empty">引擎未运行，镜像列表暂不可用。</div>
        ) : images.length === 0 ? (
          <div className="empty">还没有任何镜像（docker pull 或 Docker Desktop 拉取后这里会出现）</div>
        ) : (
          <table className="table docker-table">
            <thead>
              <tr>
                <th>仓库:标签</th>
                <th>大小</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {images.map((img) => (
                <tr key={img.id || `${img.repository}:${img.tag}`}>
                  <td className="dock-mono">
                    {img.repository}:{img.tag}
                  </td>
                  <td>{img.size}</td>
                  <td className="dock-status">{img.created}</td>
                  <td>
                    <button
                      className="btn small danger"
                      onClick={() => setConfirm({ kind: 'image', id: img.id })}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 容器日志抽屉：tail 200 文本 + 刷新 */}
      {logs && (
        <>
          <div className="drawer-mask" onClick={() => setLogs(null)} />
          <div className="drawer">
            <div className="drawer-head">
              <h3>日志 · {logs.name}</h3>
              <button className="btn small" onClick={() => setLogs(null)}>
                关闭
              </button>
            </div>
            <div className="drawer-actions">
              <button className="btn small" disabled={logs.loading} onClick={() => void refreshLogs()}>
                {logs.loading ? '加载中…' : '刷新'}
              </button>
              <span className="hint">最近 200 行</span>
            </div>
            <pre className="vc-log dock-log">{logs.text || (logs.loading ? '加载中…' : '（无日志输出）')}</pre>
          </div>
        </>
      )}

      {/* 确认框：删除注明强制移除；stop/restart 同样确认 */}
      {confirm && (
        <div className="menu-mask" onClick={() => setConfirm(null)}>
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-title">{confirmTitle(confirm)}</div>
            <div className="menu-note">{confirmNote(confirm)}</div>
            <div className="drawer-actions">
              <button className="btn" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button className={`btn ${confirm.kind === 'image' || confirm.action === 'remove' ? 'danger' : 'primary'}`} onClick={() => void runConfirm()}>
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const ACTION_LABEL: Record<DockerActionName, string> = {
  start: '启动',
  stop: '停止',
  restart: '重启',
  remove: '删除'
}

function confirmTitle(c: ConfirmAction): string {
  return c.kind === 'image'
    ? `确认删除镜像 ${c.id.slice(0, 12)}`
    : `确认${ACTION_LABEL[c.action]}容器 ${c.name}`
}

function confirmNote(c: ConfirmAction): string {
  if (c.kind === 'image') return '将执行 docker rmi，删除该镜像（未被容器引用时才可成功）。'
  if (c.action === 'remove') return '将执行 docker rm -f，强制移除容器（运行中也会先强制终止），不可恢复。'
  if (c.action === 'stop') return '将执行 docker stop，优雅停止该容器。'
  if (c.action === 'restart') return '将执行 docker restart，重启该容器。'
  return '将执行 docker start，启动该容器。'
}
