// 适配器目录动态合成：注册表里 active 且 enabled 的 agent × 实现矩阵（catalog.ts）。
// - 有实现（claude/codex/grok/kimi/zcode）→ 正常适配器卡，可切换；
// - 无实现（dsh/gemini/qwen/opencode/…/generic:*）→ 说明卡（沿用 claude-desktop 的 available:false + naReason 机制），
//   文案说清「检测到了什么、为什么这里没有它、不影响什么」，用户不会以为功能坏了。
// agent 停用/消失后，下一次拉取目录自动少一张卡 —— 这就是「自动增减」。
// 只在 Windows 平台条目上合成：适配器的目标路径全部是 Windows 主目录（~/.claude 等），
// WSL 里的同名工具配置在发行版内部，这里的写入路径够不着，硬显示只会让用户点出一堆失败。
import fs from 'node:fs'
import type {
  ApiHubAdapterInfo,
  ApiHubAdapterId,
  ApiHubCatalogEntry,
  ApiHubCatalogResult,
  ApiHubCustomProvider,
  ApiHubProviderPrefill,
  ApiHubProviderProtocol,
  RegistryAgent
} from '../../shared/types'
import { isAgentActive } from '../../shared/registry'
import { ADAPTER_IMPLEMENTATIONS, IMPLEMENTED_SIGIDS, NA_ID_OVERRIDES, NA_SKIP_SIGIDS, STATIC_API_HUB_CATALOG, claudeDesktopAdapter } from './catalog'
import { readRegistryAgents } from '../versionCenter/registryRead'

/** 注册表里检测到但没有实现的 agent → 说明卡（id 用 na: 命名空间，避免与真适配器 id 撞车） */
function naCardOf(sigId: string, agentLabel: string): ApiHubCatalogEntry {
  const override = NA_ID_OVERRIDES[sigId]
  const id = (override ?? 'na:' + sigId) as ApiHubCatalogEntry['id']
  return {
    id,
    label: agentLabel,
    available: false,
    naReason:
      '已检测到 ' + agentLabel + '，但「接口一键切换」暂不支持它，不影响技能同步（技能照常扫描与建链）',
    notes: [],
    needsKey: false,
    fieldDefs: [],
    sigId,
    agentLabel
  }
}

/**
 * 纯合成：输入注册表条目，输出目录。
 * - 一个 sigId 只出一张卡（同签名多条目如 claude-win/claude-wsl 去重）；
 * - claude-desktop 说明卡只在检测到 claude 时出现（它依附 Claude Code 的安装）；
 * - 注册表里连一个签名都没有（老注册表未跑过自动发现）→ 回落内置静态目录并标记 degraded，
 *   否则页面会整片空掉，用户根本不知道去哪里点。
 */
export function synthesizeApiHubCatalog(agents: RegistryAgent[]): ApiHubCatalogResult {
  // 「注册表里压根没有签名信息」= 老注册表还没跑过自动发现（不是"用户停用了"）：这时回落内置列表，
  // 否则页面整片空掉，用户根本不知道去哪里点。用户主动停用/工具确实没装 → 目录就该是空的（UI 给空态提示）。
  if (!agents.some((a) => a.sigId)) {
    return {
      adapters: STATIC_API_HUB_CATALOG,
      degraded: true,
      reason: '注册表里还没有记录任何工具签名（可在仪表盘点一次「自动发现」），先显示内置列表'
    }
  }
  const usable = agents.filter((a) => a.platform === 'windows' && isAgentActive(a))
  const bySig = new Map<string, RegistryAgent>()
  for (const a of usable) {
    if (!a.sigId) continue
    if (!bySig.has(a.sigId)) bySig.set(a.sigId, a)
  }

  const out: ApiHubCatalogEntry[] = []
  for (const impl of ADAPTER_IMPLEMENTATIONS) {
    const hit = bySig.get(impl.sigId)
    if (!hit) continue
    out.push({ ...impl.info, sigId: impl.sigId, agentLabel: hit.label ?? hit.name })
    // Claude Desktop 没有可靠的写入目标，但"检测到 claude 却没有 Claude Desktop 卡"会让人以为漏了
    if (impl.sigId === 'claude') {
      out.push({ ...claudeDesktopAdapter, sigId: 'claude', agentLabel: hit.label ?? hit.name })
    }
  }
  // 说明卡按展示名排序（注册表顺序不稳定，UI 上跳来跳去很难看）
  const na = [...bySig.entries()]
    .filter(([sigId]) => !IMPLEMENTED_SIGIDS.has(sigId) && !NA_SKIP_SIGIDS.has(sigId))
    .map(([sigId, a]) => naCardOf(sigId, a.label ?? a.name))
    .sort((x, y) => x.label.localeCompare(y.label))
  out.push(...na)
  return { adapters: out, degraded: false }
}

export type ApiHubCatalogDeps = { vaultPath: string; fsMod?: typeof fs }

/** 读盘 + 合成；注册表读不到 → 内置静态目录（degraded=true，UI 顶部提示一句） */
export function buildApiHubCatalog(deps: ApiHubCatalogDeps): ApiHubCatalogResult {
  const r = readRegistryAgents(deps.vaultPath, deps.fsMod ?? fs)
  if (!r.agents) {
    return { adapters: STATIC_API_HUB_CATALOG, degraded: true, reason: r.reason }
  }
  return synthesizeApiHubCatalog(r.agents)
}

// ---------- 自定义供应商 → 适配器表单字段（「一键填入」） ----------

/** 供应商名 → Provider ID：只留小写字母/数字/连字符（各适配器的 providerId 白名单一致） */
export function providerIdOf(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'custom'
}

/** 适配器实现定义查表（预填时按 fieldDefs 过滤，绝不给表单塞它不认识的键） */
function infoOf(adapterId: ApiHubAdapterId): ApiHubAdapterInfo | undefined {
  return ADAPTER_IMPLEMENTATIONS.find((i) => i.info.id === adapterId)?.info
}

/**
 * 把自定义供应商的公共信息（地址/接口格式/默认模型）映射成某个适配器的表单字段。
 * 原则：能确定的才填；填不了的（如供应商没写默认模型）留空并进 missing 让用户补，
 * 绝不编造模型名——写进配置文件的东西用户不看就发现不了。
 */
export function providerPrefill(
  adapterId: ApiHubAdapterId,
  p: Pick<ApiHubCustomProvider, 'label' | 'baseUrl' | 'protocol' | 'defaultModel'>
): ApiHubProviderPrefill {
  const model = (p.defaultModel ?? '').trim()
  const baseUrl = p.baseUrl.trim()
  const label = p.label.trim()
  const id = providerIdOf(label)
  const protocol: ApiHubProviderProtocol = p.protocol
  const openaiLike = protocol !== 'anthropic'
  const missing: string[] = []
  const notes: string[] = []
  let raw: Record<string, string>

  switch (adapterId) {
    case 'claude-cli':
      raw = { baseUrl }
      break
    case 'codex':
      raw = { providerId: id, baseUrl, wireApi: openaiLike ? 'chat' : 'responses' }
      notes.push('接口格式已按' + (openaiLike ? 'OpenAI 兼容（chat）' : 'Anthropic 兼容（responses）') + '填入，如与该工具要求不符请手动改')
      break
    case 'grok':
      raw = { modelId: model, baseUrl, name: label, apiBackend: openaiLike ? 'chat' : 'responses', contextWindow: '0' }
      if (!model) missing.push('模型 ID')
      notes.push('上下文窗口先填 0（表示不指定），需要的话请按供应商说明改')
      break
    case 'kimi':
      raw = {
        providerId: id,
        modelId: model,
        baseUrl,
        type: protocol === 'anthropic' ? 'anthropic' : 'openai',
        modelDisplay: label,
        thinkingEnabled: 'true'
      }
      if (!model) missing.push('模型 ID')
      notes.push('接口格式（Type）已按' + (protocol === 'anthropic' ? 'anthropic' : 'openai') + '填入，可手动改')
      break
    case 'zcode':
      raw = { providerId: id, providerName: label, baseURL: baseUrl, kind: 'anthropic' }
      if (protocol !== 'anthropic') notes.push('ZCode 目前只认 anthropic 兼容接口，请确认该供应商提供这种接口')
      break
    default:
      raw = {}
      break
  }
  const allowed = new Set((infoOf(adapterId)?.fieldDefs ?? []).map((d) => d.key))
  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (allowed.has(k) && v !== '') fields[k] = v
  }
  // 允许的字段里没被填上的（除已知可选/有默认值的）提示用户补
  for (const def of infoOf(adapterId)?.fieldDefs ?? []) {
    if (fields[def.key] !== undefined) continue
    if (def.advanced) continue
    if (def.key === 'maxContext' || def.key === 'capabilities' || def.key === 'name') continue
    if (!missing.includes(def.label)) missing.push(def.label)
  }
  return { fields, missing, notes }
}
