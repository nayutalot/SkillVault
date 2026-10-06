// 全部 typed IPC handler。所有 handler 经 envelope 包装：F 盘缺席等异常以 { ok:false, error } 返回，不白屏。
import { app, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type {
  AgentsRepairResult,
  DoctorItem,
  ImportPlan,
  Registry,
  RemoteTarget,
  Result,
  ScanReport,
  ScanWslData,
  SyncResult
} from '../shared/types'
import { loadSettings, saveSettings, type AppSettings } from './settings'
import {
  createJunction,
  getLinkState,
  isLinkPath,
  listVaultAgentFiles,
  listVaultSkills,
  pathExists,
  removeLink,
  repairAgentsDirHardlinks,
  scanWindowsAgents,
  vaultAgentsDir,
  vaultSkillDir
} from './winLinks'
import { executeImport, planImport } from './importer'
import { runWslScan } from './wslScan'
import { syncAll } from './sync'
import { applyFix, runDoctor } from './doctor'
import { parseRegistry, defaultRegistry, REGISTRY_VERSION } from '../shared/registry'
import { git } from './git'
import { WSL_VAULT, wslUncSkillDir } from '../shared/paths'
import { decodeTextBuffer } from '../shared/textDecode'
import {
  isKnownCopyPath,
  isKnownSkillName,
  isValidSkillName,
  rememberCopyPaths,
  rememberSkillNames,
  resolveVaultSkillDir,
  resolveVaultSkillMd,
  scanCopyPaths
} from './skillOpen'
import {
  isKnownAgentFile,
  rememberAgentFiles,
  resolveVaultAgentMd
} from './agentsOpen'
import { launchVsCode, resolveVsCode } from './vscode'
import { probeRemote, targetConfigError } from './remote'
import { syncToRemote, transportFor } from './remoteSync'
import {
  cancelJob,
  jobSnapshot,
  readVersionCache,
  requestUpdateOne,
  runVersionCheckAll,
  runVersionCheckSingle
} from './versionCenter/jobs'
import {
  type KimiSealer
} from './kimi/profiles'
import { API_HUB_CATALOG, apihubImportCurrent, apihubReadCurrent, apihubSwitch, validateHubFields, type ApiHubDeps } from './apihub'
import { deleteHubProfile, hubProfileView, listHubViews, loadHubStore, upsertHubProfile } from './apihub/store'
import type { ApiHubAdapterId, ApiHubImportResult, ApiHubProfileInput, ApiHubProfilesResult } from '../shared/types'
import {
  containerAction,
  dockerContainers,
  dockerImages,
  dockerInfo,
  dockerLogs,
  dockerStats,
  imageRemove,
  startEngine
} from './docker'
import { hostVm, wslAction, wslOverview } from './wslmon'
import type { DockerActionName, WslActionName, WslOverview } from '../shared/types'

function envelope<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, data: fn() }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function envelopeAsync<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function settingsDir(): string {
  return app.getPath('userData')
}

// ---------- Kimi Code CLI 配置（接口中心 kimi 适配器共用；api_key 全值只经内存，绝不落日志/缓存/仓库） ----------

/** safeStorage（Windows DPAPI）装配的 seal/解密；不可用由 profiles 层自动降级并打 plainStore 标记 */
const kimiSealer: KimiSealer = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64'))
}

/** registry 读取三态：不存在（missing）/ 存在但解析失败（corrupt 携带原因）/ 正常。
 *  损坏时绝不能回落空 registry 供上层覆盖保存 —— 那会把用户全部 agent 定义静默清空。 */
function readRegistry(vaultPath: string): { registry: Registry; file: string; corrupt?: string } {
  const file = path.join(vaultPath, 'registry.json')
  if (!fs.existsSync(file)) return { registry: { version: REGISTRY_VERSION, agents: [] }, file }
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { registry: { version: REGISTRY_VERSION, agents: [] }, file, corrupt: `registry.json 读取失败: ${String(e)}` }
  }
  const r = parseRegistry(text)
  if (r.ok) return { registry: r.registry, file }
  return { registry: { version: REGISTRY_VERSION, agents: [] }, file, corrupt: r.error }
}

/** 同步互斥：syncAll / syncToRemote / registry:save 都会动 vault 与裸仓的 git 状态，
 *  runCompanion 的 await 窗口内事件循环空闲，可重入会造成 index.lock 争用与假冲突 —— 全部串行化。 */
let syncChain: Promise<unknown> = Promise.resolve()
function withSyncLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = syncChain.then(fn, fn)
  syncChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function registerIpc(): void {
  ipcMain.handle('settings:get', () => envelope(() => loadSettings(settingsDir())))

  ipcMain.handle('settings:save', (_e, s: AppSettings) =>
    envelope(() => {
      saveSettings(settingsDir(), s)
      return loadSettings(settingsDir())
    })
  )

  // ---------- 两阶段扫描（消灭启动冻结）----------
  // 阶段一 scan:windows：纯 Windows 侧（settings/registry/junction/vault），同步快速（<300ms），先渲染矩阵。
  ipcMain.handle('scan:windows', () =>
    envelope((): ScanReport => {
      const s = loadSettings(settingsDir())
      const vaultOk = fs.existsSync(path.join(s.vaultPath, '.git'))
      const { registry } = readRegistry(s.vaultPath)
      const agents = scanWindowsAgents(s.vaultPath, registry)
      const skills = listVaultSkills(s.vaultPath)
      const agentFiles = listVaultAgentFiles(s.vaultPath)
      // 登记 copyPath 白名单（仅允许复制当前扫描结果中的路径）与打开动作的 skill / agent 文件成员集合
      rememberCopyPaths([
        ...scanCopyPaths(s.vaultPath, skills, agents, WSL_VAULT),
        // 子智能体集合：vault agents 目录、vault 内各 .md、各 agent agentsDir（Windows 绝对 / WSL posix）
        vaultAgentsDir(s.vaultPath),
        ...agentFiles.map((f) => path.join(vaultAgentsDir(s.vaultPath), f)),
        ...agents.filter((a) => a.agentsDir).map((a) => a.agentsDir!)
      ])
      rememberSkillNames(skills.map((x) => x.name))
      rememberAgentFiles(agentFiles)
      return { skills, agents, vaultOk }
    })
  )

  // 阶段二 scan:wsl：异步调 companion scan（20s 超时），失败/超时回落 userData/wsl-scan-cache.json（stale=true）。
  ipcMain.handle('scan:wsl', () =>
    envelopeAsync(async (): Promise<ScanWslData> => {
      const s = loadSettings(settingsDir())
      const out = await runWslScan(s, { cacheFile: path.join(settingsDir(), 'wsl-scan-cache.json') })
      // WSL agent 到达后（成功或缓存），把合并后的 agent 集合重新登记进 copyPath 白名单（skill/agent 文件集合不变）。
      // await 期间用户可能已改 vaultPath 并重跑 scan:windows —— 陈旧快照整体替换白名单会把新 vault 的合法路径全部作废，
      // 因此续段前重读 settings，vaultPath 已变则放弃登记（本次报告本就是旧 vault 的数据）。
      if (out.report && loadSettings(settingsDir()).vaultPath === s.vaultPath) {
        const { registry } = readRegistry(s.vaultPath)
        const winAgents = scanWindowsAgents(s.vaultPath, registry)
        const linuxAgents = out.report.agents.filter((a) => a.platform === 'linux')
        const skills = listVaultSkills(s.vaultPath)
        const agentFiles = listVaultAgentFiles(s.vaultPath)
        rememberCopyPaths([
          ...scanCopyPaths(s.vaultPath, skills, [...winAgents, ...linuxAgents], WSL_VAULT),
          vaultAgentsDir(s.vaultPath),
          ...agentFiles.map((f) => path.join(vaultAgentsDir(s.vaultPath), f)),
          ...[...winAgents, ...linuxAgents].filter((a) => a.agentsDir).map((a) => a.agentsDir!)
        ])
      }
      return { report: out.report, stale: out.stale, reason: out.reason }
    })
  )

  // ---------- 链接操作（kind: 'skill' 默认逐 skill junction；'agents' 为子智能体整目录链接）----------

  ipcMain.handle('link:set', (_e, arg: { agentName: string; skillName?: string; kind?: 'skill' | 'agents' }) =>
    envelope(() => {
      const s = loadSettings(settingsDir())
      const { registry } = readRegistry(s.vaultPath)
      const agent = registry.agents.find((a) => a.name === arg.agentName && a.platform === 'windows')
      if (!agent) throw new Error(`registry 中找不到 Windows agent: ${arg.agentName}`)
      if (arg.kind === 'agents') {
        if (!agent.agentsDir) throw new Error(`agent 未配置 agentsDir，无法建立子智能体链接: ${agent.name}`)
        const target = vaultAgentsDir(s.vaultPath)
        if (!pathExists(target)) throw new Error(`vault 中不存在 agents 目录: ${target}`)
        const state = getLinkState(agent.agentsDir, target)
        if (state === 'real-dir') throw new Error(`目标是真实目录，拒绝覆盖: ${agent.agentsDir}（请先人工处理）`)
        if (state === 'linked') return { state }
        if (isLinkPath(agent.agentsDir)) removeLink(agent.agentsDir)
        createJunction(target, agent.agentsDir)
        return { state: getLinkState(agent.agentsDir, target) }
      }
      if (!arg.skillName) throw new Error('缺少 skillName')
      // skillName 白名单校验（与 skill:open* 同边界）：防 `..\` 目录穿越到 agent skillsDir 之外建链
      if (!isValidSkillName(arg.skillName)) throw new Error(`非法 skill 名（仅允许 ^[a-z0-9][a-z0-9-]*$）: ${JSON.stringify(String(arg.skillName))}`)
      const target = vaultSkillDir(s.vaultPath, arg.skillName)
      if (!pathExists(target)) throw new Error(`vault 中不存在该 skill: ${arg.skillName}`)
      const linkPath = path.join(agent.skillsDir, arg.skillName)
      const state = getLinkState(linkPath, target)
      if (state === 'real-dir') throw new Error(`目标是真实目录，拒绝覆盖: ${linkPath}（请先 re-import）`)
      if (state === 'linked') return { state }
      if (isLinkPath(linkPath)) removeLink(linkPath)
      createJunction(target, linkPath)
      return { state: getLinkState(linkPath, target) }
    })
  )

  ipcMain.handle('link:remove', (_e, arg: { agentName: string; skillName?: string; kind?: 'skill' | 'agents' }) =>
    envelope(() => {
      const s = loadSettings(settingsDir())
      const { registry } = readRegistry(s.vaultPath)
      const agent = registry.agents.find((a) => a.name === arg.agentName && a.platform === 'windows')
      if (!agent) throw new Error(`registry 中找不到 Windows agent: ${arg.agentName}`)
      if (arg.kind !== 'agents' && arg.skillName && !isValidSkillName(arg.skillName)) {
        throw new Error(`非法 skill 名（仅允许 ^[a-z0-9][a-z0-9-]*$）: ${JSON.stringify(String(arg.skillName))}`)
      }
      const linkPath =
        arg.kind === 'agents'
          ? agent.agentsDir
          : arg.skillName
            ? path.join(agent.skillsDir, arg.skillName)
            : undefined
      if (!linkPath) throw new Error(arg.kind === 'agents' ? `agent 未配置 agentsDir: ${agent.name}` : '缺少 skillName')
      if (fs.existsSync(linkPath) && !isLinkPath(linkPath)) {
        throw new Error(`目标是真实目录/文件，拒绝删除: ${linkPath}`)
      }
      removeLink(linkPath)
      const expected =
        arg.kind === 'agents' ? vaultAgentsDir(s.vaultPath) : vaultSkillDir(s.vaultPath, arg.skillName ?? '')
      return { state: getLinkState(linkPath, expected) }
    })
  )

  ipcMain.handle('import:preview', (_e, arg: { sourceDir: string }) =>
    envelope(() => {
      const s = loadSettings(settingsDir())
      return planImport(arg.sourceDir, s.vaultPath)
    })
  )

  ipcMain.handle('import:run', (_e, arg: { sourceDir: string; dryRun: boolean }) =>
    envelope(() => {
      const s = loadSettings(settingsDir())
      const r = executeImport(arg.sourceDir, s.vaultPath, { dryRun: arg.dryRun })
      return { plan: r as ImportPlan & { steps: string[] } }
    })
  )

  ipcMain.handle('sync:run', () =>
    envelopeAsync(async (): Promise<SyncResult> => {
      const s = loadSettings(settingsDir())
      return withSyncLock(() => syncAll(s))
    })
  )

  ipcMain.handle('doctor:run', () =>
    envelopeAsync(async (): Promise<DoctorItem[]> => {
      const s = loadSettings(settingsDir())
      const { registry } = readRegistry(s.vaultPath)
      return runDoctor(s, registry)
    })
  )

  // applyFix 全部由主进程从 settings/registry/扫描结果重新推导路径，绝不信任渲染层回传的 payload（防越权写/建链）
  ipcMain.handle('doctor:fix', (_e, item: DoctorItem) =>
    envelopeAsync(() => applyFix(loadSettings(settingsDir()), readRegistry(loadSettings(settingsDir()).vaultPath).registry, item))
  )

  ipcMain.handle('registry:get', () =>
    envelope(() => {
      const s = loadSettings(settingsDir())
      const { registry, file, corrupt } = readRegistry(s.vaultPath)
      if (!fs.existsSync(file)) {
        // vault 尚未初始化时返回默认 registry，保存时会写入 vault
        return { registry: structuredClone(defaultRegistry()), file, missing: true }
      }
      // 损坏：返回默认值仅供只读展示 + corrupt 原因；registry:save 会拒绝覆盖
      if (corrupt) {
        return { registry: structuredClone(defaultRegistry()), file, missing: false, corrupt }
      }
      return { registry, file, missing: false }
    })
  )

  ipcMain.handle('registry:save', (_e, reg: Registry) =>
    envelopeAsync(async () =>
      // 与 syncAll/syncToRemote 共用互斥：registry commit 可能落在 sync 的 companion await 窗口内，并发动 git 会互相踩
      withSyncLock(() => {
        const s = loadSettings(settingsDir())
        const { corrupt } = readRegistry(s.vaultPath)
        if (corrupt) {
          throw new Error(`registry.json 已损坏（${corrupt}），拒绝覆盖保存。请先人工修复或删除该文件：${path.join(s.vaultPath, 'registry.json')}`)
        }
        const check = parseRegistry(JSON.stringify(reg))
        if (!check.ok) throw new Error(check.error)
        const file = path.join(s.vaultPath, 'registry.json')
        fs.mkdirSync(s.vaultPath, { recursive: true })
        fs.writeFileSync(file, JSON.stringify(check.registry, null, 2) + '\n', 'utf8')
        if (fs.existsSync(path.join(s.vaultPath, '.git'))) {
          git(s.vaultPath, ['add', 'registry.json'])
          const st = git(s.vaultPath, ['status', '--porcelain'])
          if (st.stdout.trim()) git(s.vaultPath, ['commit', '-m', 'skillvault: update registry'])
        }
        return check.registry
      })
    )
  )

  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return { ok: true, data: null } as Result<string | null>
    return { ok: true, data: r.filePaths[0] } as Result<string | null>
  })

  ipcMain.handle('shell:open', (_e, p: string) =>
    envelopeAsync(async () => {
      const err = await shell.openPath(p)
      if (err) throw new Error(err)
      return true
    })
  )

  // ---------- 打开动作（渲染层只传 skillName；路径全部由主进程解析并校验） ----------

  /** 打开动作三重校验：skillName 白名单 + 路径 containment 由 resolveVaultSkillDir 承担；再要求命中当前扫描结果 */
  function assertOpenableSkill(vaultPath: string, skillName: string): void {
    resolveVaultSkillDir(vaultPath, skillName)
    if (!isKnownSkillName(skillName)) {
      throw new Error(`该 skill 不在当前扫描结果中，请先回仪表盘刷新: ${JSON.stringify(String(skillName ?? ''))}`)
    }
  }

  /** 在资源管理器中打开 vault 真身目录 */
  ipcMain.handle('skill:openFolder', (_e, arg: { skillName: string }) =>
    envelopeAsync(async () => {
      const s = loadSettings(settingsDir())
      assertOpenableSkill(s.vaultPath, arg.skillName)
      const dir = resolveVaultSkillDir(s.vaultPath, arg.skillName)
      if (!fs.existsSync(dir)) throw new Error(`vault 中不存在该 skill: ${arg.skillName}`)
      const err = await shell.openPath(dir)
      if (err) throw new Error(err)
      return true
    })
  )

  /** 在资源管理器中打开 WSL 侧 vault 目录（\\wsl.localhost\<distro>\root\skill-vault\skills\<name>） */
  ipcMain.handle('skill:openExplorerWsl', (_e, arg: { skillName: string }) =>
    envelopeAsync(async () => {
      const s = loadSettings(settingsDir())
      assertOpenableSkill(s.vaultPath, arg.skillName)
      const unc = wslUncSkillDir(s.wslDistro, arg.skillName)
      const err = await shell.openPath(unc)
      if (err) throw new Error(err)
      return true
    })
  )

  /**
   * VS Code 打开 SKILL.md：resolveVsCode 命中则 spawn(exe, [mdPath]) 直启（不经 shell，env 已清洗）；
   * 直启失败（error 事件）或解析不到 VS Code 时 shell.openPath 兜底，返回值注明 via='fallback' 并携带失败原因供 UI 透出。
   */
  ipcMain.handle('skill:openMd', (_e, arg: { skillName: string }) =>
    envelopeAsync(async () => {
      const s = loadSettings(settingsDir())
      assertOpenableSkill(s.vaultPath, arg.skillName)
      const md = resolveVaultSkillMd(s.vaultPath, arg.skillName)
      if (!fs.existsSync(md)) throw new Error(`SKILL.md 不存在: ${arg.skillName}`)
      const exe = resolveVsCode()
      if (exe) {
        const r = await launchVsCode({ spawn }, exe, md)
        if (r.ok) return { via: 'vscode' as const }
        // 常见失败：继承了 ELECTRON_RUN_AS_NODE 等 env（已在 vscode.ts 清洗兜底一层）；reason 透传给 UI
        const err = await shell.openPath(md)
        if (err) throw new Error(`VS Code 启动失败（${r.error}），系统默认程序兜底也失败: ${err}`)
        return { via: 'fallback' as const, reason: r.error }
      }
      const err = await shell.openPath(md)
      if (err) throw new Error(err)
      return { via: 'fallback' as const }
    })
  )

  /** 复制路径到剪贴板：仅允许当前扫描结果白名单内的值 */
  ipcMain.handle('skill:copyPath', (_e, arg: { path: string }) =>
    envelope(() => {
      if (!isKnownCopyPath(arg.path)) throw new Error('拒绝复制：该路径不在当前扫描结果白名单内')
      clipboard.writeText(String(arg.path))
      return true
    })
  )

  // ---------- 子智能体 .md 打开/读取（安全边界与 skill 打开动作同级） ----------

  /** 打开动作三重校验：文件名白名单 + agents 目录 containment（resolveVaultAgentMd）+ 命中当前扫描的 agentFiles 集合 */
  function assertOpenableAgentMd(vaultPath: string, fileName: string): void {
    resolveVaultAgentMd(vaultPath, fileName)
    if (!isKnownAgentFile(fileName)) {
      throw new Error(`该文件不在当前扫描结果中，请先回仪表盘刷新: ${JSON.stringify(String(fileName ?? ''))}`)
    }
  }

  /** 读取 vault agents/<file> 的前 40 行预览与 vault 绝对路径（详情抽屉用；绝不返回全文件） */
  ipcMain.handle('agent:readMd', (_e, arg: { fileName: string }) =>
    envelope(() => {
      const s = loadSettings(settingsDir())
      assertOpenableAgentMd(s.vaultPath, arg.fileName)
      const md = resolveVaultAgentMd(s.vaultPath, arg.fileName)
      if (!fs.existsSync(md)) throw new Error(`文件不存在: ${arg.fileName}`)
      // GBK/UTF-16 文件按 UTF-8 强解会在预览里乱码：先读 Buffer，再走共享解码兜底（BOM → 严格 UTF-8 → GBK）。
      // decodeTextBuffer 只用于展示（预览），绝不写回磁盘——写回等于静默转码，二进制误判时会把文件写坏。
      const buf = fs.readFileSync(md)
      const decoded = decodeTextBuffer(buf)
      if (!decoded) throw new Error(`文件不是可读文本（二进制或未知编码）: ${md}`)
      const lines = decoded.text.split(/\r?\n/)
      return { path: md, preview: lines.slice(0, 40).join('\n'), truncated: lines.length > 40 }
    })
  )

  /** VS Code 打开子智能体 .md：复用 skill:openMd 的直启 + 系统默认程序兜底模式（reason 透出） */
  ipcMain.handle('agent:openMd', (_e, arg: { fileName: string }) =>
    envelopeAsync(async () => {
      const s = loadSettings(settingsDir())
      assertOpenableAgentMd(s.vaultPath, arg.fileName)
      const md = resolveVaultAgentMd(s.vaultPath, arg.fileName)
      if (!fs.existsSync(md)) throw new Error(`文件不存在: ${arg.fileName}`)
      const exe = resolveVsCode()
      if (exe) {
        const r = await launchVsCode({ spawn }, exe, md)
        if (r.ok) return { via: 'vscode' as const }
        // 常见失败：继承了 ELECTRON_RUN_AS_NODE 等 env；reason 透传给 UI
        const err = await shell.openPath(md)
        if (err) throw new Error(`VS Code 启动失败（${r.error}），系统默认程序兜底也失败: ${err}`)
        return { via: 'fallback' as const, reason: r.error }
      }
      const err = await shell.openPath(md)
      if (err) throw new Error(err)
      return { via: 'fallback' as const }
    })
  )

  /** 在资源管理器中打开 vault agents 目录（目录级打开，不落到任意子路径） */
  ipcMain.handle('agent:openFolder', () =>
    envelopeAsync(async () => {
      const s = loadSettings(settingsDir())
      const dir = vaultAgentsDir(s.vaultPath)
      if (!fs.existsSync(dir)) throw new Error(`vault 中不存在 agents 目录: ${dir}`)
      const err = await shell.openPath(dir)
      if (err) throw new Error(err)
      return true
    })
  )

  /**
   * 子智能体 agentsDir 一键修复（仅 Windows；UI 确认框先行）：以 vault agents 为源，
   * 把真实目录重建为硬链接共享目录（同名同 inode 跳过 / 同名异文件先移入回收目录再重建 / 多余 .md 移入回收目录）。
   */
  ipcMain.handle('agents:repair', (_e, arg: { agentName: string }) =>
    envelopeAsync(async (): Promise<AgentsRepairResult> => {
      if (process.platform !== 'win32') throw new Error('agentsDir 一键修复仅支持 Windows 平台')
      const name = String(arg?.agentName ?? '')
      const s = loadSettings(settingsDir())
      const { registry } = readRegistry(s.vaultPath)
      const agent = registry.agents.find((a) => a.name === name && a.platform === 'windows')
      if (!agent) throw new Error(`registry 中找不到 Windows agent: ${name}`)
      if (!agent.agentsDir) throw new Error(`agent 未配置 agentsDir，无法修复: ${agent.name}`)
      return repairAgentsDirHardlinks(s.vaultPath, agent.agentsDir)
    })
  )

  // ---------- SSH / Docker 远程目标（先行框架：真实目标出现前绝不伪造连通状态） ----------

  /** 探测单个目标（目标由渲染层传入 —— 探测无文件系统副作用；失败/未配置都是合法状态，原因原样透出） */
  ipcMain.handle('remote:probe', (_e, target: RemoteTarget) =>
    envelopeAsync(async () => {
      const cfgErr = targetConfigError(target)
      if (cfgErr) return { ok: false, detail: cfgErr }
      return probeRemote(target)
    })
  )

  /** 按 id 同步到远程目标（目标必须来自 settings，防止渲染层注入任意传输参数） */
  ipcMain.handle('remote:sync', (_e, arg: { targetId: string }) =>
    envelopeAsync(async () => {
      const s = loadSettings(settingsDir())
      const t = s.remoteTargets.find((x) => x.id === arg.targetId)
      if (!t) throw new Error(`settings 中找不到远程目标: ${String(arg.targetId ?? '')}`)
      if (!t.enabled) throw new Error(`远程目标已停用: ${t.label}`)
      if (!fs.existsSync(path.join(s.vaultPath, '.git'))) throw new Error(`vault 不可用，无法同步: ${s.vaultPath}`)
      return withSyncLock(() => syncToRemote(t, s.vaultPath, transportFor(t)))
    })
  )

  // ---------- 版本中心（检测全部 agent harness 已装 vs 最新版本；更新仅用户点击触发） ----------

  /** 版本中心依赖：缓存文件 + DeepSeek 本体目录（settings.deepseekHarnessRoot，github 通道检测/更新用） */
  function vcDeps() {
    return {
      cacheFile: path.join(app.getPath('userData'), 'version-cache.json'),
      deepseekRoot: loadSettings(settingsDir()).deepseekHarnessRoot
    }
  }

  /** arg.useCache=true 只读缓存（秒回，UI 先渲染上次结果）；arg.id 指定单条重查；无 arg 跑全量实时检查 */
  ipcMain.handle('versions:checkAll', (_e, arg?: { useCache?: boolean; id?: string }) =>
    envelopeAsync(async () => {
      if (arg?.id) return runVersionCheckSingle(String(arg.id), vcDeps())
      if (arg?.useCache) {
        const cached = readVersionCache(vcDeps().cacheFile)
        if (cached) return { ...cached, stale: true, reason: '来自缓存' }
      }
      return runVersionCheckAll(vcDeps())
    })
  )

  /** 未确认时先做预检（winget 进程运行中 / github 首次点击确认）；blocked=true 交 UI 确认后带 confirmed 重发 */
  ipcMain.handle('versions:updateOne', (_e, arg: { id: string; confirmed?: boolean }) =>
    envelopeAsync(async () => requestUpdateOne(String(arg?.id ?? ''), arg?.confirmed === true, vcDeps()))
  )

  ipcMain.handle('versions:jobStatus', (_e, arg: { jobId: string }) =>
    envelope(() => jobSnapshot(String(arg?.jobId ?? '')))
  )

  ipcMain.handle('versions:cancel', (_e, arg: { jobId: string }) =>
    envelope(() => ({ cancelled: cancelJob(String(arg?.jobId ?? '')) }))
  )

  // ---------- 接口中心（Kimi Code CLI 与全部 agent harness 统一档案切换；key 全值只在主进程内存瞬间存在） ----------

  /** apihub 依赖装配：homeDir/userDataDir/sealer 每次 handler 现取，测试经由模块级注入演练 */
  function apihubDeps(): ApiHubDeps {
    return { homeDir: os.homedir(), userDataDir: settingsDir(), sealer: kimiSealer, fsMod: fs }
  }

  ipcMain.handle('apihub:adapters', () => envelope(() => ({ adapters: API_HUB_CATALOG })))

  ipcMain.handle('apihub:current', (_e, arg: { adapterId: ApiHubAdapterId }) =>
    envelopeAsync(async () => {
      const info = API_HUB_CATALOG.find((a) => a.id === arg?.adapterId)
      if (!info) throw new Error('未知适配器: ' + String(arg?.adapterId ?? ''))
      return apihubReadCurrent(arg.adapterId, apihubDeps())
    })
  )

  ipcMain.handle('apihub:profiles', (_e, arg: { adapterId: ApiHubAdapterId }) =>
    envelopeAsync(async (): Promise<ApiHubProfilesResult> => {
      const store = loadHubStore(settingsDir(), fs)
      return { profiles: listHubViews(store, arg.adapterId, kimiSealer), activeId: store.activeByAdapter[arg.adapterId] ?? null }
    })
  )

  ipcMain.handle('apihub:save', (_e, arg: { input: ApiHubProfileInput; apiKeyPlain: string }) =>
    envelopeAsync(async () => {
      const input = arg?.input
      if (!input || !API_HUB_CATALOG.find((a) => a.id === input.adapterId)?.available) throw new Error('未知或不可用适配器')
      const err = validateHubFields(input.adapterId, input.fields ?? {}, Boolean(String(arg.apiKeyPlain ?? '').trim()))
      if (err) throw new Error(err)
      const saved = upsertHubProfile(settingsDir(), input, String(arg.apiKeyPlain ?? ''), kimiSealer, fs)
      return hubProfileView(saved, kimiSealer)
    })
  )

  ipcMain.handle('apihub:delete', (_e, arg: { adapterId: ApiHubAdapterId; id: string }) =>
    envelopeAsync(async (): Promise<ApiHubProfilesResult> => {
      const store = deleteHubProfile(settingsDir(), arg.adapterId, String(arg?.id ?? ''), fs)
      return { profiles: listHubViews(store, arg.adapterId, kimiSealer), activeId: store.activeByAdapter[arg.adapterId] ?? null }
    })
  )

  /** 从当前配置导入：key 全值只在内存一瞬间，立即 seal；结构不明拒绝导入并给原因 */
  ipcMain.handle('apihub:import', (_e, arg: { adapterId: ApiHubAdapterId }) =>
    envelopeAsync(async (): Promise<ApiHubImportResult> => {
      const r = await apihubImportCurrent(arg.adapterId, apihubDeps())
      if (!r.imported || !r.profile) return { imported: false, profile: null, reason: r.reason }
      return { imported: true, profile: hubProfileView(r.profile, kimiSealer) }
    })
  )

  /** 一键切换：zcode 运行中返回 blocked 由 UI 确认后带 confirmed 重发；备份→原子写→校验→失败回滚 */
  ipcMain.handle('apihub:switch', (_e, arg: { adapterId: ApiHubAdapterId; id: string; confirmed?: boolean }) =>
    envelopeAsync(async () => {
      return apihubSwitch(arg.adapterId, String(arg?.id ?? ''), apihubDeps(), { confirmed: arg?.confirmed === true })
    })
  )

  // ---------- Docker 页（Portainer 风格容器/镜像管理；引擎未运行是常态，全部优雅降级） ----------

  ipcMain.handle('docker:info', () => envelopeAsync(() => dockerInfo()))

  ipcMain.handle('docker:containers', () => envelopeAsync(() => dockerContainers()))

  ipcMain.handle('docker:images', () => envelopeAsync(() => dockerImages()))

  ipcMain.handle('docker:stats', () => envelopeAsync(() => dockerStats()))

  ipcMain.handle('docker:logs', (_e, arg: { name: string }) =>
    envelopeAsync(() => dockerLogs(String(arg?.name ?? '')))
  )

  /** 容器动作（start/stop/restart/remove）：确认框由 UI 层负责，主进程只收白名单动作名 + 容器名 */
  ipcMain.handle('docker:action', (_e, arg: { name: string; action: DockerActionName }) =>
    envelopeAsync(async () => {
      const r = await containerAction(String(arg?.name ?? ''), arg?.action)
      if (!r.ok) throw new Error(r.detail || 'docker 动作失败')
      return r
    })
  )

  ipcMain.handle('docker:imageRemove', (_e, arg: { id: string }) =>
    envelopeAsync(async () => {
      const r = await imageRemove(String(arg?.id ?? ''))
      if (!r.ok) throw new Error(r.detail || '镜像删除失败')
      return r
    })
  )

  /** 拉起 Docker Desktop 引擎（detached，不轮询；就绪需 10-30 秒，刷新由用户点） */
  ipcMain.handle('docker:startEngine', () => envelopeAsync(() => startEngine()))

  // ---------- WSL 页（任务管理器风格资源监控；危险动作确认在 UI 层，主进程只校验参数） ----------

  /** 一次返回：发行版清单（运行中非 docker 系附带 stats）+ 宿主 vmmem 内存 */
  ipcMain.handle('wsl:distros', () => envelopeAsync((): Promise<WslOverview> => wslOverview()))

  ipcMain.handle('wsl:host', () => envelopeAsync(() => hostVm()))

  ipcMain.handle('wsl:action', (_e, arg: { action: WslActionName; name?: string }) =>
    envelopeAsync(() => wslAction(arg?.action, arg?.name))
  )

  ipcMain.handle('app:info', () =>
    envelope(() => ({
      name: 'SkillVault',
      versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
      userData: app.getPath('userData')
    }))
  )
}
