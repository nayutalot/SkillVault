// 版本目录：8 个内置 agent harness 条目。
// 零网络代码由通道自身完成（winget/npm/各 CLI 自带通道），本目录不含任何 URL/凭据；
// 更新仅由用户点击触发（updateOne），检测超时统一 90s，更新 20min。
// 每条带 sigId（对应 agentSignatures 的签名）：版本中心据此按注册表自动隐藏"这台机器上没检测到的工具"，
// 见 visibility.ts；显示全部/固定显示由用户在 UI 上控制。

export type CatalogEntry =
  | {
      kind: 'npm'
      id: string
      name: string
      channel: string
      /** 对应 agent 签名 id（决定可见性：注册表里该工具 active 且 enabled 才默认显示） */
      sigId: string
      npm: { pkg: string }
      uiNote?: string
    }
  | {
      kind: 'winget'
      id: string
      name: string
      channel: string
      /** 对应 agent 签名 id（决定可见性：注册表里该工具 active 且 enabled 才默认显示） */
      sigId: string
      winget: { packageId: string }
      /**
       * winget list 已装检测是否用精确 id（默认 true，加 -e）。
       * 商店系 MSIX 应用的已装记录 id 是完整包名（如 MSIX\OpenAI.Codex_26.825..._x64__...），
       * 精确匹配会漏检 → listExact:false 用子串匹配（仅用于已装检测；升级清单仍按精确 id 对齐）。
       */
      listExact?: boolean
      /** 更新预检：tasklist 检测这些进程是否在运行（运行中 → UI 弹确认框） */
      processNames?: string[]
      /** 商店系应用：更新失败时提示走 Microsoft Store */
      storeFallback?: boolean
      uiNote?: string
    }
  | {
      kind: 'native'
      id: string
      name: string
      channel: string
      /** 对应 agent 签名 id（决定可见性：注册表里该工具 active 且 enabled 才默认显示） */
      sigId: string
      native: { binPath: string }
      uiNote?: string
    }
  | {
      kind: 'arp'
      id: string
      name: string
      channel: string
      /** 对应 agent 签名 id（决定可见性：注册表里该工具 active 且 enabled 才默认显示） */
      sigId: string
      arp: { displayName: string }
      uiNote?: string
    }
  | {
      kind: 'github'
      id: string
      name: string
      channel: string
      /** 对应 agent 签名 id（决定可见性：注册表里该工具 active 且 enabled 才默认显示） */
      sigId: string
      github: { repo: string }
      uiNote?: string
    }

export const VERSION_CATALOG: CatalogEntry[] = [
  {
    kind: 'npm',
    id: 'claude-code-npm',
    name: 'Claude Code CLI (npm)',
    channel: 'npm: @anthropic-ai/claude-code',
    sigId: 'claude',
    npm: { pkg: '@anthropic-ai/claude-code' }
  },
  {
    kind: 'winget',
    id: 'claude-code-winget',
    name: 'Claude Code CLI (winget)',
    channel: 'winget: Anthropic.ClaudeCode',
    sigId: 'claude',
    winget: { packageId: 'Anthropic.ClaudeCode' }
  },
  {
    kind: 'winget',
    id: 'claude-desktop',
    name: 'Claude Desktop',
    channel: 'winget: Anthropic.Claude',
    sigId: 'claude',
    winget: { packageId: 'Anthropic.Claude' },
    processNames: ['claude.exe']
  },
  {
    kind: 'winget',
    id: 'codex-desktop',
    name: 'Codex Desktop',
    channel: 'MSIX: OpenAI.Codex',
    sigId: 'codex',
    winget: { packageId: 'OpenAI.Codex' },
    listExact: false,
    processNames: ['Codex.exe'],
    storeFallback: true,
    uiNote: '商店系应用：若 winget 更新失败，请通过 Microsoft Store 手动更新'
  },
  {
    kind: 'native',
    id: 'kimi-cli',
    name: 'Kimi Code CLI',
    channel: '自带更新器: ~/.kimi-code/bin/kimi',
    sigId: 'kimi',
    native: { binPath: '~/.kimi-code/bin/kimi' }
  },
  {
    kind: 'native',
    id: 'grok-cli',
    name: 'Grok CLI',
    channel: '自带更新器: ~/.grok/bin/grok',
    sigId: 'grok',
    native: { binPath: '~/.grok/bin/grok' }
  },
  {
    kind: 'github',
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    channel: 'GitHub Releases: deepseek-ai/deepseek-harness',
    sigId: 'dsh',
    github: { repo: 'deepseek-ai/deepseek-harness' },
    // 安装目录来自 settings.deepseekHarnessRoot（默认 D:\Apps\deepseek-harness）；
    // 更新 = 下载 GitHub 源码包并在 staging 内 npm install 重建后原子换目录（旧目录自动备份；~/.dsh 数据不受影响）
    uiNote: '更新从 GitHub 拉取源码包并重建（约需数分钟），旧目录自动备份；用户数据 ~/.dsh 不受影响'
  },
  {
    kind: 'winget',
    id: 'zcode',
    name: 'ZCode',
    channel: 'winget: ZhipuAI.ZCode',
    sigId: 'zcode',
    winget: { packageId: 'ZhipuAI.ZCode' },
    processNames: ['ZCode.exe'],
    uiNote: '更新会关闭正在运行的 ZCode（包括本应用所在的会话环境）'
  }
]

export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return VERSION_CATALOG.find((e) => e.id === id)
}
