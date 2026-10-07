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
  linked: '已建快捷方式',
  missing: '还没建快捷方式',
  'wrong-target': '快捷方式指向了别处',
  'real-dir': '这里是真实文件（未入库）',
  'vault-missing': '库里找不到'
}

/** 图例（白话：符号含义 + 该状态意味着什么） */
const LEGEND =
  '✓ 已建快捷方式（真正的文件在库里） · ✗ 还没建快捷方式 · ~ 快捷方式指向了别处 · ! 这里是真实文件（还没入库） · ∅ 库里找不到这个技能 · 点技能名看详情'

function joinSkillDir(agent: AgentScan, skill: string): string {
  return agent.platform === 'windows' ? `${agent.skillsDir}\\${skill}` : `${agent.skillsDir}/${skill}`
}

/**
 * 矩阵列头用短名：20 个 agent 并排时 "-win/-wsl/generic-" 后缀全是噪音且撑宽表格，
 * 平台信息已有 th-sub 一行展示，这里把 claude-win / generic-qoderwork-win 缩成 claude / qoderwork
 */
function shortAgentName(name: string): string {
  return name.replace(/^generic-/, '').replace(/-(win|wsl)$/, '')
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
      r.data.conflicts.length ? `同步完成，但有 ${r.data.conflicts.length} 个冲突需要处理` : 'Windows 和 WSL 都已同步'
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
      rows.push({ label: '技能库里的真身（真正的文件在这）', path: `${settings.vaultPath}\\skills\\${detail}` })
    }
    for (const a of report.agents.filter((x) => x.platform === 'windows')) {
      rows.push({
        label: `Windows Agent ${a.name}`,
        path: joinSkillDir(a, detail),
        state: report.vaultOk ? a.links[detail] ?? 'missing' : 'vault-missing'
      })
    }
    rows.push({ label: 'WSL 技能库', path: wslVaultSkillDir(detail), wsl: true })
    for (const a of report.agents.filter((x) => x.platform === 'linux')) {
      rows.push({ label: `WSL Agent ${a.name}`, path: joinSkillDir(a, detail) })
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
        ? `VS Code 没能启动（${r.data.reason}），已改用系统默认程序打开 SKILL.md`
        : '没找到 VS Code，已改用系统默认程序打开 SKILL.md'
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
    if (r.data.state === 'linked') notify('ok', a.name + ' 的子智能体目录已重建（' + (r.data.note ?? '已建好快捷方式') + '）')
    else notify('err', '重建后仍未生效（当前状态：' + r.data.state + '），详见步骤日志')
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
        ? `VS Code 没能启动（${r.data.reason}），已改用系统默认程序打开`
        : '没找到 VS Code，已改用系统默认程序打开'
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
          技能库（默认在用户目录下的 SkillVault 文件夹）找不到，或者它不是一个有效的仓库。请先完成迁移，或到设置页检查路径。
        </div>
      )}
      {wslPhase === 'pending' && (
        <div className="banner warn">正在读取 WSL 那一侧…（表格先按 Windows 的结果显示，WSL 的列稍后补上）</div>
      )}
      {wslPhase === 'stale' && (
        <div className="banner warn">
          这次连不上 WSL，暂时用上次扫描的结果（{wslCacheTs !== null ? fmtCacheTime(wslCacheTs) : '?'}）显示，可能已经过时。
          <button className="btn small" onClick={() => report && void loadWsl(report)}>
            重试
          </button>
        </div>
      )}
      {wslPhase === 'unavailable' && (
        <div className="banner warn">
          读不到 WSL 那一侧（需要 Ubuntu 与 /root/skill-vault），表格里暂时没有 WSL 的列
          {wslReason ? `：${wslReason}` : ''}。
          <button className="btn small" onClick={() => report && void loadWsl(report)}>
            重试
          </button>
        </div>
      )}
      {report && report.vaultOk && (
        <div className="banner ok">
          技能库正常 · 共 {report.skills.length} 个技能 · {report.agents.filter((a) => a.platform === 'windows').length} 个
          Windows Agent · {report.agents.filter((a) => a.platform === 'linux').length} 个 WSL Agent
        </div>
      )}

      <div className="card">
        <table className="matrix">
          <thead>
            <tr>
              <th>skill</th>
              {report?.agents.map((a) => (
                <th key={a.name} title={`${a.name} · ${a.skillsDir}`}>
                  <div>{shortAgentName(a.name)}</div>
                  <div className="th-sub">{a.platform === 'windows' ? 'Windows' : 'WSL'}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report?.skills.length === 0 && (
              <tr>
                <td colSpan={1 + report.agents.length} className="empty">
                  技能库里还没有技能。到「导入」页把各个 Agent 的技能收进来。
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
        <div className="legend">{LEGEND}</div>
      </div>

      {report && report.vaultOk && (
        <div className="card">
          <h3>子智能体</h3>
          {agentRows.length === 0 ? (
            <div className="empty">
              还没有哪个 Agent 填写了子智能体目录。到「设置」页给 Agent 填上子智能体目录，这些定义就会集中放进技能库。
            </div>
          ) : (
            <table className="matrix agent-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>这个位置的状态</th>
                  <th>技能库里的子智能体文件（点击查看内容）</th>
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
                          <span className="skill-desc none">（技能库里还没有子智能体文件）</span>
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
                子智能体目录重建日志：{repairRes.agent}（结果：
                {STATE_LABEL[repairRes.state as LinkState] ?? repairRes.state}）
                <button className="btn ghost small" onClick={() => setRepairRes(null)}>
                  关闭
                </button>
              </h4>
              <pre className="conflict">{repairRes.steps.join('\n')}</pre>
            </div>
          )}
          <div className="legend">
            子智能体定义都集中放在技能库里，各个 Agent 的位置只需要一个快捷方式指向它 · 状态符号含义见上方图例
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
                {state === 'missing' ? '建快捷方式（指向库里的文件）' : '修正快捷方式（重新指向库）'}
              </button>
            )}
            {(state === 'linked' || state === 'wrong-target') && (
              <button
                className="btn danger"
                onClick={() => void cellAction(() => window.api.removeLink(menu.agent.name, menu.skill))}
              >
                删除快捷方式
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
                打开这个文件夹
              </button>
            )}
            {state === 'real-dir' && (
              <div className="menu-note">
                这里放的是真实的技能文件，不是指向库的快捷方式，所以它和库里是两份。建议到「导入」页重新导入（先处理库里的同名项再导入）。
              </div>
            )}
            {state === 'vault-missing' && (
              <div className="menu-note">技能库里没有这个技能，所以没法建快捷方式。请先到「导入」页把它收进库里。</div>
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
              <div className="sec-title">每个 Agent 那边是什么状态（点表格里的格子可以建/修快捷方式）</div>
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
              <div className="legend">{LEGEND}</div>
            </div>

            <div>
              <div className="sec-title">这些文件都在哪</div>
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
                      在文件夹中打开
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
                    '已在资源管理器中打开技能库目录'
                  )
                }
              >
                在文件夹中打开
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
              {agentMenu.name} 的子智能体目录 — {STATE_LABEL[agentMenuState]}
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
                    {agentMenuState === 'missing' ? '建快捷方式（指向库里的子智能体目录）' : '修正快捷方式（重新指向库）'}
                  </button>
                )}
                {(agentMenuState === 'linked' || agentMenuState === 'wrong-target') && (
                  <button
                    className="btn danger"
                    onClick={() => void agentCellAction(() => window.api.removeLink(agentMenu.name, '', 'agents'))}
                  >
                    删除快捷方式
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
                    打开技能库里的子智能体目录
                  </button>
                )}
              </>
            ) : (
              <div className="menu-note">
                WSL 这一侧的建/删快捷方式要在 WSL 里执行一条命令：
                <code>skm agents-link --agent {agentMenu.name}</code>
                （「体检」页可以查出 /mnt 形式的旧链接）。
              </div>
            )}
            {agentMenuState === 'real-dir' && (
              <div className="menu-note">
                这里放的是真实目录，不是指向库的快捷方式。关闭本窗口后点行内「一键修复」，程序会以技能库里的子智能体目录为准重建这个位置。
              </div>
            )}
            {agentMenuState === 'vault-missing' && (
              <div className="menu-note">技能库里没有子智能体目录，所以没法建快捷方式。</div>
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
            <div className="menu-title">重建 {pendingRepair.name} 的子智能体目录</div>
            <div className="menu-path">{pendingRepair.agentsDir}</div>
            <div className="menu-note">
              {'会把 '}
              {pendingRepair.agentsDir}
              {' 这个位置重建为与技能库一致的子智能体目录（以库里的 agents 为准）。库中没有的多余文件会先移到技能库同级的回收文件夹（.trash-<时间>），不会直接删除，需要时可以自己找回来。'}
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
              <div className="sec-title">文件在技能库里的完整路径</div>
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
              <div className="sec-title">内容预览（最多前 40 行{agentDetail.info.truncated ? '，后面还有内容未显示' : ''}）</div>
              <pre className="conflict">{agentDetail.info.preview}</pre>
            </div>

            <div className="drawer-actions">
              <button
                className="btn primary"
                onClick={() =>
                  void openAction(() => window.api.openAgentFolder(), '已在资源管理器中打开技能库的子智能体目录')
                }
              >
                在文件夹中打开
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
              <h4>冲突的原始输出（程序不会强行覆盖，请按提示人工处理）</h4>
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
