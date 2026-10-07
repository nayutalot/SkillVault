// 版本中心可见性 + 固定显示（pin）：
// - 默认只显示"这台机器上确实有这个工具"的条目（注册表里对应 sigId 的 agent active 且 enabled）；
// - 用户可对单条「固定显示」（pinned，即使没检测到也留着，比如装在 WSL / 换机前的习惯）；
// - 注册表读不到时显示全部（保守降级：宁可多显示，也不能让用户以为版本中心坏了）；
// - pin 与"显示全部"存在 userData/version-center-prefs.json（与版本缓存同目录，注入式路径便于单测）。
// 全部为纯逻辑 + 注入 fs，主进程与 vitest 共用。
import fs from 'node:fs'
import path from 'node:path'
import { isAgentActive } from '../../shared/registry'
import type { RegistryAgent, VersionCatalogResult, VersionCatalogView } from '../../shared/types'
import { VERSION_CATALOG } from './catalog'
import { readRegistryAgents } from './registryRead'

export const VERSION_PREFS_VERSION = 1 as const

export type VersionPrefs = {
  version: typeof VERSION_PREFS_VERSION
  /** 固定显示的条目 id（即使没检测到也显示） */
  pinned: string[]
  /** 用户是否打开了「显示全部（含未检测到的）」 */
  showHidden: boolean
}

export function versionPrefsFile(userDataDir: string): string {
  return path.join(userDataDir, 'version-center-prefs.json')
}

export function emptyVersionPrefs(): VersionPrefs {
  return { version: VERSION_PREFS_VERSION, pinned: [], showHidden: false }
}

/** 读偏好：文件缺失/损坏一律回落默认值（pin 丢了顶多多显示几条，绝不让版本中心起不来） */
export function loadVersionPrefs(
  userDataDir: string,
  fsMod: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs
): VersionPrefs {
  try {
    const file = versionPrefsFile(userDataDir)
    if (!fsMod.existsSync(file)) return emptyVersionPrefs()
    const raw = JSON.parse(fsMod.readFileSync(file, 'utf8')) as Partial<VersionPrefs>
    const known = new Set(VERSION_CATALOG.map((e) => e.id))
    const pinned = Array.isArray(raw.pinned) ? raw.pinned.filter((id): id is string => typeof id === 'string' && known.has(id)) : []
    return { version: VERSION_PREFS_VERSION, pinned, showHidden: raw.showHidden === true }
  } catch {
    return emptyVersionPrefs()
  }
}

/** 原子写偏好（临时文件 + rename），失败不抛（pin 是体验项，写不进去不该中断用户操作） */
export function saveVersionPrefs(
  userDataDir: string,
  prefs: VersionPrefs,
  fsMod: Pick<typeof fs, 'mkdirSync' | 'writeFileSync' | 'renameSync'> = fs
): void {
  try {
    fsMod.mkdirSync(userDataDir, { recursive: true })
    const file = versionPrefsFile(userDataDir)
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
    fsMod.writeFileSync(tmp, JSON.stringify(prefs, null, 2) + '\n', 'utf8')
    fsMod.renameSync(tmp, file)
  } catch {
    /* 忽略：下次进页面还是上次的显示偏好，不影响检测与更新 */
  }
}

/** 固定/取消固定某条；id 不在版本目录里直接抛错（调用方状态陈旧，不静默写入垃圾 id） */
export function setVersionPinned(
  userDataDir: string,
  id: string,
  pinned: boolean,
  fsMod: typeof fs = fs
): VersionPrefs {
  if (!VERSION_CATALOG.some((e) => e.id === id)) throw new Error('版本目录中不存在该条目: ' + String(id))
  const prefs = loadVersionPrefs(userDataDir, fsMod)
  const set = new Set(prefs.pinned)
  if (pinned) set.add(id)
  else set.delete(id)
  const next: VersionPrefs = { ...prefs, pinned: [...set] }
  saveVersionPrefs(userDataDir, next, fsMod)
  return next
}

export function setVersionShowHidden(
  userDataDir: string,
  show: boolean,
  fsMod: typeof fs = fs
): VersionPrefs {
  const prefs = loadVersionPrefs(userDataDir, fsMod)
  const next: VersionPrefs = { ...prefs, showHidden: show === true }
  saveVersionPrefs(userDataDir, next, fsMod)
  return next
}

/**
 * 合成目录视图。
 * agents === null（注册表读不到）→ degraded：全部可见、detected 一律 false（我们并不知道），UI 顶部说明一句。
 */
export function buildVersionCatalog(opts: { agents: RegistryAgent[] | null; prefs: VersionPrefs }): VersionCatalogResult {
  const degraded = opts.agents === null
  const sigIds = new Set<string>()
  for (const a of opts.agents ?? []) {
    if (isAgentActive(a) && a.sigId) sigIds.add(a.sigId)
  }
  const pinnedSet = new Set(opts.prefs.pinned)
  const entries: VersionCatalogView[] = VERSION_CATALOG.map((e) => {
    const detected = !degraded && sigIds.has(e.sigId)
    const pinned = pinnedSet.has(e.id)
    return {
      id: e.id,
      name: e.name,
      channel: e.channel,
      channelKind: e.kind,
      sigId: e.sigId,
      ...(e.uiNote ? { hint: e.uiNote } : {}),
      detected,
      visible: degraded ? true : detected || pinned,
      pinned
    }
  })
  return {
    entries,
    hiddenCount: entries.filter((e) => !e.visible).length,
    degraded,
    showHidden: opts.prefs.showHidden
  }
}

/** 本轮该检查哪些条目：showHidden=true → null（全部）；否则只回可见条目 id */
export function visibleVersionIds(result: VersionCatalogResult): string[] | null {
  if (result.showHidden) return null
  return result.entries.filter((e) => e.visible).map((e) => e.id)
}

export type VersionCatalogDeps = { vaultPath: string; userDataDir: string; fsMod?: typeof fs }

/** 读盘 + 合成（IPC 与测试共用入口） */
export function versionCatalogFromDisk(deps: VersionCatalogDeps): VersionCatalogResult {
  const fsMod = deps.fsMod ?? fs
  const read = readRegistryAgents(deps.vaultPath, fsMod)
  const prefs = loadVersionPrefs(deps.userDataDir, fsMod)
  const result = buildVersionCatalog({ agents: read.agents, prefs })
  return read.agents === null ? { ...result, reason: read.reason } : result
}
