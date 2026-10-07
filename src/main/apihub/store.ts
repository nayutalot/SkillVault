// 接口中心档案库：userData/api-hub-profiles.json，按适配器分节 + 自定义供应商一节。
// api_key 以 Electron safeStorage（Windows DPAPI）加密后 base64 落盘；不可用时降级 base64 明文并标记 plainStore:true。
// 全值只在 seal/解密瞬间存在于内存，绝不写日志/缓存/仓库。fs 与 sealer 全部可注入，vitest 直接单测。
// 语义与 kimi/profiles.ts 同族（复用其 KimiSealer 接口与 seal 策略）；旧「Kimi 接口」页档案在此自动迁移进 kimi 节。
import fs from 'node:fs'
import path from 'node:path'
import type {
  ApiHubAdapterId,
  ApiHubCustomProvider,
  ApiHubCustomProviderInput,
  ApiHubCustomProviderView,
  ApiHubProfile,
  ApiHubProfileInput,
  ApiHubProfileView,
  ApiHubProviderProtocol,
  KimiProfile
} from '../../shared/types'
import { loadStore as loadLegacyKimiStore, profilesFile, type KimiSealer } from '../kimi/profiles'
import { maskSecret } from '../kimi/tomlEdit'

export const API_HUB_STORE_VERSION = 1 as const

export type ApiHubStore = {
  version: typeof API_HUB_STORE_VERSION
  byAdapter: Partial<Record<ApiHubAdapterId, ApiHubProfile[]>>
  activeByAdapter: Partial<Record<ApiHubAdapterId, string | null>>
  /**
   * 自定义供应商（用户自填 API 地址 + 密钥，一次配置给所有支持的 agent 一键填入）。
   * 旧文件没有这一节 → 读成空数组；**故意不升 version**：升版会让 loadHubStore 把旧文件判为不兼容整体丢弃，
   * 用户已存的档案全没了。加可选字段是向后/向前都兼容的。
   */
  customProviders?: ApiHubCustomProvider[]
}

export function emptyHubStore(): ApiHubStore {
  return { version: API_HUB_STORE_VERSION, byAdapter: {}, activeByAdapter: {}, customProviders: [] }
}

export function apiHubStoreFile(userDataDir: string): string {
  return path.join(userDataDir, 'api-hub-profiles.json')
}

function sectionOf(store: ApiHubStore, adapterId: ApiHubAdapterId): ApiHubProfile[] {
  return store.byAdapter[adapterId] ?? []
}

/**
 * 旧「Kimi 接口」页档案（userData/kimi-profiles.json）→ 接口中心 kimi 节的档案映射。
 * id/name/apiKeySealed/plainStore 原样搬运（不重新 seal，DPAPI 密文跨迁移必须逐字节一致），
 * 结构化字段平铺进 fields（maxContext/capabilities/thinkingEnabled 转字符串承载）。
 */
export function kimiProfileToHub(p: KimiProfile): ApiHubProfile {
  return {
    id: p.id,
    adapterId: 'kimi',
    name: p.name,
    fields: {
      providerId: p.providerId,
      type: p.type,
      baseUrl: p.baseUrl,
      modelId: p.modelId,
      modelDisplay: p.modelDisplay,
      maxContext: String(p.maxContext),
      capabilities: p.capabilities.join(', '),
      thinkingEnabled: p.thinkingEnabled ? 'true' : 'false'
    },
    apiKeySealed: p.apiKeySealed,
    ...(p.plainStore === true ? { plainStore: true as const } : {})
  }
}

/**
 * 旧 Kimi 档案一次性自动迁移：apihub 库尚无 kimi 节且旧文件存在 → 档案与 activeId 映射进 kimi 节并落盘；
 * 旧文件保留不删（作为备份）。kimi 节一旦存在（即便被用户清空成空数组）不再重复迁移，避免删档后被旧文件复活。
 * 迁移失败不抛（接口中心照常可用），下次加载自动重试。
 */
export function migrateLegacyKimiProfiles(
  userDataDir: string,
  store: ApiHubStore,
  fsMod: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'mkdirSync' | 'writeFileSync' | 'renameSync'>
): ApiHubStore {
  if (store.byAdapter['kimi']) return store
  try {
    if (!fsMod.existsSync(profilesFile(userDataDir))) return store
    const legacy = loadLegacyKimiStore(userDataDir, fsMod)
    if (!legacy.profiles.length) return store
    store.byAdapter['kimi'] = legacy.profiles.map(kimiProfileToHub)
    if (legacy.activeId && legacy.profiles.some((p) => p.id === legacy.activeId)) {
      store.activeByAdapter['kimi'] = legacy.activeId
    }
    saveHubStore(userDataDir, store, fsMod)
    return store
  } catch {
    return store
  }
}

const PROVIDER_PROTOCOLS: readonly ApiHubProviderProtocol[] = ['anthropic', 'openai', 'gemini']

function isProtocol(v: unknown): v is ApiHubProviderProtocol {
  return typeof v === 'string' && (PROVIDER_PROTOCOLS as readonly string[]).includes(v)
}

/** 自定义供应商落盘解析：单条不合法就跳过（不让一条坏数据带走整份供应商列表） */
function parseProviders(raw: unknown): ApiHubCustomProvider[] {
  if (!Array.isArray(raw)) return []
  const out: ApiHubCustomProvider[] = []
  for (const p of raw) {
    if (typeof p !== 'object' || p === null) continue
    const o = p as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id) continue
    if (typeof o.apiKeySealed !== 'string' || !o.apiKeySealed) continue
    if (typeof o.label !== 'string' || typeof o.baseUrl !== 'string' || !isProtocol(o.protocol)) continue
    out.push({
      id: o.id,
      label: o.label,
      baseUrl: o.baseUrl,
      protocol: o.protocol,
      ...(typeof o.defaultModel === 'string' && o.defaultModel ? { defaultModel: o.defaultModel } : {}),
      ...(typeof o.notes === 'string' && o.notes ? { notes: o.notes } : {}),
      apiKeySealed: o.apiKeySealed,
      ...(o.plainStore === true ? { plainStore: true as const } : {}),
      createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0
    })
  }
  return out
}

/** 读档案库（损坏/版本不符一律回落空库，不让接口中心页起不来）；读后尝试旧 Kimi 档案自动迁移 */
export function loadHubStore(
  userDataDir: string,
  fsMod: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'mkdirSync' | 'writeFileSync' | 'renameSync'> = fs
): ApiHubStore {
  const file = apiHubStoreFile(userDataDir)
  let store: ApiHubStore
  try {
    if (!fsMod.existsSync(file)) {
      store = emptyHubStore()
    } else {
      const raw = JSON.parse(fsMod.readFileSync(file, 'utf8')) as Partial<ApiHubStore>
      if (raw.version !== API_HUB_STORE_VERSION || typeof raw.byAdapter !== 'object' || raw.byAdapter === null) {
        store = emptyHubStore()
      } else {
        const byAdapter: Partial<Record<ApiHubAdapterId, ApiHubProfile[]>> = {}
        for (const [adapterId, list] of Object.entries(raw.byAdapter)) {
          if (!Array.isArray(list)) continue
          const profiles: ApiHubProfile[] = []
          for (const p of list) {
            if (typeof p !== 'object' || p === null) continue
            if (typeof p.id !== 'string' || !p.id) continue
            if (typeof p.apiKeySealed !== 'string' || !p.apiKeySealed) continue
            profiles.push({
              id: p.id,
              adapterId: adapterId as ApiHubAdapterId,
              name: String(p.name ?? ''),
              fields: typeof p.fields === 'object' && p.fields !== null ? { ...(p.fields as Record<string, string>) } : {},
              apiKeySealed: p.apiKeySealed,
              ...(p.plainStore === true ? { plainStore: true as const } : {})
            })
          }
          // 空节也保留（如用户清空 kimi 节）：这是「已迁移/已管理」的标记，防止旧文件重复迁移
          byAdapter[adapterId as ApiHubAdapterId] = profiles
        }
        const activeByAdapter: Partial<Record<ApiHubAdapterId, string | null>> = {}
        for (const [adapterId, activeId] of Object.entries(raw.activeByAdapter ?? {})) {
          const list = byAdapter[adapterId as ApiHubAdapterId] ?? []
          if (typeof activeId === 'string' && list.some((p) => p.id === activeId)) {
            activeByAdapter[adapterId as ApiHubAdapterId] = activeId
          }
        }
        store = { version: API_HUB_STORE_VERSION, byAdapter, activeByAdapter, customProviders: parseProviders(raw.customProviders) }
      }
    }
  } catch {
    store = emptyHubStore()
  }
  return migrateLegacyKimiProfiles(userDataDir, store, fsMod)
}

/** 写档案库（临时文件 + rename 原子落盘） */
export function saveHubStore(
  userDataDir: string,
  store: ApiHubStore,
  fsMod: Pick<typeof fs, 'mkdirSync' | 'writeFileSync' | 'renameSync'> = fs
): void {
  fsMod.mkdirSync(userDataDir, { recursive: true })
  const file = apiHubStoreFile(userDataDir)
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  fsMod.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
  fsMod.renameSync(tmp, file)
}

export function newHubProfileId(adapterId: string): string {
  return 'ah-' + adapterId + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36)
}

/** seal：DPAPI 可用走 safeStorage 加密；不可用降级 base64 明文（调用方落 plainStore 标记） */
export function hubSealKey(plain: string, useEncryption: boolean, sealer: KimiSealer): string {
  if (useEncryption) return sealer.encrypt(plain)
  return Buffer.from(plain, 'utf8').toString('base64')
}

/** 解密 api_key（plainStore 降级态先 base64 还原）；仅供切换/掩码等主进程路径使用。
 *  参数只取密文与降级标记两个字段 —— 档案与自定义供应商共用同一套 seal/解密机制。 */
export function hubDecryptKey(p: { apiKeySealed: string; plainStore?: true }, sealer: KimiSealer): string {
  if (p.plainStore === true) return Buffer.from(p.apiKeySealed, 'base64').toString('utf8')
  return sealer.decrypt(p.apiKeySealed)
}

/** 档案 → 脱敏视图（解密仅取掩码；解密失败如实回 null，不抛、不伪造） */
export function hubProfileView(p: ApiHubProfile, sealer: KimiSealer): ApiHubProfileView {
  let masked = { tail: null as string | null, len: null as number | null }
  try {
    const m = maskSecret(hubDecryptKey(p, sealer))
    masked = { tail: m.tail, len: m.len }
  } catch {
    /* 换机后 DPAPI 密文不可解：如实显示未知 */
  }
  return {
    id: p.id,
    name: p.name,
    fields: { ...p.fields },
    apiKeyTail: masked.tail,
    apiKeyLen: masked.len,
    plainStore: p.plainStore === true
  }
}

export function listHubViews(store: ApiHubStore, adapterId: ApiHubAdapterId, sealer: KimiSealer): ApiHubProfileView[] {
  return sectionOf(store, adapterId).map((p) => hubProfileView(p, sealer))
}

/**
 * 新增/编辑档案。apiKeyPlain 非空 → 重新 seal；为空且是编辑 → 保留原 sealed（编辑时留空 = 不改动 key）。
 * 字段校验由调用方（适配器层）完成后传入；此处只做通用必做项。校验失败抛错。
 */
export function upsertHubProfile(
  userDataDir: string,
  input: ApiHubProfileInput,
  apiKeyPlain: string,
  sealer: KimiSealer,
  fsMod: typeof fs = fs
): ApiHubProfile {
  if (!input.name.trim()) throw new Error('档案名不能为空')
  const store = loadHubStore(userDataDir, fsMod)
  const list = sectionOf(store, input.adapterId)
  const existing = input.id ? list.find((p) => p.id === input.id) : undefined
  if (input.id && !existing) throw new Error('找不到要编辑的档案: ' + input.id)
  let profile: ApiHubProfile
  if (existing && !apiKeyPlain.trim()) {
    profile = { ...existing, name: input.name.trim(), fields: { ...input.fields } }
  } else {
    if (!apiKeyPlain.trim()) throw new Error('API Key 不能为空（编辑时留空表示不改动）')
    const useDpapi = sealer.isEncryptionAvailable()
    profile = {
      id: existing?.id ?? newHubProfileId(input.adapterId),
      adapterId: input.adapterId,
      name: input.name.trim(),
      fields: { ...input.fields },
      apiKeySealed: hubSealKey(apiKeyPlain, useDpapi, sealer),
      ...(useDpapi ? {} : { plainStore: true as const })
    }
  }
  store.byAdapter[input.adapterId] = existing
    ? list.map((p) => (p.id === profile.id ? profile : p))
    : [...list, profile]
  saveHubStore(userDataDir, store, fsMod)
  return profile
}

/** 删除档案；若删除的是生效档案，active 置空。返回删除后的 store。 */
export function deleteHubProfile(
  userDataDir: string,
  adapterId: ApiHubAdapterId,
  id: string,
  fsMod: typeof fs = fs
): ApiHubStore {
  const store = loadHubStore(userDataDir, fsMod)
  const list = sectionOf(store, adapterId)
  const next = list.filter((p) => p.id !== id)
  if (next.length === list.length) throw new Error('找不到要删除的档案: ' + id)
  store.byAdapter[adapterId] = next
  if (store.activeByAdapter[adapterId] === id) store.activeByAdapter[adapterId] = null
  saveHubStore(userDataDir, store, fsMod)
  return store
}

// ---------- 自定义供应商（用户自己填 API 地址 + 密钥） ----------

export function newProviderId(): string {
  return 'cp-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36)
}

export function listCustomProviders(store: ApiHubStore): ApiHubCustomProvider[] {
  return store.customProviders ?? []
}

export function findCustomProvider(store: ApiHubStore, id: string): ApiHubCustomProvider | undefined {
  return listCustomProviders(store).find((p) => p.id === id)
}

/** 通用必做校验（适配器无关）；错误文案白话，用户看得懂要改哪里 */
export function validateCustomProviderInput(input: ApiHubCustomProviderInput | undefined): string | null {
  if (!input || typeof input !== 'object') return '供应商信息不能为空'
  if (typeof input.label !== 'string' || !input.label.trim()) return '供应商名称不能为空'
  const url = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  if (!url) return 'API 地址（Base URL）不能为空'
  if (!url.startsWith('http://') && !url.startsWith('https://')) return 'API 地址必须以 http:// 或 https:// 开头'
  if (!isProtocol(input.protocol)) return '接口格式只能是 anthropic / openai / gemini'
  return null
}

/** 供应商 → 脱敏视图（解密仅取掩码；解密失败如实回 null，不抛、不伪造） */
export function customProviderView(p: ApiHubCustomProvider, sealer: KimiSealer): ApiHubCustomProviderView {
  let masked = { tail: null as string | null, len: null as number | null }
  try {
    const m = maskSecret(hubDecryptKey(p, sealer))
    masked = { tail: m.tail, len: m.len }
  } catch {
    /* 换机后 DPAPI 密文不可解：如实显示未知 */
  }
  return {
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    protocol: p.protocol,
    ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}),
    ...(p.notes ? { notes: p.notes } : {}),
    apiKeyTail: masked.tail,
    apiKeyLen: masked.len,
    plainStore: p.plainStore === true,
    createdAt: p.createdAt
  }
}

export function listCustomProviderViews(store: ApiHubStore, sealer: KimiSealer): ApiHubCustomProviderView[] {
  return listCustomProviders(store).map((p) => customProviderView(p, sealer))
}

/**
 * 新增/编辑自定义供应商。apiKeyPlain 非空 → 重新 seal；为空且是编辑 → 保留原密文（留空 = 不改动密钥）。
 * 与档案同一规矩：明文只在入参瞬间存在，立即 seal，绝不返回渲染层。
 */
export function upsertCustomProvider(
  userDataDir: string,
  input: ApiHubCustomProviderInput,
  apiKeyPlain: string,
  sealer: KimiSealer,
  fsMod: typeof fs = fs
): ApiHubCustomProvider {
  const err = validateCustomProviderInput(input)
  if (err) throw new Error(err)
  const store = loadHubStore(userDataDir, fsMod)
  const list = listCustomProviders(store)
  const existing = input.id ? list.find((p) => p.id === input.id) : undefined
  if (input.id && !existing) throw new Error('找不到要编辑的供应商: ' + input.id)
  const base = {
    id: existing?.id ?? newProviderId(),
    label: input.label.trim(),
    baseUrl: input.baseUrl.trim(),
    protocol: input.protocol,
    ...(input.defaultModel && input.defaultModel.trim() ? { defaultModel: input.defaultModel.trim() } : {}),
    ...(input.notes && input.notes.trim() ? { notes: input.notes.trim() } : {}),
    createdAt: existing?.createdAt ?? Date.now()
  }
  let provider: ApiHubCustomProvider
  if (existing && !apiKeyPlain.trim()) {
    provider = { ...base, apiKeySealed: existing.apiKeySealed, ...(existing.plainStore === true ? { plainStore: true as const } : {}) }
  } else {
    if (!apiKeyPlain.trim()) throw new Error('API Key 不能为空（编辑时留空表示不改动）')
    const useDpapi = sealer.isEncryptionAvailable()
    provider = { ...base, apiKeySealed: hubSealKey(apiKeyPlain, useDpapi, sealer), ...(useDpapi ? {} : { plainStore: true as const }) }
  }
  store.customProviders = existing ? list.map((p) => (p.id === provider.id ? provider : p)) : [...list, provider]
  saveHubStore(userDataDir, store, fsMod)
  return provider
}

/** 删除自定义供应商（已引用了它的档案不受影响：档案自己存着密钥密文）。返回删除后的 store。 */
export function deleteCustomProvider(userDataDir: string, id: string, fsMod: typeof fs = fs): ApiHubStore {
  const store = loadHubStore(userDataDir, fsMod)
  const list = listCustomProviders(store)
  const next = list.filter((p) => p.id !== id)
  if (next.length === list.length) throw new Error('找不到要删除的供应商: ' + id)
  store.customProviders = next
  saveHubStore(userDataDir, store, fsMod)
  return store
}

/**
 * 档案「另存为自定义供应商」：直接把档案的密钥密文转存（同一 sealer/plainStore 语义），
 * 明文一次都不出现 —— 比"渲染层拿到明文再提交一遍"安全得多。
 * 地址/接口格式/默认模型按适配器的字段命名差异做一次映射。
 */
export function customProviderFromProfile(
  userDataDir: string,
  adapterId: ApiHubAdapterId,
  profileId: string,
  label: string | undefined,
  sealer: KimiSealer,
  fsMod: typeof fs = fs
): ApiHubCustomProvider {
  const store = loadHubStore(userDataDir, fsMod)
  const profile = sectionOf(store, adapterId).find((p) => p.id === profileId)
  if (!profile) throw new Error('找不到要另存的档案: ' + profileId)
  const f = profile.fields
  const baseUrl = (f.baseUrl ?? f.baseURL ?? '').trim()
  if (!baseUrl) throw new Error('该档案没有填 API 地址，无法另存为自定义供应商')
  // 接口格式：kimi 的 type / zcode 的 kind 各自能透露一点，其余按 openai 兼容兜底
  const type = (f.type ?? '').trim()
  const kind = (f.kind ?? '').trim()
  const protocol: ApiHubProviderProtocol = type === 'anthropic' || kind === 'anthropic' ? 'anthropic' : 'openai'
  const defaultModel = (f.modelId ?? '').trim()
  const provider: ApiHubCustomProvider = {
    id: newProviderId(),
    label: (label ?? profile.name).trim() || profile.name,
    baseUrl,
    protocol,
    ...(defaultModel ? { defaultModel } : {}),
    apiKeySealed: profile.apiKeySealed,
    ...(profile.plainStore === true ? { plainStore: true as const } : {}),
    createdAt: Date.now()
  }
  store.customProviders = [...listCustomProviders(store), provider]
  saveHubStore(userDataDir, store, fsMod)
  return provider
}
