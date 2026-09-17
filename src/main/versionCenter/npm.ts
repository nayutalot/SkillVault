// npm 通道：全局包已装版本（npm ls -g --depth=0 --json）与最新版本（npm view <pkg> version）。
// 读用户现有 npm 配置，不强制改 registry；npm 在 Windows 上通常是 npm.cmd shim（Node 直接 spawn .cmd 会 EINVAL）
// → 统一经 cmd.exe /d /s /c 执行。pkg 全部来自内置 catalog 常量（无空格、无元字符），无注入面。
//
// GUI 启动的应用继承的 PATH 可能缺少 npm 所在目录（cmd 只会回 GBK 的 "'npm' 不是内部或外部命令"），
// 因此执行前先解析 npm.cmd 绝对路径：where.exe npm.cmd → %ProgramFiles%\nodejs\npm.cmd → %APPDATA%\npm\npm.cmd；
// 全部失败给出明确错误（绝不带着乱码报 check-failed）。
import fs from 'node:fs'
import path from 'node:path'
import { execCmdArgs, defaultSpawner, type Spawner } from './exec'

export const NPM_CHECK_TIMEOUT_MS = 90_000
/** where.exe 解析超时（快命令，独立于检查超时） */
export const NPM_WHERE_TIMEOUT_MS = 15_000

/** npm.cmd 全部解析失败时的明确错误文案 */
export const NPM_NOT_FOUND_ERROR = '未找到 npm.cmd（已尝试 where 与常见安装位），请确认 Node.js 安装'

export type NpmDeps = {
  spawner?: Spawner
  timeoutMs?: number
  /** 覆盖环境变量（ProgramFiles / APPDATA 候选解析；测试注入） */
  env?: NodeJS.ProcessEnv
  /** 候选存在性检查（默认 fs 探测；测试注入） */
  fileExists?: (p: string) => boolean
}

/** %ProgramFiles%\nodejs\npm.cmd 与 %APPDATA%\npm\npm.cmd 候选（env 可注入） */
export function npmCmdCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const pf = env['ProgramFiles'] ?? ''
  const ad = env['APPDATA'] ?? ''
  return [pf ? path.join(pf, 'nodejs', 'npm.cmd') : '', ad ? path.join(ad, 'npm', 'npm.cmd') : ''].filter(Boolean)
}

/**
 * 解析 npm.cmd 绝对路径：
 * 1) where.exe npm.cmd —— 经 cmd chcp 65001 通道（where 重定向输出用 OEM 代码页，中文系统 GBK 路径会被
 *    按 UTF-8 解成乱码），且命中行必须通过存在性校验（乱码/失效 PATH 项直接落到候选探测）；
 * 2) 常见安装位候选（%ProgramFiles%\nodejs\npm.cmd、%APPDATA%\npm\npm.cmd）按存在性探测。
 * 全部失败返回 null（调用方给 NPM_NOT_FOUND_ERROR）。
 */
export async function resolveNpmCmdPath(deps: NpmDeps = {}): Promise<string | null> {
  const spawner = deps.spawner ?? defaultSpawner
  const fileExists =
    deps.fileExists ??
    ((p: string): boolean => {
      try {
        return fs.statSync(p).isFile()
      } catch {
        return false
      }
    })
  const r = await execCmdArgs(['where.exe', 'npm.cmd'], { timeoutMs: NPM_WHERE_TIMEOUT_MS, spawner }).done
  if (r.ok) {
    const first = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
    if (first && fileExists(first)) return first
  }
  for (const c of npmCmdCandidates(deps.env ?? process.env)) {
    if (fileExists(c)) return c
  }
  return null
}

/** 解析失败的统一错误（调用方直接作为 check-failed 的 note） */
function notFound(): { error: string } {
  return { error: NPM_NOT_FOUND_ERROR }
}

/** 解析 npm ls -g --json 的 dependencies → Map<包名, 版本>；非 JSON（npm 报错文本）→ 空表 */
export function parseNpmLsDependencies(stdout: string): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const parsed = JSON.parse(stdout) as { dependencies?: Record<string, { version?: string }> }
    for (const [name, info] of Object.entries(parsed.dependencies ?? {})) {
      if (info && typeof info.version === 'string') map.set(name, info.version)
    }
  } catch {
    /* 保持空表 */
  }
  return map
}

/** npm view <pkg> version 输出可能混有告警行（本项目 .npmrc 实测有 unknown config 告警）→ 取最后一个版本形行。
 *  容忍 prerelease 后缀（上游把 latest tag 指向 2.0.0-rc.1 时输出照样有效）。 */
export function parseNpmViewVersion(stdout: string): string | null {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^v?\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/.test(lines[i])) return lines[i]
  }
  return null
}

function isNpmLsJson(stdout: string): boolean {
  try {
    const p: unknown = JSON.parse(stdout)
    return typeof p === 'object' && p !== null
  } catch {
    return false
  }
}

/** npm ls -g：成功（含空 dependencies）返回 map；npm 不可用/报错返回 error */
export async function npmInstalled(
  deps: NpmDeps = {}
): Promise<{ map: Map<string, string> } | { error: string }> {
  const npm = await resolveNpmCmdPath(deps)
  if (!npm) return notFound()
  // 绝对路径含空格（Program Files）→ 必须走参数数组通道（execCmdLine 单行内嵌引号会被 cmd /s 语义破坏）
  const r = await execCmdArgs([npm, 'ls', '-g', '--depth=0', '--json'], {
    timeoutMs: deps.timeoutMs ?? NPM_CHECK_TIMEOUT_MS,
    spawner: deps.spawner
  }).done
  if (isNpmLsJson(r.stdout)) return { map: parseNpmLsDependencies(r.stdout) }
  return { error: `npm ls -g 失败: ${(r.stderr || r.stdout || '无输出').slice(0, 200)}` }
}

/** npm view <pkg> version：读用户现有 npm 配置查最新版 */
export async function npmLatest(pkg: string, deps: NpmDeps = {}): Promise<{ version?: string; error?: string }> {
  const npm = await resolveNpmCmdPath(deps)
  if (!npm) return notFound()
  const r = await execCmdArgs([npm, 'view', pkg, 'version'], {
    timeoutMs: deps.timeoutMs ?? NPM_CHECK_TIMEOUT_MS,
    spawner: deps.spawner
  }).done
  const v = parseNpmViewVersion(r.stdout)
  if (v) return { version: v }
  return { error: `npm view 失败: ${(r.stderr || r.stdout || '无输出').slice(0, 200)}` }
}
