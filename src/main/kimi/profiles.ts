// Kimi 档案库：userData/kimi-profiles.json。
// api_key 以 Electron safeStorage（Windows DPAPI）加密后 base64 落盘；safeStorage 不可用时降级
// base64 明文并在档案上标记 plainStore:true（note: plainStore:true）。全值只在 seal/解密瞬间存在于内存，
// 绝不写日志/缓存/仓库。electron 依赖全部经 KimiSealer 注入，本文件可被 vitest 直接单测。
import fs from 'node:fs'
import path from 'node:path'
import type { KimiProfile, KimiProfileInput, KimiProfileView } from '../../shared/types'
import { extractProviderSecret, maskSecret, parseKimiConfigDisplay, thinkingEnabledOf } from './tomlEdit'

export const KIMI_PROFILES_VERSION = 1 as const

export type KimiProfileStore = { version: typeof KIMI_PROFILES_VERSION; profiles: KimiProfile[]; activeId: string | null }

/** safeStorage 抽象（主进程用 electronSealer(safeStorage) 装配；测试用 fake） */
export interface KimiSealer {
  isEncryptionAvailable(): boolean
  /** 返回 base64 密文（或降级时的 base64 明文，由档案 plainStore 标记区分） */
  encrypt(plain: string): string
  decrypt(sealedBase64: string): string
}

/** providerId 白名单：小写字母数字，可含连字符，不以连字符开头 */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]*$/

export function emptyStore(): KimiProfileStore {
  return { version: KIMI_PROFILES_VERSION, profiles: [], activeId: null }
}

export function profilesFile(userDataDir: string): string {
  return path.join(userDataDir, 'kimi-profiles.json')
}

/** 读档案库（损坏/缺失一律回落空库，不让 Kimi 页起不来） */
export function loadStore(userDataDir: string, fsMod: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs): KimiProfileStore {
  const file = profilesFile(userDataDir)
  try {
    if (!fsMod.existsSync(file)) return emptyStore()
    const raw = JSON.parse(fsMod.readFileSync(file, 'utf8')) as Partial<KimiProfileStore>
    if (raw.version !== KIMI_PROFILES_VERSION || !Array.isArray(raw.profiles)) return emptyStore()
    const profiles: KimiProfile[] = []
    for (const p of raw.profiles) {
      if (typeof p !== 'object' || p === null) continue
      if (typeof p.id !== 'string' || !p.id) continue
      if (typeof p.apiKeySealed !== 'string' || !p.apiKeySealed) continue
      profiles.push({
        id: p.id,
        name: String(p.name ?? ''),
        providerId: String(p.providerId ?? ''),
        type: String(p.type ?? 'openai'),
        baseUrl: String(p.baseUrl ?? ''),
        apiKeySealed: p.apiKeySealed,
        ...(p.plainStore === true ? { plainStore: true as const } : {}),
        modelId: String(p.modelId ?? ''),
        modelDisplay: String(p.modelDisplay ?? ''),
        maxContext: typeof p.maxContext === 'number' && Number.isFinite(p.maxContext) ? p.maxContext : 131072,
        capabilities: Array.isArray(p.capabilities) ? p.capabilities.map(String) : [],
        thinkingEnabled: p.thinkingEnabled === true
      })
    }
    const activeId = typeof raw.activeId === 'string' && profiles.some((p) => p.id === raw.activeId) ? raw.activeId : null
    return { version: KIMI_PROFILES_VERSION, profiles, activeId }
  } catch {
    return emptyStore()
  }
}

/** 写档案库（临时文件 + rename 原子落盘） */
export function saveStore(
  userDataDir: string,
  store: KimiProfileStore,
  fsMod: Pick<typeof fs, 'mkdirSync' | 'writeFileSync' | 'renameSync'> = fs
): void {
  fsMod.mkdirSync(userDataDir, { recursive: true })
  const file = profilesFile(userDataDir)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fsMod.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
  fsMod.renameSync(tmp, file)
}

export function newProfileId(): string {
  return `kp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** 档案输入校验（新增与编辑共用）；返回错误文案或 null */
export function validateProfileInput(input: KimiProfileInput): string | null {
  if (!input.name.trim()) return '档案名不能为空'
  if (!PROVIDER_ID_RE.test(input.providerId)) return 'providerId 只允许小写字母/数字/连字符，且不以连字符开头'
  if (!input.baseUrl.trim()) return 'Base URL 不能为空'
  if (!/^https?:\/\//.test(input.baseUrl.trim())) return 'Base URL 必须以 http(s):// 开头'
  if (!input.modelId.trim()) return '模型 ID 不能为空'
  if (!Number.isFinite(input.maxContext) || input.maxContext <= 0 || !Number.isInteger(input.maxContext))
    return 'max_context_size 必须是正整数'
  return null
}

/** 档案 → 脱敏视图：掩码由调用方传入（解密只在主进程内存瞬间发生），本函数绝不接触全值 */
export function profileView(p: KimiProfile, masked: { tail: string | null; len: number | null }): KimiProfileView {
  return {
    id: p.id,
    name: p.name,
    providerId: p.providerId,
    type: p.type,
    baseUrl: p.baseUrl,
    modelId: p.modelId,
    modelDisplay: p.modelDisplay,
    maxContext: p.maxContext,
    capabilities: p.capabilities,
    thinkingEnabled: p.thinkingEnabled,
    apiKeyTail: masked.tail,
    apiKeyLen: masked.len,
    plainStore: p.plainStore === true
  }
}

/** 解密 api_key（plainStore 降级态先 base64 还原）；仅供 switch / 掩码计算等主进程路径使用 */
export function decryptKey(p: KimiProfile, sealer: KimiSealer): string {
  if (p.plainStore === true) return Buffer.from(p.apiKeySealed, 'base64').toString('utf8')
  return sealer.decrypt(p.apiKeySealed)
}

/** 列表视图（解密仅取掩码；解密失败如实回 null，不抛、不伪造） */
export function listProfileViews(store: KimiProfileStore, sealer: KimiSealer): KimiProfileView[] {
  return store.profiles.map((p) => {
    let masked = { tail: null as string | null, len: null as number | null }
    try {
      const m = maskSecret(decryptKey(p, sealer))
      masked = { tail: m.tail, len: m.len }
    } catch {
      /* 解密失败（如换机器后 DPAPI 密文不可解）：如实显示未知 */
    }
    return profileView(p, masked)
  })
}

/** seal：DPAPI 可用走 safeStorage 加密；不可用降级 base64 明文（调用方负责落 plainStore 标记） */
export function sealKey(plain: string, useEncryption: boolean, sealer: KimiSealer): string {
  if (useEncryption) return sealer.encrypt(plain)
  return Buffer.from(plain, 'utf8').toString('base64')
}

/**
 * 新增/编辑档案。apiKeyPlain 非空 → 重新 seal；为空且是编辑 → 保留原 sealed（编辑时留空 = 不改动 key）。
 * 返回保存后的档案。校验失败抛错。
 */
export function upsertProfile(
  userDataDir: string,
  input: KimiProfileInput,
  apiKeyPlain: string,
  sealer: KimiSealer,
  fsMod: typeof fs = fs
): KimiProfile {
  const err = validateProfileInput(input)
  if (err) throw new Error(err)
  const store = loadStore(userDataDir, fsMod)
  const plain = apiKeyPlain.trim()
  const existing = input.id ? store.profiles.find((p) => p.id === input.id) : undefined
  if (input.id && !existing) throw new Error(`找不到要编辑的档案: ${input.id}`)
  let profile: KimiProfile
  if (existing && !plain) {
    // 编辑但未填新 key：沿用原 sealed（含 plainStore 标记）
    profile = { ...existing, ...stripId(input) }
  } else {
    const useDpapi = sealer.isEncryptionAvailable()
    profile = {
      id: existing?.id ?? newProfileId(),
      ...stripId(input),
      apiKeySealed: sealKey(plain, useDpapi, sealer),
      ...(useDpapi ? {} : { plainStore: true as const })
    }
  }
  store.profiles = existing
    ? store.profiles.map((p) => (p.id === profile.id ? profile : p))
    : [...store.profiles, profile]
  saveStore(userDataDir, store, fsMod)
  return profile
}

function stripId(input: KimiProfileInput): Omit<KimiProfileInput, 'id'> {
  const { id: _id, ...rest } = input
  return rest
}

/** 删除档案；若删除的是生效档案，activeId 置空。返回删除后的 store。 */
export function deleteProfile(userDataDir: string, id: string, fsMod: typeof fs = fs): KimiProfileStore {
  const store = loadStore(userDataDir, fsMod)
  const before = store.profiles.length
  store.profiles = store.profiles.filter((p) => p.id !== id)
  if (store.profiles.length === before) throw new Error(`找不到要删除的档案: ${id}`)
  if (store.activeId === id) store.activeId = null
  saveStore(userDataDir, store, fsMod)
  return store
}

// ---------- 从当前 config.toml 导入 ----------

/**
 * 从现有 config.toml 文本生成待入库档案（配合 upsertProfile 立即 seal）。
 * api_key 全值只在返回值 apiKeyPlain 里存在一瞬间，调用方必须立即传给 upsertProfile，
 * 绝不允许写入日志/缓存/仓库。结构不明（无 default_model / 缺块 / 缺 key）一律拒绝导入，不硬解。
 */
export function profileInputFromConfigText(text: string): { input: KimiProfileInput; apiKeyPlain: string } {
  const display = parseKimiConfigDisplay(text)
  if (!display.defaultModel) throw new Error('config.toml 中没有 default_model，无法导入')
  const model = display.models.find((m) => m.id === display.defaultModel)
  if (!model || !model.provider || !model.model)
    throw new Error(`default_model ${display.defaultModel} 没有对应的 [models] 块，无法导入`)
  const provider = display.providers.find((p) => p.id === model.provider)
  if (!provider) throw new Error(`找不到 provider 块 [providers.${model.provider}]，无法导入`)
  const secret = extractProviderSecret(text, provider.id)
  if (!secret) throw new Error(`provider ${provider.id} 块中没有 api_key，无法导入`)
  return {
    input: {
      name: provider.baseUrl ? hostLabel(provider.baseUrl) : provider.id,
      providerId: provider.id,
      type: provider.type ?? 'openai',
      baseUrl: provider.baseUrl ?? '',
      modelId: model.model,
      modelDisplay: model.displayName ?? model.model,
      maxContext: model.maxContext ?? 131072,
      capabilities: model.capabilities ?? [],
      thinkingEnabled: thinkingEnabledOf(text)
    },
    apiKeyPlain: secret
  }
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}
