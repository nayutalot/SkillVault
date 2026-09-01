// WSL 侧扫描 + 缓存降级（两阶段扫描的第二阶段）。
// companion 不可达/超时（20s）时回落 userData/wsl-scan-cache.json，绝不阻塞、绝不白屏；
// 缓存命中时 stale=true，由 UI 标注「缓存 HH:MM」并提供重试。
import fs from 'node:fs'
import path from 'node:path'
import type { AgentScan, ScanWslData, SkillMeta, WslScanPayload } from '../shared/types'
import type { AppSettings } from './settings'
import { runCompanion, type Spawner } from './wslBridge'

/** scan:wsl 的 companion 超时上限（远小于旧同步版 90s，且全程异步不冻结事件循环） */
export const SCAN_WSL_TIMEOUT_MS = 20000

export type ScanWslOutcome = ScanWslData

export type WslScanDeps = {
  /** 可注入 spawner（单测用 fake 子进程） */
  spawner?: Spawner
  now?: () => number
  /** 缓存文件路径；null/undefined 表示禁用缓存读写 */
  cacheFile?: string | null
  /** 超时毫秒数（生产固定 SCAN_WSL_TIMEOUT_MS；测试可缩短以验证超时降级路径） */
  timeoutMs?: number
}

/** 读缓存：形状校验（ts 数字 + agents/skills 数组），任何异常按无缓存处理 */
export function readWslScanCache(file: string): WslScanPayload | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WslScanPayload>
    if (typeof raw.ts !== 'number' || !Array.isArray(raw.agents) || !Array.isArray(raw.skills)) return null
    return { ts: raw.ts, agents: raw.agents as AgentScan[], skills: raw.skills as SkillMeta[] }
  } catch {
    return null
  }
}

/** 写缓存（临时文件 + rename 原子替换）；失败静默（缓存属加速手段，不致命） */
export function writeWslScanCache(file: string, payload: WslScanPayload): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    /* 缓存写入失败可忽略 */
  }
}

/**
 * 第二阶段：异步调 companion scan（20s 超时）。
 * 成功 → 写缓存并返回 { report, stale:false }；
 * 失败/超时 → 读缓存，命中返回 { report: cached, stale:true, reason }，未命中 { report:null, stale:false, reason }。
 */
export async function runWslScan(settings: AppSettings, deps: WslScanDeps = {}): Promise<ScanWslOutcome> {
  const c = await runCompanion(settings.wslDistro, ['scan'], deps.timeoutMs ?? SCAN_WSL_TIMEOUT_MS, deps.spawner)
  const p = c.parsed as { ok?: boolean; skills?: SkillMeta[]; agents?: AgentScan[] } | undefined
  if (c.ok && p && p.ok === true && Array.isArray(p.agents)) {
    const payload: WslScanPayload = {
      ts: deps.now?.() ?? Date.now(),
      agents: p.agents,
      skills: Array.isArray(p.skills) ? p.skills : []
    }
    if (deps.cacheFile) writeWslScanCache(deps.cacheFile, payload)
    return { report: payload, stale: false }
  }
  const reason = `WSL companion 不可达: ${(c.parseError || c.stderr || c.stdout || '无输出').slice(0, 200)}`
  const cached = deps.cacheFile ? readWslScanCache(deps.cacheFile) : null
  if (cached) return { report: cached, stale: true, reason }
  return { report: null, stale: false, reason }
}
