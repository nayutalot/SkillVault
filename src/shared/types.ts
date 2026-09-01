// 三方共享类型：主进程 / 渲染进程 / companion（经 esbuild 打包）

export type LinkState = 'linked' | 'missing' | 'wrong-target' | 'real-dir' | 'vault-missing'

export type RemoteTargetKind = 'ssh' | 'docker'

/** SSH / Docker 远程目标（先行框架：真实目标出现前绝不伪造连通状态） */
export type RemoteTarget = {
  id: string
  kind: RemoteTargetKind
  label: string
  enabled: boolean
  /** ssh: 主机名/IP */
  host?: string
  port?: number
  /** ssh: 登录用户 */
  user?: string
  /** docker: 容器名 */
  container?: string
}

export type AppSettings = {
  vaultPath: string
  barePath: string
  wslDistro: string
  /** DeepSeek Harness 本体安装目录（版本中心 github 通道检测/更新用；默认 D:\Apps\deepseek-harness） */
  deepseekHarnessRoot: string
  /** 远程目标列表（默认 []，零云远端原则不变：仅用户显式配置后才启用） */
  remoteTargets: RemoteTarget[]
}

export type SkillMeta = { name: string; hasSkillMd: boolean; description: string }

export type AgentScan = {
  name: string
  platform: 'windows' | 'linux'
  skillsDir: string
  links: Record<string, LinkState>
  /** registry 中配置的子智能体目录（未配置则缺省） */
  agentsDir?: string
  /** agentsDir（整目录链接）当前的 LinkState */
  agentsDirState?: LinkState
  /** agentsDir 状态附注（如真实目录形态的「硬链接共享」） */
  agentsDirNote?: string
  /** vault agents/ 集合中的 .md 文件清单（同名目录共享，排序后返回） */
  agentFiles?: string[]
}

/** agents:repair 返回：steps 为修复步骤日志（可直接展示），state/note 为修复后重扫结果 */
export type AgentsRepairResult = { steps: string[]; state: LinkState; note?: string }

export type ScanReport = { skills: SkillMeta[]; agents: AgentScan[]; vaultOk: boolean }

/** WSL 侧 companion 扫描负载（scan:wsl 第二阶段返回值与 userData/wsl-scan-cache.json 同构） */
export type WslScanPayload = { ts: number; agents: AgentScan[]; skills: SkillMeta[] }

/** scan:wsl 返回：stale=true 表示本次 companion 不可达/超时，report 来自缓存 */
export type ScanWslData = { report: WslScanPayload | null; stale: boolean; reason?: string }

export type SyncStep = { side: 'windows' | 'wsl'; cmd: string; ok: boolean; detail: string }

export type SyncResult = { steps: SyncStep[]; conflicts: string[] }

export type DoctorItem = {
  id: string
  severity: 'error' | 'warn' | 'info'
  message: string
  fixable: boolean
  fixId?: string
  payload?: Record<string, unknown>
}

export type RegistryAgent = {
  name: string
  platform: 'windows' | 'linux'
  skillsDir: string
  include: string[]
  /** 子智能体共享目录（整目录链接到 vault agents/）；v1 数据缺省为 undefined */
  agentsDir?: string
  /** 展示名（如 "Claude Code"）；缺省时 UI 回落 name */
  label?: string
  /** 条目来源：builtin 默认 4 条 / discovered 自动发现 / manual 用户手加；旧数据缺省视为 builtin */
  source?: 'builtin' | 'discovered' | 'manual'
  /** 是否启用（缺省视为 true）；停用条目不参与扫描与建链，但条目本身保留 */
  enabled?: boolean
  /** discovered 来源命中的签名 id（genericSweep 兜底为 generic:<dirname>） */
  sigId?: string
  /** discovered/manual 条目本轮扫描状态：目录消失标 missing（绝不删除条目），builtin 不参与状态标记 */
  status?: 'active' | 'missing'
}

export type Registry = { version: 3; agents: RegistryAgent[] }

export type ImportPlan = {
  ok: boolean
  error?: string
  sourceDir: string
  sourceRealPath: string
  sourceIsLink: boolean
  skillName: string
  nameOk: boolean
  hasSkillMd: boolean
  targetDir: string
  fileCount: number
  totalBytes: number
  vaultConflict: boolean
  actions: string[]
}

export type ImportExecuteResult = { plan: ImportPlan; steps: string[] }

export type WslSelfcheck = {
  ok: boolean
  error?: string
  identity: { name: string; email: string }
  originOk: boolean
  execIssues: { rel: string }[]
  mntLinks: { agent: string; skill: string; target: string }[]
}

// ---------- 版本中心（agent harness 已装版本 vs 最新版本检测 + 一键更新） ----------

/** 通道类型：npm 全局包 / winget 包 / 自带更新器 CLI / ARP 安装器（仅检测）/ GitHub Releases 源码重建 */
export type VersionChannelKind = 'npm' | 'winget' | 'native' | 'arp' | 'github'

/** 条目状态：checking 仅渲染层占位用 */
export type VersionState = 'up-to-date' | 'upgradable' | 'unknown' | 'check-failed' | 'detect-only' | 'checking'

export type VersionStatus = {
  id: string
  name: string
  /** 通道展示文本，如 "npm: @anthropic-ai/claude-code" */
  channel: string
  channelKind: VersionChannelKind
  installed?: string
  latest?: string
  state: VersionState
  /** 检查结论附注（失败原因 / 状态解释） */
  note?: string
  /** 固定 UI 提示（如 zcode 的会话环境警告） */
  hint?: string
}

/** 检查结果缓存（userData/version-cache.json 与 checkAll 返回值同构） */
export type VersionCachePayload = { ts: number; statuses: VersionStatus[] }

/** versions:checkAll 返回：stale=true 表示来自缓存（实时检查全部失败或显式读缓存） */
export type CheckAllResult = VersionCachePayload & { stale: boolean; reason?: string }

export type VersionJobStatus = 'running' | 'done' | 'failed' | 'cancelled'

/** 更新 job 快照（IPC 轮询返回；log 为增量内存日志的尾部截断） */
export type VersionJobSnapshot = {
  jobId: string
  entryId: string
  status: VersionJobStatus
  log: string[]
  error?: string
  /** 完成后自动重查的新状态（done 时携带） */
  after?: VersionStatus
}

/** versions:updateOne 返回：blocked=true 表示目标进程在运行，需 UI 确认后带 confirmed 重发 */
export type UpdateStartResult = { blocked: boolean; running?: boolean; processName?: string; jobId?: string }

// ---------- Kimi 档案模型（接口中心 kimi 适配器复用；旧「Kimi 接口」页已合并进接口中心） ----------

/** 新增/编辑档案的渲染层输入（apiKeyPlain 仅经 IPC 传明文，主进程立即 seal，绝不落盘落日志） */
export type KimiProfileInput = {
  /** 有值 = 编辑既有档案；缺省 = 新增（主进程生成 id） */
  id?: string
  name: string
  /** 小写字母数字连字符白名单校验（写入 [providers.<providerId>]） */
  providerId: string
  /** 默认 openai，固定项 */
  type: string
  baseUrl: string
  /** 不含 provider 前缀，如 kimi-k3（复合键为 "<providerId>/<modelId>"） */
  modelId: string
  modelDisplay: string
  maxContext: number
  capabilities: string[]
  thinkingEnabled: boolean
}

/** 档案本体（kimi-profiles.json 落盘形态，接口中心 kimi 节迁移时原样搬运 key 密文）：apiKeySealed = safeStorage 加密后的 base64 */
export type KimiProfile = KimiProfileInput & {
  id: string
  apiKeySealed: string
  /** safeStorage 不可用时的降级标记：apiKeySealed 实为 base64 明文（note: plainStore:true） */
  plainStore?: true
}

/** 档案脱敏视图：api_key 一律只有尾 4 位与长度，绝无全值 */
export type KimiProfileView = {
  id: string
  name: string
  providerId: string
  type: string
  baseUrl: string
  modelId: string
  modelDisplay: string
  maxContext: number
  capabilities: string[]
  thinkingEnabled: boolean
  apiKeyTail: string | null
  apiKeyLen: number | null
  plainStore: boolean
}

/** config.toml 只读脱敏展示（parseKimiConfigDisplay 的返回，绝不含 api_key 全值） */
export type KimiProviderDisplay = {
  id: string
  type?: string
  baseUrl?: string
  apiKeyTail?: string
  apiKeyLen?: number
}

export type KimiModelDisplay = {
  id: string
  provider?: string
  model?: string
  displayName?: string
  maxContext?: number
  capabilities?: string[]
}

export type KimiConfigDisplay = {
  defaultModel: string | null
  providers: KimiProviderDisplay[]
  models: KimiModelDisplay[]
}

// ---------- Docker 页（Portainer 风格容器/镜像管理；引擎未运行是常态，全程优雅降级） ----------

/** dockerInfo 结果：online=引擎在线；engine-down=引擎未运行（stderr 命中 dockerDesktopLinuxEngine 特征） */
export type DockerInfo = {
  state: 'online' | 'engine-down' | 'error'
  clientVersion?: string
  serverVersion?: string
  /** engine-down / error 时的错误摘要（供横幅展示） */
  error?: string
}

/** 容器行（ps -a JSON Lines 解析 + stats --no-stream 按名称合并；stats 取不到时两字段缺省） */
export type DockerContainer = {
  id: string
  name: string
  image: string
  /** raw 状态：running / exited / paused / created …（徽章配色由渲染层归类） */
  state: string
  /** 人类可读状态文本，如 "Up 2 hours (0.2)" / "Exited (0) 3 days ago" */
  status: string
  created: string
  ports: string
  cpuPerc?: string
  memUsage?: string
}

export type DockerImage = { repository: string; tag: string; id: string; size: string; created: string }

export type DockerContainersResult = { containers: DockerContainer[]; error?: string }

export type DockerImagesResult = { images: DockerImage[]; error?: string }

export type DockerLogsResult = { ok: boolean; text: string; error?: string }

export type DockerActionName = 'start' | 'stop' | 'restart' | 'remove'

/** startEngine 结果：ok=true 仅为「已成功拉起 Docker Desktop.exe」，引擎就绪需 10-30 秒后手动刷新 */
export type DockerEngineStart = { ok: boolean; hint?: string; error?: string }

// ---------- WSL 页（任务管理器风格的资源监控；绝不为取数而启动已停止的发行版） ----------

/** Other = 过渡态（Installing/Converting/Uninstalling 等非 Running/Stopped 状态，原样展示不丢行） */
export type WslDistroState = 'Running' | 'Stopped' | 'Other'

/** wsl -l -v 单行解析结果（`*` 标默认发行版） */
export type WslDistro = { name: string; state: WslDistroState; version: string; isDefault: boolean }

/** 发行版内一次性读取 /proc 的复合指标；取不到的项为 null（绝不硬造数值） */
export type WslDistroStats = {
  memTotalKb: number | null
  memFreeKb: number | null
  memAvailKb: number | null
  load1: number | null
  diskTotal: string | null
  diskUsed: string | null
  diskAvail: string | null
  diskPct: number | null
  uptimeSec: number | null
}

/** 宿主侧 WSL VM 进程（vmmemWSL / vmmem）工作集内存；进程不存在时为 null */
export type WslHostVm = { name: string; wsBytes: number }

/** wsl:distros 返回的发行版视图：Running 且非 docker-desktop 的卡附带 stats */
export type WslDistroView = WslDistro & {
  stats: WslDistroStats | null
  statsError?: string
  /** 由 Docker Desktop 管理的发行版（docker-desktop*）：不取数，只显示状态 */
  managedByDocker: boolean
}

export type WslOverview = { distros: WslDistroView[]; host: WslHostVm | null; error?: string }

export type WslActionName = 'terminate' | 'boot' | 'shutdownAll'

// ---------- 接口中心（把 Kimi 档案切换模式扩展到全部 agent harness；api_key 全值绝不出现于 IPC/展示） ----------

export type ApiHubAdapterId = 'claude-cli' | 'claude-desktop' | 'codex' | 'grok' | 'kimi' | 'zcode' | 'deepseek'

/** 表单字段定义（驱动通用表单渲染；select 用 options） */
export type ApiHubFieldDef = {
  key: string
  label: string
  placeholder?: string
  kind?: 'text' | 'select'
  options?: string[]
  /** 高级字段（折叠展示） */
  advanced?: boolean
}

/** 适配器目录项（apihub:adapters 返回；available=false 渲染 N/A 说明卡） */
export type ApiHubAdapterInfo = {
  id: ApiHubAdapterId
  label: string
  available: boolean
  naReason?: string
  notes: string[]
  needsKey: boolean
  fieldDefs: ApiHubFieldDef[]
}

/** 新增/编辑档案输入；fields 为适配器特定的非敏感字段，key 明文单独走 apiKeyPlain */
export type ApiHubProfileInput = {
  id?: string
  adapterId: ApiHubAdapterId
  name: string
  fields: Record<string, string>
}
export type ApiHubProfile = {
  id: string
  adapterId: ApiHubAdapterId
  name: string
  fields: Record<string, string>
  apiKeySealed: string
  plainStore?: true
}
export type ApiHubProfileView = {
  id: string
  name: string
  fields: Record<string, string>
  apiKeyTail: string | null
  apiKeyLen: number | null
  plainStore: boolean
}
export type ApiHubProfilesResult = { profiles: ApiHubProfileView[]; activeId: string | null }

/** apihub:adapters 的单适配器当前状态（readCurrent 脱敏结果，绝不含 key 全值） */
export type ApiHubCurrentResult = {
  adapterId: ApiHubAdapterId
  available: boolean
  naReason?: string
  configPaths: string[]
  baseUrl: string | null
  apiKeyTail: string | null
  apiKeyLen: number | null
  /** 额外脱敏展示键值（如 zcode 当前选中、codex 的 model_provider） */
  detail: Record<string, string>
  activeId: string | null
  matchedProfileId: string | null
}

export type ApiHubSwitchResult = { backupFiles: string[]; warning?: string }
/** switch 预检：blocked=true 表示目标进程在运行，需 UI 确认后带 confirmed 重发 */
export type ApiHubSwitchStart = { blocked: boolean; running?: boolean; processName?: string }
export type ApiHubImportResult = { imported: boolean; profile: ApiHubProfileView | null; reason?: string }

/** IPC 统一返回封装 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

// ===== REGION-APIHUB-TYPES（并发子代理在下方追加接口中心类型，勿改本行及以上内容） =====

// ---------- 接口中心：动态目录（注册表驱动） ----------

/**
 * 动态目录里的条目 id：有写配置实现的适配器沿用 ApiHubAdapterId（档案、切换、导入全部照旧）；
 * 注册表检测到但接口中心没有实现的 agent 生成「说明卡」，用 'na:<sigId>' 命名空间占位
 * （不污染 ApiHubAdapterId 联合类型 —— 档案库的键永远只可能是真有实现的那几个）。
 */
export type ApiHubCatalogId = ApiHubAdapterId | `na:${string}`

/** 动态合成的目录项（apihub:adapters 返回；id 可能是 na: 说明卡，UI 只展示不提供操作） */
export type ApiHubCatalogEntry = Omit<ApiHubAdapterInfo, 'id'> & {
  id: ApiHubCatalogId
  /** 命中的 agent 签名 id（说明卡文案「检测到谁」用；有实现的卡也回填便于排查） */
  sigId?: string
  /** 注册表里的展示名（说明卡文案用；与 label 可能不同，如「Claude Code」vs「Claude Code CLI」） */
  agentLabel?: string
}

/** apihub:adapters 返回：degraded=true 表示注册表读不到/还没有签名信息，已回落内置静态目录（绝不白屏） */
export type ApiHubCatalogResult = { adapters: ApiHubCatalogEntry[]; degraded: boolean; reason?: string }

// ---------- 接口中心：自定义供应商（用户自己填 API 地址 + 密钥，一次配置处处一键填入） ----------

/** 接口格式（决定"切换给谁用"时按哪一套字段预填：Anthropic / OpenAI / Gemini 兼容） */
export type ApiHubProviderProtocol = 'anthropic' | 'openai' | 'gemini'

/** 落盘形态：apiKeySealed 与档案同族（safeStorage/DPAPI 加密，明文绝不出主进程） */
export type ApiHubCustomProvider = {
  id: string
  label: string
  baseUrl: string
  protocol: ApiHubProviderProtocol
  defaultModel?: string
  notes?: string
  apiKeySealed: string
  plainStore?: true
  createdAt: number
}

/** 新增/编辑自定义供应商输入（apiKeyPlain 明文单独走 save 入参；编辑时留空 = 不改动密钥） */
export type ApiHubCustomProviderInput = {
  id?: string
  label: string
  baseUrl: string
  protocol: ApiHubProviderProtocol
  defaultModel?: string
  notes?: string
}

/** 脱敏视图：密钥只回尾 4 位与长度，明文永不返回渲染层 */
export type ApiHubCustomProviderView = {
  id: string
  label: string
  baseUrl: string
  protocol: ApiHubProviderProtocol
  defaultModel?: string
  notes?: string
  apiKeyTail: string | null
  apiKeyLen: number | null
  plainStore: boolean
  createdAt: number
}

/**
 * apihub:save 的输入扩展：apiKeyPlain 留空且带 apiKeyFromProviderId 时，
 * 主进程直接用该自定义供应商的密钥（明文不经过 IPC，渲染层也不需要回显密钥）。
 */
export type ApiHubProfileSaveInput = ApiHubProfileInput & { apiKeyFromProviderId?: string }

/** 「从自定义供应商一键填入」结果：fields 按适配器 fieldDefs 能填多少填多少；missing 为需用户手填的字段标签 */
export type ApiHubProviderPrefill = { fields: Record<string, string>; missing: string[]; notes: string[] }

// ---------- 版本中心：可见性（按注册表自动隐藏未检测到的工具）+ 固定显示 ----------

/** 版本目录视图项：detected=注册表里对应 agent active 且 enabled；visible=detected 或用户固定显示 */
export type VersionCatalogView = {
  id: string
  name: string
  channel: string
  channelKind: VersionChannelKind
  /** 对应 agent 签名 id（claude / codex / kimi / grok / dsh / zcode） */
  sigId: string
  hint?: string
  detected: boolean
  visible: boolean
  pinned: boolean
}

/** versions:catalog 返回：degraded=true 表示注册表读不到、已按「全部显示」保守降级 */
export type VersionCatalogResult = {
  entries: VersionCatalogView[]
  hiddenCount: number
  degraded: boolean
  reason?: string
  /** 用户是否打开了「显示全部（含未检测到的）」；打开时 checkAll 也遍历全部条目 */
  showHidden: boolean
}

// ===== REGION-IMPORT-TYPES（并发子代理在下方追加导入扫描类型，勿改本行及以上内容） =====

// ---------- 导入自动扫描（skillScan.ts）：把「手动挑文件夹」换成「扫出来给你勾」 ----------

/**
 * 候选状态：
 * - importable 可导入
 * - linked     已入库（原位置已是指向 vault 的快捷方式，真身就在库里）
 * - conflict   vault 里已有同名 skill（重名，导入会被拒绝，绝不覆盖）
 * - error      解析/读取失败（断链、无权限等，原因见 errors）
 */
export type SkillScanStatus = 'importable' | 'linked' | 'conflict' | 'error'

/** 一个可导入的 skill 目录（只有含 SKILL.md 的目录才会成为候选） */
export type SkillScanCandidate = {
  /** 候选目录原始路径（交给 import:run 的正是它） */
  dir: string
  /** 技能名（链接解析后真身目录的 basename，与导入后 vault 内的目录名一致） */
  skillName: string
  /** 是否含 SKILL.md（候选恒为 true；保留字段便于 UI 直接展示） */
  hasSkillMd: boolean
  /** 该路径本身是 junction/symlink（真身在别处，导入时解析到真身） */
  isLink: boolean
  /** vault 中已存在同名 skill */
  vaultConflict: boolean
  /** 来源 agent 名（额外目录为 '额外目录'） */
  sourceAgent: string
  /** 相对来源的层级：agent skillsDir 的直接子目录为 1；额外目录自身为 0 */
  depth: number
  status: SkillScanStatus
}

/** 参与本轮扫描的 agent（含 0 个 skill 目录的：说明扫过了但目录是空的） */
export type SkillScanAgent = { name: string; label: string; skillsDir: string; dirCount: number }

/** 个别目录的问题（不存在/读不了/断链）：只记录，不中断整体扫描 */
export type SkillScanError = { dir: string; reason: string }

export type SkillScanResult = {
  candidates: SkillScanCandidate[]
  scannedAgents: SkillScanAgent[]
  errors: SkillScanError[]
}
