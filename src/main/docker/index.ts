// Docker 页后端：全部经 execAsync 异步调用 docker CLI（与版本中心同一防御模式）。
// - args 数组传参、绝不 shell、绝不 spawnSync；--format {{json .}} 模板作为单个 arg 直传（无需引号包装）；
// - `docker ps/images/stats --format {{json .}}` 输出为 JSON Lines（每行一个 JSON 对象）→ 手写按行 split 解析，零新依赖；
// - 引擎未运行是常态（dockerDesktopLinuxEngine pipe 不存在）→ state:'engine-down' 优雅降级，绝不报错刷屏；
// - startEngine：fs 检查 Docker Desktop.exe 存在后 detached 拉起（stdio ignore + unref），不自动轮询引擎，刷新由用户点。
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type {
  DockerActionName,
  DockerContainer,
  DockerContainersResult,
  DockerImage,
  DockerImagesResult,
  DockerInfo,
  DockerLogsResult
} from '../../shared/types'
import { execAsync, type Spawner } from '../versionCenter/exec'

/** 查询类命令统一超时（stats --no-stream 冷启动可能数秒） */
export const DOCKER_TIMEOUT_MS = 60_000
/** logs 读取超时（tail 200 文本，应秒回） */
export const DOCKER_LOGS_TIMEOUT_MS = 30_000

/** Docker Desktop 引擎启动器（需运行时 fs 存在性检查；缺失则如实报错） */
export const DOCKER_DESKTOP_EXE = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'

export type DockerDeps = {
  /** 可注入 spawner（单测用 fake；默认真实 spawn） */
  spawner?: Spawner
  /** 可注入 fs（单测断言存在性检查用） */
  fsMod?: Pick<typeof fs, 'existsSync'>
  /** 可注入 Docker Desktop 路径 */
  desktopExe?: string
  /** startEngine 的启动确认窗口（默认 1500ms；单测注入缩短等待） */
  confirmDelayMs?: number
}

/** 引擎下线判定特征（真机实测 stderr）：npipe dockerDesktopLinuxEngine 不存在 / 系统找不到指定的文件 */
export function isEngineDown(stderr: string): boolean {
  return /dockerDesktopLinuxEngine|cannot find the file specified/i.test(String(stderr ?? ''))
}

/** 引擎错误摘要：取 stderr 第一个非空行截断（供横幅展示，不整段刷屏） */
export function summarizeEngineError(stderr: string): string {
  const first = String(stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return (first ?? '无法连接 Docker 引擎').slice(0, 220)
}

/** JSON Lines 解析：按行 split，跳过空行与解析失败行（docker 偶发告警文本混入不致命） */
export function parseJsonLines<T>(out: string): T[] {
  const rows: T[] = []
  for (const raw of String(out ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    try {
      rows.push(JSON.parse(line) as T)
    } catch {
      /* 畸形行跳过 */
    }
  }
  return rows
}

type DockerVersionJson = { Client?: { Version?: string }; Server?: { Version?: string | null } }

/** dockerInfo：ok=引擎在线（返回 Client/Server 版本）；失败按 stderr 特征归类 engine-down / error */
export async function dockerInfo(deps: DockerDeps = {}): Promise<DockerInfo> {
  const r = await execAsync('docker', ['version', '--format', '{{json .}}'], {
    timeoutMs: DOCKER_TIMEOUT_MS,
    spawner: deps.spawner
  }).done
  if (r.ok) {
    let parsed: DockerVersionJson | null = null
    try {
      parsed = JSON.parse(r.stdout.trim()) as DockerVersionJson
    } catch {
      /* 版本 JSON 解析失败仍算在线，只是拿不到版本号 */
    }
    return {
      state: 'online',
      clientVersion: parsed?.Client?.Version,
      serverVersion: parsed?.Server?.Version ?? undefined
    }
  }
  if (isEngineDown(r.stderr)) {
    return { state: 'engine-down', error: summarizeEngineError(r.stderr) }
  }
  return { state: 'error', error: summarizeEngineError(r.stderr || r.stdout || 'docker version 失败') }
}

type PsRow = { ID?: string; Names?: string; Image?: string; State?: string; Status?: string; CreatedAt?: string; Ports?: string }
type ImageRow = { Repository?: string; Tag?: string; ID?: string; Size?: string; CreatedAt?: string; CreatedSince?: string }
type StatsRow = { Name?: string; CPUPerc?: string; MemUsage?: string }

/** ps 单行 → 容器行（Names 可能逗号分隔多别名，展示取全部原样） */
function rowToContainer(j: PsRow): DockerContainer {
  return {
    id: String(j.ID ?? ''),
    name: String(j.Names ?? '').split(',')[0] ?? '',
    image: String(j.Image ?? ''),
    state: String(j.State ?? ''),
    status: String(j.Status ?? ''),
    created: String(j.CreatedAt ?? ''),
    ports: String(j.Ports ?? '')
  }
}

/** stats 按容器名归并（名字取 `Names` 首个，与 stats 的 `Name` 对齐） */
export function mergeStats(
  containers: DockerContainer[],
  stats: StatsRow[]
): DockerContainer[] {
  const byName = new Map<string, { cpuPerc: string; memUsage: string }>()
  for (const s of stats) {
    if (s.Name) byName.set(String(s.Name), { cpuPerc: String(s.CPUPerc ?? ''), memUsage: String(s.MemUsage ?? '') })
  }
  return containers.map((c) => {
    const hit = byName.get(c.name)
    return hit ? { ...c, cpuPerc: hit.cpuPerc, memUsage: hit.memUsage } : c
  })
}

/** docker ps -a --format {{json .}}：全量容器（含已停止） */
export async function dockerPs(deps: DockerDeps = {}): Promise<DockerContainer[]> {
  const r = await execAsync('docker', ['ps', '-a', '--format', '{{json .}}'], {
    timeoutMs: DOCKER_TIMEOUT_MS,
    spawner: deps.spawner
  }).done
  if (!r.ok && !r.stdout.trim()) return []
  return parseJsonLines<PsRow>(r.stdout).map(rowToContainer)
}

/** docker stats --no-stream --format {{json .}}：一次性快照（按 Name 返回） */
export async function dockerStats(deps: DockerDeps = {}): Promise<StatsRow[]> {
  const r = await execAsync('docker', ['stats', '--no-stream', '--format', '{{json .}}'], {
    timeoutMs: DOCKER_TIMEOUT_MS,
    spawner: deps.spawner
  }).done
  if (!r.ok && !r.stdout.trim()) return []
  return parseJsonLines<StatsRow>(r.stdout)
}

/** 容器列表 + stats 合并（IPC docker:containers 直接用；ps 失败时返回 error 供 UI 透出） */
export async function dockerContainers(deps: DockerDeps = {}): Promise<DockerContainersResult> {
  const rows = await dockerPs(deps)
  if (!rows.length) {
    // ps 空输出：区分「引擎没起来」（调用方由 dockerInfo 判定，不重复报错）与真空列表
    return { containers: [] }
  }
  const stats = await dockerStats(deps)
  return { containers: mergeStats(rows, stats) }
}

/** docker images --format {{json .}}：镜像列表（created 优先 CreatedSince 人类可读，CreatedAt 兜底） */
export async function dockerImages(deps: DockerDeps = {}): Promise<DockerImagesResult> {
  const r = await execAsync('docker', ['images', '--format', '{{json .}}'], {
    timeoutMs: DOCKER_TIMEOUT_MS,
    spawner: deps.spawner
  }).done
  if (!r.ok && !r.stdout.trim()) return { images: [] }
  const images = parseJsonLines<ImageRow>(r.stdout).map((j) => ({
    repository: String(j.Repository ?? ''),
    tag: String(j.Tag ?? ''),
    id: String(j.ID ?? ''),
    size: String(j.Size ?? ''),
    created: String(j.CreatedSince || j.CreatedAt || '')
  }))
  return { images }
}

/** 容器动作参数构造（纯函数，单测断言 argv；remove 用 rm -f 强制移除） */
export function containerActionArgs(name: string, action: DockerActionName): string[] {
  switch (action) {
    case 'start':
      return ['start', name]
    case 'stop':
      return ['stop', name]
    case 'restart':
      return ['restart', name]
    case 'remove':
      return ['rm', '-f', name]
  }
}

const CONTAINER_ACTIONS: readonly DockerActionName[] = ['start', 'stop', 'restart', 'remove']

/** 容器动作（start/stop/restart/remove）；动作名白名单由类型收口，绝不拼 shell */
export async function containerAction(
  name: string,
  action: DockerActionName,
  deps: DockerDeps = {}
): Promise<{ ok: boolean; detail: string }> {
  if (!CONTAINER_ACTIONS.includes(action)) throw new Error(`非法的容器动作: ${String(action)}`)
  const target = String(name ?? '').trim()
  if (!target) throw new Error('缺少容器名')
  const r = await execAsync('docker', containerActionArgs(target, action), {
    timeoutMs: DOCKER_TIMEOUT_MS,
    spawner: deps.spawner
  }).done
  return { ok: r.ok, detail: (r.stderr || r.stdout || '').trim().slice(0, 300) }
}

/** 镜像删除参数构造：docker rmi <id> */
export function imageRemoveArgs(id: string): string[] {
  return ['rmi', id]
}

export async function imageRemove(id: string, deps: DockerDeps = {}): Promise<{ ok: boolean; detail: string }> {
  const target = String(id ?? '').trim()
  if (!target) throw new Error('缺少镜像 ID')
  const r = await execAsync('docker', imageRemoveArgs(target), {
    timeoutMs: DOCKER_TIMEOUT_MS,
    spawner: deps.spawner
  }).done
  return { ok: r.ok, detail: (r.stderr || r.stdout || '').trim().slice(0, 300) }
}

/** docker logs --tail 200 <name>：文本日志（stdout/stderr 合并 —— docker 常把日志写 stderr） */
export async function dockerLogs(name: string, deps: DockerDeps = {}): Promise<DockerLogsResult> {
  const target = String(name ?? '').trim()
  if (!target) throw new Error('缺少容器名')
  const r = await execAsync('docker', ['logs', '--tail', '200', target], {
    timeoutMs: DOCKER_LOGS_TIMEOUT_MS,
    spawner: deps.spawner
  }).done
  const text = [r.stdout, r.stderr].filter((s) => s.trim()).join('\n').trimEnd()
  // ok 以退出码为准（容器日志常走 stderr，合并进 text 仅供展示；失败时 error 带原因）
  return { ok: r.ok, text, error: r.ok ? undefined : (r.stderr || r.stdout || 'logs 失败').slice(0, 300) }
}

/**
 * 启动 Docker Desktop 引擎：exe 必须真实存在（fs 检查）→ detached spawn（stdio ignore + unref）。
 * spawn 的 'error' 事件是异步的 —— 必须等一个短窗口：窗口内 error/非零退出 → ok:false，
 * 否则才返回 ok:true（同步 resolve 会让 error 分支变成永远走不到的死代码，把启动失败报成成功）。
 * 返回 ok=true 仅为「已成功拉起 Docker Desktop.exe」，引擎就绪需 10-30 秒，绝不自动轮询，刷新由用户点。
 */
export function startEngine(deps: DockerDeps = {}): Promise<{ ok: boolean; hint?: string; error?: string }> {
  const exe = deps.desktopExe ?? DOCKER_DESKTOP_EXE
  const fsMod = deps.fsMod ?? fs
  if (!fsMod.existsSync(exe)) {
    return Promise.resolve({ ok: false, error: `未找到 Docker Desktop: ${exe}（请确认已安装）` })
  }
  return new Promise((resolve) => {
    const spawner: Spawner = deps.spawner ?? ((cmd, args, opts) => spawn(cmd, args, opts))
    let child: ChildProcess
    try {
      const opts: SpawnOptions = { detached: true, stdio: 'ignore', windowsHide: true }
      child = spawner(exe, [], opts)
    } catch (e) {
      resolve({ ok: false, error: `Docker Desktop 启动失败: ${String(e)}` })
      return
    }
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const finish = (r: { ok: boolean; hint?: string; error?: string }): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    // detached + unref：启动器独立于本应用存活；error 事件（如权限/组策略拦截）在窗口内如实转为 ok:false
    child.once('error', (e: Error) => finish({ ok: false, error: `Docker Desktop 启动失败: ${e.message}` }))
    child.once('close', (code) => {
      if (code !== 0 && code !== null) finish({ ok: false, error: `Docker Desktop 启动器异常退出（退出码 ${code}）` })
    })
    child.unref?.()
    timer = setTimeout(() => finish({ ok: true, hint: '引擎启动约需 10-30 秒，稍后点刷新' }), deps.confirmDelayMs ?? 1500)
  })
}
