// 子智能体 .md 打开/读取动作的安全边界（纯逻辑 + 可注入依赖，vitest 无头覆盖）。
// 铁律与 skillOpen 同级：渲染进程只传文件名；一切路径都由主进程从 settings.vaultPath 解析并校验。
import path from 'node:path'
import { vaultAgentsDir } from './winLinks'

/**
 * agent .md 文件名白名单：小写字母/数字开头，仅含小写字母、数字、连字符，且必须以 .md 结尾。
 * 天然排除 `..`、`\`、`/`、`:`、大写、其它扩展名（含 SKILL.md 之外的可执行形态）。
 */
export const AGENT_MD_RE = /^[a-z0-9][a-z0-9-]*\.md$/

export function isValidAgentMdName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 128 && AGENT_MD_RE.test(name)
}

/**
 * 由文件名解析 vault agents/ 内 .md 真身路径。三重校验（与 skillOpen 同级）：
 * 1) 文件名必须匹配白名单正则（拒目录穿越/绝对路径注入/大小写绕过/非 .md）
 * 2) resolve 后必须严格位于 `<vault>\agents\` 前缀内（Windows 路径比较不区分大小写）
 * 3) 调用方再叠加「命中当前扫描的 agentFiles 集合」成员校验（本模块提供 remember/isKnown）
 * 任一不过即抛错（IPC 层转为错误 envelope）。
 */
export function resolveVaultAgentMd(vaultPath: string, fileName: string): string {
  if (!isValidAgentMdName(fileName)) {
    throw new Error(`非法 agent 文件名（仅允许 ^[a-z0-9][a-z0-9-]*\\.md$）: ${JSON.stringify(String(fileName ?? ''))}`)
  }
  const agentsDir = path.resolve(vaultAgentsDir(vaultPath))
  const md = path.resolve(agentsDir, fileName)
  const normDir = agentsDir.toLowerCase()
  const normMd = md.toLowerCase()
  if (!normMd.startsWith(normDir + path.sep)) {
    throw new Error(`路径越界（目录穿越防护）: ${md}`)
  }
  return md
}

// ---------- 打开动作的「当前扫描结果」成员校验 ----------

let knownAgentFiles: Set<string> = new Set()

/** 扫描完成后由主进程登记当前 vault agents/ 文件名集合（覆盖上次） */
export function rememberAgentFiles(names: readonly string[]): void {
  knownAgentFiles = new Set(names)
}

export function isKnownAgentFile(name: unknown): boolean {
  return typeof name === 'string' && knownAgentFiles.has(name)
}
