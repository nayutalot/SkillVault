// 接口中心编排层：适配器目录（CATALOG）+ 当前状态读取 + 导入 + 切换骨架（备份→原子写→重读校验→失败回滚）。
// 全部底层变换在 transforms.ts（纯函数），档案库在 store.ts；本文件只做 组装/读盘写盘/流程控制。
// homeDir/userDataDir/sealer/fsMod/clock/zcodeRunning 全部可注入，vitest 用临时目录演练、真实文件零改动。
import fs from 'node:fs'
import path from 'node:path'
import type {
  ApiHubAdapterId,
  ApiHubAdapterInfo,
  ApiHubCurrentResult,
  ApiHubFieldDef,
  ApiHubProfile,
  ApiHubProfileInput,
  ApiHubSwitchResult,
  ApiHubSwitchStart
} from '../../shared/types'
import type { KimiSealer } from '../kimi/profiles'
import { profileInputFromConfigText } from '../kimi/profiles'
import { backupStamp, parseKimiConfigDisplay, thinkingEnabledOf, tomlQuote } from '../kimi/tomlEdit'
import { upsertHubProfile } from './store'
import { STATIC_API_HUB_CATALOG } from './catalog'
import {
  claudeApplyEnv,
  claudeParseEnv,
  claudeVerify,
  codexApplyAuth,
  codexApplyConfig,
  codexParseAuth,
  codexParseConfig,
  codexVerify,
  grokApply,
  grokParse,
  grokVerify,
  kimiApplyConfig,
  kimiVerify,
  tomlSetKey,
  zcodeApplyConfig,
  zcodeApplySetting,
  zcodeDeriveSelectedForm,
  zcodeParse,
  zcodeVerify,
  type KimiApplyFields
} from './transforms'
import { hubDecryptKey, loadHubStore, saveHubStore } from './store'
import { execAsync } from '../versionCenter/exec'

// ---------- 路径与目录 ----------

export function adapterPaths(adapterId: ApiHubAdapterId, homeDir: string): string[] {
  switch (adapterId) {
    case 'claude-cli':
      return [path.join(homeDir, '.claude', 'settings.json')]
    case 'codex':
      return [path.join(homeDir, '.codex', 'auth.json'), path.join(homeDir, '.codex', 'config.toml')]
    case 'grok':
      return [path.join(homeDir, '.grok', 'config.toml')]
    case 'kimi':
      return [path.join(homeDir, '.kimi-code', 'config.toml')]
    case 'zcode':
      return [path.join(homeDir, '.zcode', 'v2', 'config.json'), path.join(homeDir, '.zcode', 'v2', 'setting.json')]
    default:
      return []
  }
}

// ---------- 目录（CATALOG） ----------
// 静态目录本体已移到 catalog.ts（与动态合成共用同一份适配器定义，避免两处定义漂移）。
// 这份静态目录只在注册表读不到时兜底展示；正常情况下目录由 adapters.ts 按注册表动态合成。

export const API_HUB_CATALOG: ApiHubAdapterInfo[] = STATIC_API_HUB_CATALOG

// ---------- 内部工具 ----------

function readTextIfExists(fsMod: typeof fs, file: string): string {
  try {
    // 剥离 UTF-8 BOM：带 BOM 的 JSON 会让 JSON.parse 直接抛错，该用户将永远无法切换
    return fsMod.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return ''
  }
}

function fileExists(fsMod: typeof fs, file: string): boolean {
  try {
    return fsMod.existsSync(file)
  } catch {
    return false
  }
}

/** 顶层/节内 TOML 字符串值提取（字符串运算，读取 api_key 等全值专用；结果只进内存瞬间路径） */
function tomlStringValue(text: string, sectionInner: string | null, key: string): string | null {
  let header: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim()
    if (!t) continue
    if (t.startsWith('[') && t.endsWith(']')) {
      header = t.slice(1, -1).trim()
      continue
    }
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    if (k !== key) continue
    if (header !== sectionInner) continue
    const v = t.slice(eq + 1).trim()
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1)
    return null
  }
  return null
}

/** JSON 对象里按点路径取字符串值（如 env.ANTHROPIC_AUTH_TOKEN）；缺失返回 null */
function jsonStringByPath(text: string, segments: string[]): string | null {
  let obj: Record<string, unknown>
  try {
    const v = JSON.parse(text)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
    obj = v as Record<string, unknown>
  } catch {
    return null
  }
  let cur: unknown = obj
  for (const seg of segments) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return null
    cur = (cur as Record<string, unknown>)[seg]
  }
  return typeof cur === 'string' ? cur : null
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

function isProviderId(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(s)
}

export function validateHubFields(adapterId: ApiHubAdapterId, fields: Record<string, string>, hasKey: boolean): string | null {
  const nonEmpty = (k: string): boolean => Boolean((fields[k] ?? '').trim())
  switch (adapterId) {
    case 'claude-cli':
      if (!nonEmpty('baseUrl')) return 'Base URL 不能为空'
      if (!fields.baseUrl.trim().startsWith('http://') && !fields.baseUrl.trim().startsWith('https://')) return 'Base URL 必须以 http(s):// 开头'
      break
    case 'codex':
      if (!isProviderId(fields.providerId ?? '')) return 'Provider ID 只允许小写字母/数字/连字符'
      if (!nonEmpty('baseUrl')) return 'Base URL 不能为空'
      if (fields.wireApi !== 'responses' && fields.wireApi !== 'chat') return 'wireApi 只能是 responses 或 chat'
      break
    case 'grok': {
      if (!nonEmpty('modelId')) return '模型 ID 不能为空'
      if (!nonEmpty('baseUrl')) return 'Base URL 不能为空'
      if (!/^\d+$/.test((fields.contextWindow ?? '').trim())) return '上下文窗口必须是正整数'
      if (fields.apiBackend !== 'responses' && fields.apiBackend !== 'chat') return 'apiBackend 只能是 responses 或 chat'
      break
    }
    case 'kimi': {
      if (!isProviderId(fields.providerId ?? '')) return 'Provider ID 只允许小写字母/数字/连字符'
      if (!nonEmpty('modelId')) return '模型 ID 不能为空'
      if (!nonEmpty('baseUrl')) return 'Base URL 不能为空'
      if (!fields.baseUrl.trim().startsWith('http://') && !fields.baseUrl.trim().startsWith('https://')) return 'Base URL 必须以 http(s):// 开头'
      const t = (fields.type ?? '').trim()
      if (t && t !== 'openai' && t !== 'anthropic') return 'type 只能是 openai 或 anthropic'
      const mc = (fields.maxContext ?? '').trim()
      if (mc && !/^\d+$/.test(mc)) return '上下文窗口必须是正整数'
      const th = (fields.thinkingEnabled ?? '').trim()
      if (th && th !== 'true' && th !== 'false') return 'Thinking 只能是 true 或 false'
      break
    }
    case 'zcode':
      if (!isProviderId(fields.providerId ?? '')) return 'Provider ID 只允许小写字母/数字/连字符'
      if (!nonEmpty('providerName')) return '供应商名称不能为空'
      if (!nonEmpty('baseURL')) return 'Base URL 不能为空'
      break
    default:
      break
  }
  if (!hasKey) return null
  return null
}

// ---------- 适配器 glue：读当前 / 组装写入 ----------

type PreparedWrite = { path: string; next: string }

function claudeGlue(deps: ApiHubDeps, fields: Record<string, string>, apiKeyPlain: string): PreparedWrite[] {
  const fsMod = deps.fsMod ?? fs
  const file = adapterPaths('claude-cli', deps.homeDir)[0]
  const text = readTextIfExists(fsMod, file)
  return [{ path: file, next: claudeApplyEnv(text, fields.baseUrl.trim(), apiKeyPlain) }]
}

function codexGlue(deps: ApiHubDeps, fields: Record<string, string>, apiKeyPlain: string): PreparedWrite[] {
  const fsMod = deps.fsMod ?? fs
  const [authFile, configFile] = adapterPaths('codex', deps.homeDir)
  const authText = readTextIfExists(fsMod, authFile)
  const configText = readTextIfExists(fsMod, configFile)
  return [
    { path: authFile, next: codexApplyAuth(authText, apiKeyPlain) },
    { path: configFile, next: codexApplyConfig(configText, fields.providerId.trim(), fields.baseUrl.trim(), fields.wireApi.trim()) }
  ]
}

function grokGlue(deps: ApiHubDeps, fields: Record<string, string>, apiKeyPlain: string): PreparedWrite[] {
  const fsMod = deps.fsMod ?? fs
  const file = adapterPaths('grok', deps.homeDir)[0]
  const text = readTextIfExists(fsMod, file)
  const f = {
    modelId: fields.modelId.trim(),
    baseUrl: fields.baseUrl.trim(),
    name: (fields.name ?? '').trim() || fields.modelId.trim(),
    apiBackend: fields.apiBackend === 'chat' ? 'chat' : 'responses',
    // 非数字输入兜底 0（NaN 会写出非法 TOML 'context_window = NaN'）
    contextWindow: (() => {
      const n = Number((fields.contextWindow ?? '0').trim())
      return Number.isFinite(n) && n > 0 ? n : 0
    })()
  }
  return [{ path: file, next: grokApply(text, f, apiKeyPlain) }]
}

/**
 * apihub fields Record → kimi 规范字段（缺省值与旧 Kimi 接口页一致：type=openai、maxContext=131072、
 * modelDisplay 同模型 ID、thinkingEnabled=true）。
 */
export function kimiFieldsOf(fields: Record<string, string>): KimiApplyFields {
  const modelId = (fields.modelId ?? '').trim()
  const maxContext = Number((fields.maxContext ?? '').trim())
  return {
    providerId: (fields.providerId ?? '').trim(),
    modelId,
    baseUrl: (fields.baseUrl ?? '').trim(),
    type: (fields.type ?? '').trim() || 'openai',
    modelDisplay: (fields.modelDisplay ?? '').trim() || modelId,
    maxContext: Number.isFinite(maxContext) && maxContext > 0 ? Math.trunc(maxContext) : 131072,
    capabilities: (fields.capabilities ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    thinkingEnabled: (fields.thinkingEnabled ?? '').trim() !== 'false'
  }
}

function kimiGlue(deps: ApiHubDeps, fields: Record<string, string>, apiKeyPlain: string): PreparedWrite[] {
  const fsMod = deps.fsMod ?? fs
  const file = adapterPaths('kimi', deps.homeDir)[0]
  const text = readTextIfExists(fsMod, file)
  return [{ path: file, next: kimiApplyConfig(text, kimiFieldsOf(fields), apiKeyPlain) }]
}

function zcodeGlue(deps: ApiHubDeps, fields: Record<string, string>, apiKeyPlain: string, knownForms: string[]): PreparedWrite[] {
  const fsMod = deps.fsMod ?? fs
  const [configFile, settingFile] = adapterPaths('zcode', deps.homeDir)
  const configText = readTextIfExists(fsMod, configFile)
  const settingText = readTextIfExists(fsMod, settingFile)
  const selectedValue = (fields.selectedKeyForm ?? '').trim() || zcodeDeriveSelectedForm(knownForms, fields.providerId.trim())
  return [
    {
      path: configFile,
      next: zcodeApplyConfig(configText, { providerId: fields.providerId.trim(), providerName: fields.providerName.trim(), baseURL: fields.baseURL.trim(), kind: (fields.kind ?? 'anthropic').trim() }, apiKeyPlain)
    },
    { path: settingFile, next: zcodeApplySetting(settingText, selectedValue) }
  ]
}

// ---------- 当前状态读取（脱敏） ----------

export async function apihubReadCurrent(adapterId: ApiHubAdapterId, deps: ApiHubDeps): Promise<ApiHubCurrentResult> {
  const info = API_HUB_CATALOG.find((a) => a.id === adapterId)
  if (!info || !info.available) {
    return {
      adapterId,
      available: false,
      naReason: info?.naReason ?? '该适配器不可用',
      configPaths: [],
      baseUrl: null,
      apiKeyTail: null,
      apiKeyLen: null,
      detail: {},
      activeId: null,
      matchedProfileId: null
    }
  }
  const fsMod = deps.fsMod ?? fs
  const paths = adapterPaths(adapterId, deps.homeDir)
  const store = loadHubStore(deps.userDataDir, fsMod)
  const activeId = store.activeByAdapter[adapterId] ?? null
  const base: ApiHubCurrentResult = {
    adapterId,
    available: true,
    configPaths: paths,
    baseUrl: null,
    apiKeyTail: null,
    apiKeyLen: null,
    detail: {},
    activeId,
    matchedProfileId: null
  }
  if (adapterId === 'claude-cli') {
    const d = claudeParseEnv(readTextIfExists(fsMod, paths[0]))
    base.baseUrl = d.baseUrl
    base.apiKeyTail = d.keyTail
    base.apiKeyLen = d.keyLen
    base.matchedProfileId = (sectionProfiles(store, adapterId).find((p) => p.fields.baseUrl === d.baseUrl) ?? { id: null }).id ?? null
    return base
  }
  if (adapterId === 'codex') {
    const auth = codexParseAuth(readTextIfExists(fsMod, paths[0]))
    const cfg = codexParseConfig(readTextIfExists(fsMod, paths[1]))
    base.baseUrl = cfg.baseUrl
    base.apiKeyTail = auth.keyTail
    base.apiKeyLen = auth.keyLen
    base.detail.modelProvider = cfg.modelProvider ?? '（未设置）'
    base.detail.wireApi = cfg.wireApi ?? '（未设置）'
    base.matchedProfileId =
      (sectionProfiles(store, adapterId).find((p) => p.fields.providerId === cfg.modelProvider && p.fields.baseUrl === cfg.baseUrl) ?? { id: null }).id ?? null
    return base
  }
  if (adapterId === 'grok') {
    const d = grokParse(readTextIfExists(fsMod, paths[0]))
    base.baseUrl = d.baseUrl
    base.apiKeyTail = d.keyTail
    base.apiKeyLen = d.keyLen
    base.detail.defaultModel = d.defaultModel ?? '（未设置）'
    base.detail.apiBackend = d.apiBackend ?? '（未设置）'
    base.detail.contextWindow = d.contextWindow === null ? '（未设置）' : String(d.contextWindow)
    base.matchedProfileId = (sectionProfiles(store, adapterId).find((p) => p.fields.modelId === d.defaultModel) ?? { id: null }).id ?? null
    return base
  }
  if (adapterId === 'kimi') {
    const text = readTextIfExists(fsMod, paths[0])
    const d = parseKimiConfigDisplay(text)
    const model = d.models.find((m) => m.id === d.defaultModel)
    const prov = d.providers.find((p) => p.id === model?.provider)
    base.baseUrl = prov?.baseUrl ?? null
    base.apiKeyTail = prov?.apiKeyTail ?? null
    base.apiKeyLen = prov?.apiKeyLen ?? null
    base.detail.defaultModel = d.defaultModel ?? '（未设置）'
    base.detail.thinking = thinkingEnabledOf(text) ? 'true' : 'false'
    if (model) {
      base.detail.modelDisplay = model.displayName ?? model.model ?? '（未设置）'
      base.detail.maxContext = model.maxContext === undefined ? '（未设置）' : String(model.maxContext)
      if (model.capabilities && model.capabilities.length) base.detail.capabilities = model.capabilities.join(', ')
    }
    base.matchedProfileId =
      (sectionProfiles(store, adapterId).find((p) => kimiCompositeKey(p.fields) === d.defaultModel) ?? { id: null }).id ?? null
    return base
  }
  // zcode
  const d = zcodeParse(readTextIfExists(fsMod, paths[0]), readTextIfExists(fsMod, paths[1]))
  const selectedId = selectedProviderId(d.selected, d.providers.map((p) => p.id))
  const current = d.providers.find((p) => p.id === selectedId)
  base.baseUrl = current?.baseURL ?? null
  base.apiKeyTail = current?.keyTail ?? null
  base.apiKeyLen = current?.keyLen ?? null
  base.detail.selected = d.selected ?? '（未设置）'
  base.detail.providers = String(d.providers.length) + ' 条（' + d.providers.map((p) => p.id + (p.enabled ? '✓' : '✗')).join(', ') + '）'
  base.matchedProfileId = (sectionProfiles(store, adapterId).find((p) => p.fields.providerId === selectedId) ?? { id: null }).id ?? null
  return base
}

function sectionProfiles(store: ReturnType<typeof loadHubStore>, adapterId: ApiHubAdapterId): ApiHubProfile[] {
  return store.byAdapter[adapterId] ?? []
}

/** kimi 档案的复合模型键 "<providerId>/<modelId>"（与 config.toml 的 default_model 同形，用于命中判定） */
function kimiCompositeKey(fields: Record<string, string>): string {
  return (fields.providerId ?? '').trim() + '/' + (fields.modelId ?? '').trim()
}

/**
 * 从 selectedKey 形态反向解析 providerId。providerId 本身可含冒号（真机如 builtin:bigmodel-coding-plan），
 * 故优先按『已知 providerId 结尾』匹配（selected === id 或以 ':' + id 结尾），退而求其次取最后一个 ':' 之后段。
 */
function selectedProviderId(selected: string | null, providerIds: string[]): string | null {
  if (!selected) return null
  const hit = providerIds.find((id) => selected === id || selected.endsWith(':' + id))
  if (hit) return hit
  const idx = selected.lastIndexOf(':')
  return idx >= 0 ? selected.slice(idx + 1) : selected
}

// ---------- 导入当前配置 ----------

export async function apihubImportCurrent(
  adapterId: ApiHubAdapterId,
  deps0: ApiHubDeps
): Promise<{ imported: boolean; profile: ApiHubProfile | null; reason?: string }> {
  const deps: ApiHubDeps = { ...deps0, fsMod: deps0.fsMod ?? fs }
  const fsMod = deps.fsMod as typeof fs
  const paths = adapterPaths(adapterId, deps.homeDir)
  const upsert = (fields: Record<string, string>, name: string, key: string): ApiHubProfile => {
    const input: ApiHubProfileInput = { adapterId, name, fields }
    return upsertWithActive(deps, input, key)
  }
  if (adapterId === 'claude-cli') {
    const text = readTextIfExists(fsMod, paths[0])
    const key = jsonStringByPath(text, ['env', 'ANTHROPIC_AUTH_TOKEN'])
    const baseUrl = jsonStringByPath(text, ['env', 'ANTHROPIC_BASE_URL'])
    if (!key || !baseUrl) return { imported: false, profile: null, reason: 'settings.json 中没有 env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN，无法导入' }
    return { imported: true, profile: upsert({ baseUrl }, hostLabel(baseUrl), key) }
  }
  if (adapterId === 'codex') {
    const authText = readTextIfExists(fsMod, paths[0])
    const key = jsonStringByPath(authText, ['OPENAI_API_KEY'])
    const cfg = codexParseConfig(readTextIfExists(fsMod, paths[1]))
    if (!key || !cfg.modelProvider || !cfg.baseUrl) {
      return { imported: false, profile: null, reason: 'auth.json 缺 OPENAI_API_KEY 或 config.toml 缺 model_providers 块，无法导入' }
    }
    return {
      imported: true,
      profile: upsert({ providerId: cfg.modelProvider, baseUrl: cfg.baseUrl, wireApi: cfg.wireApi ?? 'responses' }, hostLabel(cfg.baseUrl), key)
    }
  }
  if (adapterId === 'grok') {
    const text = readTextIfExists(fsMod, paths[0])
    const d = grokParse(text)
    if (!d.defaultModel || !d.baseUrl) return { imported: false, profile: null, reason: 'config.toml 缺 [models] default 或 [model] 块，无法导入' }
    const key = tomlStringValue(text, 'model.' + tomlQuote(d.defaultModel), 'api_key')
    if (!key) return { imported: false, profile: null, reason: '当前 [model] 块中没有 api_key，无法导入' }
    return {
      imported: true,
      profile: upsert(
        {
          modelId: d.defaultModel,
          baseUrl: d.baseUrl,
          name: d.name ?? d.defaultModel,
          apiBackend: d.apiBackend ?? 'responses',
          contextWindow: d.contextWindow === null ? '0' : String(d.contextWindow)
        },
        d.name ?? hostLabel(d.baseUrl),
        key
      )
    }
  }
  if (adapterId === 'kimi') {
    const text = readTextIfExists(fsMod, paths[0])
    if (!text.trim()) return { imported: false, profile: null, reason: '找不到 ' + paths[0] + '（或内容为空），无法导入' }
    // 复用旧 Kimi 接口链路的解析（结构不明拒绝导入，不硬解）；key 全值只在内存一瞬间，立即 seal
    let input: ReturnType<typeof profileInputFromConfigText>['input']
    let key: string
    try {
      const r = profileInputFromConfigText(text)
      input = r.input
      key = r.apiKeyPlain
    } catch (e) {
      return { imported: false, profile: null, reason: e instanceof Error ? e.message : String(e) }
    }
    return {
      imported: true,
      profile: upsert(
        {
          providerId: input.providerId,
          type: input.type,
          baseUrl: input.baseUrl,
          modelId: input.modelId,
          modelDisplay: input.modelDisplay,
          maxContext: String(input.maxContext),
          capabilities: input.capabilities.join(', '),
          thinkingEnabled: input.thinkingEnabled ? 'true' : 'false'
        },
        input.name,
        key
      )
    }
  }
  if (adapterId === 'zcode') {
    const configText = readTextIfExists(fsMod, paths[0])
    const settingText = readTextIfExists(fsMod, paths[1])
    const d = zcodeParse(configText, settingText)
    const id = selectedProviderId(d.selected, d.providers.map((p) => p.id))
    const cur = d.providers.find((p) => p.id === id)
    if (!cur || !cur.baseURL) return { imported: false, profile: null, reason: 'v2/setting.json 中没有 bigmodel 当前选中或对应 provider 条目，无法导入' }
    const key = jsonStringByPath(configText, ['provider', cur.id, 'options', 'apiKey'])
    if (!key) return { imported: false, profile: null, reason: '当前 provider 条目中没有 options.apiKey，无法导入' }
    const form = (d.selected ?? '') || zcodeDeriveSelectedForm(d.knownForms, cur.id)
    return {
      imported: true,
      profile: upsert({ providerId: cur.id, providerName: cur.name ?? cur.id, baseURL: cur.baseURL, kind: 'anthropic', selectedKeyForm: form }, cur.name ?? cur.id, key)
    }
  }
  return { imported: false, profile: null, reason: '该适配器不支持导入' }
}

function upsertWithActive(deps: ApiHubDeps, input: ApiHubProfileInput, apiKeyPlain: string): ApiHubProfile {
  const fsMod = deps.fsMod ?? fs
  const saved = upsertHubProfile(deps.userDataDir, input, apiKeyPlain, deps.sealer, fsMod)
  const store = loadHubStore(deps.userDataDir, fsMod)
  if (!store.activeByAdapter[input.adapterId]) {
    store.activeByAdapter[input.adapterId] = saved.id
    saveHubStore(deps.userDataDir, store, fsMod)
  }
  return saved
}

// ---------- 切换骨架 ----------

export type ApiHubDeps = {
  homeDir: string
  userDataDir: string
  sealer: KimiSealer
  fsMod?: typeof fs
  clock?: () => Date
  /** zcode 运行检测（默认 tasklist ZCode.exe；测试注入） */
  zcodeRunning?: () => Promise<boolean>
}

/** 默认 zcode 运行检测：tasklist 查 ZCode.exe（异步，绝不阻塞事件循环） */
export async function zcodeRunningDefault(): Promise<boolean> {
  const r = await execAsync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe', '/FO', 'CSV', '/NH'], { timeoutMs: 15000 }).done
  return r.ok && r.stdout.includes('ZCode.exe')
}

/**
 * 一键切换：zcode 预检（blocked 语义）→ 组装写入 → 备份 → 原子写 → 重读校验（失败逐文件回滚）。
 * 任一步失败：尚未写盘则原文件分毫未动；已写盘但校验失败则从备份回滚后抛错。
 */
export async function apihubSwitch(
  adapterId: ApiHubAdapterId,
  profileId: string,
  deps: ApiHubDeps,
  opts?: { confirmed?: boolean }
): Promise<ApiHubSwitchStart | ApiHubSwitchResult> {
  if (!API_HUB_CATALOG.find((a) => a.id === adapterId)?.available) throw new Error('该适配器不支持切换: ' + adapterId)
  if (adapterId === 'zcode' && !opts?.confirmed) {
    const running = deps.zcodeRunning ? await deps.zcodeRunning() : await zcodeRunningDefault()
    if (running) return { blocked: true, running: true, processName: 'ZCode.exe' }
  }
  const fsMod: typeof fs = deps.fsMod ?? fs
  const deps2: ApiHubDeps = { ...deps, fsMod }
  const now = deps.clock ?? (() => new Date())
  const store = loadHubStore(deps.userDataDir, fsMod)
  const profile = sectionProfiles(store, adapterId).find((p) => p.id === profileId)
  if (!profile) throw new Error('找不到档案: ' + profileId)
  const apiKeyPlain = hubDecryptKey(profile, deps.sealer)
  const fields = profile.fields

  // 1) 组装写入
  let writes: PreparedWrite[]
  if (adapterId === 'claude-cli') {
    writes = claudeGlue(deps2, fields, apiKeyPlain)
  } else if (adapterId === 'codex') {
    writes = codexGlue(deps2, fields, apiKeyPlain)
  } else if (adapterId === 'grok') {
    writes = grokGlue(deps2, fields, apiKeyPlain)
  } else if (adapterId === 'kimi') {
    writes = kimiGlue(deps2, fields, apiKeyPlain)
  } else {
    // knownForms 必须来自真实 setting.json：传空串会让 zcodeDeriveSelectedForm 永远落到兜底公式，
    // 静默改掉用户已有的非标准形态（还会导致校验路径派生出不同形态而永久切换失败）
    const zpaths = adapterPaths('zcode', deps.homeDir)
    const d = zcodeParse(readTextIfExists(fsMod, zpaths[0]), readTextIfExists(fsMod, zpaths[1]))
    writes = zcodeGlue(deps2, fields, apiKeyPlain, d.knownForms)
  }

  // 2) 备份（已存在才备份）；path → backup 的映射（回滚按路径取，绝不用数组下标对位）
  const backupOf = new Map<string, string>()
  for (const w of writes) {
    if (fileExists(fsMod, w.path)) {
      const backup = w.path + '.bak_' + backupStamp(now())
      fsMod.copyFileSync(w.path, backup)
      backupOf.set(w.path, backup)
    }
  }

  // 3) 原子写全部目标文件；中途失败时把已 rename 成功的前序文件从备份恢复（否则留下互相不匹配的配置对）
  const tmpFiles: string[] = []
  const written: string[] = []
  const rollbackWritten = (): void => {
    for (const p of written) {
      const backup = backupOf.get(p)
      try {
        if (backup) fsMod.copyFileSync(backup, p)
        else if (fsMod.existsSync(p)) fsMod.unlinkSync(p)
      } catch {
        /* 回滚失败只能如实报告（备份仍在） */
      }
    }
  }
  try {
    for (const w of writes) {
      fsMod.mkdirSync(path.dirname(w.path), { recursive: true })
      const tmp = w.path + '.tmp-' + process.pid + '-' + Date.now()
      tmpFiles.push(tmp)
      fsMod.writeFileSync(tmp, w.next, 'utf8')
      fsMod.renameSync(tmp, w.path)
      written.push(w.path)
    }
  } catch (e) {
    for (const tmp of tmpFiles) {
      try {
        if (fsMod.existsSync(tmp)) fsMod.unlinkSync(tmp)
      } catch {
        /* 清理失败不掩盖原错误 */
      }
    }
    rollbackWritten()
    throw e
  }

  // 4) 重读校验；失败逐文件回滚后抛错
  try {
    verifyAdapter(adapterId, deps, fields, apiKeyPlain)
  } catch (e) {
    rollbackWritten()
    throw e
  }

  // 5) 登记生效档案
  const st = loadHubStore(deps.userDataDir, fsMod)
  st.activeByAdapter[adapterId] = profile.id
  saveHubStore(deps.userDataDir, st, fsMod)
  return { backupFiles: [...backupOf.values()], warning: adapterId === 'zcode' ? '重启 ZCode 后生效；若选中键形态派生有误，请在 ZCode 模型设置中核对' : undefined }
}

/** 重读校验：按适配器调 transforms 的 verify 系列 */
function verifyAdapter(adapterId: ApiHubAdapterId, deps: ApiHubDeps, fields: Record<string, string>, apiKeyPlain: string): void {
  const fsMod = deps.fsMod ?? fs
  const paths = adapterPaths(adapterId, deps.homeDir)
  if (adapterId === 'claude-cli') {
    claudeVerify(readTextIfExists(fsMod, paths[0]), fields.baseUrl.trim(), apiKeyPlain)
    return
  }
  if (adapterId === 'codex') {
    codexVerify(readTextIfExists(fsMod, paths[0]), readTextIfExists(fsMod, paths[1]), fields.providerId.trim(), fields.baseUrl.trim(), apiKeyPlain)
    return
  }
  if (adapterId === 'grok') {
    grokVerify(readTextIfExists(fsMod, paths[0]), { modelId: fields.modelId.trim(), baseUrl: fields.baseUrl.trim() }, apiKeyPlain)
    return
  }
  if (adapterId === 'kimi') {
    kimiVerify(readTextIfExists(fsMod, paths[0]), kimiFieldsOf(fields), apiKeyPlain)
    return
  }
  if (adapterId === 'zcode') {
    const configText = readTextIfExists(fsMod, paths[0])
    const settingText = readTextIfExists(fsMod, paths[1])
    const known = zcodeParse(configText, settingText).knownForms
    const selectedValue = (fields.selectedKeyForm ?? '').trim() || zcodeDeriveSelectedForm(known, fields.providerId.trim())
    zcodeVerify(configText, settingText, fields.providerId.trim(), fields.baseURL.trim(), selectedValue, apiKeyPlain)
  }
}
