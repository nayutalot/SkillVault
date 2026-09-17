// 打开/复制动作的安全边界（纯逻辑 + 可注入依赖，vitest 无头覆盖）。
// 铁律：渲染进程只传 skillName；一切路径都由主进程从 settings.vaultPath 解析并校验。
import path from 'node:path'
import { vaultSkillDir, vaultSkillsDir } from './winLinks'

/** skillName 白名单：小写字母/数字开头，仅含小写字母、数字、连字符。天然排除 `..`、`\`、`/`、`:`、大写 */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

export function isValidSkillName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 128 && SKILL_NAME_RE.test(name)
}

/**
 * 由 skillName 解析 vault 真身目录。三重校验：
 * 1) skillName 必须匹配白名单正则（拒目录穿越/绝对路径注入/大小写绕过）
 * 2) resolve 后必须严格位于 `<vault>\skills\` 前缀内（Windows 路径比较不区分大小写）
 * 3) 目录必须存在
 * 任一不过即抛错（IPC 层转为错误 envelope）。
 */
export function resolveVaultSkillDir(vaultPath: string, skillName: string): string {
  if (!isValidSkillName(skillName)) {
    throw new Error(`非法 skill 名（仅允许 ^[a-z0-9][a-z0-9-]*$）: ${JSON.stringify(String(skillName ?? ''))}`)
  }
  const skillsDir = path.resolve(vaultSkillsDir(vaultPath))
  const dir = path.resolve(skillsDir, skillName)
  const normSkills = skillsDir.toLowerCase()
  const normDir = dir.toLowerCase()
  if (normDir === normSkills || !normDir.startsWith(normSkills + path.sep)) {
    throw new Error(`路径越界（目录穿越防护）: ${dir}`)
  }
  return dir
}

/** vault skill 目录下的 SKILL.md 路径（先过 resolveVaultSkillDir 校验） */
export function resolveVaultSkillMd(vaultPath: string, skillName: string): string {
  return path.join(resolveVaultSkillDir(vaultPath, skillName), 'SKILL.md')
}

// ---------- 打开动作的「当前扫描结果」成员校验 ----------
// 渲染层只传 skillName；打开前必须命中最近一次扫描出的 skill 集合（主进程自建），防探测任意目录。

let knownSkillNames: Set<string> = new Set()

/** 扫描完成后由主进程登记当前 skill 名集合（覆盖上次） */
export function rememberSkillNames(names: readonly string[]): void {
  knownSkillNames = new Set(names)
}

export function isKnownSkillName(name: unknown): boolean {
  return typeof name === 'string' && knownSkillNames.has(name)
}

// ---------- copyPath 白名单 ----------
// 渲染层传来的待复制路径，必须命中「当前扫描结果」派生出的路径集合（主进程自建），否则拒绝。

let knownCopyPaths: Set<string> = new Set()

/** 归一化用于比较：Windows 路径（盘符/UNC）→ win32.normalize + 小写 + 去尾分隔符；POSIX 路径 → posix.normalize + 去尾分隔符 */
export function normalizeCopyPath(p: string): string {
  const s = String(p ?? '').trim()
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')) {
    let n = path.win32.normalize(s).toLowerCase()
    if (n.length > 3 && (n.endsWith('\\') || n.endsWith('/'))) n = n.slice(0, -1)
    return n
  }
  let n = path.posix.normalize(s)
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1)
  return n
}

/** 扫描完成后由主进程登记「允许复制」的路径集合（覆盖上次） */
export function rememberCopyPaths(paths: readonly string[]): void {
  knownCopyPaths = new Set(paths.map((p) => normalizeCopyPath(p)))
}

export function isKnownCopyPath(p: string): boolean {
  return knownCopyPaths.has(normalizeCopyPath(String(p ?? '')))
}

/** 由扫描结果构造白名单：vault 真身目录、各 agent 链接位置、WSL vault 侧目录 */
export function scanCopyPaths(vaultPath: string, skills: readonly { name: string }[], agents: readonly { platform: 'windows' | 'linux'; skillsDir: string }[], wslVault: string): string[] {
  const out: string[] = []
  for (const s of skills) {
    out.push(vaultSkillDir(vaultPath, s.name))
    out.push(`${wslVault}/skills/${s.name}`)
    for (const a of agents) {
      out.push(a.platform === 'windows' ? path.win32.join(a.skillsDir, s.name) : path.posix.join(a.skillsDir, s.name))
    }
  }
  return out
}
