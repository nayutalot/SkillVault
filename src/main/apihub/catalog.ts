// 接口中心适配器定义（纯数据，零 IO）：
// - ADAPTER_IMPLEMENTATIONS：有写配置实现的一键切换适配器（sigId = 注册表里对应的 agent 签名）。
// - STATIC_API_HUB_CATALOG：内置静态目录（含两条说明卡），只在注册表读不到时兜底展示，绝不作为默认来源。
// 「有哪些 agent」不再硬编码在这里，而由注册表（active 且 enabled）× 实现矩阵动态合成，见 adapters.ts。
import type { ApiHubAdapterInfo } from '../../shared/types'

const CC_SWITCH_NOTE = '与 CC Switch 管理同一配置，两边切换会互相覆盖，建议统一入口'

/** Claude Code CLI：写 ~/.claude/settings.json 的 env 两键 */
export const claudeCliAdapter: ApiHubAdapterInfo = {
  id: 'claude-cli',
  label: 'Claude Code CLI',
  available: true,
  notes: ['写入 ~/.claude/settings.json 的 env 两键，其余内容零改动', '对新会话生效', CC_SWITCH_NOTE],
  needsKey: true,
  fieldDefs: [{ key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com' }]
}

/**
 * Claude Desktop 说明卡：写入目标定位不到（CC Switch 经其本地网关实现），
 * 只在检测到 claude 时随目录出现，避免用户以为"漏了它"。
 */
export const claudeDesktopAdapter: ApiHubAdapterInfo = {
  id: 'claude-desktop',
  label: 'Claude Desktop',
  available: false,
  naReason: '写入目标未能定位（CC Switch 经其本地网关实现），为避免写错文件暂不支持',
  notes: [CC_SWITCH_NOTE],
  needsKey: false,
  fieldDefs: []
}

/** Codex：auth.json + config.toml 双文件 */
export const codexAdapter: ApiHubAdapterInfo = {
  id: 'codex',
  label: 'Codex',
  available: true,
  notes: ['双文件写入：auth.json 的 OPENAI_API_KEY + config.toml 的 model_provider 与 provider 块', '对新会话生效', CC_SWITCH_NOTE],
  needsKey: true,
  fieldDefs: [
    { key: 'providerId', label: 'Provider ID', placeholder: '小写字母/数字/连字符' },
    { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com/v1' },
    { key: 'wireApi', label: 'Wire API', kind: 'select', options: ['responses', 'chat'] }
  ]
}

/** Grok Build CLI：~/.grok/config.toml */
export const grokAdapter: ApiHubAdapterInfo = {
  id: 'grok',
  label: 'Grok Build CLI',
  available: true,
  notes: ['写入 ~/.grok/config.toml 的 [models] default 与 [model."…"] 块，其余段零改动', '对新会话生效', CC_SWITCH_NOTE],
  needsKey: true,
  fieldDefs: [
    { key: 'modelId', label: '模型 ID', placeholder: '如 grok-4.6' },
    { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com/v1' },
    { key: 'name', label: '显示名', placeholder: '可选' },
    { key: 'apiBackend', label: 'API Backend', kind: 'select', options: ['responses', 'chat'] },
    { key: 'contextWindow', label: '上下文窗口', placeholder: '如 500000' }
  ]
}

/** Kimi Code CLI：~/.kimi-code/config.toml */
export const kimiAdapter: ApiHubAdapterInfo = {
  id: 'kimi',
  label: 'Kimi Code CLI',
  available: true,
  notes: [
    '写入 ~/.kimi-code/config.toml 的 providers / models / default_model / thinking 块，其余段零改动',
    '对新会话生效',
    CC_SWITCH_NOTE
  ],
  needsKey: true,
  fieldDefs: [
    { key: 'providerId', label: 'Provider ID', placeholder: '小写字母/数字/连字符，写入 [providers.xxx]' },
    { key: 'modelId', label: '模型 ID', placeholder: '如 kimi-k3' },
    { key: 'baseUrl', label: 'Base URL', placeholder: 'https://…/v1' },
    { key: 'type', label: 'Type', kind: 'select', options: ['openai', 'anthropic'] },
    { key: 'modelDisplay', label: '显示名', placeholder: '可选，默认同模型 ID' },
    { key: 'maxContext', label: '上下文窗口', placeholder: '如 131072' },
    { key: 'capabilities', label: 'Capabilities', placeholder: '逗号分隔，如 thinking, tool_use' },
    { key: 'thinkingEnabled', label: 'Thinking', kind: 'select', options: ['true', 'false'] }
  ]
}

/** ZCode：v2/config.json + v2/setting.json 双文件 */
export const zcodeAdapter: ApiHubAdapterInfo = {
  id: 'zcode',
  label: 'ZCode',
  available: true,
  notes: [
    '双文件写入：v2/config.json 的 provider 条目 + v2/setting.json 的当前选中键',
    'ZCode 运行中切换可能被其覆盖，建议退出后切换、重启 ZCode 生效',
    CC_SWITCH_NOTE
  ],
  needsKey: true,
  fieldDefs: [
    { key: 'providerId', label: 'Provider ID', placeholder: '小写字母/数字/连字符' },
    { key: 'providerName', label: '供应商名称', placeholder: '显示用名称' },
    { key: 'baseURL', label: 'Base URL', placeholder: 'https://…/api/anthropic' },
    { key: 'kind', label: 'Kind', kind: 'select', options: ['anthropic'] },
    { key: 'selectedKeyForm', label: '选中键形态（留空自动派生）', advanced: true, placeholder: 'coding-plan:builtin:<id>' }
  ]
}

/** DeepSeek Harness 说明卡（dsh 签名命中时用新白话文案动态生成，这条只是静态兜底） */
export const deepseekAdapter: ApiHubAdapterInfo = {
  id: 'deepseek',
  label: 'DeepSeek Harness',
  available: false,
  naReason: 'Chrome PWA 应用，账户认证在云端，无本地 API 配置可切换',
  notes: [],
  needsKey: false,
  fieldDefs: []
}

/** sigId → 适配器实现（能真正写目标配置文件的一键切换） */
export type AdapterImplementation = { sigId: string; info: ApiHubAdapterInfo }

export const ADAPTER_IMPLEMENTATIONS: AdapterImplementation[] = [
  { sigId: 'claude', info: claudeCliAdapter },
  { sigId: 'codex', info: codexAdapter },
  { sigId: 'grok', info: grokAdapter },
  { sigId: 'kimi', info: kimiAdapter },
  { sigId: 'zcode', info: zcodeAdapter }
]

/** 有实现的 sigId 集合（其余命中一律生成说明卡） */
export const IMPLEMENTED_SIGIDS: ReadonlySet<string> = new Set(ADAPTER_IMPLEMENTATIONS.map((i) => i.sigId))

/**
 * 说明卡 id 覆写：签名 id → 既有 ApiHubAdapterId。
 * dsh 复用老的 'deepseek' 卡位，id 不漂移，用户已有的档案/习惯不受影响。
 */
export const NA_ID_OVERRIDES: Record<string, string> = { dsh: 'deepseek' }

/**
 * 不生成说明卡的签名：agents-shared 是「通用共享目录」而不是某个具体工具，
 * 给它挂一张"不支持接口切换"的卡只会让用户困惑（技能同步本来就走它）。
 */
export const NA_SKIP_SIGIDS: ReadonlySet<string> = new Set(['agents-shared'])

/** 内置静态目录（顺序与历史一致；注册表读不到时整份兜底，绝不白屏） */
export const STATIC_API_HUB_CATALOG: ApiHubAdapterInfo[] = [
  claudeCliAdapter,
  claudeDesktopAdapter,
  codexAdapter,
  grokAdapter,
  kimiAdapter,
  zcodeAdapter,
  deepseekAdapter
]
