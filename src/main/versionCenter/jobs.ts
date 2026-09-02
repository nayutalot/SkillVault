// 检查与更新编排（版本中心核心）：
// - checkAll：并行检查全部条目，每条独立超时、独立失败互不影响；结果缓存 userData/version-cache.json
//   （与 wsl-scan-cache.json 同模式：临时文件 + rename 原子替换；实时检查全部失败时回落缓存 stale=true）。
// - updateOne：仅用户点击触发。winget 条目先 tasklist 预检目标进程（zcode/claude-desktop/codex），运行中 →
//   返回 { blocked, running } 交 UI 弹确认框；github 条目（DeepSeek Harness）首次点击一律先确认（源码重建耗时数分钟）；
//   确认后以 job 形式执行（增量日志入内存注册表、可取消、detached 可终止），完成后自动重查该条目并回填缓存。
// - 绝不自动启动更新、绝不在应用启动时跑 update。
import fs from 'node:fs'
import path from 'node:path'
import type {
  CheckAllResult,
  UpdateStartResult,
  VersionCachePayload,
  VersionJobSnapshot,
  VersionStatus
} from '../../shared/types'
import type { Spawner } from '../wslBridge'
import { VERSION_CATALOG, findCatalogEntry, type CatalogEntry } from './catalog'
import {
  defaultSpawner,
  execAsync,
  execCmdLine,
  type ExecHandle,
  type ExecOptions
} from './exec'
import { wingetCheckInstalled, wingetListUpgrades, wingetUpgradeArgs, type WingetUpgradeMap } from './winget'
import { npmInstalled, npmLatest } from './npm'
import { nativeInstalledVersion, nativeUpdateHandle, resolveNativeBin } from './native'
import { arpInstalledVersion } from './arp'
import {
  compareSemver
} from './versionCompare'
import {
  DEEPSEEK_ARP_DISPLAY_NAME,
  DEEPSEEK_DEFAULT_ROOT,
  fetchLatestRelease,
  githubUpdateHandle,
  readLocalPackageVersion
} from './github'

/** 更新命令统一超时：20 分钟 */
export const UPDATE_TIMEOUT_MS = 20 * 60_000

export type VCDeps = {
  /** 可注入 spawner（单测用 fake；默认真实 spawn） */
  spawner?: Spawner
  now?: () => number
  /** 缓存文件路径；null/undefined 禁用缓存读写 */
  cacheFile?: string | null
  /** DeepSeek Harness 本体安装目录（github 通道；缺省用 DEEPSEEK_DEFAULT_ROOT） */
  deepseekRoot?: string
  /**
   * 本轮只检查这些条目 id（版本中心可见性过滤：没检测到对应工具的条目默认不查，省时间也少弹失败）。
   * 缺省/undefined/null = 全部条目（单测与"显示全部"用）。
   */
  visibleIds?: string[] | null
}

// ---------- 缓存（userData/version-cache.json，{ ts, statuses }） ----------

export function readVersionCache(file: string): VersionCachePayload | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VersionCachePayload>
    if (typeof raw.ts !== 'number' || !Array.isArray(raw.statuses)) return null
    return { ts: raw.ts, statuses: raw.statuses as VersionStatus[] }
  } catch {
    return null
  }
}

export function writeVersionCache(file: string, payload: VersionCachePayload): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    /* 缓存写入失败可忽略（加速手段，不致命） */
  }
}

/** 更新完成后把单条新状态合并回缓存（该条重查成功才调用） */
function mergeStatusIntoCache(file: string | null | undefined, status: VersionStatus, ts: number): void {
  if (!file) return
  const cached = readVersionCache(file)
  const statuses = cached ? cached.statuses.filter((s) => s.id !== status.id) : []
  statuses.push(status)
  writeVersionCache(file, { ts, statuses })
}

// ---------- 单条检查 ----------

/** 检查上下文：winget upgrade 全表在一轮检查内只跑一次（memoized Promise） */
type CheckCtx = VCDeps & { spawner: Spawner; upgrades: () => Promise<WingetUpgradeMap | 'failed'> }

function makeCtx(deps: VCDeps): CheckCtx {
  const spawner = deps.spawner ?? defaultSpawner
  let upgradesPromise: Promise<WingetUpgradeMap | 'failed'> | null = null
  return {
    ...deps,
    spawner,
    upgrades: () => {
      if (!upgradesPromise) {
        upgradesPromise = wingetListUpgrades({ spawner }).then((r) => ('map' in r ? r.map : 'failed'))
      }
      return upgradesPromise
    }
  }
}

async function checkOne(e: CatalogEntry, ctx: CheckCtx): Promise<VersionStatus> {
  const base = { id: e.id, name: e.name, channel: e.channel, channelKind: e.kind, hint: e.uiNote }
  switch (e.kind) {
    case 'arp': {
      const r = await arpInstalledVersion(e.arp.displayName, { spawner: ctx.spawner })
      if (r.error) return { ...base, state: 'check-failed', note: r.error }
      return {
        ...base,
        installed: r.version,
        state: 'detect-only',
        note: r.version ? '无自动升级通道，请手动更新' : '注册表未找到 DisplayVersion；无自动升级通道，请手动更新'
      }
    }
    case 'native': {
      const r = await nativeInstalledVersion(e.native.binPath, { spawner: ctx.spawner })
      if (r.error) return { ...base, state: 'check-failed', note: r.error }
      return { ...base, installed: r.version, state: 'unknown', note: '最新版本由其自带更新器探测，可点击更新' }
    }
    case 'github': {
      // DeepSeek Harness：本地 = <installRoot>/package.json 的 version；最新 = GitHub Releases（含 prerelease，compareSemver 选最高）
      const root = ctx.deepseekRoot ?? DEEPSEEK_DEFAULT_ROOT
      const local = readLocalPackageVersion(root)
      const latest = await fetchLatestRelease({ spawner: ctx.spawner })
      if ('missing' in local) {
        // 安装目录缺失：installed 回退展示 ARP 注册表版本（仅展示，绝不据此判定 upgradable）
        const arp = await arpInstalledVersion(DEEPSEEK_ARP_DISPLAY_NAME, { spawner: ctx.spawner })
        const fallback = arp.version
        if (!latest.ok) {
          return {
            ...base,
            installed: fallback,
            state: 'check-failed',
            note: latest.error + '；本地目录也未找到（' + root + '）'
          }
        }
        return {
          ...base,
          installed: fallback,
          latest: latest.version,
          state: 'unknown',
          note:
            '未找到本地安装（可在设置中指定目录）' +
            (fallback ? '；注册表 ARP 显示版本 ' + fallback + '（仅回退展示）' : '')
        }
      }
      if ('error' in local) return { ...base, state: 'check-failed', note: local.error }
      if (!latest.ok) return { ...base, installed: local.version, state: 'unknown', note: latest.error }
      const c = compareSemver(local.version, latest.version)
      if (c == null) {
        return { ...base, installed: local.version, latest: latest.version, state: 'unknown', note: '版本号不可比较' }
      }
      return {
        ...base,
        installed: local.version,
        latest: latest.version,
        state: c < 0 ? 'upgradable' : 'up-to-date',
        note: c < 0 ? '最新 ' + latest.tag + '（' + latest.publishedAt.slice(0, 10) + '）' : undefined
      }
    }
    case 'npm': {
      const inst = await npmInstalled({ spawner: ctx.spawner })
      if ('error' in inst) return { ...base, state: 'check-failed', note: inst.error }
      const installed = inst.map.get(e.npm.pkg)
      const latest = await npmLatest(e.npm.pkg, { spawner: ctx.spawner })
      if ('error' in latest) {
        return installed
          ? { ...base, installed, state: 'unknown', note: latest.error }
          : { ...base, state: 'check-failed', note: latest.error }
      }
      if (!installed) {
        return { ...base, latest: latest.version, state: 'unknown', note: 'npm -g 未安装该包（可能经其他通道安装）' }
      }
      const c = compareSemver(installed, latest.version ?? '')
      if (c == null) return { ...base, installed, latest: latest.version, state: 'unknown', note: '版本号不可比较' }
      return { ...base, installed, latest: latest.version, state: c < 0 ? 'upgradable' : 'up-to-date' }
    }
    case 'winget': {
      const [inst, upgrades] = await Promise.all([
        wingetCheckInstalled(e.winget.packageId, { spawner: ctx.spawner, exact: e.listExact !== false }),
        ctx.upgrades()
      ])
      if (inst.error && !inst.version) return { ...base, state: 'check-failed', note: inst.error }
      const up = upgrades === 'failed' ? undefined : upgrades.get(e.winget.packageId.toLowerCase())
      if (up) {
        return {
          ...base,
          installed: up.installed || inst.version,
          latest: up.available,
          state: 'upgradable',
          note: e.storeFallback ? '商店系应用：若 winget 更新失败，请通过 Microsoft Store 手动更新' : undefined
        }
      }
      if (!inst.version) {
        return upgrades === 'failed'
          ? { ...base, state: 'check-failed', note: inst.error ?? 'winget 未检测到已装记录，且升级清单获取失败' }
          : { ...base, state: 'unknown', note: 'winget 清单中无此应用的已装与升级记录（未安装或商店清单延迟）' }
      }
      return upgrades === 'failed'
        ? {
            ...base,
            installed: inst.version,
            state: 'unknown',
            note: '已检测到安装，但 winget upgrade 清单获取失败，无法判断是否可升级'
          }
        : { ...base, installed: inst.version, state: 'up-to-date' }
    }
  }
}

/** 单条检查兜底：任何异常 → check-failed（不影响他条） */
async function checkOneSafe(e: CatalogEntry, ctx: CheckCtx): Promise<VersionStatus> {
  try {
    return await checkOne(e, ctx)
  } catch (err) {
    return {
      id: e.id,
      name: e.name,
      channel: e.channel,
      channelKind: e.kind,
      hint: e.uiNote,
      state: 'check-failed',
      note: String(err instanceof Error ? err.message : err).slice(0, 300)
    }
  }
}

// ---------- checkAll / checkSingle ----------

/** 全量检查：并行、独立失败；全部失败回落缓存（stale），否则写缓存返回。
 *  可见性过滤由调用方（IPC 层按注册表 + pin 规则算出 visibleIds）注入；visibleIds 为空数组时不做任何检查，
 *  也绝不触发"全部失败回落缓存"（0 条可见 ≠ 检查全挂，否则会拿旧缓存冒充本次结果）。 */
export async function runVersionCheckAll(deps: VCDeps = {}): Promise<CheckAllResult> {
  const ctx = makeCtx(deps)
  const now = deps.now ?? Date.now
  const entries = deps.visibleIds ? VERSION_CATALOG.filter((e) => deps.visibleIds!.includes(e.id)) : VERSION_CATALOG
  const statuses = await Promise.all(entries.map((e) => checkOneSafe(e, ctx)))
  const failedCount = statuses.filter((s) => s.state === 'check-failed').length
  if (statuses.length > 0 && failedCount === statuses.length) {
    const cached = deps.cacheFile ? readVersionCache(deps.cacheFile) : null
    if (cached) return { ...cached, stale: true, reason: '实时检查全部失败，已回落上次缓存' }
  } else if (deps.cacheFile && statuses.length > 0) {
    writeVersionCache(deps.cacheFile, { ts: now(), statuses })
  }
  return { ts: now(), statuses, stale: false }
}

/** 单条检查（IPC versions:checkAll { id }）；成功时回填缓存 */
export async function runVersionCheckSingle(id: string, deps: VCDeps = {}): Promise<CheckAllResult> {
  const e = findCatalogEntry(id)
  if (!e) throw new Error(`版本目录中不存在该条目: ${String(id)}`)
  const ctx = makeCtx(deps)
  const now = deps.now ?? Date.now
  const status = await checkOneSafe(e, ctx)
  if (status.state !== 'check-failed' && deps.cacheFile) mergeStatusIntoCache(deps.cacheFile, status, now())
  return { ts: now(), statuses: [status], stale: false }
}

// ---------- 更新 job（仅用户点击触发；内存注册表，IPC 轮询） ----------

type UpdateJob = {
  jobId: string
  entryId: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  log: string[]
  error?: string
  after?: VersionStatus
  cancel: () => void
  startedAt: number
  finishedAt?: number
}

const jobs = new Map<string, UpdateJob>()
let jobSeq = 0
/** 已结束 job 的保留上限（防内存日志无限增长） */
const JOB_KEEP = 30

function pruneJobs(): void {
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
  while (finished.length > JOB_KEEP) {
    const oldest = finished.shift()
    if (oldest) jobs.delete(oldest.jobId)
  }
}

function snapshot(j: UpdateJob): VersionJobSnapshot {
  return { jobId: j.jobId, entryId: j.entryId, status: j.status, log: j.log.slice(-400), error: j.error, after: j.after }
}

/** IPC versions:jobStatus：不存在/已被清理 → 抛错（envelope 转 { ok:false }） */
export function jobSnapshot(jobId: string): VersionJobSnapshot {
  const j = jobs.get(jobId)
  if (!j) throw new Error(`更新任务不存在或已被清理: ${String(jobId)}`)
  return snapshot(j)
}

/** IPC versions:cancel：终止进程树并把 job 置为 cancelled（迟到的 close 不会覆盖状态） */
export function cancelJob(jobId: string): boolean {
  const j = jobs.get(jobId)
  if (!j) throw new Error(`更新任务不存在或已被清理: ${String(jobId)}`)
  if (j.status !== 'running') return false
  j.status = 'cancelled'
  j.cancel()
  return true
}

/** 按条目通道构造更新命令（winget 直启 exe；npm/.cmd shim 经 cmd.exe；github 多步流水线；一律 detached 可终止） */
function startUpdateHandle(
  e: CatalogEntry,
  opts: ExecOptions,
  deps: VCDeps = {}
): { handle: ExecHandle; commandText: string } {
  switch (e.kind) {
    case 'winget': {
      const args = wingetUpgradeArgs(e.winget.packageId)
      return { handle: execAsync('winget', args, opts), commandText: `winget ${args.join(' ')}` }
    }
    case 'npm': {
      const commandText = `npm i -g ${e.npm.pkg}@latest`
      return { handle: execCmdLine(commandText, opts), commandText }
    }
    case 'native': {
      const bin = resolveNativeBin(e.native.binPath)
      if (!bin) throw new Error(`未找到自带更新器可执行文件: ${e.native.binPath}`)
      return nativeUpdateHandle(bin, opts)
    }
    case 'github': {
      const root = deps.deepseekRoot ?? DEEPSEEK_DEFAULT_ROOT
      // now 兼作流水线时间戳时钟（<root>.bak-<ts> / .update-<ts> 后缀，测试注入保证确定性）
      return githubUpdateHandle(root, opts, { spawner: deps.spawner, nowMs: deps.now })
    }
    case 'arp':
      throw new Error('该条目无更新通道（仅检测）')
  }
}

/**
 * 启动更新 job。同一条目并发更新直接抛错（envelope → { ok:false }）。
 * job 完成后自动重查该条目（独立一轮检查，含 winget 升级清单刷新）并回填缓存。
 */
export function startUpdateJob(e: CatalogEntry, deps: VCDeps = {}): VersionJobSnapshot {
  for (const j of jobs.values()) {
    if (j.entryId === e.id && j.status === 'running') throw new Error('该条目已在更新中，请等待完成或先取消')
  }
  const now = deps.now ?? Date.now
  const jobId = `vc-${Date.now()}-${++jobSeq}`
  const job: UpdateJob = { jobId, entryId: e.id, status: 'running', log: [], startedAt: now(), cancel: () => {} }
  jobs.set(jobId, job)
  pruneJobs()
  try {
    const { handle, commandText } = startUpdateHandle(
      e,
      {
        timeoutMs: UPDATE_TIMEOUT_MS,
        spawner: deps.spawner,
        detached: true,
        onLine: (line) => job.log.push(line)
      },
      deps
    )
    job.log.push(`$ ${commandText}`)
    job.cancel = () => handle.cancel()
    void handle.done
      .then(async (r) => {
        job.finishedAt = now()
        if (job.status === 'cancelled') {
          job.log.push('✗ 已被用户取消')
          return
        }
        if (!r.ok) {
          job.status = 'failed'
          job.error = (r.stderr || r.stdout || '无输出').trim().slice(-1500)
          job.log.push(`✗ 更新命令失败（退出码 ${r.status}）`)
          if (e.kind === 'winget' && e.storeFallback) {
            job.log.push('ⓘ 商店系应用：可打开 Microsoft Store 手动更新')
          }
          return
        }
        job.log.push('✓ 更新命令执行成功，正在重新检查版本…')
        job.after = await checkOneSafe(e, makeCtx(deps))
        // 重查的 await 窗口内用户可能已取消 —— cancelled 状态绝不能被 done 覆盖（与 cancelJob 注释的承诺一致）
        // （宽化读取绕过 TS 对 await 前状态的窄化：await 点之后 status 已可能被 cancelJob 改写）
        if ((job as { status: string }).status === 'cancelled') {
          job.log.push('✗ 已被用户取消')
          return
        }
        mergeStatusIntoCache(deps.cacheFile, job.after, now())
        job.log.push(`✓ 更新完成：当前 ${job.after.installed ?? '?'}${job.after.latest ? `（最新 ${job.after.latest}）` : ''}`)
        job.status = 'done'
      })
      .catch((err: unknown) => {
        if (job.status !== 'cancelled') job.status = 'failed'
        job.error = String(err instanceof Error ? err.message : err)
        job.finishedAt ??= now()
      })
  } catch (err) {
    job.status = 'failed'
    job.error = String(err instanceof Error ? err.message : err)
    job.finishedAt = now()
  }
  return snapshot(job)
}

// ---------- 更新预检（tasklist 检测目标进程是否在运行） ----------

/** 逐个进程名探测：tasklist /FI "IMAGENAME eq <name>" /FO CSV /NH；命中返回该进程名 */
export async function findRunningProcess(names: readonly string[], deps: VCDeps = {}): Promise<string | null> {
  const spawner = deps.spawner ?? defaultSpawner
  for (const n of names) {
    const r = await execAsync('tasklist', ['/FI', `IMAGENAME eq ${n}`, '/FO', 'CSV', '/NH'], {
      timeoutMs: 15_000,
      spawner
    }).done
    if (r.stdout.toLowerCase().includes(n.toLowerCase())) return n
  }
  return null
}

/**
 * updateOne 入口（IPC versions:updateOne）：
 * 未确认时对带 processNames 的 winget 条目做运行中预检 → 运行中返回 { blocked, running, processName }
 * 交 UI 弹确认框；确认（confirmed=true）或不需预检 → 直接启动 job 返回 jobId。
 */
export async function requestUpdateOne(id: string, confirmed: boolean, deps: VCDeps = {}): Promise<UpdateStartResult> {
  const e = findCatalogEntry(id)
  if (!e) throw new Error(`版本目录中不存在该条目: ${String(id)}`)
  if (e.kind === 'arp') throw new Error('该条目无自动升级通道，请手动更新')
  // github 通道（DeepSeek Harness）：首次点击一律先确认（源码重建耗时数分钟 + 旧目录换名备份），UI 弹确认框后带 confirmed 重发
  if (e.kind === 'github' && !confirmed) return { blocked: true, running: false }
  if (!confirmed && e.kind === 'winget' && e.processNames?.length) {
    const running = await findRunningProcess(e.processNames, deps)
    if (running) return { blocked: true, running: true, processName: running }
  }
  const job = startUpdateJob(e, deps)
  return { blocked: false, jobId: job.jobId }
}
