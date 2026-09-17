import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentsRepairResult,
  ApiHubAdapterId,
  ApiHubAdapterInfo,
  ApiHubCurrentResult,
  ApiHubImportResult,
  ApiHubProfileInput,
  ApiHubProfileView,
  ApiHubProfilesResult,
  ApiHubSwitchResult,
  ApiHubSwitchStart,
  AppSettings,
  CheckAllResult,
  DockerActionName,
  DockerContainersResult,
  DockerImagesResult,
  DockerInfo,
  DockerLogsResult,
  DockerEngineStart,
  DoctorItem,
  ImportPlan,
  Registry,
  RemoteTarget,
  Result,
  ScanReport,
  ScanWslData,
  SyncResult,
  UpdateStartResult,
  VersionJobSnapshot,
  WslActionName,
  WslHostVm,
  WslOverview
} from '../shared/types'

export type ImportRunResult = { plan: ImportPlan & { steps: string[] } }

export type LinkOpResult = { state: string }

/** corrupt 有值 = registry.json 存在但解析失败（UI 必须只读展示，registry:save 会拒绝覆盖） */
export type RegistryInfo = { registry: Registry; file: string; missing: boolean; corrupt?: string }

export type AppInfo = {
  name: string
  versions: { electron: string; node: string; chrome: string }
  userData: string
}

/** VS Code 打开结果：via='vscode' 为直启成功；'fallback' 为直启失败/未解析到 VS Code、由系统默认程序兜底（reason 为直启失败原因） */
export type OpenMdResult = { via: 'vscode' | 'fallback'; reason?: string }

/** 子智能体 .md 详情抽屉负载：vault 绝对路径 + 前 40 行预览 + 是否截断 */
export type AgentMdInfo = { path: string; preview: string; truncated: boolean }

export type RemoteProbeResult = { ok: boolean; detail: string }

export type RemoteStep = { cmd: string; ok: boolean; detail: string }

export type RemoteSyncResult = { ok: boolean; steps: RemoteStep[] }

export const api = {
  getSettings: (): Promise<Result<AppSettings>> => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: AppSettings): Promise<Result<AppSettings>> => ipcRenderer.invoke('settings:save', s),
  /** 两阶段扫描一：纯 Windows 侧（settings/registry/junction/vault），快速返回先渲染矩阵 */
  scanWindows: (): Promise<Result<ScanReport>> => ipcRenderer.invoke('scan:windows'),
  /** 两阶段扫描二：WSL 侧 companion scan（20s 超时；失败/超时回落缓存，stale=true） */
  scanWsl: (): Promise<Result<ScanWslData>> => ipcRenderer.invoke('scan:wsl'),
  setLink: (agentName: string, skillName: string, kind: 'skill' | 'agents' = 'skill'): Promise<Result<LinkOpResult>> =>
    ipcRenderer.invoke('link:set', { agentName, skillName, kind }),
  removeLink: (agentName: string, skillName: string, kind: 'skill' | 'agents' = 'skill'): Promise<Result<LinkOpResult>> =>
    ipcRenderer.invoke('link:remove', { agentName, skillName, kind }),
  previewImport: (sourceDir: string): Promise<Result<ImportPlan>> =>
    ipcRenderer.invoke('import:preview', { sourceDir }),
  runImport: (sourceDir: string, dryRun: boolean): Promise<Result<ImportRunResult>> =>
    ipcRenderer.invoke('import:run', { sourceDir, dryRun }),
  sync: (): Promise<Result<SyncResult>> => ipcRenderer.invoke('sync:run'),
  doctor: (): Promise<Result<DoctorItem[]>> => ipcRenderer.invoke('doctor:run'),
  doctorFix: (item: DoctorItem): Promise<Result<{ message: string }>> => ipcRenderer.invoke('doctor:fix', item),
  getRegistry: (): Promise<Result<RegistryInfo>> => ipcRenderer.invoke('registry:get'),
  saveRegistry: (r: Registry): Promise<Result<Registry>> => ipcRenderer.invoke('registry:save', r),
  pickDirectory: (): Promise<Result<string | null>> => ipcRenderer.invoke('dialog:pickDir'),
  openPath: (p: string): Promise<Result<boolean>> => ipcRenderer.invoke('shell:open', p),
  /** 打开动作：只传 skillName / 白名单路径，绝不传原始任意路径 */
  openSkillFolder: (skillName: string): Promise<Result<boolean>> =>
    ipcRenderer.invoke('skill:openFolder', { skillName }),
  openSkillExplorerWsl: (skillName: string): Promise<Result<boolean>> =>
    ipcRenderer.invoke('skill:openExplorerWsl', { skillName }),
  openSkillMd: (skillName: string): Promise<Result<OpenMdResult>> =>
    ipcRenderer.invoke('skill:openMd', { skillName }),
  copyPath: (p: string): Promise<Result<boolean>> => ipcRenderer.invoke('skill:copyPath', { path: p }),
  /** 子智能体 .md：只传文件名（白名单校验在主进程），读取前 40 行预览 + vault 绝对路径 */
  readAgentMd: (fileName: string): Promise<Result<AgentMdInfo>> =>
    ipcRenderer.invoke('agent:readMd', { fileName }),
  /** 子智能体 .md：VS Code 打开（失败经系统默认程序兜底，reason 透出） */
  openAgentMd: (fileName: string): Promise<Result<OpenMdResult>> =>
    ipcRenderer.invoke('agent:openMd', { fileName }),
  /** 在资源管理器中打开 vault agents 目录 */
  openAgentFolder: (): Promise<Result<boolean>> => ipcRenderer.invoke('agent:openFolder'),
  /** 子智能体 agentsDir 一键修复（仅 Windows；UI 确认后调用；以 vault agents 为源重建硬链接共享目录） */
  repairAgentsDir: (agentName: string): Promise<Result<AgentsRepairResult>> =>
    ipcRenderer.invoke('agents:repair', { agentName }),
  /** 远程目标：探测连通性（未配置/不可达都是合法状态，原因原样返回） */
  probeRemote: (target: RemoteTarget): Promise<Result<RemoteProbeResult>> =>
    ipcRenderer.invoke('remote:probe', target),
  /** 远程目标：git bundle 单向同步（目标必须已在 settings 中保存且启用） */
  syncRemote: (targetId: string): Promise<Result<RemoteSyncResult>> =>
    ipcRenderer.invoke('remote:sync', { targetId }),
  /** 版本中心：useCache=true 只读缓存秒回；id 指定单条重查；无参全量实时检查（更新绝不自动发生） */
  versionsCheckAll: (arg?: { useCache?: boolean; id?: string }): Promise<Result<CheckAllResult>> =>
    ipcRenderer.invoke('versions:checkAll', arg),
  /** 版本中心：请求更新（未确认时主进程先做运行中预检，blocked=true 需确认后带 confirmed 重发） */
  versionsUpdateOne: (arg: { id: string; confirmed?: boolean }): Promise<Result<UpdateStartResult>> =>
    ipcRenderer.invoke('versions:updateOne', arg),
  /** 版本中心：轮询更新 job（增量日志 + 状态） */
  versionsJobStatus: (jobId: string): Promise<Result<VersionJobSnapshot>> =>
    ipcRenderer.invoke('versions:jobStatus', { jobId }),
  /** 版本中心：取消更新 job（终止进程树） */
  versionsCancel: (jobId: string): Promise<Result<{ cancelled: boolean }>> =>
    ipcRenderer.invoke('versions:cancel', { jobId }),
  /** 接口中心：适配器目录（含可用性/字段定义/不可用原因） */
  apihubAdapters: (): Promise<Result<{ adapters: ApiHubAdapterInfo[] }>> => ipcRenderer.invoke('apihub:adapters'),
  /** 接口中心：单适配器当前状态（脱敏；不可用适配器 available=false） */
  apihubCurrent: (adapterId: ApiHubAdapterId): Promise<Result<ApiHubCurrentResult>> =>
    ipcRenderer.invoke('apihub:current', { adapterId }),
  /** 接口中心：档案列表（key 只回尾 4 位与长度） */
  apihubProfiles: (adapterId: ApiHubAdapterId): Promise<Result<ApiHubProfilesResult>> =>
    ipcRenderer.invoke('apihub:profiles', { adapterId }),
  /** 接口中心：新增/编辑档案（apiKeyPlain 明文仅经 IPC，主进程立即 seal；编辑留空 = 不改 key） */
  apihubSave: (input: ApiHubProfileInput, apiKeyPlain: string): Promise<Result<ApiHubProfileView | null>> =>
    ipcRenderer.invoke('apihub:save', { input, apiKeyPlain }),
  /** 接口中心：删除档案（返回删除后的列表便于刷新） */
  apihubDelete: (adapterId: ApiHubAdapterId, id: string): Promise<Result<ApiHubProfilesResult>> =>
    ipcRenderer.invoke('apihub:delete', { adapterId, id }),
  /** 接口中心：从当前配置导入档案（key 全值只在主进程内存一瞬间） */
  apihubImport: (adapterId: ApiHubAdapterId): Promise<Result<ApiHubImportResult>> =>
    ipcRenderer.invoke('apihub:import', { adapterId }),
  /** 接口中心：一键切换（zcode 运行中返回 blocked，UI 确认后带 confirmed 重发） */
  apihubSwitch: (
    adapterId: ApiHubAdapterId,
    id: string,
    confirmed?: boolean
  ): Promise<Result<ApiHubSwitchStart | ApiHubSwitchResult>> => ipcRenderer.invoke('apihub:switch', { adapterId, id, confirmed }),
  /** Docker 页：引擎状态（online 返回 Client/Server 版本；engine-down 为 Docker Desktop 未运行的常态） */
  dockerInfo: (): Promise<Result<DockerInfo>> => ipcRenderer.invoke('docker:info'),
  /** Docker 页：容器列表（ps -a + stats --no-stream 已按容器名合并） */
  dockerContainers: (): Promise<Result<DockerContainersResult>> => ipcRenderer.invoke('docker:containers'),
  /** Docker 页：镜像列表 */
  dockerImages: (): Promise<Result<DockerImagesResult>> => ipcRenderer.invoke('docker:images'),
  /** Docker 页：容器资源快照（stats --no-stream 原始行） */
  dockerStats: (): Promise<Result<Record<string, unknown>[]>> => ipcRenderer.invoke('docker:stats'),
  /** Docker 页：容器日志（tail 200 文本） */
  dockerLogs: (name: string): Promise<Result<DockerLogsResult>> => ipcRenderer.invoke('docker:logs', { name }),
  /** Docker 页：容器动作（start/stop/restart/remove；确认框由 UI 层负责） */
  dockerAction: (name: string, action: DockerActionName): Promise<Result<{ ok: boolean; detail: string }>> =>
    ipcRenderer.invoke('docker:action', { name, action }),
  /** Docker 页：删除镜像（docker rmi；确认框由 UI 层负责） */
  dockerImageRemove: (id: string): Promise<Result<{ ok: boolean; detail: string }>> =>
    ipcRenderer.invoke('docker:imageRemove', { id }),
  /** Docker 页：拉起 Docker Desktop 引擎（detached；就绪需 10-30 秒，刷新由用户点） */
  dockerStartEngine: (): Promise<Result<DockerEngineStart>> => ipcRenderer.invoke('docker:startEngine'),
  /** WSL 页：一次返回发行版清单（运行中非 docker 系附带 stats）+ 宿主 vmmem 内存 */
  wslDistros: (): Promise<Result<WslOverview>> => ipcRenderer.invoke('wsl:distros'),
  /** WSL 页：宿主侧 vmmemWSL 内存（进程不存在返回 null） */
  wslHost: (): Promise<Result<WslHostVm | null>> => ipcRenderer.invoke('wsl:host'),
  /** WSL 页：terminate / boot / shutdownAll（UI 双重确认后才会到达主进程） */
  wslAction: (action: WslActionName, name?: string): Promise<Result<{ ok: boolean; detail?: string }>> =>
    ipcRenderer.invoke('wsl:action', { action, name }),
  appInfo: (): Promise<Result<AppInfo>> => ipcRenderer.invoke('app:info')
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
