// agent 自动发现的主进程编排：Windows 侧真实 fs + WSL 侧 companion `scan --agents`，结果合并进 registry.json。
// 铁律：绝不硬编码用户名 —— Windows 侧一律 os.homedir()，WSL 侧由 companion 在 WSL 内扫自己的 $HOME；
// 禁止从 Windows 侧跨 9P 批量 IO WSL 家目录（慢，且易触发权限/编码问题）。
// 全流程依赖可注入（fs 原语 / homedir / companion runner），vitest 无头可测。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  discoverFromHome,
  genericSweep,
  type AgentDiscoverReport,
  type DiscoverDeps,
  type DiscoveredAgent
} from '../shared/agentSignatures'
import { defaultRegistry, mergeDiscovered, parseRegistry, REGISTRY_VERSION } from '../shared/registry'
import type { Registry } from '../shared/types'
import type { AppSettings } from './settings'
import { runCompanion, type Spawner, type WslResult } from './wslBridge'

/** WSL 侧发现超时：与 scan:wsl 同级（companion 冷启动可达数秒～数十秒，全程异步不冻结事件循环） */
export const DISCOVER_WSL_TIMEOUT_MS = 20000

/** 真实 fs 原语：list 只回子目录名（genericSweep 需跳过非目录项；skill 目录常为 symlink，故符号链接一并计入） */
export function realDiscoverDeps(): DiscoverDeps {
  return {
    exists: (p) => fs.existsSync(p),
    list: (dir) => {
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() || e.isSymbolicLink())
          .map((e) => e.name)
          .sort()
      } catch {
        return []
      }
    }
  }
}

export type WindowsDiscoverDeps = {
  /** 主目录覆写（缺省 os.homedir()；测试注入内存目录树） */
  homeDir?: string
  /** fs 原语覆写（缺省真实 fs） */
  sigDeps?: DiscoverDeps
}

/** Windows 侧发现：签名表 + genericSweep 兜底 */
export function discoverWindowsAgents(deps: WindowsDiscoverDeps = {}): DiscoveredAgent[] {
  const home = deps.homeDir ?? os.homedir()
  const io = deps.sigDeps ?? realDiscoverDeps()
  return [...discoverFromHome(home, io), ...genericSweep(home, io)].map((c) => ({ ...c, platform: 'windows' as const }))
}

export type WslDiscoverDeps = {
  /** WSL 发行版名（来自 settings.wslDistro）；绝不在此硬编码默认值，避免与用户设置分叉 */
  distro: string
  spawner?: Spawner
  timeoutMs?: number
  /** companion 调用覆写（测试注入 fake；缺省真实 runCompanion） */
  runner?: typeof runCompanion
}

/**
 * WSL 侧发现：companion `scan --agents` 在 WSL 内枚举自己的 $HOME。
 * 失败（不可达 / 超时 / 输出不合法 / 抛异常）一律返回 null，绝不抛——UI 显示原因，Windows 侧结果照常合并。
 */
export async function discoverWslAgents(deps: WslDiscoverDeps): Promise<DiscoveredAgent[] | null> {
  try {
    const run = deps.runner ?? runCompanion
    const r: WslResult = await run(deps.distro, ['scan', '--agents'], deps.timeoutMs ?? DISCOVER_WSL_TIMEOUT_MS, deps.spawner)
    const p = r.parsed as { ok?: boolean; agents?: unknown } | undefined
    if (!r.ok || !p || p.ok !== true || !Array.isArray(p.agents)) return null
    const out: DiscoveredAgent[] = []
    for (const raw of p.agents) {
      if (typeof raw !== 'object' || raw === null) continue
      const a = raw as Record<string, unknown>
      if (typeof a.sigId !== 'string' || !a.sigId.trim()) continue
      if (typeof a.skillsDir !== 'string' || !a.skillsDir.trim()) continue
      out.push({
        sigId: a.sigId,
        label: typeof a.label === 'string' && a.label.trim() ? a.label : a.sigId,
        skillsDir: a.skillsDir,
        ...(typeof a.agentsDir === 'string' && a.agentsDir.trim() ? { agentsDir: a.agentsDir } : {}),
        ...(a.generic === true ? { generic: true } : {}),
        platform: 'linux'
      })
    }
    return out
  } catch {
    return null
  }
}

/** registry.json 路径：与 ipc.ts 的 readRegistry / registry:save 同源（vaultPath/registry.json） */
export function registryFilePath(vaultPath: string): string {
  return path.join(vaultPath, 'registry.json')
}

type RegistryFileRead = { registry: Registry; exists: boolean; corrupt?: string }

/** 读 registry.json：不存在 / 损坏都返回空注册表 + 标记，由调用方决定是否继续（损坏时一律拒绝覆盖） */
function readRegistryFile(file: string): RegistryFileRead {
  if (!fs.existsSync(file)) return { registry: { version: REGISTRY_VERSION, agents: [] }, exists: false }
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { registry: { version: REGISTRY_VERSION, agents: [] }, exists: true, corrupt: `registry.json 读取失败: ${String(e)}` }
  }
  const r = parseRegistry(text)
  if (r.ok) return { registry: r.registry, exists: true }
  return { registry: { version: REGISTRY_VERSION, agents: [] }, exists: true, corrupt: r.error }
}

/** 原子写（临时文件 + rename）：发现结果写一半崩溃不会留下截断 JSON 让下次启动解析失败 */
export function writeRegistryFile(file: string, registry: Registry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

export type RefreshDeps = {
  /** Windows 侧发现覆写（缺省真实 fs 发现） */
  discoverWin?: () => DiscoveredAgent[]
  /** WSL 侧发现覆写（缺省 companion scan --agents；返回 null = 本轮不可用） */
  discoverWsl?: () => Promise<DiscoveredAgent[] | null>
  /** registry.json 覆写（缺省 settings.vaultPath/registry.json） */
  registryFile?: string
  homeDir?: string
  sigDeps?: DiscoverDeps
  spawner?: Spawner
  timeoutMs?: number
}

/**
 * 双侧发现 → 合并 → 写回 registry.json，返回合并报告。
 * 不做任何 git 操作（registry.json 的提交交给 sync:run / registry:save 的既有流程，避免并发 index.lock）。
 * registry.json 损坏时抛错拒绝覆盖（与 registry:save 同一条铁律：覆盖会静默清空用户全部 agent 定义）。
 */
export async function refreshRegistry(settings: AppSettings, deps: RefreshDeps = {}): Promise<AgentDiscoverReport> {
  const file = deps.registryFile ?? registryFilePath(settings.vaultPath)
  const cur = readRegistryFile(file)
  if (cur.corrupt) {
    throw new Error(`registry.json 已损坏（${cur.corrupt}），拒绝覆盖保存。请先人工修复或删除该文件：${file}`)
  }
  const win = deps.discoverWin
    ? deps.discoverWin()
    : discoverWindowsAgents({ homeDir: deps.homeDir, sigDeps: deps.sigDeps })
  // vault 尚未初始化（无 registry.json）时以默认注册表为基底：发现结果与内置 4 条并存，而不是只写发现项
  const base: Registry = cur.exists ? cur.registry : defaultRegistry()

  const mWin = mergeDiscovered(base, win, 'windows')

  let wsl: DiscoveredAgent[] | null = null
  let wslReason: string | undefined
  try {
    wsl = deps.discoverWsl
      ? await deps.discoverWsl()
      : await discoverWslAgents({ distro: settings.wslDistro, spawner: deps.spawner, timeoutMs: deps.timeoutMs })
  } catch (e) {
    wsl = null
    wslReason = e instanceof Error ? e.message : String(e)
  }
  // WSL 侧本轮取不到时整段跳过 linux 合并：companion 掉线 ≠ WSL 上的 agent 消失，绝不能标 missing
  const mWsl = wsl ? mergeDiscovered(mWin.registry, wsl, 'linux') : { registry: mWin.registry, added: [], reactivated: [], missing: [] }
  if (wsl === null && !wslReason) wslReason = 'WSL companion 不可达或未返回发现结果'

  const registry = mWsl.registry
  writeRegistryFile(file, registry)

  return {
    added: [...mWin.added, ...mWsl.added],
    reactivated: [...mWin.reactivated, ...mWsl.reactivated],
    missing: [...mWin.missing, ...mWsl.missing],
    windowsFound: win.length,
    wslFound: wsl?.length ?? 0,
    wslStale: wsl === null,
    ...(wslReason !== undefined ? { wslReason } : {}),
    registry
  }
}

export type SetEnabledDeps = { registryFile?: string }

/**
 * 启用/停用条目并写盘：只改 enabled 一个字段（绝不顺手改 status —— 重新启用后由下一轮扫描决定 active/missing）。
 * 条目不存在时抛错（不静默新建：停用一个不存在的 agent 说明调用方状态已陈旧）。
 */
export function setAgentEnabled(
  settings: AppSettings,
  name: string,
  enabled: boolean,
  deps: SetEnabledDeps = {}
): Registry {
  if (typeof name !== 'string' || !name.trim()) throw new Error('agent 名必须是非空字符串')
  const file = deps.registryFile ?? registryFilePath(settings.vaultPath)
  const cur = readRegistryFile(file)
  if (cur.corrupt) {
    throw new Error(`registry.json 已损坏（${cur.corrupt}），拒绝覆盖保存。请先人工修复或删除该文件：${file}`)
  }
  const registry = cur.exists ? cur.registry : defaultRegistry()
  const agent = registry.agents.find((a) => a.name === name)
  if (!agent) throw new Error(`registry 中找不到 agent: ${name}`)
  agent.enabled = enabled === true
  writeRegistryFile(file, registry)
  return registry
}
