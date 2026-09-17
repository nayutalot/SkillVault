import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentScan, AppSettings, LinkState, ScanReport, SyncResult, WslScanPayload } from '../../../shared/types'
import { wslVaultSkillDir } from '../../../shared/paths'
import type { AgentMdInfo } from '../../../preload'
import type { Notify, PageName } from '../App'

const SYMBOL: Record<LinkState, string> = {
  linked: '✓',
  missing: '✗',
  'wrong-target': '~',
  'real-dir': '!',
  'vault-missing': '∅'
}

const STATE_LABEL: Record<LinkState, string> = {
  linked: '已链接',
  missing: '未链接',
  'wrong-target': '链接目标错误',
  'real-dir': '真实目录冲突',
  'vault-missing': 'vault 缺失'
}

function joinSkillDir(agent: AgentScan, skill: string): string {
  return agent.platform === 'windows' ? `${agent.skillsDir}\\${skill}` : `${agent.skillsDir}/${skill}`
}

type PathRow = {
  label: string
  path: string
  state?: LinkState
  /** WSL 侧路径：额外提供「资源管理器打开」按钮 */
  wsl?: boolean
}

type Props = { notify: Notify; goTo: (p: PageName) => void }

/** 把第二阶段（WSL）结果并入 Windows 侧报告：linux agent 追加为列，companion description 补空 */
function mergeWsl(base: ScanReport, w: WslScanPayload): ScanReport {
  const agents = [...base.agents, ...w.agents.filter((a) => a.platform === 'linux')]
  const skills = base.skills.map((s) => {
    const hit = w.skills.find((x) => x.name === s.name)
    return hit && !s.description && typeof hit.description === 'string' ? { ...s, description: hit.description } : s
  })
  return { ...base, agents, skills }
}

/** 缓存时间戳 → HH:MM（缓存标记展示用） */
function fmtCacheTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** WSL 第二阶段状态：pending 检测中 / stale 展示缓存 / unavailable 无任何 WSL 数据 / null 已就绪 */
type WslPhase = 'pending' | 'stale' | 'unavailable' | null

export default function Dashboard({ notify, goTo }: Props): React.JSX.Element {
  const [report, setReport] = useState<ScanReport | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [menu, setMenu] = useState<{ agent: AgentScan; skill: string } | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [agentMenu, setAgentMenu] = useState<AgentScan | null>(null)
  const [agentDetail, setAgentDetail] = useState<{ fileName: string; info: AgentMdInfo } | null>(null)
  const [pendingRepair, setPendingRepair] = useState<AgentScan | null>(null)
  const [repairRes, setRepairRes] = useState<{ agent: string; steps: string[]; state: string } | null>(null)
  const [syncRes, setSyncRes] = useState<SyncResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [wslPhase, setWslPhase] = useState<WslPhase>(null)
  const [wslReason, setWslReason] = useState('')
  const [wslCacheTs, setWslCacheTs] = useState<number | null>(null)
  /** 最新请求获胜防护：load/loadWsl 可被并发触发（刷新/建链后自动 load、重试按钮），
   *  scanWsl 最长 20s+，慢的旧响应后到会把新状态整体覆盖（刚建的链接在 UI 上回退为未链接） */
  const seqRef = useRef(0)

  /** 第二阶段：WSL 侧扫描（异步、不阻塞矩阵首渲染）；stale 时带缓存标记与重试入口 */
  const loadWsl = useCallback(async (base: ScanReport): Promise<void> => {
    const seq = ++seqRef.current
    setWslPhase('pending')
    setWslReason('')
    const w = await window.api.scanWsl()
    if (seq !== seqRef.current) return // 已有更新的加载发起，本次结果作废
    if (!w.ok) {
      setWslReason(w.error || 'WSL 扫描 IPC 失败')
      setWslPhase('unavailable')
      return
    }
    const { report: payload, stale, reason } = w.data
    if (payload) {
      setReport(mergeWsl(base, payload))
      setWslCacheTs(payload.ts)
      setWslPhase(stale ? 'stale' : null)
      if (stale) setWslReason(reason ?? '')
    } else {
      setWslReason(reason ?? '')
      setWslPhase('unavailable')
    }
  }, [])

  /** 两阶段加载：先 scanWindows 立即渲染矩阵（不等 WSL），再异步并入 WSL 列与描述 */
  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setMenu(null)
    setAgentMenu(null)
    setAgentDetail(null)
    setPendingRepair(null)
    const r = await window.api.scanWindows()
    if (seq !== seqRef.current) return
    if (!r.ok) {
      setWslPhase(null)
      notify('err', r.error || '扫描失败')
      return
    }
    setReport(r.data)
    const s = await window.api.getSettings()
    if (seq !== seqRef.current) return
    if (s.ok) setSettings(s.data)
    void loadWsl(r.data)
  }, [notify, loadWsl])

  useEffect(() => {
    void load()
  }, [load])

  const runSync = async (): Promise<void> => {
    setBusy(true)
    const r = await window.api.sync()
    setBusy(false)
    if (!r.ok) {
      notify('err', r.error || '同步失败')
      return
    }
    setSyncRes(r.data)
    notify(
      r.data.conflicts.length ? 'err' : 'ok',
      r.data.conflicts.length ? `同步完成，但有 ${r.data.conflicts.length} 个冲突` : '双侧同步完成'
    )
  }

  const cellAction = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setMenu(null)
    const r = await fn()
    if (r.ok) {
      notify('ok', '操作成功')
      await load()
    } else {
      notify('err', r.error || '操作失败')
    }
  }

  const state = menu ? (report?.vaultOk ? menu.agent.links[menu.skill] ?? 'missing' : 'vault-missing') : null

  // ---------- 详情面板（F2 / F3） ----------

  const detailMeta = detail ? report?.skills.find((s) => s.name === detail) ?? null : null

  const copy = async (p: string): Promise<void> => {
    const r = await window.api.copyPath(p)
    if (r.ok) notify('ok', `已复制：${p}`)
    else notify('err', r.error || '复制失败')
  }

  const openAction = async (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string): Promise<void> => {
    const r = await fn()
    if (r.ok) notify('ok', okMsg)
    else notify('err', r.error || '操作失败')
  }

  /** 详情面板「所在目录」路径集合（展示用；复制/打开的安全性由主进程校验） */
  const detailPaths = (): PathRow[] => {
    if (!detail || !report) return []
    const rows: PathRow[] = []
    if (settings?.vaultPath) {
      rows.push({ label: 'vault 真身目录', path: `${settings.vaultPath}\\skills\\${detail}` })
    }
    for (const a of report.agents.filter((x) => x.platform === 'windows')) {
      rows.push({
        label: `Windows agent ${a.name}`,
        path: joinSkillDir(a, detail),
        state: report.vaultOk ? a.links[detail] ?? 'missing' : 'vault-missing'
      })
    }
    rows.push({ label: 'WSL vault', path: wslVaultSkillDir(detail), wsl: true })
    for (const a of report.agents.filter((x) => x.platform === 'linux')) {
      rows.push({ label: `WSL agent ${a.name}`, path: joinSkillDir(a, detail) })
    }
    return rows
  }

  /** 详情面板逐 agent 链接状态小表：Windows 组 + WSL 组（vault 不可用时统一 vault-missing） */
  const detailLinkRows = (): { platform: 'windows' | 'linux'; name: string; state: LinkState }[] => {
    if (!detail || !report) return []
    return report.agents.map((a) => ({
      platform: a.platform,
      name: a.name,
      state: report.vaultOk ? a.links[detail] ?? 'missing' : 'vault-missing'
    }))
  }

  const openMd = async (): Promise<void> => {
    if (!detail) return
    const r = await window.api.openSkillMd(detail)
    if (!r.ok) {
      notify('err', r.error || '操作失败')
      return
    }
    if (r.data.via === 'vscode') {
      notify('ok', '已用 VS Code 打开 SKILL.md')
      return
    }
    // fallback 必须透出原因：直启失败（如 env 污染）≠ 假成功
    notify(
      r.data.reason ? 'err' : 'ok',
      r.data.reason
        ? `VS Code 未能启动（${r.data.reason}），已改用系统默认程序打开 SKILL.md`
        : '未解析到 VS Code，已用系统默认程序打开 SKILL.md（fallback）'
    )
  }

  // ---------- 子智能体（agentsDir + vault agents/*.md） ----------

  /** 配置了 agentsDir 的 machine-agent 行（保持扫描顺序：Windows 在前，WSL 到达后并入） */
  const agentRows = report?.agents.filter((a) => a.agentsDir) ?? []

  /** 点击 .md 文件：主进程三重校验后返回前 40 行预览 + vault 绝对路径 */
  const openAgentFile = async (fileName: string): Promise<void> => {
    const r = await window.api.readAgentMd(fileName)
    if (!r.ok) {
      notify('err', r.error || '读取失败')
      return
    }
    setAgentDetail({ fileName, info: r.data })
  }

  /** agentsDir 一键修复（Windows）：确认框在下方单独渲染，确认后调 agents:repair 并回显步骤日志 */
  const runRepair = async (a: AgentScan): Promise<void> => {
    setPendingRepair(null)
    setAgentMenu(null)
    const r = await window.api.repairAgentsDir(a.name)
    if (!r.ok) {
      notify('err', r.error || '修复失败')
      return
    }
    setRepairRes({ agent: a.name, steps: r.data.steps, state: r.data.state })
    if (r.data.state === 'linked') notify('ok', a.name + ' agentsDir 已修复（' + (r.data.note ?? '已链接') + '）')
    else notify('err', '修复后仍未链接（' + r.data.state + '），详见步骤日志')
    await load()
  }

  const openAgentMd = async (): Promise<void> => {
    if (!agentDetail) return
    const r = await window.api.openAgentMd(agentDetail.fileName)
    if (!r.ok) {
      notify('err', r.error || '操作失败')
      return
    }
    if (r.data.via === 'vscode') {
      notify('ok', '已用 VS Code 打开子智能体定义')
      return
    }
    notify(
      r.data.reason ? 'err' : 'ok',
      r.data.reason
        ? `VS Code 未能启动（${r.data.reason}），已改用系统默认程序打开`
        : '未解析到 VS Code，已用系统默认程序打开（fallback）'
    )
  }

  const agentCellAction = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setAgentMenu(null)
    const r = await fn()
    if (r.ok) {
      notify('ok', '操作成功')
      await load()
    } else {
      notify('err', r.error || '操作失败')
    }
  }

  const agentMenuState = agentMenu
    ? (report?.vaultOk
        ? agentMenu.agentsDirState ?? 'missing'
        : 'vault-missing')
    : null

  return (
    <div>
      <div className="toolbar">
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void runSync()}>
          {busy ? '同步中…' : '同步'}
        </button>
        <button className="btn" onClick={() => goTo('import')}>
          导入
        </button>
        <button className="btn" onClick={() => goTo('doctor')}>
          体检
        </button>
      </div>

      {report && !report.vaultOk && (
        <div className="banner err">
          vault 不可用（默认 C:\Users\sakuya\SkillVault 不存在或不是 git 仓库）。请先完成迁移，或到设置页检查路径。
        </div>
      )}
      {wslPhase === 'pending' && (
        <div className="banner warn">WSL 检测中…（矩阵已先按 Windows 侧渲染，WSL 列与描述稍后并入）</div>
      )}
      {wslPhase === 'stale' && (
        <div className="banner warn">
          WSL companion 本次不可达（{wslReason}）。当前展示缓存 {wslCacheTs !== null ? fmtCacheTime(wslCacheTs) : '?'}{' '}
          的扫描结果。
          <button className="btn small" onClick={() => report && void loadWsl(report)}>
            重试
          </button>
        </div>
      )}
      {wslPhase === 'unavailable' && (
        <div className="banner warn">
          WSL 侧 companion 不可达（Ubuntu / /root/skill-vault），矩阵缺少 WSL 列{wslReason ? `：${wslReason}` : ''}。
          <button className="btn small" onClick={() => report && void loadWsl(report)}>
            重试
          </button>
        </div>
      )}
      {report && report.vaultOk && (
        <div className="banner ok">
          vault 正常 · {report.skills.length} 个 skill · {report.agents.filter((a) => a.platform === 'windows').length} 个
          Windows agent · {report.agents.filter((a) => a.platform === 'linux').length} 个 WSL agent
        </div>
      )}

      <div className="card">
        <table className="matrix">
          <thead>
            <tr>
              <th>skill</th>
              {report?.agents.map((a) => (
                <th key={a.name} title={a.skillsDir}>
                  <div>{a.name}</div>
                  <div className="th-sub">{a.platform === 'windows' ? 'Windows' : 'WSL'}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report?.skills.length === 0 && (
              <tr>
                <td colSpan={1 + report.agents.length} className="empty">
                  vault 中还没有 skill，请先到「导入」页迁移。
                </td>
              </tr>
            )}
            {report?.skills.map((s) => (
              <tr key={s.name}>
                <td className="skill-name">
                  <button
                    className="skill-link"
                    title={`查看 ${s.name} 详情`}
                    onClick={() => setDetail(s.name)}
                  >
                    {s.name}
                  </button>
                  {!s.hasSkillMd && <span className="tag warn">缺 SKILL.md</span>}
                  {/* 截断交给 CSS ellipsis（中文代理对安全），title 悬停显示全文 */}
                  {s.description ? (
                    <div className="skill-desc" title={s.description}>
                      {s.description}
                    </div>
                  ) : (
                    <div className="skill-desc none">（无描述）</div>
                  )}
                </td>
                {report.agents.map((a) => {
                  const st = report.vaultOk ? a.links[s.name] ?? 'missing' : 'vault-missing'
                  return (
                    <td key={a.name}>
                      <button
                        className={`cell cell-${st}`}
                        title={`${a.name} / ${s.name}: ${STATE_LABEL[st]}`}
                        onClick={() => setMenu({ agent: a, skill: s.name })}
                      >
                        {SYMBOL[st]}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="legend">
          ✓ 已链接 · ✗ 未链接 · ~ 目标错误 · ! 真实目录 · ∅ vault 缺失 · 点击 skill 名查看详情
        </div>
      </div>

      {report && report.vaultOk && (
        <div className="card">
          <h3>子智能体</h3>
          {agentRows.length === 0 ? (
            <div className="empty">registry 中还没有配置 agentsDir 的 agent（可在设置页为 agent 填写 agents 目录）。</div>
          ) : (
            <table className="matrix agent-table">
              <thead>
                <tr>
                  <th>agent</th>
                  <th>agentsDir 状态</th>
                  <th>vault agents/*.md（点击查看）</th>
                </tr>
              </thead>
              <tbody>
                {agentRows.map((a) => {
                  const st = a.agentsDirState ?? 'missing'
                  const repairable = a.platform === 'windows' && (st === 'real-dir' || st === 'missing' || st === 'wrong-target')
                  return (
                    <tr key={a.name}>
                      <td className="skill-name">
                        <button
                          className={`cell cell-${st}`}
                          title={`${a.name}: ${STATE_LABEL[st]}${a.agentsDirNote ? `（${a.agentsDirNote}）` : ''}\n${a.agentsDir ?? ''}`}
                          onClick={() => setAgentMenu(a)}
                        >
                          {SYMBOL[st]}
                        </button>{' '}
                        <strong>{a.name}</strong>
                        <div className="skill-desc" title={a.agentsDir}>
                          {a.agentsDir}
                        </div>
                      </td>
                      <td className={`lt-state st-${st}`}>
                        <span className={`cell cell-${st}`}>{SYMBOL[st]}</span> {STATE_LABEL[st]}
                        {a.agentsDirNote && <span className="tag">{a.agentsDirNote}</span>}
                        <div className="skill-desc none">{a.platform === 'windows' ? 'Windows' : 'WSL'}</div>
                        {repairable && (
                          <button className="btn small primary" onClick={() => setPendingRepair(a)}>
                            一键修复
                          </button>
                        )}
                      </td>
                      <td>
                        {(a.agentFiles ?? []).length === 0 ? (
                          <span className="skill-desc none">（vault agents/ 为空）</span>
                        ) : (
                          (a.agentFiles ?? []).map((f) => (
                            <button key={f} className="btn small agent-file" onClick={() => void openAgentFile(f)}>
                              {f}
                            </button>
                          ))
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {repairRes && (
            <div className={`card ${repairRes.state === 'linked' ? '' : 'card-err'}`}>
              <h4>
                agentsDir 修复日志：{repairRes.agent}（结果 {repairRes.state}）
                <button className="btn ghost small" onClick={() => setRepairRes(null)}>
                  关闭
                </button>
              </h4>
              <pre className="conflict">{repairRes.steps.join('\n')}</pre>
            </div>
          )}
          <div className="legend">
            子智能体定义整目录链接到 vault agents/（Windows junction / WSL 相对 symlink）· 状态符号同上图例
          </div>
        </div>
      )}

      {menu && state && (
        <div className="menu-mask" onClick={() => setMenu(null)}>
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-title">
              {menu.agent.name} / {menu.skill} — {STATE_LABEL[state]}
            </div>
            <div className="menu-path">{joinSkillDir(menu.agent, menu.skill)}</div>
            {(state === 'missing' || state === 'wrong-target') && (
              <button
                className="btn primary"
                onClick={() =>
                  void cellAction(() => window.api.setLink(menu.agent.name, menu.skill))
                }
              >
                {state === 'missing' ? '建立链接 → vault' : '修复链接（重建 → vault）'}
              </button>
            )}
            {(state === 'linked' || state === 'wrong-target') && (
              <button
                className="btn danger"
                onClick={() => void cellAction(() => window.api.removeLink(menu.agent.name, menu.skill))}
              >
                解除链接
              </button>
            )}
            {(state === 'linked' || state === 'real-dir') && (
              <button
                className="btn"
                onClick={() => {
                  setMenu(null)
                  void window.api.openPath(joinSkillDir(menu.agent, menu.skill))
                }}
              >
                打开目录
              </button>
            )}
            {state === 'real-dir' && (
              <div className="menu-note">
                该位置是真实目录（非链接），建议动作：到「导入」页重新导入（先删除 vault 同名项再导入）。
              </div>
            )}
            {state === 'vault-missing' && (
              <div className="menu-note">vault 中缺少该 skill 目录，无法建立链接。</div>
            )}
            <button className="btn ghost" onClick={() => setMenu(null)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {detail && (
        <div className="drawer-mask" onClick={() => setDetail(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h3>{detail}</h3>
              <button className="btn ghost small" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>

            <div>
              <div className="sec-title">简介</div>
              <div className="detail-desc">{detailMeta?.description || '（无描述）'}</div>
            </div>

            <div>
              <div className="sec-title">链接状态（点击矩阵单元格可建链/修复）</div>
              <table className="linktable">
                <tbody>
                  {['windows', 'linux'].map((plat) => {
                    const rows = detailLinkRows().filter((r) => r.platform === plat)
                    if (!rows.length) {
                      return (
                        <tr key={plat}>
                          <td className="lt-group">{plat === 'windows' ? 'Windows' : 'WSL'}</td>
                          <td className="lt-none" colSpan={2}>
                            （无 agent）
                          </td>
                        </tr>
                      )
                    }
                    return rows.map((r, i) => (
                      <tr key={r.name}>
                        {i === 0 && <td className="lt-group">{plat === 'windows' ? 'Windows' : 'WSL'}</td>}
                        {i > 0 && <td className="lt-group lt-group-cont" />}
                        <td className="lt-agent" title={report?.agents.find((a) => a.name === r.name)?.skillsDir}>
                          {r.name}
                        </td>
                        <td className={`lt-state st-${r.state}`}>
                          <span className={`cell cell-${r.state}`}>{SYMBOL[r.state]}</span> {STATE_LABEL[r.state]}
                        </td>
                      </tr>
                    ))
                  })}
                </tbody>
              </table>
              <div className="legend">✓ 已链接 · ✗ 未链接 · ~ 目标错误 · ! 真实目录 · ∅ vault 缺失</div>
            </div>

            <div>
              <div className="sec-title">所在目录</div>
              {detailPaths().map((p) => (
                <div className="path-row" key={p.label + p.path}>
                  <div className="path-main">
                    <div className="path-label">{p.label}</div>
                    <div className="path-text">{p.path}</div>
                  </div>
                  <button className="btn small" onClick={() => void copy(p.path)}>
                    复制
                  </button>
                  {p.wsl && (
                    <button
                      className="btn small"
                      title="用 \\\\wsl.localhost\\ 路径在资源管理器中打开"
                      onClick={() =>
                        void openAction(
                          () => window.api.openSkillExplorerWsl(detail),
                          '已在资源管理器中打开 WSL 目录'
                        )
                      }
                    >
                      资源管理器打开
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="drawer-actions">
              <button
                className="btn primary"
                onClick={() =>
                  void openAction(
                    () => window.api.openSkillFolder(detail),
                    '已在资源管理器中打开 vault 目录'
                  )
                }
              >
                在资源管理器打开
              </button>
              <button className="btn" onClick={() => void openMd()}>
                VS Code 打开 SKILL.md
              </button>
            </div>
          </aside>
        </div>
      )}

      {agentMenu && agentMenuState && (
        <div className="menu-mask" onClick={() => setAgentMenu(null)}>
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-title">
              {agentMenu.name} / agentsDir — {STATE_LABEL[agentMenuState]}
            </div>
            <div className="menu-path">{agentMenu.agentsDir}</div>
            {agentMenu.platform === 'windows' ? (
              <>
                {(agentMenuState === 'missing' || agentMenuState === 'wrong-target') && (
                  <button
                    className="btn primary"
                    onClick={() =>
                      void agentCellAction(() => window.api.setLink(agentMenu.name, '', 'agents'))
                    }
                  >
                    {agentMenuState === 'missing' ? '建立整目录链接 → vault' : '修复链接（重建 → vault）'}
                  </button>
                )}
                {(agentMenuState === 'linked' || agentMenuState === 'wrong-target') && (
                  <button
                    className="btn danger"
                    onClick={() => void agentCellAction(() => window.api.removeLink(agentMenu.name, '', 'agents'))}
                  >
                    解除链接
                  </button>
                )}
                {agentMenuState === 'linked' && (
                  <button
                    className="btn"
                    onClick={() => {
                      setAgentMenu(null)
                      void window.api.openAgentFolder()
                    }}
                  >
                    打开 vault agents 目录
                  </button>
                )}
              </>
            ) : (
              <div className="menu-note">
                WSL 侧建/解链请使用 companion：<code>skm agents-link --agent {agentMenu.name}</code>（体检页可检测 /mnt
                式旧链接）。
              </div>
            )}
            {agentMenuState === 'real-dir' && (
              <div className="menu-note">
                该位置是真实目录（非链接）。可关闭本窗后点行内「一键修复」，以 vault agents 为源重建硬链接共享目录。
              </div>
            )}
            {agentMenuState === 'vault-missing' && (
              <div className="menu-note">vault 中缺少 agents 目录，无法建立链接。</div>
            )}
            <button className="btn ghost" onClick={() => setAgentMenu(null)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {pendingRepair && (
        <div className="menu-mask" onClick={() => setPendingRepair(null)}>
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-title">一键修复 {pendingRepair.name} / agentsDir</div>
            <div className="menu-path">{pendingRepair.agentsDir}</div>
            <div className="menu-note">
              {'将重建 '}
              {pendingRepair.agentsDir}
              {' 为指向 vault agents 的硬链接目录（ vault 为源，多余文件将移除）。多余 .md 会先移入 vault 同级 .trash-<ts> 目录，不直接删除。'}
            </div>
            <div className="drawer-actions">
              <button className="btn" onClick={() => setPendingRepair(null)}>
                取消
              </button>
              <button className="btn danger" onClick={() => void runRepair(pendingRepair)}>
                确认修复
              </button>
            </div>
          </div>
        </div>
      )}

      {agentDetail && (
        <div className="drawer-mask" onClick={() => setAgentDetail(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h3>{agentDetail.fileName}</h3>
              <button className="btn ghost small" onClick={() => setAgentDetail(null)}>
                关闭
              </button>
            </div>

            <div>
              <div className="sec-title">vault 绝对路径</div>
              <div className="path-row">
                <div className="path-main">
                  <div className="path-text">{agentDetail.info.path}</div>
                </div>
                <button className="btn small" onClick={() => void copy(agentDetail.info.path)}>
                  复制
                </button>
              </div>
            </div>

            <div>
              <div className="sec-title">内容预览（前 40 行{agentDetail.info.truncated ? '，已截断' : ''}）</div>
              <pre className="conflict">{agentDetail.info.preview}</pre>
            </div>

            <div className="drawer-actions">
              <button
                className="btn primary"
                onClick={() =>
                  void openAction(() => window.api.openAgentFolder(), '已在资源管理器中打开 vault agents 目录')
                }
              >
                资源管理器打开
              </button>
              <button className="btn" onClick={() => void openAgentMd()}>
                VS Code 打开
              </button>
            </div>
          </aside>
        </div>
      )}

      {syncRes && (
        <div className={`card ${syncRes.conflicts.length ? 'card-err' : ''}`}>
          <h3>最近一次同步（{syncRes.conflicts.length ? '有冲突' : '成功'}）</h3>
          {syncRes.steps.map((s, i) => (
            <div key={i} className={`step ${s.ok ? 'ok' : 'fail'}`}>
              <span className="step-side">{s.side === 'windows' ? 'Win' : 'WSL'}</span>
              <span className="step-cmd">{s.cmd}</span>
              <span className={`step-badge ${s.ok ? 'ok' : 'fail'}`}>{s.ok ? 'OK' : '失败'}</span>
              {s.detail && <pre className="step-detail">{s.detail}</pre>}
            </div>
          ))}
          {syncRes.conflicts.length > 0 && (
            <div>
              <h4>冲突（原样输出，绝不 force）</h4>
              {syncRes.conflicts.map((c, i) => (
                <pre key={i} className="conflict">
                  {c}
                </pre>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
