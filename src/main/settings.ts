import fs from 'node:fs'
import path from 'node:path'
import { DEEPSEEK_DEFAULT_ROOT } from './versionCenter/github'
import type { AppSettings, RemoteTarget, RemoteTargetKind } from '../shared/types'

export type { AppSettings, RemoteTarget } from '../shared/types'

export const DEFAULT_SETTINGS: AppSettings = {
  vaultPath: 'C:\\Users\\sakuya\\SkillVault',
  barePath: 'C:\\Users\\sakuya\\SkillVault.git',
  wslDistro: 'Ubuntu',
  deepseekHarnessRoot: DEEPSEEK_DEFAULT_ROOT,
  remoteTargets: []
}

/** 远程目标条目校验：仅保留已知字段，非法条目整体丢弃（配置损坏不应让应用起不来） */
function parseRemoteTargets(raw: unknown): RemoteTarget[] {
  if (!Array.isArray(raw)) return []
  const out: RemoteTarget[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const t = item as Record<string, unknown>
    if (typeof t.id !== 'string' || !t.id.trim()) continue
    if (t.kind !== 'ssh' && t.kind !== 'docker') continue
    if (typeof t.label !== 'string') continue
    out.push({
      id: t.id,
      kind: t.kind as RemoteTargetKind,
      label: t.label,
      enabled: t.enabled === true,
      ...(typeof t.host === 'string' && t.host ? { host: t.host } : {}),
      ...(isValidPort(t.port) ? { port: t.port } : {}),
      ...(typeof t.user === 'string' && t.user ? { user: t.user } : {}),
      ...(typeof t.container === 'string' && t.container ? { container: t.container } : {})
    })
  }
  return out
}

/** 端口合法性：1-65535 整数（2.5/-22 之类非法值直接丢弃，不落盘拼进 ssh -p） */
function isValidPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 65535
}

/** configDir 传 null 时（无头脚本场景）返回默认设置；remoteTargets 永远是新数组（浅拷贝会共享模块级默认数组） */
function defaultSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, remoteTargets: [] }
}

export function loadSettings(configDir: string | null): AppSettings {
  if (!configDir) return defaultSettings()
  try {
    const file = path.join(configDir, 'settings.json')
    if (!fs.existsSync(file)) return defaultSettings()
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppSettings>
    return {
      vaultPath: typeof raw.vaultPath === 'string' && raw.vaultPath ? raw.vaultPath : DEFAULT_SETTINGS.vaultPath,
      barePath: typeof raw.barePath === 'string' && raw.barePath ? raw.barePath : DEFAULT_SETTINGS.barePath,
      wslDistro: typeof raw.wslDistro === 'string' && raw.wslDistro ? raw.wslDistro : DEFAULT_SETTINGS.wslDistro,
      deepseekHarnessRoot:
        typeof raw.deepseekHarnessRoot === 'string' && raw.deepseekHarnessRoot
          ? raw.deepseekHarnessRoot
          : DEFAULT_SETTINGS.deepseekHarnessRoot,
      remoteTargets: parseRemoteTargets(raw.remoteTargets)
    }
  } catch {
    return defaultSettings()
  }
}

/** 原子写（临时文件 + rename）：崩溃打断写入时不会留下截断的 JSON 让下次启动静默回落默认值 */
export function saveSettings(configDir: string, s: AppSettings): void {
  fs.mkdirSync(configDir, { recursive: true })
  const file = path.join(configDir, 'settings.json')
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}
