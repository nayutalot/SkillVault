// 接口中心：自定义供应商管理卡（与档案卡并列）+ 「一键填入」选择器。
// 用户在这里填一次「API 地址 + 密钥 + 接口格式」，之后在任意支持的 agent 表单里一键预填，
// 不用每个工具重复抄一遍地址和密钥。密钥只在保存时经 IPC 交给主进程加密（safeStorage/DPAPI），
// 界面与列表永远只显示尾 4 位；编辑时留空表示不改动密钥。
import { useState } from 'react'
import type { ApiHubCustomProviderInput, ApiHubCustomProviderView, ApiHubProviderProtocol } from '../../../shared/types'
import type { Notify } from '../App'

const PROTOCOL_LABEL: Record<ApiHubProviderProtocol, string> = {
  anthropic: 'Anthropic 兼容',
  openai: 'OpenAI 兼容',
  gemini: 'Gemini 兼容'
}

export const PROTOCOL_OPTIONS: ApiHubProviderProtocol[] = ['anthropic', 'openai', 'gemini']

/** 供应商表单态（apiKey 留空 = 编辑时不改密钥） */
export type ProviderDraft = {
  id?: string
  label: string
  baseUrl: string
  protocol: ApiHubProviderProtocol
  defaultModel: string
  notes: string
  apiKey: string
}

export function emptyProviderDraft(): ProviderDraft {
  return { label: '', baseUrl: '', protocol: 'openai', defaultModel: '', notes: '', apiKey: '' }
}

export function draftOf(p: ApiHubCustomProviderView): ProviderDraft {
  return {
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    protocol: p.protocol,
    defaultModel: p.defaultModel ?? '',
    notes: p.notes ?? '',
    apiKey: ''
  }
}

function keyMask(tail: string | null, len: number | null): string {
  if (!tail) return '（未知）'
  return '****' + tail + '（' + (len === null ? '?' : String(len)) + ' 字符）'
}

/**
 * 自定义供应商卡：列表 + 增删改。
 * providers 由父组件持有（档案表单的「一键填入」也要用同一份），本组件只负责表单与调用。
 */
export function ApiHubProvidersCard({
  notify,
  providers,
  onChanged
}: {
  notify: Notify
  providers: ApiHubCustomProviderView[]
  onChanged: (list: ApiHubCustomProviderView[]) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ApiHubCustomProviderView | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (!draft) return
    const input: ApiHubCustomProviderInput = {
      id: draft.id,
      label: draft.label.trim(),
      baseUrl: draft.baseUrl.trim(),
      protocol: draft.protocol,
      defaultModel: draft.defaultModel.trim(),
      notes: draft.notes.trim()
    }
    setBusy(true)
    const r = await window.api.apihubProviderSave(input, draft.apiKey)
    setBusy(false)
    if (!r.ok) {
      // 保存失败保留表单：用户刚填的地址与密钥不能丢
      notify('err', r.error || '保存失败')
      return
    }
    notify('ok', draft.id ? '供应商已更新' : '供应商已添加')
    setDraft(null)
    const list = await window.api.apihubProvidersList()
    if (list.ok) onChanged(list.data)
  }

  const doDelete = async (p: ApiHubCustomProviderView): Promise<void> => {
    setBusy(true)
    const r = await window.api.apihubProviderDelete(p.id)
    setBusy(false)
    setPendingDelete(null)
    if (!r.ok) {
      notify('err', r.error || '删除失败')
      return
    }
    notify('ok', '供应商「' + p.label + '」已删除')
    onChanged(r.data)
  }

  return (
    <div className="card">
      <h3>自定义供应商（自己填 API 地址 + 密钥）</h3>
      <div className="hint">
        在这里填一次你买的/自建的接口地址与密钥，之后任意支持的 agent 都能在新增档案时「从自定义供应商填入」，
        地址、模型、密钥一次带过去，不用重复抄。密钥加密保存在这台电脑上，界面只显示尾号。
      </div>
      {providers.length === 0 && !draft && <div className="empty">还没有自定义供应商。点「新增供应商」把常用的地址存下来。</div>}
      {providers.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>名称</th>
              <th>API 地址</th>
              <th>接口格式</th>
              <th>默认模型</th>
              <th>密钥</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.label}</strong>
                  {p.notes && <div className="hint">{p.notes}</div>}
                </td>
                <td>
                  <code>{p.baseUrl}</code>
                </td>
                <td>{PROTOCOL_LABEL[p.protocol]}</td>
                <td>{p.defaultModel || '（未填）'}</td>
                <td>
                  {keyMask(p.apiKeyTail, p.apiKeyLen)}
                  {p.plainStore && (
                    <span className="badge warn" title="safeStorage 不可用，密钥以 base64 明文落盘">
                      明文存储
                    </span>
                  )}
                </td>
                <td>
                  <div className="kimi-actions">
                    <button className="btn small" onClick={() => setDraft(draftOf(p))}>
                      编辑
                    </button>
                    <button className="btn small danger" disabled={busy} onClick={() => setPendingDelete(p)}>
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pendingDelete && (
        <div className="banner warn">
          「{pendingDelete.label}」将被删除（已经用它填过并保存的档案不受影响，档案自己存着密钥）。确认删除？
          <div className="toolbar">
            <button className="btn danger" disabled={busy} onClick={() => void doDelete(pendingDelete)}>
              确认删除
            </button>
            <button className="btn ghost" onClick={() => setPendingDelete(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {!draft && (
        <div className="toolbar">
          <button className="btn" onClick={() => setDraft(emptyProviderDraft())}>
            新增供应商
          </button>
        </div>
      )}

      {draft && (
        <>
          <h4>{draft.id ? '编辑供应商：' + draft.label : '新增供应商'}</h4>
          <table className="kv">
            <tbody>
              <tr>
                <th>名称</th>
                <td>
                  <input
                    className="input"
                    value={draft.label}
                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    placeholder="如 MicuAPI / 公司网关"
                  />
                </td>
              </tr>
              <tr>
                <th>API 地址</th>
                <td>
                  <input
                    className="input wide"
                    value={draft.baseUrl}
                    onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                  />
                </td>
              </tr>
              <tr>
                <th>接口格式</th>
                <td>
                  <select
                    className="input"
                    value={draft.protocol}
                    onChange={(e) => setDraft({ ...draft, protocol: e.target.value as ApiHubProviderProtocol })}
                  >
                    {PROTOCOL_OPTIONS.map((o) => (
                      <option key={o} value={o}>
                        {PROTOCOL_LABEL[o]}
                      </option>
                    ))}
                  </select>
                  <div className="hint">按供应商文档选：多数中转站是 OpenAI 兼容；Claude 官方/镜像多为 Anthropic 兼容。</div>
                </td>
              </tr>
              <tr>
                <th>默认模型</th>
                <td>
                  <input
                    className="input wide"
                    value={draft.defaultModel}
                    onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
                    placeholder="可选，如 claude-sonnet-4 / gpt-4.1"
                  />
                  <div className="hint">填了才能在支持的 agent 里自动带上模型名；留空则该字段要你自己填。</div>
                </td>
              </tr>
              <tr>
                <th>备注</th>
                <td>
                  <input
                    className="input wide"
                    value={draft.notes}
                    onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                    placeholder="可选，如「包月套餐，别超额」"
                  />
                </td>
              </tr>
              <tr>
                <th>API Key</th>
                <td>
                  <input
                    className="input wide"
                    type="password"
                    value={draft.apiKey}
                    onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                    placeholder={draft.id ? '留空 = 不改动当前密钥' : '仅经 IPC 传给主进程，立即加密入库'}
                    autoComplete="off"
                  />
                </td>
              </tr>
            </tbody>
          </table>
          <div className="toolbar">
            <button className="btn primary" disabled={busy} onClick={() => void save()}>
              保存供应商
            </button>
            <button className="btn ghost" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 「从自定义供应商填入」选择器：选中后由主进程按目标 agent 的字段定义算出预填值。
 * 密钥不回显 —— 保存时勾选「用这条供应商的密钥」，由主进程直接用密文解出来的明文落盘。
 */
export function ProviderPrefillPicker({
  adapterId,
  providers,
  notify,
  onPrefill
}: {
  adapterId: string
  providers: ApiHubCustomProviderView[]
  notify: Notify
  onPrefill: (r: { fields: Record<string, string>; missing: string[]; notes: string[] }, providerId: string) => void
}): React.JSX.Element | null {
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  if (providers.length === 0) return null
  const apply = async (): Promise<void> => {
    if (!picked) return
    setBusy(true)
    // 旧 preload 签名只认 ApiHubAdapterId，这里的 adapterId 已是"有实现的适配器"（N/A 卡不会渲染表单）
    const r = await window.api.apihubProviderPrefill(adapterId as never, picked)
    setBusy(false)
    if (!r.ok) {
      notify('err', r.error || '读取供应商失败')
      return
    }
    onPrefill(r.data, picked)
  }
  return (
    <div className="banner">
      从自定义供应商一键填入：
      <select className="input" value={picked} onChange={(e) => setPicked(e.target.value)}>
        <option value="">（选择一条已保存的供应商）</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}（{PROTOCOL_LABEL[p.protocol]}）
          </option>
        ))}
      </select>
      <button className="btn small" disabled={!picked || busy} onClick={() => void apply()}>
        填入
      </button>
      <div className="hint">填入的是地址、模型等公开信息；密钥保存在主进程，保存档案时自动带上，不在界面回显。</div>
    </div>
  )
}
