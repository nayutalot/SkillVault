// 接口中心的各适配器纯函数变换层：读取（脱敏）/ 改写 / 校验。
// 刻意全部做成 纯文本/纯对象 → 纯文本/纯对象 的函数，fs 与骨架（备份→原子写→校验→回滚）在 index.ts。
// 红线：本文件任何函数的返回值都绝不含 api_key 全值（只有尾 4 位与长度）；全值仅作为参数流入、立即被写入目标文本。
// 实现约束：全部正则为静态字面量（键名比较用 ===）；TOML/JSON 内容行一律经 tomlEdit 助手与显式拼接构造（零模板字面量，便于安全审计）。
import { extractProviderSecret, maskSecret, parseKimiConfigDisplay, setDefaultModel, thinkingEnabledOf, tomlAssign, tomlAssignRaw, tomlHeader, tomlQuote, upsertBlock } from '../kimi/tomlEdit'

// ---------- 通用 JSON 编辑（保留全部既有键与插入顺序；2 空格缩进 + 尾换行） ----------

/** 解析 JSON 对象文本；解析失败抛错（调用方决定回滚语义）；剥离 UTF-8 BOM（Windows 编辑器常写出） */
function parseObject(text: string): Record<string, unknown> {
  const v = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('JSON 顶层不是对象')
  return v as Record<string, unknown>
}

function serializeJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2) + '\n'
}

/** 读取嵌套对象字段；类型不符返回空对象 */
function subObject(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = o[key]
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

// ---------- claude-cli：~/.claude/settings.json 的 env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN ----------

export type ClaudeEnvDisplay = { baseUrl: string | null; keyTail: string | null; keyLen: number | null; hasEnv: boolean }

/** 只读解析 settings.json 的 env 块（key 只回尾 4 位与长度） */
export function claudeParseEnv(text: string): ClaudeEnvDisplay {
  const out: ClaudeEnvDisplay = { baseUrl: null, keyTail: null, keyLen: null, hasEnv: false }
  let obj: Record<string, unknown>
  try {
    obj = parseObject(text)
  } catch {
    return out
  }
  const env = subObject(obj, 'env')
  if (Object.keys(env).length === 0 && (obj.env === undefined || obj.env === null)) return out
  out.hasEnv = true
  if (typeof env.ANTHROPIC_BASE_URL === 'string') out.baseUrl = env.ANTHROPIC_BASE_URL
  if (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN) {
    const m = maskSecret(env.ANTHROPIC_AUTH_TOKEN)
    out.keyTail = m.tail
    out.keyLen = m.len
  }
  return out
}

/** 改写 env 两键，其余键与顺序原样保留；env 不存在则创建 */
export function claudeApplyEnv(text: string, baseUrl: string, apiKeyPlain: string): string {
  const obj = text.trim() ? parseObject(text) : {}
  const env = subObject(obj, 'env')
  env.ANTHROPIC_BASE_URL = baseUrl
  env.ANTHROPIC_AUTH_TOKEN = apiKeyPlain
  obj.env = env
  return serializeJson(obj)
}

export function claudeVerify(text: string, baseUrl: string, apiKeyPlain: string): void {
  const d = claudeParseEnv(text)
  if (d.baseUrl !== baseUrl) throw new Error('重读校验失败：ANTHROPIC_BASE_URL 不一致')
  if (d.keyTail !== maskSecret(apiKeyPlain).tail) throw new Error('重读校验失败：ANTHROPIC_AUTH_TOKEN 尾 4 位不一致')
}

// ---------- 通用 TOML 行工具（字符串运算实现，无正则捕获流） ----------

/** 顶格节头判断 */
function isHeaderLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('[') && t.endsWith(']')
}

/** 顶格节头的内部文本（去方括号）；非节头返回 null */
function headerInner(line: string): string | null {
  const t = line.trim()
  if (!t.startsWith('[') || !t.endsWith(']')) return null
  return t.slice(1, -1).trim()
}

/** key = value 行拆分（字符串运算；key 限字母数字下划线连字符），非赋值行返回 null */
function parseAssignLine(line: string): { key: string; value: string } | null {
  const t = line.trim()
  const eq = t.indexOf('=')
  if (eq <= 0) return null
  const key = t.slice(0, eq).trim()
  let i = 0
  while (i < key.length) {
    const c = key.charAt(i)
    const ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-'
    if (!ok) return null
    i++
  }
  return { key, value: t.slice(eq + 1).trim() }
}

/** "..." 带引号值提取；非该形态返回 null（不做转义还原，本机各配置的值不含转义） */
function unquote(raw: string): string | null {
  const t = raw.trim()
  if (t.length < 2 || !t.startsWith('"') || !t.endsWith('"')) return null
  return t.slice(1, -1)
}

// ---------- codex：auth.json（OPENAI_API_KEY）+ config.toml（model_provider + [model_providers.<id>]） ----------

export type CodexAuthDisplay = { keyTail: string | null; keyLen: number | null; authMode: string | null }

export function codexParseAuth(text: string): CodexAuthDisplay {
  const out: CodexAuthDisplay = { keyTail: null, keyLen: null, authMode: null }
  let obj: Record<string, unknown>
  try {
    obj = parseObject(text)
  } catch {
    return out
  }
  if (typeof obj.auth_mode === 'string') out.authMode = obj.auth_mode
  if (typeof obj.OPENAI_API_KEY === 'string' && obj.OPENAI_API_KEY) {
    const m = maskSecret(obj.OPENAI_API_KEY)
    out.keyTail = m.tail
    out.keyLen = m.len
  }
  return out
}

export function codexApplyAuth(text: string, apiKeyPlain: string): string {
  const obj = text.trim() ? parseObject(text) : {}
  obj.OPENAI_API_KEY = apiKeyPlain
  obj.auth_mode = 'apikey'
  return serializeJson(obj)
}

export type CodexConfigDisplay = { modelProvider: string | null; baseUrl: string | null; wireApi: string | null }

const CODEX_PROVIDER_PREFIX = '[model_providers.'

/** 只读解析 config.toml 的 model_provider 与 [model_providers.<id>] 块 */
export function codexParseConfig(text: string): CodexConfigDisplay {
  const out: CodexConfigDisplay = { modelProvider: null, baseUrl: null, wireApi: null }
  let inProviderBlock = false
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim()
    if (isHeaderLine(t)) {
      const inner = headerInner(t) ?? ''
      inProviderBlock = inner.startsWith('model_providers.')
      continue
    }
    const a = parseAssignLine(t)
    if (!a) continue
    if (!inProviderBlock && a.key === 'model_provider') {
      const v = unquote(a.value)
      if (v !== null) out.modelProvider = v
      continue
    }
    if (inProviderBlock) {
      const v = unquote(a.value)
      if (v === null) continue
      if (a.key === 'base_url') out.baseUrl = v
      if (a.key === 'wire_api') out.wireApi = v
    }
  }
  return out
}

/** config.toml 改写：顶层 model_provider 指向 providerId + upsert [model_providers.<id>] 块 */
export function codexApplyConfig(text: string, providerId: string, baseUrl: string, wireApi: string): string {
  const section = 'model_providers.' + providerId
  const block = [
    tomlHeader(section),
    tomlAssign('name', providerId),
    tomlAssign('base_url', baseUrl),
    tomlAssign('wire_api', wireApi),
    tomlAssignRaw('requires_openai_auth', 'true')
  ]
  let next = upsertBlock(text, tomlHeader(section), block)
  next = tomlSetKey(next, null, 'model_provider', providerId)
  return next
}

export function codexVerify(authText: string, configText: string, providerId: string, baseUrl: string, apiKeyPlain: string): void {
  const a = codexParseAuth(authText)
  if (a.keyTail !== maskSecret(apiKeyPlain).tail) throw new Error('重读校验失败：OPENAI_API_KEY 尾 4 位不一致')
  if (a.authMode !== 'apikey') throw new Error('重读校验失败：auth_mode 不是 apikey')
  const c = codexParseConfig(configText)
  if (c.modelProvider !== providerId) throw new Error('重读校验失败：model_provider 不一致')
  if (c.baseUrl !== baseUrl) throw new Error('重读校验失败：model_providers.base_url 不一致')
}

// ---------- grok：~/.grok/config.toml 的 [models] default + [model."<modelId>"] 块 ----------

export type GrokDisplay = {
  defaultModel: string | null
  modelId: string | null
  baseUrl: string | null
  name: string | null
  apiBackend: string | null
  contextWindow: number | null
  keyTail: string | null
  keyLen: number | null
}

/** [model."X"] 节头的 X 提取；非该形态返回 null */
function grokModelHeader(inner: string): string | null {
  const prefix = 'model."'
  if (!inner.startsWith(prefix) || !inner.endsWith('"')) return null
  return inner.slice(prefix.length, -1)
}

/** 只读解析 grok config.toml：[models] default 与 [model."X"] 块（key 只回尾 4 位与长度） */
export function grokParse(text: string): GrokDisplay {
  const out: GrokDisplay = {
    defaultModel: null,
    modelId: null,
    baseUrl: null,
    name: null,
    apiBackend: null,
    contextWindow: null,
    keyTail: null,
    keyLen: null
  }
  let header = ''
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim()
    if (isHeaderLine(t)) {
      header = headerInner(t) ?? ''
      continue
    }
    const a = parseAssignLine(t)
    if (!a) continue
    if (header === 'models' && a.key === 'default') {
      const v = unquote(a.value)
      if (v !== null) out.defaultModel = v
      continue
    }
    const modelId = grokModelHeader(header)
    if (modelId === null) continue
    const v = unquote(a.value)
    if (a.key === 'model' && v !== null) out.modelId = v
    if (a.key === 'base_url' && v !== null) out.baseUrl = v
    if (a.key === 'name' && v !== null) out.name = v
    if (a.key === 'api_backend' && v !== null) out.apiBackend = v
    if (a.key === 'context_window' && /^\d+$/.test(a.value)) out.contextWindow = Number(a.value)
    if (a.key === 'api_key' && v !== null && v) {
      const mk = maskSecret(v)
      out.keyTail = mk.tail
      out.keyLen = mk.len
    }
  }
  return out
}

/** 整块删除 headerText 指向的节（header 行到下一个顶格节头之前，含块尾分隔空行）；节不存在原样返回。切换后清除旧块专用 */
function removeBlock(text: string, headerText: string): string {
  if (!text.trim()) return text
  // 按文本实际 eol 拆行再用同一 eol join：用 '\n' 拆 CRLF 文本会在每行尾残留 '\r'，join 后变 '\r\r\n' 损坏全文件
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(eol)
  const idx = lines.findIndex((l) => l.trim() === headerText)
  if (idx < 0) return text
  let end = lines.length
  for (let i = idx + 1; i < lines.length; i++) {
    if (isHeaderLine(lines[i])) {
      end = i
      break
    }
  }
  while (end > idx && lines[end - 1].trim() === '') end--
  lines.splice(idx, end - idx)
  return lines.join(eol)
}

/** grok config.toml 改写：[models] default + [model."<modelId>"] 块（其余段零改动） */
export function grokApply(
  text: string,
  f: { modelId: string; baseUrl: string; name: string; apiBackend: string; contextWindow: number },
  apiKeyPlain: string
): string {
  // 目标与现行 default 不同：先整块移除旧 [model."<old>"]（含旧 api_key），避免残留过期凭据块
  const prevDefault = grokParse(text).defaultModel
  const base = prevDefault && prevDefault !== f.modelId ? removeBlock(text, tomlHeader('model.' + tomlQuote(prevDefault))) : text
  const section = 'model.' + tomlQuote(f.modelId)
  const block = [
    tomlHeader(section),
    tomlAssign('model', f.modelId),
    tomlAssign('base_url', f.baseUrl),
    tomlAssign('name', f.name),
    tomlAssign('api_backend', f.apiBackend),
    tomlAssignRaw('context_window', String(Math.trunc(Number(f.contextWindow)))),
    tomlAssign('api_key', apiKeyPlain)
  ]
  let next = upsertBlock(base, tomlHeader(section), block)
  next = upsertBlock(next, '[models]', [tomlHeader('models'), tomlAssign('default', f.modelId)])
  return next
}

export function grokVerify(text: string, f: { modelId: string; baseUrl: string }, apiKeyPlain: string): void {
  const d = grokParse(text)
  if (d.defaultModel !== f.modelId) throw new Error('重读校验失败：[models] default 不一致')
  if (d.modelId !== f.modelId || d.baseUrl !== f.baseUrl) throw new Error('重读校验失败：[model] 块不一致')
  if (d.keyTail !== maskSecret(apiKeyPlain).tail) throw new Error('重读校验失败：api_key 尾 4 位不一致')
}

// ---------- zcode：v2/config.json（provider.<id>）+ v2/setting.json（modelProviderFamilySelectedKeys） ----------

export type ZcodeProviderDisplay = {
  id: string
  name: string | null
  baseURL: string | null
  keyTail: string | null
  keyLen: number | null
  enabled: boolean
}

export type ZcodeConfigDisplay = { providers: ZcodeProviderDisplay[]; selected: string | null; knownForms: string[] }

/** 只读解析 zcode 双文件（providers + 当前选中键；key 只回尾 4 位与长度） */
export function zcodeParse(configText: string, settingText: string): ZcodeConfigDisplay {
  const out: ZcodeConfigDisplay = { providers: [], selected: null, knownForms: [] }
  let cfg: Record<string, unknown>
  try {
    cfg = parseObject(configText)
  } catch {
    return out
  }
  const prov = subObject(cfg, 'provider')
  for (const id of Object.keys(prov)) {
    const p = subObject(prov, id)
    const opts = subObject(p, 'options')
    const d: ZcodeProviderDisplay = {
      id,
      name: typeof p.name === 'string' ? p.name : null,
      baseURL: typeof opts.baseURL === 'string' ? opts.baseURL : null,
      keyTail: null,
      keyLen: null,
      enabled: p.enabled === true
    }
    if (typeof opts.apiKey === 'string' && opts.apiKey) {
      const mk = maskSecret(opts.apiKey)
      d.keyTail = mk.tail
      d.keyLen = mk.len
    }
    out.providers.push(d)
  }
  let st: Record<string, unknown> = {}
  try {
    st = settingText.trim() ? parseObject(settingText) : {}
  } catch {
    st = {}
  }
  const fam = subObject(st, 'modelProviderFamilySelectedKeys')
  for (const k of Object.keys(fam)) {
    const v = fam[k]
    if (typeof v !== 'string' || !v) continue
    out.knownForms.push(v)
    if (k === 'bigmodel') out.selected = v
  }
  return out
}

/** config.json 改写：upsert provider.<id>（结构照抄现有条目形态），其余 provider 与键零改动 */
export function zcodeApplyConfig(
  text: string,
  f: { providerId: string; providerName: string; baseURL: string; kind: string },
  apiKeyPlain: string
): string {
  const obj = text.trim() ? parseObject(text) : {}
  const prov = subObject(obj, 'provider')
  const existing = subObject(prov, f.providerId)
  const opts = subObject(existing, 'options')
  opts.apiKey = apiKeyPlain
  opts.baseURL = f.baseURL
  prov[f.providerId] = {
    name: f.providerName,
    kind: f.kind || 'anthropic',
    options: opts,
    enabled: true,
    source: 'custom'
  }
  obj.provider = prov
  return serializeJson(obj)
}

export function zcodeApplySetting(text: string, selectedValue: string): string {
  const obj = text.trim() ? parseObject(text) : {}
  const fam = subObject(obj, 'modelProviderFamilySelectedKeys')
  fam.bigmodel = selectedValue
  obj.modelProviderFamilySelectedKeys = fam
  return serializeJson(obj)
}

/**
 * selectedKey 形态派生：优先复用 knownForms 里已包含该 providerId 的形态（providerId 本身可含冒号，
 * 故按 ':<providerId>' 结尾匹配，保留家族前缀约定）；无历史形态时按 ZCode 现行惯例
 * coding-plan:builtin:<id> 派生（UI 须提示用户重启 ZCode 核对）。
 */
export function zcodeDeriveSelectedForm(knownForms: string[], providerId: string): string {
  const hit = knownForms.find((f) => f === providerId || f.endsWith(':' + providerId))
  if (hit) return hit
  return 'coding-plan:builtin:' + providerId
}

export function zcodeVerify(
  configText: string,
  settingText: string,
  providerId: string,
  baseURL: string,
  selectedValue: string,
  apiKeyPlain: string
): void {
  const d = zcodeParse(configText, settingText)
  const p = d.providers.find((x) => x.id === providerId)
  if (!p) throw new Error('重读校验失败：provider 条目不存在')
  if (p.baseURL !== baseURL) throw new Error('重读校验失败：baseURL 不一致')
  if (!p.enabled) throw new Error('重读校验失败：条目未启用')
  if (p.keyTail !== maskSecret(apiKeyPlain).tail) throw new Error('重读校验失败：apiKey 尾 4 位不一致')
  if (d.selected !== selectedValue) throw new Error('重读校验失败：modelProviderFamilySelectedKeys.bigmodel 不一致')
}

// ---------- kimi：~/.kimi-code/config.toml 的 providers / models / default_model / thinking 块级改写 ----------
// 块构造与重读校验复用 kimi/tomlEdit 的既有助手（行为已被 kimi 用例覆盖）；旧「Kimi 接口」页合并进接口中心后，
// 这里是 kimi 适配器唯一的写入/校验路径。内容行一律经 tomlAssign/tomlAssignRaw/tomlHeader 与显式 '+' 拼接。

/** kimi 适配器的档案字段（apihub fields Record 与之互转的规范形，由 index.ts 的映射 glue 承担） */
export type KimiApplyFields = {
  /** 小写字母数字连字符，写入 [providers.<providerId>] */
  providerId: string
  /** 复合键为 "<providerId>/<modelId>" */
  modelId: string
  baseUrl: string
  /** openai | anthropic */
  type: string
  modelDisplay: string
  maxContext: number
  capabilities: string[]
  thinkingEnabled: boolean
}

/** config.toml 改写：upsert providers/models 两块 + default_model + [thinking].enabled 键级赋值（其余段落与未知键零改动） */
export function kimiApplyConfig(text: string, f: KimiApplyFields, apiKeyPlain: string): string {
  const providerSection = 'providers.' + f.providerId
  const providerBlock = [
    tomlHeader(providerSection),
    tomlAssign('type', f.type),
    tomlAssign('base_url', f.baseUrl),
    tomlAssign('api_key', apiKeyPlain)
  ]
  const modelKey = f.providerId + '/' + f.modelId
  const caps = f.capabilities.map((c) => tomlQuote(c)).join(', ')
  const modelBlock = [
    tomlHeader('models.' + tomlQuote(modelKey)),
    tomlAssign('provider', f.providerId),
    tomlAssign('model', f.modelId),
    tomlAssignRaw('max_context_size', String(Math.trunc(f.maxContext))),
    'capabilities = [ ' + caps + ' ]',
    tomlAssign('display_name', f.modelDisplay)
  ]
  let next = upsertBlock(text, tomlHeader(providerSection), providerBlock)
  next = upsertBlock(next, tomlHeader('models.' + tomlQuote(modelKey)), modelBlock)
  // [thinking] 只改 enabled 这一个键（键级 upsert）：用户在块内手工加的其它键原样保留，不被整块替换清掉
  next = tomlSetKeyRaw(next, 'thinking', 'enabled', f.thinkingEnabled ? 'true' : 'false')
  next = setDefaultModel(next, modelKey)
  return next
}

/** 重读校验：default_model / provider 块 / models 块 / thinking / api_key 尾 4 位；任一不一致抛错（调用方回滚） */
export function kimiVerify(text: string, f: KimiApplyFields, apiKeyPlain: string): void {
  const d = parseKimiConfigDisplay(text)
  const modelKey = f.providerId + '/' + f.modelId
  if (d.defaultModel !== modelKey) throw new Error('重读校验失败：default_model 不一致')
  const p = d.providers.find((x) => x.id === f.providerId)
  if (!p || p.baseUrl !== f.baseUrl) throw new Error('重读校验失败：providers.' + f.providerId + ' 块不一致')
  if (!d.models.some((m) => m.id === modelKey)) throw new Error('重读校验失败：[models] 块不一致')
  if (thinkingEnabledOf(text) !== f.thinkingEnabled) throw new Error('重读校验失败：[thinking] enabled 不一致')
  const secret = extractProviderSecret(text, f.providerId)
  if (secret === null || maskSecret(secret).tail !== maskSecret(apiKeyPlain).tail)
    throw new Error('重读校验失败：api_key 尾 4 位不一致')
}

// ---------- 通用 TOML：节内键赋值（kimi tomlEdit 的 setDefaultModel 泛化版） ----------

/**
 * tomlSetKey：把 sectionHeader 指向的节内 key 赋值为字符串值（null = 顶层）。
 * 节/键不存在时创建（顶层键插到首个节头之前；节缺失则先建节）。
 * 键名比较用 ===（无正则捕获流），只处理单行字符串赋值。
 * tomlSetKeyRaw 为其原始值变体（布尔/数字，不经 tomlQuote）。
 */
export function tomlSetKey(text: string, sectionHeader: string | null, key: string, value: string): string {
  return tomlSetKeyLine(text, sectionHeader, tomlAssign(key, value))
}

export function tomlSetKeyRaw(text: string, sectionHeader: string | null, key: string, rawValue: string): string {
  return tomlSetKeyLine(text, sectionHeader, tomlAssignRaw(key, rawValue))
}

function tomlSetKeyLine(text: string, sectionHeader: string | null, line: string): string {
  // 按文本实际 eol 拆行再用同一 eol join：用 '\n' 拆 CRLF 文本会在每行尾残留 '\r'，join 后变 '\r\r\n' 损坏全文件
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.length ? text.split(eol) : []
  if (sectionHeader === null) {
    const topIdx = lines.findIndex((l) => {
      if (isHeaderLine(l)) return false
      const a = parseAssignLine(l)
      return a !== null && a.key === keyOf(line)
    })
    if (topIdx >= 0) {
      lines[topIdx] = line
      return lines.join(eol)
    }
    const firstHeader = lines.findIndex((l) => isHeaderLine(l))
    if (firstHeader < 0) lines.unshift(line)
    else lines.splice(firstHeader, 0, line, '')
    return lines.join(eol)
  }
  // 节名兼容带/不带方括号两种形态（'models' 与 '[models]' 都指向 [models]）；
  // 旧实现直接 tomlHeader(sectionHeader)，带括号传参时拼成 '[[models]]' 永远找不到节、静默退化为文末追加
  const inner = sectionHeader.startsWith('[') && sectionHeader.endsWith(']')
    ? sectionHeader.slice(1, -1)
    : sectionHeader
  const headerText = tomlHeader(inner)
  const secIdx = lines.findIndex((l) => l.trim() === headerText)
  if (secIdx < 0) return upsertBlock(text, headerText, [headerText, line])
  // 节内找 key（到下一个节头为止）
  let end = lines.length
  for (let i = secIdx + 1; i < lines.length; i++) {
    if (isHeaderLine(lines[i])) {
      end = i
      break
    }
  }
  for (let i = secIdx + 1; i < end; i++) {
    const a = parseAssignLine(lines[i])
    if (a !== null && a.key === keyOf(line)) {
      lines[i] = line
      return lines.join(eol)
    }
  }
  lines.splice(end, 0, line)
  return lines.join(eol)
}

/** 从构造好的赋值行取键名（'key = …' → 'key'；键名已由 tomlAssign/tomlAssignRaw 保证合法） */
function keyOf(assignLine: string): string {
  const eq = assignLine.indexOf('=')
  return assignLine.slice(0, eq).trim()
}
