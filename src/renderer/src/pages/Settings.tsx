import { useCallback, useEffect, useState } from 'react'
import type { AgentDiscoverReport } from '../../../shared/agentSignatures'
import type { AppSettings, Registry, RegistryAgent, RemoteTarget } from '../../../shared/types'
import type { Notify } from '../App'

/** 生成远程目标 id（label 为空也可用） */
function newTargetId(): string {
  return `t-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** Agent 来源的白话标签（source 缺省视为内置） */
const SOURCE_LABEL: Record<NonNullable<RegistryAgent['source']>, string> = {
  builtin: '内置',
  discovered: '自动发现',
  manual: '手动添加'
}

/** 一条 Agent 为什么“不参与同步” */
function idleReason(a: RegistryAgent): string {
  if (a.enabled === false) return '已停用，不参与同步'
  if (a.status === 'missing') return '上次扫描没找到这个目录，暂不参与同步（重新扫描后会恢复）'
  return ''
}

type ProbeRow = { probing: boolean; detail: string; ok: boolean | null }

export default function SettingsPage({ notify }: { notify: Notify }): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [registry, setRegistry] = useState<Registry | null>(null)
  const [registryFile, setRegistryFile] = useState('')
  const [registryMissing, setRegistryMissing] = useState(false)
  const [registryCorrupt, setRegistryCorrupt] = useState('')
  const [probe, setProbe] = useState<Record<string, ProbeRow>>({})
  /** include 输入的原始草稿（按行索引）：受控值逐键 split+filter 会把「a,」里的逗号吞掉，用户永远打不出多项列表 */
  const [includeDrafts, setIncludeDrafts] = useState<Record<number, string>>({})
  /** 已识别 Agent 卡：本轮重新扫描的报告（新增/消失）+ 扫描中状态 + 正在切换启停的条目名 */
  const [discoverRes, setDiscoverRes] = useState<AgentDiscoverReport | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [toggling, setToggling] = useState('')

  /** 把 include 草稿解析回 registry（失焦/保存时调用） */
  const flushIncludeDraft = (i: number): void => {
    const draft = includeDrafts[i]
    if (draft === undefined || !registry) return
    setIncludeDrafts((p) => {
      const { [i]: _drop, ...rest } = p
      return rest
    })
    const include = draft.split(',').map((x) => x.trim()).filter(Boolean)
    if (include.join(',') !== registry.agents[i].include.join(',')) {
      const agents = registry.agents.slice()
      agents[i] = { ...agents[i], include }
      setRegistry({ ...registry, agents })
    }
  }

  const load = useCallback(async () => {
    const s = await window.api.getSettings()
    if (!s.ok) notify('err', s.error || '读取设置失败')
    else setSettings(s.data)
    const r = await window.api.getRegistry()
    if (!r.ok) notify('err', r.error || '读取 registry 失败')
    else {
      setRegistry(r.data.registry)
      setRegistryFile(r.data.file)
      setRegistryMissing(r.data.missing)
      setRegistryCorrupt(r.data.corrupt ?? '')
    }
  }, [notify])

  useEffect(() => {
    void load()
  }, [load])

  const saveSettings = async (): Promise<void> => {
    if (!settings) return
    const r = await window.api.saveSettings(settings)
    notify(r.ok ? 'ok' : 'err', r.ok ? '设置已保存' : r.error || '保存失败')
  }

  const patchAgent = (i: number, patch: Partial<RegistryAgent>): void => {
    if (!registry) return
    const agents = registry.agents.slice()
    agents[i] = { ...agents[i], ...patch }
    setRegistry({ ...registry, agents })
  }

  const saveRegistry = async (): Promise<void> => {
    if (!registry) return
    // 先落所有未失焦的 include 草稿，避免丢最后一次编辑
    for (const k of Object.keys(includeDrafts)) flushIncludeDraft(Number(k))
    const r = await window.api.saveRegistry(registry)
    notify(r.ok ? 'ok' : 'err', r.ok ? '已保存，并随技能库一起提交' : r.error || '保存失败')
  }

  // ---------- 已识别的 Agent（自动发现 + 启停） ----------

  /** 重新扫描：Windows 与 WSL 两侧都扫，结果合并进 registry.json（新条目自动加入，消失的只标记不删除） */
  const discover = async (): Promise<void> => {
    setDiscovering(true)
    const r = await window.api.discoverAgents()
    setDiscovering(false)
    if (!r.ok) {
      notify('err', r.error || '扫描失败')
      return
    }
    setDiscoverRes(r.data)
    setRegistry(r.data.registry)
    notify('ok', `扫描完成：本机找到 ${r.data.windowsFound} 个（Windows）、${r.data.wslFound} 个（WSL）`)
  }

  /** 启用/停用：只改这一个开关，条目本身保留（重新扫描后由扫描结果决定它还在不在） */
  const toggleEnabled = async (a: RegistryAgent, enabled: boolean): Promise<void> => {
    setToggling(a.name)
    const r = await window.api.setAgentEnabled(a.name, enabled)
    setToggling('')
    if (!r.ok) {
      notify('err', r.error || '修改失败')
      return
    }
    setRegistry(r.data)
    notify('ok', `${a.label ?? a.name} 已${enabled ? '启用，会参与同步' : '停用，不参与同步'}`)
  }

  // ---------- 远程目标 CRUD（SSH / Docker，先行框架） ----------

  const patchTarget = (id: string, patch: Partial<RemoteTarget>): void => {
    if (!settings) return
    setSettings({
      ...settings,
      remoteTargets: settings.remoteTargets.map((t) => (t.id === id ? { ...t, ...patch } : t))
    })
  }

  const addTarget = (): void => {
    if (!settings) return
    setSettings({
      ...settings,
      remoteTargets: [
        ...settings.remoteTargets,
        { id: newTargetId(), kind: 'ssh', label: '新目标', enabled: false }
      ]
    })
  }

  const removeTarget = (id: string): void => {
    if (!settings) return
    setSettings({ ...settings, remoteTargets: settings.remoteTargets.filter((t) => t.id !== id) })
    setProbe(({ [id]: _drop, ...rest }) => rest)
  }

  /** 测试连接：探测当前表单值（未保存也可测）；结果如实显示，未配置/不可达都是合法状态 */
  const testTarget = async (t: RemoteTarget): Promise<void> => {
    setProbe((p) => ({ ...p, [t.id]: { probing: true, detail: '', ok: null } }))
    const r = await window.api.probeRemote(t)
    if (!r.ok) {
      setProbe((p) => ({ ...p, [t.id]: { probing: false, detail: r.error || '探测 IPC 失败', ok: false } }))
      return
    }
    setProbe((p) => ({ ...p, [t.id]: { probing: false, detail: r.data.detail, ok: r.data.ok } }))
  }

  return (
    <div>
      <div className="card">
        <h3>文件放哪</h3>
        <p className="hint">
          技能库就是一个普通文件夹，里面保存着你的全部技能；Windows 和 WSL 两边靠它互相同步。除非你很清楚自己在做什么，否则不用改。
        </p>
        {settings && (
          <table className="kv">
            <tbody>
              <tr>
                <th>技能库文件夹</th>
                <td>
                  <input
                    className="input wide"
                    title="技能真正的存放位置（默认在用户目录下的 SkillVault）"
                    value={settings.vaultPath}
                    onChange={(e) => setSettings({ ...settings, vaultPath: e.target.value })}
                  />
                </td>
              </tr>
              <tr>
                <th>中转文件夹</th>
                <td>
                  <input
                    className="input wide"
                    title="Windows 和 WSL 交换改动用的中转位置（默认在用户目录下的 SkillVault.git）"
                    value={settings.barePath}
                    onChange={(e) => setSettings({ ...settings, barePath: e.target.value })}
                  />
                </td>
              </tr>
              <tr>
                <th>WSL 发行版名称</th>
                <td>
                  <input
                    className="input"
                    title="要同步的 Linux 子系统名称（如 Ubuntu），需与 wsl -l -v 里显示的一致"
                    value={settings.wslDistro}
                    onChange={(e) => setSettings({ ...settings, wslDistro: e.target.value })}
                  />
                </td>
              </tr>
              <tr>
                <th>DeepSeek 本体目录</th>
                <td>
                  <input
                    className="input wide"
                    title="版本更新页里 DeepSeek Harness 条目的本地安装目录（用它的 package.json 判断已装版本）"
                    value={settings.deepseekHarnessRoot}
                    onChange={(e) => setSettings({ ...settings, deepseekHarnessRoot: e.target.value })}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        )}
        <button className="btn primary" onClick={() => void saveSettings()}>
          保存设置
        </button>
      </div>

      <div className="card">
        <h3>Agent 清单（存在技能库里，跟着一起同步）</h3>
        <div className="hint">
          {registryCorrupt
            ? `这份清单已损坏（${registryCorrupt}），下面显示的是默认内容，仅供查看，无法保存 —— 请人工修复或删除 ${registryFile} 后重启`
            : registryMissing
              ? `技能库还没初始化，下面显示的是默认内容；保存时会写入 ${registryFile}`
              : `文件位置：${registryFile}`}
        </div>
        <p className="hint">
          每一行代表一个会用技能的 AI 工具：它的技能文件夹在哪、哪些技能归它管（include 填 * 表示全部）。改动只有点了「保存清单」才会生效。
          自动发现的工具不用在这里登记，到下方「已识别的 Agent」里开关即可。
        </p>
        {registry && (
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>平台</th>
                <th>技能文件夹</th>
                <th>子智能体文件夹（可选）</th>
                <th>包含哪些技能（逗号分隔，* 为全部）</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {/* 只列内置/手动条目：自动发现的十几条在这编辑既无必要也把表格撑爆，它们的启停在下方卡片 */}
              {registry.agents
                .map((a, i) => ({ a, i }))
                .filter(({ a }) => a.source !== 'discovered')
                .map(({ a, i }) => (
                  <tr key={i}>
                    <td>
                      <input className="input" value={a.name} onChange={(e) => patchAgent(i, { name: e.target.value })} />
                    </td>
                    <td>
                      <select
                        className="input"
                        value={a.platform}
                        onChange={(e) => patchAgent(i, { platform: e.target.value as 'windows' | 'linux' })}
                      >
                        <option value="windows">windows</option>
                        <option value="linux">linux</option>
                      </select>
                    </td>
                    <td>
                      <input
                        className="input wide"
                        value={a.skillsDir}
                        onChange={(e) => patchAgent(i, { skillsDir: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="input wide"
                        placeholder="留空 = 不共享子智能体"
                        value={a.agentsDir ?? ''}
                        onChange={(e) => patchAgent(i, { agentsDir: e.target.value.trim() ? e.target.value : undefined })}
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        value={includeDrafts[i] ?? a.include.join(',')}
                        onChange={(e) => setIncludeDrafts((p) => ({ ...p, [i]: e.target.value }))}
                        onBlur={() => flushIncludeDraft(i)}
                      />
                    </td>
                    <td>
                      <button
                        className="btn small danger"
                        onClick={() => setRegistry({ ...registry, agents: registry.agents.filter((_, j) => j !== i) })}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
        <div className="toolbar">
          <button
            className="btn"
            onClick={() =>
              registry &&
              setRegistry({
                ...registry,
                agents: [...registry.agents, { name: '', platform: 'windows', skillsDir: '', include: ['*'] }]
              })
            }
          >
            新增 Agent
          </button>
          <button className="btn primary" disabled={!registry} onClick={() => void saveRegistry()}>
            保存清单
          </button>
        </div>
      </div>

      <div className="card">
        <h3>已识别的 Agent</h3>
        <p className="hint">
          程序会自动找出这台电脑上装了哪些 AI 工具、它们的技能文件夹在哪，并加入上面的清单。扫描只读取目录信息，不会改动任何文件。
        </p>
        <div className="toolbar">
          <button className="btn primary" disabled={discovering} onClick={() => void discover()}>
            {discovering ? '扫描中…（最多约 20 秒）' : '重新扫描'}
          </button>
          <span className="hint">本机目录里的工具会被自动认出来；不想要的可以停用，停用后条目仍保留。</span>
        </div>
        {discoverRes && (
          <div className="hint">
            本次结果：新增 {discoverRes.added.length} 个
            {discoverRes.added.length > 0 ? `（${discoverRes.added.join('、')}）` : ''} · 重新出现{' '}
            {discoverRes.reactivated.length} 个 · 本次没找到 {discoverRes.missing.length} 个
            {discoverRes.missing.length > 0 ? `（${discoverRes.missing.join('、')}，条目保留，下次扫到会恢复）` : ''}
            {discoverRes.wslStale ? ` · WSL 这侧这次没连上${discoverRes.wslReason ? `（${discoverRes.wslReason}）` : ''}` : ''}
          </div>
        )}
        {registry && registry.agents.length === 0 && <div className="empty">还没有任何 Agent 条目。</div>}
        {registry && registry.agents.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>来源</th>
                <th>技能文件夹</th>
                <th>参与同步</th>
              </tr>
            </thead>
            <tbody>
              {registry.agents.map((a) => (
                <tr key={a.name}>
                  <td>
                    <strong>{a.label ?? a.name}</strong>
                    <div className="skill-desc none">{a.name}</div>
                  </td>
                  <td>
                    <span className="tag">{SOURCE_LABEL[a.source ?? 'builtin']}</span>
                  </td>
                  <td className="hint" title={a.skillsDir}>
                    {a.skillsDir}
                    {idleReason(a) && <div className="err-text">{idleReason(a)}</div>}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={a.enabled !== false}
                      disabled={toggling === a.name}
                      onChange={(e) => void toggleEnabled(a, e.target.checked)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>推送到别的电脑（SSH / Docker）</h3>
        <p className="hint">
          想把这台电脑的技能库也放到另一台电脑或容器里，就在这里填上对方的信息；填好后到「同步」页点「同步」即可推送。没配置或连不上都是正常状态，程序不会假装成功。
          连接用的密码由系统自带的 SSH 工具管理，本软件不存储密码。
        </p>
        {settings && settings.remoteTargets.length === 0 && (
          <div className="empty">还没有远程电脑。点「新增目标」添加一个 SSH 主机或 Docker 容器。</div>
        )}
        {settings && settings.remoteTargets.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>启用</th>
                <th>连接方式</th>
                <th>名称</th>
                <th>主机名 / 容器名</th>
                <th>端口</th>
                <th>登录用户</th>
                <th>测试连接</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {settings.remoteTargets.map((t) => {
                const p = probe[t.id]
                return (
                  <tr key={t.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={t.enabled}
                        onChange={(e) => patchTarget(t.id, { enabled: e.target.checked })}
                      />
                    </td>
                    <td>
                      <select
                        className="input"
                        value={t.kind}
                        onChange={(e) => patchTarget(t.id, { kind: e.target.value as RemoteTarget['kind'] })}
                      >
                        <option value="ssh">ssh</option>
                        <option value="docker">docker</option>
                      </select>
                    </td>
                    <td>
                      <input
                        className="input"
                        value={t.label}
                        onChange={(e) => patchTarget(t.id, { label: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="input wide"
                        placeholder={t.kind === 'ssh' ? '主机名/IP' : '容器名'}
                        value={t.kind === 'ssh' ? t.host ?? '' : t.container ?? ''}
                        onChange={(e) =>
                          t.kind === 'ssh'
                            ? patchTarget(t.id, { host: e.target.value })
                            : patchTarget(t.id, { container: e.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        placeholder="22"
                        value={t.port ?? ''}
                        onChange={(e) => {
                          const n = Number(e.target.value)
                          // 只接受 1-65535 整数（2.5/-22 这类值落盘后会拼进 ssh -p 必失败）
                          patchTarget(t.id, { port: e.target.value && Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined })
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        placeholder={t.kind === 'ssh' ? '登录用户（可空）' : '—'}
                        disabled={t.kind !== 'ssh'}
                        value={t.user ?? ''}
                        onChange={(e) => patchTarget(t.id, { user: e.target.value })}
                      />
                    </td>
                    <td>
                      <button className="btn small" disabled={p?.probing} onClick={() => void testTarget(t)}>
                        {p?.probing ? '探测中…' : '测试连接'}
                      </button>
                      {p && !p.probing && (
                        <div className={`hint ${p.ok ? '' : 'err-text'}`}>
                          {p.ok ? '✓ 可达' : '✗ 不可达/未配置'}：{p.detail}
                        </div>
                      )}
                    </td>
                    <td>
                      <button className="btn small danger" onClick={() => removeTarget(t.id)}>
                        删除
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {settings && (
          <div className="toolbar">
            <button className="btn" onClick={addTarget}>
              新增目标
            </button>
            <button className="btn primary" onClick={() => void saveSettings()}>
              保存设置（含远程电脑）
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
