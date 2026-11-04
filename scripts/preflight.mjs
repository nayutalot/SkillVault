#!/usr/bin/env node
// ---------------------------------------------------------------------------
// preflight.mjs —— 复现前置环境预检
//
// 目的：评审者在动手跑之前，先用一条命令知道自己缺什么、哪个版本不满足、
//       哪些可选能力不可用。避免「跑不起来 → 以为作品坏了」。
//
// 用法：
//   node scripts/preflight.mjs            # 预检并打印报告
//   node scripts/preflight.mjs --json     # 额外输出机器可读 JSON（stdout）
//   node scripts/preflight.mjs --help
//
// 退出码：
//   0 = 全部必需项满足
//   1 = 有必需项不满足（不可选项缺失不算失败）
//   2 = 参数错误
//
// 判定原则：
//   - 必需项 = 跑通「源码验证路径」所需：Node、pnpm、Git。
//   - 可选项 = 只影响部分功能：WSL（跨端同步）、Docker（容器页）。
//   - 任何一项都只做「观察」，绝不修改系统、绝不安装任何东西。
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`preflight.mjs —— 复现前置环境预检

用法：
  node scripts/preflight.mjs          打印人可读报告
  node scripts/preflight.mjs --json   额外在 stdout 输出机器可读 JSON
  node scripts/preflight.mjs --help   显示本帮助

退出码：0 全部必需项满足 / 1 有必需项不满足 / 2 参数错误

本脚本只做观察：绝不安装软件、绝不修改系统配置、绝不触碰用户真实数据。`)
  process.exit(0)
}
const wantJson = argv.includes('--json')

// ---- 工具版本探测 ---------------------------------------------------------
/**
 * 执行一个只读命令并返回其 stdout；失败返回 null（不抛）。
 *
 * Windows 注意事项：npm / pnpm 这类全局工具是 .cmd 包装脚本，Node ≥ 18.20/20.12/22 为修复
 * CVE-2024-27980（cmd.exe 参数注入）默认禁止在不开 shell 的情况下 spawn .cmd/.bat —— 直接
 * spawn 会抛 EINVAL。因此这类命令改走 `cmd.exe /d /s /c`。本脚本用到的参数全是脚本内写死的
 * 字面量（不含用户输入），不存在注入面。
 */
function probe(cmd, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
    return probeCmd(cmd, args)
  }
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/** 通过 cmd.exe 执行 .cmd/.bat 包装脚本（参数均为脚本内字面量） */
function probeCmd(cmd, args) {
  const line = [cmd, ...args].join(' ')
  try {
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/** 取版本号里的第一个 x.y.z 形态片段 */
function firstVersion(text) {
  const m = String(text ?? '').match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/)
  return m ? m[0] : null
}

/** 比较版本串：a<b 返回负数，a==b 返回 0，a>b 返回正数；无法解析返回 null */
function compareVersions(a, b) {
  if (!a || !b) return null
  const pa = a.split(/[.+-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)))
  const pb = b.split(/[.+-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)))
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1
    } else {
      const sx = String(x)
      const sy = String(y)
      if (sx !== sy) return sx < sy ? -1 : 1
    }
  }
  return 0
}

const checks = []
/**
 * @param {object} c
 * @param {string} c.name      检查项名称
 * @param {'required'|'optional'} c.level
 * @param {boolean} c.ok
 * @param {string} c.detail    人可读详情
 * @param {string} [c.hint]    不满足时给用户的下一步
 * @param {string} [c.version]
 */
function record(c) {
  checks.push(c)
}

// ---- 1. Node 版本（必需）--------------------------------------------------
const nodeVersion = process.versions.node
const nodeOk = compareVersions(nodeVersion, '20.0.0') !== null && compareVersions(nodeVersion, '20.0.0') >= 0
record({
  name: 'Node.js',
  level: 'required',
  ok: nodeOk,
  version: nodeVersion,
  detail: nodeOk ? `v${nodeVersion}（要求 ≥ 20）` : `v${nodeVersion}，低于要求的 20`,
  hint: nodeOk ? undefined : '请安装 Node.js 20 或更高版本：https://nodejs.org/',
})

// ---- 2. pnpm（必需）-------------------------------------------------------
// pnpm 是 .cmd 包装脚本，Windows 下必须经 cmd.exe 探测（见 probe 的说明）
const pnpmRaw = probe(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'])
const pnpmVersion = pnpmRaw ? firstVersion(pnpmRaw) : null
const pnpmOk = !!pnpmVersion && compareVersions(pnpmVersion, '9.0.0') >= 0
record({
  name: 'pnpm',
  level: 'required',
  ok: pnpmOk,
  version: pnpmVersion ?? undefined,
  detail: pnpmOk
    ? `v${pnpmVersion}（要求 ≥ 9）`
    : pnpmRaw
      ? `v${pnpmVersion}，低于要求的 9`
      : '未在 PATH 中找到 pnpm',
  hint: pnpmOk ? undefined : '安装：npm i -g pnpm@9（或 corepack enable pnpm）',
})

// ---- 3. Git（必需）--------------------------------------------------------
const gitRaw = probe('git', ['--version'])
const gitVersion = gitRaw ? firstVersion(gitRaw) : null
const gitOk = !!gitVersion && compareVersions(gitVersion, '2.30.0') >= 0
record({
  name: 'Git',
  level: 'required',
  ok: gitOk,
  version: gitVersion ?? undefined,
  detail: gitOk ? `v${gitVersion}（要求 ≥ 2.30）` : gitRaw ? `v${gitVersion}，低于要求的 2.30` : '未在 PATH 中找到 git',
  hint: gitOk ? undefined : '请安装 Git for Windows：https://git-scm.com/download/win',
})

// ---- 4. 依赖是否已安装（必需）---------------------------------------------
const nodeModulesPresent = fs.existsSync(path.join(REPO_ROOT, 'node_modules'))
const vitestPresent = fs.existsSync(path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'))
record({
  name: '依赖已安装',
  level: 'required',
  ok: nodeModulesPresent && vitestPresent,
  detail: nodeModulesPresent
    ? vitestPresent
      ? 'node_modules/ 存在且 vitest 可用'
      : 'node_modules/ 存在但缺少 vitest，请重新执行 pnpm install'
    : '尚未执行 pnpm install',
  hint: nodeModulesPresent && vitestPresent ? undefined : '执行：pnpm install --frozen-lockfile',
})

// ---- 5. 锁文件（必需，用于冻结依赖版本）----------------------------------
const lockPresent = fs.existsSync(path.join(REPO_ROOT, 'pnpm-lock.yaml'))
record({
  name: '依赖锁文件',
  level: 'required',
  ok: lockPresent,
  detail: lockPresent ? 'pnpm-lock.yaml 存在，依赖版本可冻结' : '缺少 pnpm-lock.yaml，无法冻结依赖版本',
  hint: lockPresent ? undefined : '请从仓库完整克隆（不要只拷贝 src/ 目录）',
})

// ---- 6. WSL（可选：仅跨端同步需要）---------------------------------------
const wslRaw = probe('wsl.exe', ['--status'])
const wslList = probe('wsl.exe', ['-l', '-q'])
const wslDistros = (wslList ?? '')
  .split(/\r?\n/)
  .map((s) => s.replace(/\0/g, '').trim())
  .filter((s) => s && !s.startsWith('Windows Subsystem for Linux'))
const wslOk = wslRaw !== null || wslList !== null
record({
  name: 'WSL2',
  level: 'optional',
  ok: wslOk,
  detail: wslOk
    ? `可用${wslDistros.length ? `，已安装发行版：${wslDistros.join('、')}` : '，但未检测到发行版'}`
    : '未检测到 wsl.exe（仅影响跨端同步与 WSL 页面，不影响源码验证路径）',
  hint: wslOk ? undefined : '如需跨端同步：wsl --install -d Ubuntu',
})

// ---- 7. Docker（可选：仅容器页需要）--------------------------------------
const dockerRaw = probe('docker', ['--version'])
const dockerInfo = probe('docker', ['info', '--format', '{{.ServerVersion}}'])
const dockerInstalled = dockerRaw !== null
const dockerRunning = !!dockerInfo
record({
  name: 'Docker',
  level: 'optional',
  ok: dockerInstalled,
  detail: dockerInstalled
    ? dockerRunning
      ? `已安装且引擎运行中（Server ${dockerInfo.trim()}）`
      : '已安装，但引擎未运行 —— 应用会显示降级提示而非报错'
    : '未检测到 Docker（仅影响容器页，不影响其它功能）',
  hint: dockerInstalled ? undefined : '如需容器页：https://docs.docker.com/desktop/',
})

// ---- 8. 仓库自身状态（可选，但影响复现）----------------------------------
const isGitRepo = fs.existsSync(path.join(REPO_ROOT, '.git'))
let headSha = null
let dirty = null
if (isGitRepo) {
  const rev = probe('git', ['rev-parse', 'HEAD'])
  headSha = rev ? rev.trim() : null
  const st = probe('git', ['status', '--porcelain'])
  dirty = st === null ? null : st.trim().length > 0
}
record({
  name: '仓库状态',
  level: 'optional',
  ok: isGitRepo,
  detail: isGitRepo
    ? `HEAD ${headSha ? headSha.slice(0, 12) : '未知'}${dirty === true ? '，工作区有未提交改动（复现结果可能与提交不一致）' : dirty === false ? '，工作区干净' : ''}`
    : '当前目录不是 git 仓库（无法核对提交锚点）',
  hint: isGitRepo ? undefined : '请在完整克隆的仓库目录内运行本脚本',
})

// ---- 汇总 -----------------------------------------------------------------
const requiredFailed = checks.filter((c) => c.level === 'required' && !c.ok)
const optionalMissing = checks.filter((c) => c.level === 'optional' && !c.ok)
const allOk = requiredFailed.length === 0

// stdout：机器可读（--json）
if (wantJson) {
  process.stdout.write(
    JSON.stringify(
      {
        tool: 'scripts/preflight.mjs',
        repoRoot: REPO_ROOT,
        platform: { os: os.platform(), release: os.release(), arch: os.arch(), node: process.version },
        ok: allOk,
        requiredFailed: requiredFailed.map((c) => c.name),
        checks: checks.map((c) => ({
          name: c.name,
          level: c.level,
          ok: c.ok,
          version: c.version ?? null,
          detail: c.detail,
          hint: c.hint ?? null,
        })),
      },
      null,
      2
    ) + '\n'
  )
}

// stderr：人可读报告
const lines = []
lines.push('—— SkillVault 复现前置预检 ——')
lines.push(`平台：${os.platform()} ${os.release()} ${os.arch()} / Node ${process.version}`)
lines.push('')
for (const c of checks) {
  const badge = c.ok ? '✔' : c.level === 'required' ? '✘' : '!'
  const level = c.level === 'required' ? '必需' : '可选'
  lines.push(`${badge} [${level}] ${c.name}：${c.detail}`)
  if (!c.ok && c.hint) lines.push(`    → ${c.hint}`)
}
lines.push('')
if (allOk) {
  lines.push('结论：必需项全部满足，可以按 REPRODUCE.md 执行复现。')
  if (optionalMissing.length) {
    lines.push(`提示：${optionalMissing.map((c) => c.name).join('、')} 未就绪，只影响对应功能的实测环节，不影响其余部分。`)
  }
} else {
  lines.push(`结论：${requiredFailed.length} 个必需项不满足（${requiredFailed.map((c) => c.name).join('、')}），请先按上面的提示处理。`)
}
console.error(lines.join('\n'))

process.exit(allOk ? 0 : 1)
