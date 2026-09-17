import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, Registry, RegistryAgent, RemoteTarget } from '../../../shared/types'
import type { Notify } from '../App'

/** 生成远程目标 id（label 为空也可用） */
function newTargetId(): string {
  return `t-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
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
    notify(r.ok ? 'ok' : 'err', r.ok ? 'registry 已写入 vault 并提交' : r.error || '保存失败')
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
        <h3>路径设置</h3>
        {settings && (
          <table className="kv">
            <tbody>
              <tr>
                <th>vault 工作克隆</th>
                <td>
                  <input
                    className="input wide"
                    value={settings.vaultPath}
                    onChange={(e) => setSettings({ ...settings, vaultPath: e.target.value })}
                  />
                </td>
              </tr>
              <tr>
                <th>本地裸仓（唯一 origin）</th>
                <td>
                  <input
                    className="input wide"
                    value={settings.barePath}
                    onChange={(e) => setSettings({ ...settings, barePath: e.target.value })}
                  />
                </td>
              </tr>
              <tr>
                <th>WSL 发行版</th>
                <td>
                  <input
                    className="input"
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
                    title="版本中心 DeepSeek Harness 条目的本地安装目录（其 package.json 提供已装版本；GitHub 源码重建的换目录目标）"
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
        <h3>registry（存于 vault 根，随仓库同步）</h3>
        <div className="hint">
          {registryCorrupt
            ? `registry.json 已损坏（${registryCorrupt}）。以下为默认值仅供查看，保存被拒绝 —— 请人工修复或删除 ${registryFile}`
            : registryMissing
              ? `vault 尚未初始化，以下为默认值；保存时会写入 ${registryFile}`
              : `文件: ${registryFile}`}
        </div>
        {registry && (
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>平台</th>
                <th>skills 目录</th>
                <th>agents 目录（可选，子智能体共享）</th>
                <th>include（逗号分隔，* 为全部）</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {registry.agents.map((a, i) => (
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
                      placeholder="留空 = 不参与子智能体共享"
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
            新增 agent
          </button>
          <button className="btn primary" disabled={!registry} onClick={() => void saveRegistry()}>
            保存 registry
          </button>
        </div>
      </div>

      <div className="card">
        <h3>远程目标（SSH / Docker）</h3>
        <p className="hint">
          先行框架：配置真实的 SSH 主机或 Docker 容器后，可在同步页把 vault 以 git bundle 单向推送到远端。未配置/不可达
          都是合法状态，应用绝不伪造「同步成功」。凭据请走系统 ssh-agent / 免密配置，本应用不存储密码。
        </p>
        {settings && settings.remoteTargets.length === 0 && (
          <div className="empty">尚未配置远程目标。点击「新增目标」添加 SSH 主机或 Docker 容器。</div>
        )}
        {settings && settings.remoteTargets.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>启用</th>
                <th>类型</th>
                <th>名称</th>
                <th>host / container</th>
                <th>port</th>
                <th>user</th>
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
              保存设置（含远程目标）
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
