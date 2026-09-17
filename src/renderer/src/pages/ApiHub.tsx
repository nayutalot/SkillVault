import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiHubAdapterId, ApiHubAdapterInfo, ApiHubCurrentResult, ApiHubProfileInput, ApiHubProfileView } from '../../../shared/types'
import type { Notify } from '../App'

/** 表单态：fields 直接承载适配器字段，apiKey 单独（留空 = 编辑时不改动） */
type FormState = { id?: string; name: string; fields: Record<string, string>; apiKey: string }

/** 单适配器加载态 */
type Sel = {
  info: ApiHubAdapterInfo | null
  profiles: ApiHubProfileView[]
  activeId: string | null
  current: ApiHubCurrentResult | null
}

function keyMask(tail: string | null, len: number | null): string {
  if (!tail) return '（未知）'
  return '****' + tail + '（' + (len === null ? '?' : String(len)) + ' 字符）'
}

function fileNameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

export default function ApiHubPage({ notify }: { notify: Notify }): React.JSX.Element {
  const [adapters, setAdapters] = useState<ApiHubAdapterInfo[]>([])
  const [sel, setSel] = useState<ApiHubAdapterId>('claude-cli')
  const [selData, setSelData] = useState<Sel>({ info: null, profiles: [], activeId: null, current: null })
  const [form, setForm] = useState<FormState | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [pending, setPending] = useState<{ kind: 'switch' | 'delete'; id: string } | null>(null)
  const [zcodeConfirm, setZcodeConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 最新请求获胜防护：快速切换选项卡时两次 loadSel 并发在飞，旧适配器的响应后到
   *  会把新选项卡的数据整体覆盖（界面高亮 B 但列表是 A 的档案，此时点「切换」会写错适配器） */
  const loadSeqRef = useRef(0)

  const loadAdapters = useCallback(async (): Promise<ApiHubAdapterInfo[]> => {
    const r = await window.api.apihubAdapters()
    if (!r.ok) {
      notify('err', r.error || '读取适配器目录失败')
      return []
    }
    setAdapters(r.data.adapters)
    return r.data.adapters
  }, [notify])

  const loadSel = useCallback(
    async (id: ApiHubAdapterId, info: ApiHubAdapterInfo | null): Promise<void> => {
      const seq = ++loadSeqRef.current
      const c = await window.api.apihubCurrent(id)
      const p = await window.api.apihubProfiles(id)
      if (seq !== loadSeqRef.current) return // 已切到别的选项卡，本次结果作废
      if (!c.ok) {
        notify('err', c.error || '读取当前状态失败')
        setSelData({ info, profiles: [], activeId: null, current: null })
        return
      }
      const profiles = p.ok ? p.data.profiles : []
      const activeId = p.ok ? p.data.activeId : null
      if (!p.ok) notify('err', p.error || '读取档案失败')
      setSelData({ info, profiles, activeId, current: c.data })
    },
    [notify]
  )

  useEffect(() => {
    void (async () => {
      const list = await loadAdapters()
      const first = list.find((a) => a.available)?.id ?? 'claude-cli'
      setSel(first)
      await loadSel(first, list.find((a) => a.id === first) ?? null)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const switchTab = async (id: ApiHubAdapterId): Promise<void> => {
    setSel(id)
    setForm(null)
    setPending(null)
    setShowAdvanced(false)
    await loadSel(id, adapters.find((a) => a.id === id) ?? null)
  }

  const refresh = async (): Promise<void> => {
    await loadSel(sel, adapters.find((a) => a.id === sel) ?? null)
  }

  const patchField = (key: string, value: string): void =>
    setForm((f) => (f ? { ...f, fields: { ...f.fields, [key]: value } } : f))

  // ---------- 动作 ----------

  const importCurrent = async (): Promise<void> => {
    setBusy(true)
    const r = await window.api.apihubImport(sel)
    setBusy(false)
    if (!r.ok) notify('err', r.error || '导入失败')
    else if (!r.data.imported) notify('err', '无法导入：' + (r.data.reason || '结构不明'))
    else notify('ok', '已从当前配置导入档案「' + (r.data.profile?.name ?? '') + '」')
    await refresh()
  }

  const saveForm = async (): Promise<void> => {
    if (!form) return
    const input: ApiHubProfileInput = { id: form.id, adapterId: sel, name: form.name.trim(), fields: {} }
    for (const def of selInfo?.fieldDefs ?? []) input.fields[def.key] = (form.fields[def.key] ?? '').trim()
    setBusy(true)
    const r = await window.api.apihubSave(input, form.apiKey)
    setBusy(false)
    if (!r.ok) {
      // 保存失败绝不清空表单：用户填写的字段与 API Key 会全部丢失
      notify('err', r.error || '保存失败')
      return
    }
    notify('ok', form.id ? '档案已更新' : '档案已创建')
    setForm(null)
    await refresh()
  }

  const doSwitch = async (id: string, confirmed?: boolean): Promise<void> => {
    setBusy(true)
    const r = await window.api.apihubSwitch(sel, id, confirmed)
    setBusy(false)
    if (!r.ok) {
      setPending(null)
      notify('err', r.error || '切换失败（原配置未被破坏）')
      await refresh()
      return
    }
    if ('blocked' in r.data && r.data.blocked) {
      setBusy(false)
      notify('err', '检测到 ZCode 正在运行：配置可能被其覆盖。确认继续请在下方再点一次「确认切换」')
      setZcodeConfirm(true)
      setPending({ kind: 'switch', id })
      return
    }
    setPending(null)
    setZcodeConfirm(false)
    if ('backupFiles' in r.data) {
      const lastName = r.data.backupFiles.length ? fileNameOf(r.data.backupFiles[r.data.backupFiles.length - 1]) : ''
      notify('ok', '已切换生效（备份 ' + lastName + '）' + (r.data.warning ? ' · ' + r.data.warning : ''))
    }
    await refresh()
  }

  const doDelete = async (p: ApiHubProfileView): Promise<void> => {
    setBusy(true)
    const r = await window.api.apihubDelete(sel, p.id)
    setBusy(false)
    setPending(null)
    if (!r.ok) notify('err', r.error || '删除失败')
    else {
      setSelData((s) => ({ ...s, profiles: r.data.profiles, activeId: r.data.activeId }))
      notify('ok', '档案「' + p.name + '」已删除')
    }
  }

  // ---------- 渲染辅助 ----------

  const selInfo = selData.info ?? adapters.find((a) => a.id === sel) ?? null
  const cur = selData.current
  const pendingProfile = pending ? selData.profiles.find((p) => p.id === pending.id) : undefined
  const editingKey = form?.id ? selData.profiles.find((p) => p.id === form.id)?.apiKeyTail : undefined

  return (
    <div>
      {/* ---------- 适配器选项卡 ---------- */}
      <div className="toolbar apihub-tabs">
        {adapters.map((a) => (
          <button
            key={a.id}
            className={'btn' + (a.id === sel ? ' primary' : '')}
            onClick={() => void switchTab(a.id)}
          >
            {a.label}
            {!a.available ? ' ⃠' : ''}
          </button>
        ))}
      </div>

      {/* ---------- 不可用适配器说明卡 ---------- */}
      {selInfo && !selInfo.available && (
        <div className="card">
          <h3>{selInfo.label}</h3>
          <div className="banner warn">{selInfo.naReason}</div>
        </div>
      )}

      {/* ---------- 当前状态卡 ---------- */}
      {selInfo?.available && cur?.available && (
        <div className="card">
          <h3>{selInfo.label} 当前生效</h3>
          <div className="hint">
            目标文件：
            {cur.configPaths.map((p) => (
              <code key={p}> {p}</code>
            ))}
          </div>
          <table className="kv">
            <tbody>
              <tr>
                <th>Base URL</th>
                <td>
                  <code>{cur.baseUrl ?? '（未设置）'}</code>
                  {cur.matchedProfileId && <span className="badge ok">当前生效</span>}
                </td>
              </tr>
              <tr>
                <th>API Key</th>
                <td>{keyMask(cur.apiKeyTail, cur.apiKeyLen)}</td>
              </tr>
              {Object.keys(cur.detail).map((k) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>
                    <code>{cur.detail[k]}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="toolbar">
            <button className="btn primary" disabled={busy} onClick={() => void importCurrent()}>
              从当前配置导入
            </button>
            <button className="btn" onClick={() => setForm({ name: '', fields: {}, apiKey: '' })}>
              新增档案
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => void refresh()}>
              刷新
            </button>
          </div>
          {selData.profiles.length === 0 && (
            <div className="banner warn">档案库还是空的。点「从当前配置导入」把现有供应商一键收进档案库（API Key 会立即加密入库）。</div>
          )}
        </div>
      )}

      {/* ---------- 档案列表 ---------- */}
      {selInfo?.available && (
        <div className="card">
          <h3>供应商档案（加密存于本机 userData，不入 vault 仓库）</h3>
          {pending && pendingProfile && (
            <div className="banner warn">
              {pending.kind === 'switch'
                ? '将把「' +
                  pendingProfile.name +
                  '」写入 ' +
                  (cur?.configPaths ?? []).join(' 与 ') +
                  '（自动时间戳备份）' +
                  (sel === 'zcode' && zcodeConfirm ? '；⚠ ZCode 正在运行，配置可能被其覆盖，建议退出 ZCode 后切换、重启 ZCode 生效' : '') +
                  '。确认切换？'
                : '「' + pendingProfile.name + '」是当前生效档案，删除后档案库不再记录它（配置文件不会被改动）。确认删除？'}
              <div className="toolbar">
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => (pending.kind === 'switch' ? void doSwitch(pending.id, sel === 'zcode' ? true : undefined) : void doDelete(pendingProfile))}
                >
                  确认切换
                </button>
                <button className="btn ghost" onClick={() => { setPending(null); setZcodeConfirm(false) }}>
                  取消
                </button>
              </div>
            </div>
          )}
          {selData.profiles.length === 0 && <div className="empty">还没有档案。先「从当前配置导入」或「新增档案」。</div>}
          {selData.profiles.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>档案</th>
                  <th>关键字段</th>
                  <th>API Key</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {selData.profiles.map((p) => {
                  const isActive = p.id === selData.activeId
                  return (
                    <tr key={p.id} className={isActive ? 'kimi-active-row' : undefined}>
                      <td>
                        <strong>{p.name}</strong>
                        {isActive && <span className="badge ok">当前生效</span>}
                        {p.plainStore && (
                          <span className="badge warn" title="safeStorage 不可用，密钥以 base64 明文落盘">
                            明文存储
                          </span>
                        )}
                      </td>
                      <td>
                        {(selInfo.fieldDefs ?? [])
                          .filter((def) => p.fields[def.key])
                          .map((def) => (
                            <div key={def.key} className="hint">
                              {def.label}: <code>{p.fields[def.key]}</code>
                            </div>
                          ))}
                      </td>
                      <td>{keyMask(p.apiKeyTail, p.apiKeyLen)}</td>
                      <td>
                        <div className="kimi-actions">
                          <button className="btn small primary" disabled={busy || isActive} onClick={() => setPending({ kind: 'switch', id: p.id })}>
                            切换
                          </button>
                          <button className="btn small" onClick={() => setForm({ id: p.id, name: p.name, fields: { ...p.fields }, apiKey: '' })}>
                            编辑
                          </button>
                          <button className="btn small danger" disabled={busy} onClick={() => (isActive ? setPending({ kind: 'delete', id: p.id }) : void doDelete(p))}>
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---------- 新增 / 编辑表单 ---------- */}
      {form && selInfo?.available && (
        <div className="card">
          <h3>{form.id ? '编辑档案：' + form.name : '新增档案'}</h3>
          <table className="kv">
            <tbody>
              <tr>
                <th>档案名</th>
                <td>
                  <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 MicuAPI / DeepSeek" />
                </td>
              </tr>
              {(selInfo.fieldDefs ?? []).map((def) => (
                <tr key={def.key}>
                  <th>{def.label}</th>
                  <td>
                    {def.kind === 'select' ? (
                      <select className="input" value={form.fields[def.key] ?? ''} onChange={(e) => patchField(def.key, e.target.value)}>
                        {(def.options ?? []).map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="input wide"
                        value={form.fields[def.key] ?? ''}
                        onChange={(e) => patchField(def.key, e.target.value)}
                        placeholder={def.placeholder}
                      />
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <th>API Key</th>
                <td>
                  <input
                    className="input wide"
                    type="password"
                    value={form.apiKey}
                    onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                    placeholder={form.id ? '留空 = 不改动当前密钥' + (editingKey ? '（尾 4 位 ' + editingKey + '）' : '') : '仅经 IPC 传给主进程，立即加密入库'}
                    autoComplete="off"
                  />
                </td>
              </tr>
            </tbody>
          </table>
          <div className="toolbar">
            <button className="btn primary" disabled={busy} onClick={() => void saveForm()}>
              保存档案
            </button>
            <button className="btn ghost" onClick={() => setForm(null)}>
              取消
            </button>
          </div>
          <div className="hint">
            密钥以 safeStorage（Windows DPAPI）加密存 userData/api-hub-profiles.json；目标配置文件仅在「切换」时被写入，且写前自动时间戳备份、写后重读校验（失败自动回滚）。
          </div>
        </div>
      )}
    </div>
  )
}
