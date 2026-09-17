// WSL 页后端（任务管理器风格资源监控）：全部经 execAsync 异步调用（全 args 数组、绝不 shell）。
// - wsl.exe 一律带 WSL_UTF8=1（execAsync 的 decode 已含 cleanWslOutput 清洗 UTF-16 空字节，双保险）；
// - distroStats 仅对 Running 且非 docker-desktop 的发行版执行一次复合读取（meminfo/loadavg/df/uptime），
//   绝不为了取数而启动已停止的发行版；docker-desktop 由 Docker Desktop 管理，只显示状态；
// - hostVm 读宿主侧 vmmemWSL/vmmem 进程工作集（PowerShell Get-Process JSON），进程不存在返回 null。
import type {
  WslActionName,
  WslDistro,
  WslDistroState,
  WslDistroStats,
  WslDistroView,
  WslHostVm,
  WslOverview
} from '../../shared/types'
import { execAsync, type Spawner } from '../versionCenter/exec'

/** wsl.exe -l -v / 动作类命令超时（冷启动可达数秒） */
export const WSL_TIMEOUT_MS = 30_000
/** 发行版内复合指标读取超时（sh -c 一次进出，正常秒级） */
export const DISTRO_STATS_TIMEOUT_MS = 30_000
/** PowerShell Get-Process 超时 */
export const HOST_VM_TIMEOUT_MS = 15_000

export type WslmonDeps = {
  spawner?: Spawner
}

/** wsl -l -v 输出解析（容忍中英文表头 / 默认星标 / 空行 / 告警噪声行）。
 *  行结构：[*] <name…> <state> <version>；以「末 token 是版本号(1|2)」锚定数据行，
 *  state 原样透出 —— Installing/Converting/Uninstalling 等过渡态归为 Other，绝不整行丢弃（发行版会从监控里凭空消失）。 */
export function parseWslList(out: string): WslDistro[] {
  const distros: WslDistro[] = []
  for (const raw of String(out ?? '').split(/\r?\n/)) {
    // 解析器自身再兜一层 UTF-16 空字节清洗（正常应由 execAsync decode 完成）
    const line = raw.replace(/\0/g, '').trim()
    if (!line) continue
    const lower = line.toLowerCase()
    // 表头行：同时含 state 与 version 关键字（英文表头 NAME/STATE/VERSION；换语言也不会误判为数据行）
    if (lower.includes('state') && lower.includes('version')) continue
    if (/^[-*\s]+$/.test(line)) continue
    let tokens = line.split(/\s+/)
    let isDefault = false
    if (tokens[0] === '*') {
      isDefault = true
      tokens = tokens.slice(1)
    }
    if (tokens.length < 3) continue
    // 锚定：最后一个 token 必须是版本号（1/2），倒数第二个是 state；发行版名可含空格
    const version = tokens[tokens.length - 1]
    if (!/^[12]$/.test(version)) continue
    const stateToken = tokens[tokens.length - 2]
    const state: WslDistroState = /^running$/i.test(stateToken)
      ? 'Running'
      : /^stopped$/i.test(stateToken)
        ? 'Stopped'
        : 'Other'
    const name = tokens.slice(0, tokens.length - 2).join(' ')
    if (!name) continue
    distros.push({ name, state, version, isDefault })
  }
  return distros
}

/** wsl.exe -l -v：发行版清单（isDefault 来自 `*` 星标） */
export async function listDistros(deps: WslmonDeps = {}): Promise<{ distros: WslDistro[]; error?: string }> {
  const r = await execAsync('wsl.exe', ['-l', '-v'], {
    timeoutMs: WSL_TIMEOUT_MS,
    env: { WSL_UTF8: '1' },
    spawner: deps.spawner
  }).done
  const distros = parseWslList(r.stdout)
  if (!distros.length && !r.ok) {
    return { distros: [], error: (r.stderr || r.stdout || 'wsl -l -v 失败').trim().slice(0, 300) }
  }
  return { distros }
}

/** PowerShell Get-Process JSON 解析：空输出 / 畸形 JSON / WS≤0 → null（进程不存在是常态，不是错误） */
export function parseHostVm(out: string): WslHostVm | null {
  const clean = String(out ?? '').trim()
  if (!clean) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(clean)
  } catch {
    return null
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  for (const it of arr) {
    const o = it as { Name?: unknown; WS?: unknown }
    if (o && typeof o.WS === 'number' && o.WS > 0) {
      return { name: typeof o.Name === 'string' ? o.Name : 'vmmemWSL', wsBytes: o.WS }
    }
  }
  return null
}

/** 宿主侧 WSL VM 进程（vmmemWSL 优先，vmmem 也读但不强求）工作集字节 */
export async function hostVm(deps: WslmonDeps = {}): Promise<WslHostVm | null> {
  const script = 'Get-Process vmmemWSL,vmmem -ErrorAction SilentlyContinue | Select-Object Name,WS | ConvertTo-Json -Compress'
  const r = await execAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeoutMs: HOST_VM_TIMEOUT_MS, spawner: deps.spawner }
  ).done
  return parseHostVm(r.stdout)
}

/** 发行版内一次性复合读取：meminfo + loadavg + df -h / + uptime（一次 wsl 调用全拿） */
export const DISTRO_STATS_CMD = 'cat /proc/meminfo; cat /proc/loadavg; df -h /; cat /proc/uptime'

function parseKb(line: string): number | null {
  const m = /:\s+(\d+)\s+kB/i.exec(line)
  return m ? Number(m[1]) : null
}

/** 复合输出解析：取不到的项为 null（部分输出 / 命令半途失败都不硬造数值） */
export function parseDistroStats(out: string): WslDistroStats {
  const stats: WslDistroStats = {
    memTotalKb: null,
    memFreeKb: null,
    memAvailKb: null,
    load1: null,
    diskTotal: null,
    diskUsed: null,
    diskAvail: null,
    diskPct: null,
    uptimeSec: null
  }
  for (const raw of String(out ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/^MemTotal:/i.test(line)) stats.memTotalKb = parseKb(line)
    else if (/^MemFree:/i.test(line)) stats.memFreeKb = parseKb(line)
    else if (/^MemAvailable:/i.test(line)) stats.memAvailKb = parseKb(line)
    else if (/^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+\/\d+\s+\d+/.test(line)) {
      // loadavg：0.00 0.01 0.00 1/363 1340
      const t = line.split(/\s+/)
      stats.load1 = Number(t[0])
    } else if (/^\S+\s+[\d.]+[KMGTP]?\s+[\d.]+[KMGTP]?\s+[\d.]+[KMGTP]?\s+\d+%\s+\/$/.test(line)) {
      // df -h / 数据行：/dev/sdd 1007G 20G 936G 3% /
      const t = line.split(/\s+/)
      stats.diskTotal = t[1]
      stats.diskUsed = t[2]
      stats.diskAvail = t[3]
      stats.diskPct = Number(String(t[4]).replace('%', ''))
    } else if (/^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?$/.test(line)) {
      // uptime：6660.90 159823.94（两列浮点，排除与 loadavg 冲突：loadavg 行含 / 已在前命中）
      const t = line.split(/\s+/)
      stats.uptimeSec = Math.round(Number(t[0]))
    }
  }
  return stats
}

/** distroStats：仅调用方保证传入 Running 且非 docker-desktop 的发行版（见 wslOverview） */
export async function distroStats(
  name: string,
  deps: WslmonDeps = {}
): Promise<{ stats: WslDistroStats; error?: string }> {
  const r = await execAsync('wsl.exe', ['-d', name, '-e', 'sh', '-c', DISTRO_STATS_CMD], {
    timeoutMs: DISTRO_STATS_TIMEOUT_MS,
    env: { WSL_UTF8: '1' },
    spawner: deps.spawner
  }).done
  const stats = parseDistroStats(r.stdout)
  const error = r.ok ? undefined : (r.stderr || '读取失败').trim().slice(0, 200)
  return { stats, error }
}

/** wsl 动作参数构造（纯函数，单测断言 argv） */
export function wslActionArgs(action: WslActionName, name?: string): string[] {
  switch (action) {
    case 'terminate':
      return ['--terminate', String(name ?? '')]
    case 'boot':
      return ['-d', String(name ?? ''), '-e', 'true']
    case 'shutdownAll':
      return ['--shutdown']
  }
}

const WSL_ACTIONS: readonly WslActionName[] = ['terminate', 'boot', 'shutdownAll']

/** 危险动作执行（terminate / boot / shutdownAll）；UI 层负责确认框，主进程只做参数完备性校验 */
export async function wslAction(
  action: WslActionName,
  name: string | undefined,
  deps: WslmonDeps = {}
): Promise<{ ok: boolean; detail?: string }> {
  if (!WSL_ACTIONS.includes(action)) throw new Error(`非法的 WSL 动作: ${String(action)}`)
  if ((action === 'terminate' || action === 'boot') && !String(name ?? '').trim()) {
    throw new Error(`该动作需要发行版名: ${action}`)
  }
  const r = await execAsync('wsl.exe', wslActionArgs(action, name), {
    timeoutMs: action === 'boot' ? WSL_TIMEOUT_MS * 2 : WSL_TIMEOUT_MS,
    env: { WSL_UTF8: '1' },
    spawner: deps.spawner
  }).done
  return { ok: r.ok, detail: (r.stderr || r.stdout || '').trim().slice(0, 300) || undefined }
}

/** docker-desktop 系发行版（由 Docker Desktop 管理：不取数、只显示状态） */
function managedByDocker(name: string): boolean {
  return name === 'docker-desktop' || name.startsWith('docker-desktop')
}

/** wsl:distros 一次返回：清单 + 宿主 vmmem + 各运行中（非 docker 系）发行版 stats（并行，各只取一次） */
export async function wslOverview(deps: WslmonDeps = {}): Promise<WslOverview> {
  const { distros, error } = await listDistros(deps)
  const running = distros.filter((d) => d.state === 'Running' && !managedByDocker(d.name))
  const [host, statsList] = await Promise.all([
    hostVm(deps),
    Promise.all(running.map(async (d) => ({ name: d.name, ...(await distroStats(d.name, deps)) })))
  ])
  const statsMap = new Map(statsList.map((s) => [s.name, s]))
  const views: WslDistroView[] = distros.map((d) => {
    const hit = statsMap.get(d.name)
    return {
      ...d,
      stats: hit?.stats ?? null,
      statsError: hit?.error,
      managedByDocker: managedByDocker(d.name)
    }
  })
  return { distros: views, host, error }
}
