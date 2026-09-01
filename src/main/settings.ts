import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEEPSEEK_DEFAULT_ROOT } from './versionCenter/github'
import type { AppSettings, RemoteTarget, RemoteTargetKind } from '../shared/types'

export type { AppSettings, RemoteTarget } from '../shared/types'

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

/**
 * 默认设置：路径按当前用户主目录派生（os.homedir），绝不硬编码机器专属用户名——
 * 硬编码换电脑/换用户名安装即失效（默认 vault、裸仓全部指向不存在的路径）。
 * 每次调用都派生新对象，remoteTargets 永远是新数组（共享模块级默认数组是历史 bug）。
 */
export function defaultSettings(): AppSettings {
  const home = os.homedir()
  return {
    vaultPath: path.join(home, 'SkillVault'),
    barePath: path.join(home, 'SkillVault.git'),
    wslDistro: 'Ubuntu',
    deepseekHarnessRoot: DEEPSEEK_DEFAULT_ROOT,
    remoteTargets: []
  }
}

export function loadSettings(configDir: string | null): AppSettings {
  if (!configDir) return defaultSettings()
  try {
    const file = path.join(configDir, 'settings.json')
    if (!fs.existsSync(file)) return defaultSettings()
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppSettings>
    const d = defaultSettings()
    return {
      vaultPath: typeof raw.vaultPath === 'string' && raw.vaultPath ? raw.vaultPath : d.vaultPath,
      barePath: typeof raw.barePath === 'string' && raw.barePath ? raw.barePath : d.barePath,
      wslDistro: typeof raw.wslDistro === 'string' && raw.wslDistro ? raw.wslDistro : d.wslDistro,
      deepseekHarnessRoot:
        typeof raw.deepseekHarnessRoot === 'string' && raw.deepseekHarnessRoot
          ? raw.deepseekHarnessRoot
          : d.deepseekHarnessRoot,
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
