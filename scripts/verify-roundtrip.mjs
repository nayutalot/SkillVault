#!/usr/bin/env node
// ============================================================================
// scripts/verify-roundtrip.mjs —— SkillVault 双端往返验收脚本
// ----------------------------------------------------------------------------
// 目的：让评审者用一条命令、独立验证 SkillVault 的核心链路真的能跑：
//   1. Windows 侧提交并推送        （src/main/sync.ts 的第 1 段）
//   2. WSL 侧提交 → 变基拉取 → 推送（src/companion/skm.ts 的 cmdSync）
//      Windows 侧再回拉合并          （src/main/sync.ts 的第 3 段）
//   3. 冲突演练：同一文件两边不同内容 → Windows 侧 pull 冲突 → 检出 MERGE_HEAD
//      → 收集未合并文件 → merge --abort → 验证双方内容都还在、零残留状态
//   4. 链接状态：harness 目录指向 vault 目录的 junction 是否真的「同一份数据」
//
// 关键设计（WHY —— 这决定了本脚本是「验收」还是「自我感动」）：
//   本脚本**不重新实现**产品逻辑，而是直接跑仓库里的真实源码：
//     - src/main/sync.ts         → 真实 syncAll() 编排（add/commit/push/pull）
//     - src/main/git.ts          → 真实 gitAsync()/git()（含 core.quotepath=false 等注入）
//     - src/main/winLinks.ts     → 真实 getLinkState()/createJunction()（链接五态判定）
//     - src/shared/registry.ts   → 真实 parseRegistry()（v3 校验）
//     - src/shared/frontmatter.ts → 真实 parseFrontmatter()（SKILL.md 合法性）
//     - src/companion/skm.ts     → 真实 WSL 伴生 CLI（子进程执行，stdout 恒为单个 JSON）
//   只把 sync.ts 依赖的 runCompanion（原本走 wsl.exe 进真 WSL）换成本地夹具调用：
//   真机上没有 WSL 也能跑，而且跑的是同一份 companion 源码。
//
// 零依赖：只用 Node 内置模块 + PATH 上的 git。ESM，零构建步骤。
// 安全：只读写传入的夹具根目录，绝不触碰用户 HOME / 真实 harness 配置。
//
// 用法：
//   node scripts/verify-roundtrip.mjs [夹具根目录]
//   node scripts/verify-roundtrip.mjs --help
//
// 退出码：0 = 全部通过；1 = 有步骤失败；2 = 参数/环境错误
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const SKILL_NAME = 'demo-skill'

// ---------------------------------------------------------------------------
// 0. 参数与用法
// ---------------------------------------------------------------------------

function usage() {
  process.stdout.write(
    [
      '用法: node scripts/verify-roundtrip.mjs [夹具根目录]',
      '',
      '对 scripts/init-fixture.mjs 生成的夹具跑一遍完整双端往返验收：',
      '  步骤 0  前置检查：registry.json 能被产品 parseRegistry 解析（v3）/ SKILL.md frontmatter 合法',
      '  步骤 1  Windows 侧 add -A → commit → push origin main（真实 syncAll 编排）',
      '  步骤 2  WSL 侧   add -A → commit → pull --rebase → push origin main',
      '         （WSL 侧由真实 companion src/companion/skm.ts 以子进程方式执行）',
      '         → Windows 侧 pull --no-rebase --no-edit origin main 后拿到 wsl.txt',
      '  步骤 3  冲突演练（独立演练仓）：双方同文件不同内容 → pull 冲突 → 收集未合并文件',
      '         → merge --abort → 校验双方内容零丢失、无残留合并/变基状态',
      '  步骤 4  链接状态：harness/skills/<skill> → vault/skills/<skill>（junction，写入互相可见）',
      '  步骤 5  终态检查：vault 工作区干净 + 无残留合并/变基状态 + 仍在 main 分支',
      '',
      '输出：',
      '  stdout  机器可读 JSON 报告（同时写入 <夹具根目录>/acceptance-report.json）',
      '  stderr  人读摘要（中文）',
      '',
      '退出码：0 = 全部通过 / 1 = 有步骤失败 / 2 = 参数或环境错误',
      '',
      '示例:',
      '  node scripts/init-fixture.mjs',
      '  node scripts/verify-roundtrip.mjs',
      ''
    ].join('\n')
  )
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  usage()
  process.exit(0)
}
const positional = argv.filter((a) => !a.startsWith('--'))
const fixtureRoot = path.resolve(positional[0] ?? path.join(os.tmpdir(), 'skillvault-fixture'))

// ---------------------------------------------------------------------------
// 1. 让 Node 能直接跑仓库里的 .ts 源码
// ---------------------------------------------------------------------------
// WHY：产品源码是 TypeScript，且 import 路径不带扩展名（`'./git'`）—— 这是 TS 的
// bundler/node 解析行为，Node 原生不认。Node 24 提供 module.registerHooks()，
// 注册一个「补 .ts 扩展名」的解析钩子，就能零构建直接跑真源码。
// 注意：钩子只在**本进程**生效；companion 是独立 CLI，必须把同样的钩子注入子进程
// （--import 预加载，见下文 CHILD_PRELOAD）。

/**
 * 子进程预加载脚本（写成真实文件再 --import，而不是 data: URL）：
 *   (a) 注册 .ts 解析钩子 —— 让 companion（src/companion/skm.ts，TS 源码）能被 Node 直接跑
 *   (b) 拦截 spawnSync / spawn —— 把 companion 真实发出的 git 命令记到 JSONL 日志
 * WHY 要 (b)：companion 在子进程里跑，主进程拦不到；不记的话报告里就看不到 WSL 侧真实执行的
 *   git 命令与退出码（那正是本脚本要交付的证据）。
 * WHY 写成文件而不是 data: URL：Windows 上 Node 的 --import 只接受 file:// URL，
 *   data: URL 会在 CJS loader 阶段直接报 ERR_INVALID_ARG_VALUE。
 */
const CHILD_PRELOAD = `
import { registerHooks } from 'node:module'
import { existsSync, appendFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/i.test(specifier)) {
      const parentDir = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd()
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        const cand = path.resolve(parentDir, specifier + ext)
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  }
})

const require = createRequire(import.meta.url)
const cp = require('node:child_process')
const isGit = (cmd) => {
  const c = String(cmd).toLowerCase()
  return c === 'git' || c.endsWith('git.exe')
}
const append = (rec) => {
  try {
    appendFileSync(process.env.SV_GIT_LOG, JSON.stringify(rec) + '\\n')
  } catch {
    /* 记录失败不影响 companion 本体 */
  }
}

const origSpawnSync = cp.spawnSync
cp.spawnSync = function (cmd, args, opts) {
  const r = origSpawnSync.apply(this, arguments)
  if (isGit(cmd)) {
    append({
      cmd: 'git ' + Array.from(args ?? []).slice(4).join(' '),
      cwd: opts && opts.cwd ? String(opts.cwd) : null,
      exitCode: r.status ?? -1,
      ok: r.status === 0,
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? '')
    })
  }
  return r
}

const origSpawn = cp.spawn
cp.spawn = function (cmd, args, opts) {
  const child = origSpawn.apply(this, arguments)
  if (isGit(cmd)) {
    const rec = {
      cmd: 'git ' + Array.from(args ?? []).slice(4).join(' '),
      cwd: opts && opts.cwd ? String(opts.cwd) : null,
      exitCode: null,
      ok: false,
      stdout: '',
      stderr: ''
    }
    append(rec)
    const out = []
    const err = []
    child.stdout?.on('data', (d) => out.push(Buffer.from(d)))
    child.stderr?.on('data', (d) => err.push(Buffer.from(d)))
    child.once('close', (code) => {
      rec.exitCode = code ?? -1
      rec.ok = code === 0
      rec.stdout = Buffer.concat(out).toString('utf8')
      rec.stderr = Buffer.concat(err).toString('utf8')
    })
  }
  return child
}
`

/** 注册 .ts 解析钩子（必须在 import 产品模块**之前**调用） */
function installTsHooks() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier)) {
        const parentDir = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd()
        for (const ext of ['.ts', '.tsx', '/index.ts']) {
          const cand = path.resolve(parentDir, specifier + ext)
          if (fs.existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true }
        }
      }
      return nextResolve(specifier, context)
    }
  })
}

// ---------------------------------------------------------------------------
// 2. git 调用流水账（记录本进程真实执行过的 git 命令 + 退出码）
// ---------------------------------------------------------------------------
// WHY 这样能生效：产品模块用 `import { spawnSync } from 'node:child_process'` 取 ESM 具名导出，
// 而内置模块的 ESM 具名导出是对 CJS exports 的**一次性快照**——只要在本进程 import 产品模块
// **之前**改掉 CJS 的 exports，产品侧拿到的就是打过补丁的版本。
// 因此本文件**刻意不写** `import { spawnSync } from 'node:child_process'`（那会提前创建快照），
// 一律通过 createRequire 拿 CJS 版本。
const require = createRequire(import.meta.url)
const cp = require('node:child_process')

/** git 调用流水账（本进程） */
const gitCalls = []
/** 子进程（companion）侧 git 调用流水账 */
const childGitCalls = []

function isGitCmd(cmd) {
  const c = String(cmd).toLowerCase()
  return c === 'git' || c.endsWith('git.exe') || c.endsWith('git.cmd')
}

/** 去掉产品注入的两个 -c 文本参数（core.quotepath / i18n.logOutputEncoding），只留子命令 */
function gitCmdText(args) {
  const list = Array.from(args ?? [])
  // 产品注入形如：['-c','core.quotepath=false','-c','i18n.logOutputEncoding=UTF-8', ...子命令]
  const cut = list[0] === '-c' && list[2] === '-c' ? 4 : 0
  return `git ${list.slice(cut).join(' ')}`
}

function installGitRecorder() {
  const origSpawnSync = cp.spawnSync
  cp.spawnSync = function (cmd, args, opts) {
    const r = origSpawnSync.apply(this, arguments)
    if (isGitCmd(cmd)) {
      gitCalls.push({
        cmd: gitCmdText(args),
        fullArgs: Array.from(args ?? []),
        cwd: opts && opts.cwd ? String(opts.cwd) : null,
        exitCode: r.status ?? -1,
        ok: r.status === 0,
        stdout: String(r.stdout ?? ''),
        stderr: String(r.stderr ?? ''),
        api: 'spawnSync'
      })
    }
    return r
  }

  // 产品新版本用异步 spawn（gitAsync），故两版都要拦
  const origSpawn = cp.spawn
  cp.spawn = function (cmd, args, opts) {
    const child = origSpawn.apply(this, arguments)
    if (isGitCmd(cmd)) {
      const rec = {
        cmd: gitCmdText(args),
        fullArgs: Array.from(args ?? []),
        cwd: opts && opts.cwd ? String(opts.cwd) : null,
        exitCode: null,
        ok: false,
        stdout: '',
        stderr: '',
        api: 'spawn'
      }
      gitCalls.push(rec)
      const out = []
      const err = []
      child.stdout?.on('data', (d) => out.push(Buffer.from(d)))
      child.stderr?.on('data', (d) => err.push(Buffer.from(d)))
      child.once('close', (code) => {
        rec.exitCode = code ?? -1
        rec.ok = code === 0
        rec.stdout = Buffer.concat(out).toString('utf8')
        rec.stderr = Buffer.concat(err).toString('utf8')
      })
    }
    return child
  }
}

// ---------------------------------------------------------------------------
// 3. 夹具定位
// ---------------------------------------------------------------------------

function loadFixture(root) {
  const fixtureJson = path.join(root, 'fixture.json')
  if (!fs.existsSync(fixtureJson)) {
    throw new Error(`找不到夹具清单: ${fixtureJson}\n请先运行: node scripts/init-fixture.mjs ${root}`)
  }
  const fx = JSON.parse(fs.readFileSync(fixtureJson, 'utf8'))
  const p = fx.paths ?? {}
  const paths = {
    root: path.resolve(p.root ?? root),
    bare: path.resolve(p.bare),
    vault: path.resolve(p.vault),
    wslSide: path.resolve(p.wslSide),
    harnessA: path.resolve(p.harnessA),
    harnessB: path.resolve(p.harnessB),
    harnessASkills: path.resolve(p.harnessASkills),
    harnessAAgents: path.resolve(p.harnessAAgents),
    harnessBSkills: path.resolve(p.harnessBSkills),
    harnessBAgents: path.resolve(p.harnessBAgents),
    registry: path.resolve(p.registry),
    skillDir: path.resolve(p.skillDir),
    skillMd: path.resolve(p.skillMd),
    fixtureJson: path.resolve(p.fixtureJson ?? fixtureJson),
    acceptanceReport: path.resolve(p.acceptanceReport ?? path.join(root, 'acceptance-report.json'))
  }
  for (const key of ['bare', 'vault', 'wslSide']) {
    if (!fs.existsSync(paths[key])) {
      throw new Error(`夹具不完整：缺少 ${key} 目录 ${paths[key]}，请重新运行 init-fixture.mjs`)
    }
  }
  return { fixture: fx, paths, branch: fx.branch ?? 'main', skillName: fx.skillName ?? SKILL_NAME }
}

// ---------------------------------------------------------------------------
// 4. 小工具
// ---------------------------------------------------------------------------

/** 文件 SHA-256（十六进制）；文件不存在返回 null */
function sha256File(file) {
  if (!fs.existsSync(file)) return null
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 读文本（不存在返回 null） */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** lstat 安全包装 */
function lstatSafe(p) {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

/**
 * 直接执行一条 git 命令（探针类只读检查 / 演练编排）。
 * 与 src/main/git.ts 的 GIT_TEXT_ARGS 保持一致（core.quotepath=false + UTF-8 日志编码）。
 */
function gitProbe(cwd, args) {
  const r = cp.spawnSync(
    'git',
    ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8', ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
    }
  )
  return {
    ok: r.status === 0,
    exitCode: r.status ?? -1,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString()
  }
}

/** 仓库里是否残留合并/变基中间态 */
function residualState(repo) {
  const gitDir = path.join(repo, '.git')
  const markers = {
    MERGE_HEAD: fs.existsSync(path.join(gitDir, 'MERGE_HEAD')),
    'rebase-merge': fs.existsSync(path.join(gitDir, 'rebase-merge')),
    'rebase-apply': fs.existsSync(path.join(gitDir, 'rebase-apply')),
    CHERRY_PICK_HEAD: fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD')),
    REVERT_HEAD: fs.existsSync(path.join(gitDir, 'REVERT_HEAD')),
    'index.lock': fs.existsSync(path.join(gitDir, 'index.lock'))
  }
  return { any: Object.values(markers).some(Boolean), markers }
}

/** 截断输出尾部（完整内容在 gitCommands 里） */
function tail(s, n = 600) {
  const t = String(s ?? '').trim()
  return t.length > n ? '…' + t.slice(-n) : t
}

/**
 * 从产品源码里抽出「本脚本用到的 git 命令」在源码中的出处（文件 + 行号 + 原行文本）。
 * WHY：脚本里的每条命令都声称「和产品一模一样」，那就必须给出可核对的出处——
 * 评审者可以按行号自己去源码里对，而不是只能相信脚本的说法。
 */
function extractSourceEvidence() {
  const wanted = [
    { file: 'src/main/sync.ts', needle: "['add', '-A']" },
    { file: 'src/main/sync.ts', needle: "['status', '--porcelain']" },
    { file: 'src/main/sync.ts', needle: "['commit', '-m'" },
    { file: 'src/main/sync.ts', needle: "['push', 'origin', 'main']" },
    { file: 'src/main/sync.ts', needle: "['pull', '--no-rebase', '--no-edit', 'origin', 'main']" },
    { file: 'src/main/sync.ts', needle: "['rev-parse', '-q', '--verify', 'MERGE_HEAD']" },
    { file: 'src/main/sync.ts', needle: "['diff', '--name-only', '--diff-filter=U']" },
    { file: 'src/main/sync.ts', needle: "['merge', '--abort']" },
    { file: 'src/companion/skm.ts', needle: "gitRun(['add', '-A'])" },
    { file: 'src/companion/skm.ts', needle: "gitRun(['status', '--porcelain'])" },
    { file: 'src/companion/skm.ts', needle: "gitRun(['commit', '-m'" },
    { file: 'src/companion/skm.ts', needle: "gitRun(['pull', '--rebase', 'origin', 'main'])" },
    { file: 'src/companion/skm.ts', needle: "gitRun(['push', 'origin', 'main'])" },
    { file: 'src/main/git.ts', needle: 'core.quotepath=false' },
    { file: 'src/main/git.ts', needle: 'i18n.logOutputEncoding=UTF-8' }
  ]
  const out = []
  for (const w of wanted) {
    const abs = path.join(REPO_ROOT, w.file)
    if (!fs.existsSync(abs)) {
      out.push({ file: w.file, needle: w.needle, found: false, line: null, text: null })
      continue
    }
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
    let hit = null
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(w.needle)) {
        hit = { line: i + 1, text: lines[i].trim() }
        break
      }
    }
    out.push({ file: w.file, needle: w.needle, found: !!hit, line: hit?.line ?? null, text: hit?.text ?? null })
  }
  return out
}

// ---------------------------------------------------------------------------
// 5. 步骤实现
// ---------------------------------------------------------------------------

/** 把产品的 SyncStep 列表转成报告结构 */
function dumpSteps(steps) {
  return steps.map((s) => ({
    side: s.side,
    cmd: s.cmd,
    ok: s.ok,
    skipped: s.skipped ?? false,
    detail: tail(s.detail, 400)
  }))
}

/**
 * 跑一轮真实的 syncAll()（产品编排）。
 * 产品顺序（src/main/sync.ts）：
 *   Windows: add -A → status → (有 diff) commit → push origin main
 *   WSL    : companion sync（add -A → commit → pull --rebase → push）
 *   Windows: pull --no-rebase --no-edit origin main
 */
async function runProductSync(ctx) {
  const settings = {
    vaultPath: ctx.paths.vault,
    barePath: ctx.paths.bare,
    wslDistro: 'FIXTURE',
    deepseekHarnessRoot: '',
    remoteTargets: []
  }
  // 新版 syncAll(settings, deps) 支持注入 companionFn；旧版没有 deps 参数 → 走手工编排分支
  const result = ctx.supportsDeps
    ? await ctx.syncAll(settings, { companionFn: ctx.companionFn })
    : await ctx.syncAllLegacy(settings, ctx)
  return {
    result,
    windowsSteps: result.steps.filter((s) => s.side === 'windows'),
    wslSteps: result.steps.filter((s) => s.side === 'wsl')
  }
}

/**
 * 把夹具的三个仓库复位到 fixture.json 记录的基线提交。
 *
 * WHY 必须复位：验收脚本要求「可反复运行」（评审者往往会连跑两遍对比）。
 *   第 1 跑会在 vault 里留下 newfile.txt、在 wsl-side 里留下 wsl.txt、裸仓也会前进；
 *   第 2 跑时这些文件已存在且内容相同 → git 看不到任何 diff → 产品会走「无变更，跳过 commit」
 *   分支，验收就测不到「提交 → 推送 → 变基拉取 → 回拉」这条主链路了。
 *   所以每次运行都先把 vault / wsl-side / bare 复位到基线提交，保证每次都是同一条完整链路。
 * 复位用 git 自己的命令（reset --hard + clean -fd + update-ref），不动夹具目录之外的东西。
 * 夹具本就是一次性可丢弃的沙盘，复位不会造成用户数据损失。
 */
async function resetFixtureToBaseline(ctx) {
  const { paths } = ctx
  const base = ctx.fixture.commits?.vault ?? ctx.fixture.commits?.bare ?? null
  if (!base) {
    return {
      name: 'step0b-fixture-reset',
      title: '夹具复位：把 vault / wsl-side / bare 复位到基线提交（保证脚本可反复运行）',
      pass: true,
      details: { skipped: true, reason: 'fixture.json 未记录基线提交，跳过复位' }
    }
  }
  const resetCmds = []
  const runReset = async (cwd, args) => {
    const r = await ctx.gitRun(cwd, args)
    resetCmds.push({ cwd, cmd: `git ${args.join(' ')}`, exitCode: r.status, ok: r.ok, stderrTail: tail(r.stderr, 200) })
    return r
  }
  for (const repo of [paths.vault, paths.wslSide]) {
    await runReset(repo, ['checkout', ctx.branch])
    await runReset(repo, ['reset', '--hard', base])
    await runReset(repo, ['clean', '-fd'])
  }
  // 裸仓：把 main 拨回基线（演练/往返推进过的提交全部丢弃），并确保 HEAD 仍指向 main
  await runReset(paths.bare, ['update-ref', `refs/heads/${ctx.branch}`, base])
  await runReset(paths.bare, ['symbolic-ref', 'HEAD', `refs/heads/${ctx.branch}`])

  const heads = {
    vault: gitProbe(paths.vault, ['rev-parse', 'HEAD']).stdout.trim(),
    wslSide: gitProbe(paths.wslSide, ['rev-parse', 'HEAD']).stdout.trim(),
    bare: gitProbe(paths.bare, ['rev-parse', ctx.branch]).stdout.trim()
  }
  const statuses = {
    vault: gitProbe(paths.vault, ['status', '--porcelain']).stdout.trim(),
    wslSide: gitProbe(paths.wslSide, ['status', '--porcelain']).stdout.trim()
  }
  return {
    name: 'step0b-fixture-reset',
    title: '夹具复位：把 vault / wsl-side / bare 复位到基线提交（保证脚本可反复运行）',
    pass:
      heads.vault === base &&
      heads.wslSide === base &&
      heads.bare === base &&
      statuses.vault === '' &&
      statuses.wslSide === '',
    details: {
      baselineCommit: base,
      headsAfterReset: heads,
      statusAfterReset: statuses,
      commands: resetCmds
    }
  }
}

/**
 * 步骤 0 —— 前置检查：夹具里的 registry.json 必须能被产品 parseRegistry 接受（v3），
 * SKILL.md 的 frontmatter 必须能被产品 parseFrontmatter 解析出 name/description。
 */
function step0Precheck(ctx) {
  const { paths } = ctx
  const registryText = readText(paths.registry)
  const registryParsed =
    registryText !== null ? ctx.parseRegistry(registryText) : { ok: false, error: 'registry.json 不存在' }
  const skillMdText = readText(paths.skillMd)
  const fm = skillMdText !== null ? ctx.parseFrontmatter(skillMdText) : {}
  return {
    name: 'step0-fixture-precheck',
    title: '前置检查：registry.json 能被产品 parseRegistry 解析（v3）/ SKILL.md frontmatter 合法',
    pass:
      registryParsed.ok === true &&
      registryParsed.registry.version === 3 &&
      Array.isArray(registryParsed.registry.agents) &&
      registryParsed.registry.agents.length > 0 &&
      !!fm.name &&
      !!fm.description,
    details: {
      registryPath: paths.registry,
      registryParseOk: registryParsed.ok === true,
      registryError: registryParsed.ok ? null : registryParsed.error,
      registryVersion: registryParsed.ok ? registryParsed.registry.version : null,
      registryAgents: registryParsed.ok
        ? registryParsed.registry.agents.map((a) => ({
            name: a.name,
            platform: a.platform,
            skillsDir: a.skillsDir,
            include: a.include,
            source: a.source,
            enabled: a.enabled
          }))
        : [],
      skillMdPath: paths.skillMd,
      frontmatter: fm,
      skillMdSha256: sha256File(paths.skillMd),
      registrySha256: sha256File(paths.registry)
    }
  }
}

/**
 * 步骤 1 —— Windows 侧提交并推送。
 * 走**真实**的 syncAll()：Windows 侧 add -A → status → commit → push origin main。
 */
async function step1WindowsPush(ctx) {
  const { paths } = ctx
  const newFile = path.join(paths.skillDir, 'newfile.txt')
  fs.writeFileSync(newFile, '由 verify-roundtrip.mjs 写入的 Windows 侧文件。\n', 'utf8')

  const before = {
    vaultHead: gitProbe(paths.vault, ['rev-parse', 'HEAD']).stdout.trim(),
    bareHead: gitProbe(paths.bare, ['rev-parse', 'HEAD']).stdout.trim()
  }

  const { result, windowsSteps } = await runProductSync(ctx)
  const after = {
    vaultHead: gitProbe(paths.vault, ['rev-parse', 'HEAD']).stdout.trim(),
    bareHead: gitProbe(paths.bare, ['rev-parse', 'HEAD']).stdout.trim()
  }

  const commitStep = windowsSteps.find((s) => s.cmd === 'git commit')
  const pushStep = windowsSteps.find((s) => s.cmd === 'git push origin main')

  return {
    name: 'step1-windows-commit-and-push',
    title: 'Windows 侧：写入新文件 → add -A → commit → push origin main（真实 syncAll 编排）',
    pass:
      !!commitStep &&
      commitStep.ok &&
      !!pushStep &&
      pushStep.ok &&
      after.vaultHead !== before.vaultHead &&
      after.bareHead === after.vaultHead &&
      sha256File(newFile) !== null,
    details: {
      newFile,
      newFileSha256: sha256File(newFile),
      before,
      after,
      commitSha: after.vaultHead,
      bareHeadAfter: after.bareHead,
      pushedToBare: after.bareHead === after.vaultHead,
      productSteps: dumpSteps(result.steps),
      productConflicts: result.conflicts,
      productAborted: result.aborted ?? false,
      productAbortReason: result.abortReason ?? null
    }
  }
}

/**
 * 步骤 2 —— WSL 侧（companion）提交 → 变基拉取 → 推送，Windows 侧再回拉拿到。
 * WSL 侧由**真实**的 src/companion/skm.ts 以子进程方式执行（SKM_VAULT 指向夹具 wsl-side）。
 * Windows 侧的回拉同样由真实 syncAll() 完成（产品顺序：push → companion → pull）。
 */
async function step2WslSideSync(ctx) {
  const { paths } = ctx
  const wslFile = path.join(paths.wslSide, 'skills', ctx.skillName, 'wsl.txt')
  fs.mkdirSync(path.dirname(wslFile), { recursive: true })
  fs.writeFileSync(wslFile, '由 verify-roundtrip.mjs 写入的 WSL 侧文件。\n', 'utf8')

  const before = {
    wslHead: gitProbe(paths.wslSide, ['rev-parse', 'HEAD']).stdout.trim(),
    vaultHead: gitProbe(paths.vault, ['rev-parse', 'HEAD']).stdout.trim()
  }

  // 真实产品编排：companion 在 Windows push 之后、最终 pull 之前把 WSL 的改动推上裸仓
  const { result, windowsSteps, wslSteps } = await runProductSync(ctx)
  const companionPull = wslSteps.find((s) => s.cmd === 'git pull --rebase origin main')
  const companionPush = wslSteps.find((s) => s.cmd === 'git push origin main')
  const windowsPull = windowsSteps.find((s) => s.cmd === 'git pull --no-rebase origin main')

  const after = {
    wslHead: gitProbe(paths.wslSide, ['rev-parse', 'HEAD']).stdout.trim(),
    vaultHead: gitProbe(paths.vault, ['rev-parse', 'HEAD']).stdout.trim(),
    bareHead: gitProbe(paths.bare, ['rev-parse', 'HEAD']).stdout.trim()
  }
  const vaultWslFile = path.join(paths.skillDir, 'wsl.txt')
  const vaultHasWslFile = fs.existsSync(vaultWslFile)

  return {
    name: 'step2-wsl-side-sync',
    title:
      'WSL 侧：companion sync（add -A → commit → pull --rebase → push）→ Windows 侧回拉拿到 wsl.txt',
    pass:
      !!companionPull &&
      companionPull.ok &&
      !!companionPush &&
      companionPush.ok &&
      !!windowsPull &&
      windowsPull.ok &&
      after.wslHead !== before.wslHead &&
      after.bareHead === after.wslHead &&
      after.vaultHead === after.wslHead &&
      vaultHasWslFile,
    details: {
      wslFile,
      wslFileSha256: sha256File(wslFile),
      before,
      after,
      productSteps: dumpSteps(result.steps),
      productConflicts: result.conflicts,
      productAborted: result.aborted ?? false,
      companionPullOk: companionPull?.ok ?? false,
      companionPushOk: companionPush?.ok ?? false,
      windowsPullOk: windowsPull?.ok ?? false,
      vaultHasWslFile,
      vaultWslFileSha256: sha256File(vaultWslFile),
      vaultWslFileContentMatches: readText(vaultWslFile) === readText(wslFile)
    }
  }
}

/**
 * 步骤 3 —— 冲突演练。
 *
 * WHY 用「独立演练仓」而不是主夹具的 vault/wsl-side：
 *   冲突演练必然在裸仓里留下一条分叉历史（Windows 侧提交被拒、WSL 侧提交已推）。
 *   如果直接在主夹具上演练，主夹具的裸仓历史会被永久改写，脚本就**不可重复运行**
 *   （第二次跑时 Windows 侧的 push 必然又被拒，步骤 1 直接失败）。
 *   评审者必须能反复跑同一份夹具，所以演练放到 <夹具根>/drill/ 下的独立裸仓 + 两个克隆里，
 *   主夹具的 vault / wsl-side / bare 全程不受影响。
 *
 * 演练内容（与产品 src/main/sync.ts 第 3 段的命令序列完全一致）：
 *   a. WSL 侧提交并推送 conflict.txt（WSL 内容）→ 裸仓前进
 *   b. Windows 侧基于**旧提交**提交同名文件（Windows 内容）→ 它的 push 必然被拒
 *      （non-fast-forward；产品从不 force push，这正是「绝不丢数据」的体现）
 *   c. Windows 侧执行产品同款 pull：git pull --no-rebase --no-edit origin main
 *      → 分叉合并必然冲突 → 产生 MERGE_HEAD
 *   d. 产品同款收集命令：git diff --name-only --diff-filter=U
 *   e. 产品同款恢复命令：git merge --abort
 *   校验：(a) 冲突被中止 (b) 双方内容都还在磁盘（零丢失） (c) 无任何残留合并/变基状态
 */
async function step3ConflictDrill(ctx) {
  const { paths } = ctx
  const drillRoot = path.join(paths.root, 'drill')
  const drillBare = path.join(drillRoot, 'bare.git')
  const drillVault = path.join(drillRoot, 'vault')
  const drillWsl = path.join(drillRoot, 'wsl-side')

  // 演练仓重建：每次从零开始，保证脚本可重复运行
  fs.rmSync(drillRoot, { recursive: true, force: true })
  fs.mkdirSync(drillRoot, { recursive: true })

  const git = ctx.gitRun // 产品的 git 执行函数（gitAsync / git）
  const branch = ctx.branch

  // --- 演练仓骨架：裸仓 + 一个共同基线提交 + 两个克隆 ---
  // 用产品自己的 git 执行函数搭骨架（而不是另写一套 spawn），保证演练仓的 git 行为与产品一致
  const initBare = await git(drillRoot, ['init', '--bare', drillBare])
  const initVault = await git(drillRoot, ['init', '-b', branch, drillVault])
  const skeleton = [
    { cmd: 'git init --bare <drill>/bare.git', exitCode: initBare.status, ok: initBare.ok },
    { cmd: `git init -b ${branch} <drill>/vault`, exitCode: initVault.status, ok: initVault.ok }
  ]
  // 裸仓 HEAD 指向 main（app 的 push/pull 全部硬编码 main，分支名不一致会直接 refspec 不匹配）
  await git(drillBare, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  for (const repo of [drillVault]) {
    await git(repo, ['config', 'user.name', 'SkillVault Fixture', '--local'])
    await git(repo, ['config', 'user.email', 'fixture@example.invalid', '--local'])
    await git(repo, ['config', 'core.autocrlf', 'false', '--local'])
  }
  await git(drillVault, ['remote', 'add', 'origin', drillBare])
  fs.mkdirSync(path.join(drillVault, 'skills', ctx.skillName), { recursive: true })
  fs.writeFileSync(
    path.join(drillVault, 'skills', ctx.skillName, 'SKILL.md'),
    `---\nname: ${ctx.skillName}\ndescription: 演练用基线技能。\n---\n`,
    'utf8'
  )
  await git(drillVault, ['add', '-A'])
  await git(drillVault, ['commit', '-m', 'chore: 冲突演练基线'])
  await git(drillVault, ['push', '-u', 'origin', branch])
  // 裸仓 HEAD 再次指向 main：clone 会跟随裸仓 HEAD 选默认分支，必须在 clone 之前定好
  await git(drillBare, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  // clone 必须放在「基线已推送」之后：否则克隆出来的是空仓 + master 分支，
  // 后续 companion 的 push origin main 会直接 "src refspec main does not match any"
  const initWsl = await git(drillRoot, ['clone', drillBare, drillWsl])
  skeleton.push({ cmd: 'git clone <drill>/bare.git <drill>/wsl-side', exitCode: initWsl.status, ok: initWsl.ok })
  for (const repo of [drillWsl]) {
    await git(repo, ['config', 'user.name', 'SkillVault Fixture', '--local'])
    await git(repo, ['config', 'user.email', 'fixture@example.invalid', '--local'])
    await git(repo, ['config', 'core.autocrlf', 'false', '--local'])
  }
  await git(drillWsl, ['checkout', branch])
  await git(drillWsl, ['branch', '--set-upstream-to', `origin/${branch}`, branch])

  const rel = 'skills/' + ctx.skillName + '/conflict.txt'
  const winFile = path.join(drillVault, ...rel.split('/'))
  const wslFile = path.join(drillWsl, ...rel.split('/'))
  const windowsContent = 'Windows 侧的冲突内容（唯一标记：WINDOWS-SIDE-8f2c）。\n'
  const wslContent = 'WSL 侧的冲突内容（唯一标记：WSL-SIDE-4b7a）。\n'

  // --- a. WSL 侧提交并推送（用真实 companion 跑它的 add/commit/pull --rebase/push 序列）---
  fs.mkdirSync(path.dirname(wslFile), { recursive: true })
  fs.writeFileSync(wslFile, wslContent, 'utf8')
  const companion = await ctx.runCompanionIn(drillWsl, ['sync'], 180000)
  const companionParsed = companion.parsed
  const companionSteps = companionParsed && Array.isArray(companionParsed.steps) ? companionParsed.steps : []

  // --- b. Windows 侧提交同名不同内容的文件（基于旧提交 → 与裸仓分叉）---
  fs.mkdirSync(path.dirname(winFile), { recursive: true })
  fs.writeFileSync(winFile, windowsContent, 'utf8')
  const winAdd = await git(drillVault, ['add', '-A'])
  const winCommit = await git(drillVault, ['commit', '-m', 'verify: Windows 侧冲突内容'])
  const winPush = await git(drillVault, ['push', 'origin', branch]) // 预期被拒（non-fast-forward）

  const headsBeforePull = {
    vault: gitProbe(drillVault, ['rev-parse', 'HEAD']).stdout.trim(),
    bare: gitProbe(drillBare, ['rev-parse', branch]).stdout.trim(),
    wsl: gitProbe(drillWsl, ['rev-parse', 'HEAD']).stdout.trim()
  }

  // --- c. 产品同款 pull（src/main/sync.ts 第 3 段）---
  const pull = await git(drillVault, ['pull', '--no-rebase', '--no-edit', 'origin', branch])
  const mergeHeadProbe = await git(drillVault, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  const mergeHeadPresent = mergeHeadProbe.ok && mergeHeadProbe.stdout.trim().length > 0

  // --- d. 产品同款收集命令 ---
  const unmerged = await git(drillVault, ['diff', '--name-only', '--diff-filter=U'])
  const unmergedFiles = unmerged.stdout
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)

  // 中止前的现场内容留证
  const conflictedFileContentBeforeAbort = readText(winFile)

  // --- e. 产品同款恢复命令 ---
  const abort = await git(drillVault, ['merge', '--abort'])

  // --- 中止后的校验 ---
  const mergeHeadAfter = await git(drillVault, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  const mergeHeadGone = !mergeHeadAfter.ok || mergeHeadAfter.stdout.trim().length === 0
  const residual = residualState(drillVault)
  const residualWsl = residualState(drillWsl)
  const windowsSideContent = readText(winFile)
  const wslSideContent = readText(wslFile)
  const windowsKept = windowsSideContent === windowsContent
  const wslKept = wslSideContent === wslContent
  const headsAfterAbort = {
    vault: gitProbe(drillVault, ['rev-parse', 'HEAD']).stdout.trim(),
    bare: gitProbe(drillBare, ['rev-parse', branch]).stdout.trim(),
    wsl: gitProbe(drillWsl, ['rev-parse', 'HEAD']).stdout.trim()
  }
  // 中止后 Windows 侧应回到「自己的提交」状态（本地提交仍在，未被合并覆盖）
  const windowsCommitPreserved = headsAfterAbort.vault === headsBeforePull.vault

  return {
    name: 'step3-conflict-drill',
    title: '冲突演练：双方同文件不同内容 → pull 冲突 → 收集未合并文件 → merge --abort → 零丢失',
    pass:
      !pull.ok &&
      mergeHeadPresent &&
      unmergedFiles.includes(rel) &&
      abort.ok &&
      mergeHeadGone &&
      !residual.any &&
      !residualWsl.any &&
      windowsKept &&
      wslKept &&
      windowsCommitPreserved,
    details: {
      drillRoot,
      drillBare,
      drillVault,
      drillWsl,
      skeleton,
      relativePath: rel,
      windowsContentSha256: crypto.createHash('sha256').update(windowsContent).digest('hex'),
      wslContentSha256: crypto.createHash('sha256').update(wslContent).digest('hex'),
      companionSteps: companionSteps.map((s) => ({
        side: s.side,
        cmd: s.cmd,
        ok: s.ok,
        skipped: s.skipped ?? false,
        detail: tail(s.detail, 300)
      })),
      companionOk: companion.ok,
      commits: {
        windowsAddExit: winAdd.status,
        windowsCommitExit: winCommit.status,
        windowsPushExit: winPush.status,
        windowsPushRejectedAsExpected: !winPush.ok,
        windowsPushStderrTail: tail(winPush.stderr, 300)
      },
      headsBeforePull,
      headsAfterAbort,
      windowsCommitPreservedAfterAbort: windowsCommitPreserved,
      pull: {
        cmd: `git pull --no-rebase --no-edit origin ${branch}`,
        exitCode: pull.status,
        ok: pull.ok,
        stdoutTail: tail(pull.stdout, 600),
        stderrTail: tail(pull.stderr, 600)
      },
      mergeHeadDetected: mergeHeadPresent,
      mergeHeadSha: mergeHeadProbe.stdout.trim(),
      unmergedFiles,
      unmergedCommand: 'git diff --name-only --diff-filter=U',
      conflictedFileContentBeforeAbort,
      abort: {
        cmd: 'git merge --abort',
        exitCode: abort.status,
        ok: abort.ok,
        stdoutTail: tail(abort.stdout, 300),
        stderrTail: tail(abort.stderr, 300)
      },
      mergeHeadGoneAfterAbort: mergeHeadGone,
      residualState: residual,
      residualStateWslSide: residualWsl,
      dataLoss: {
        windowsSideContentPreserved: windowsKept,
        wslSideContentPreserved: wslKept,
        windowsSideSha256: sha256File(winFile),
        wslSideSha256: sha256File(wslFile)
      }
    }
  }
}

/**
 * 判定链接形态：junction / symlink / hardlink / none。
 * WHY 需要专门判定：Windows 上 Node 的 lstat 把 junction 和 symlink 都报成
 * isSymbolicLink=true（junction 是 NTFS reparse point），光看 lstat 分不出来。
 *   - PowerShell 的 Get-Item .LinkType 能权威区分 Junction / SymbolicLink / HardLink
 *   - 硬链接另用 dev+ino 判定（与产品 src/main/winLinks.ts 的 sameFileByIno 同思路）
 * 两者都拿不到时退化为「symlink/junction 未知」，绝不编造结论。
 */
function detectLinkKind(linkPath, targetPath) {
  const kind = { linkType: 'none', detectedBy: 'node-fs', linkTypeRaw: null, error: null }
  const lstat = lstatSafe(linkPath)
  if (!lstat || !lstat.isSymbolicLink()) {
    // 非链接：可能是硬链接共享目录（产品 agentsDir 的形态）
    try {
      const a = fs.statSync(linkPath)
      const b = fs.statSync(targetPath)
      if (a.ino === b.ino && a.dev === b.dev) {
        kind.linkType = 'hardlink'
        kind.detectedBy = 'node-fs-inode'
      }
    } catch {
      /* ignore */
    }
    return kind
  }
  // Windows：用 PowerShell 权威判定 LinkType
  if (process.platform === 'win32') {
    try {
      const r = cp.spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Item -Force -LiteralPath '${linkPath.replace(/'/g, "''")}').LinkType`
        ],
        { encoding: 'utf8', timeout: 20000, windowsHide: true }
      )
      const out = (r.stdout ?? '').trim()
      if (r.status === 0 && out) {
        kind.linkTypeRaw = out
        kind.detectedBy = 'powershell-LinkType'
        kind.linkType = out.toLowerCase() === 'junction' ? 'junction' : out.toLowerCase()
        return kind
      }
      kind.error = `PowerShell LinkType 探测失败（status=${r.status}）：${tail(r.stderr || r.stdout, 200)}`
    } catch (e) {
      kind.error = String(e && e.message ? e.message : e)
    }
  }
  // 退化判定：链接存在但无法区分 junction / symlink
  kind.linkType = 'symlink-or-junction'
  kind.detectedBy = 'node-fs-lstat'
  return kind
}

/**
 * 步骤 4 —— 链接状态检查。
 * 用产品的 createJunction()（src/main/winLinks.ts）建链接，用产品的 getLinkState() 判定状态；
 * 最后验证「写进 vault 源目录的内容，能透过 harness 路径读到」——这才是「链接真的生效」的判据。
 */
async function step4LinkState(ctx) {
  const { paths } = ctx
  const vaultSkillDir = path.join(paths.vault, 'skills', ctx.skillName)
  const linkPath = path.join(paths.harnessASkills, ctx.skillName)

  // 已存在就先摘掉（只删链接本身；真实目录改名为 .bak，绝不删除用户数据）
  const pre = lstatSafe(linkPath)
  let preKind = 'missing'
  let backupDir = null
  if (pre && pre.isSymbolicLink()) {
    fs.rmSync(linkPath, { force: true })
    preKind = 'symlink-removed'
  } else if (pre) {
    backupDir = `${linkPath}.bak-${Date.now()}`
    fs.renameSync(linkPath, backupDir)
    preKind = 'real-dir-renamed'
  }

  // 用产品的真实函数建 junction（Windows 免管理员权限）
  let requestedLinkType = 'junction'
  let createError = null
  try {
    ctx.createJunction(vaultSkillDir, linkPath)
  } catch (e) {
    createError = String(e && e.message ? e.message : e)
    try {
      fs.symlinkSync(path.resolve(vaultSkillDir), linkPath, 'junction')
    } catch {
      try {
        fs.symlinkSync(path.resolve(vaultSkillDir), linkPath, 'dir')
        requestedLinkType = 'symlink'
      } catch (e2) {
        createError = String(e2 && e2.message ? e2.message : e2)
      }
    }
  }

  const lstat = lstatSafe(linkPath)
  const isSym = !!lstat && lstat.isSymbolicLink()
  let readlinkTarget = null
  try {
    readlinkTarget = fs.readlinkSync(linkPath)
  } catch {
    readlinkTarget = null
  }
  let realTarget = null
  try {
    realTarget = fs.realpathSync(linkPath)
  } catch {
    realTarget = null
  }
  const sameInode = (() => {
    try {
      return fs.statSync(linkPath).ino === fs.statSync(vaultSkillDir).ino
    } catch {
      return false
    }
  })()

  // 链接形态判定：junction / symlink / hardlink（junction 与 symlink 在 Node 的 lstat 里长一样，
  // 靠 PowerShell 的 .LinkType 权威区分）
  const kind = detectLinkKind(linkPath, vaultSkillDir)

  // 链接五态：用产品自己的判定函数
  const state = ctx.getLinkState(linkPath, vaultSkillDir)

  // 关键判据：往 vault 源目录写文件，透过 harness 路径能不能读到
  const probeName = 'link-probe.txt'
  const probeInVault = path.join(vaultSkillDir, probeName)
  const probeInHarness = path.join(linkPath, probeName)
  const probeContent = 'link-probe: 由 verify-roundtrip.mjs 写入\n'
  fs.writeFileSync(probeInVault, probeContent, 'utf8')
  const visibleThroughLink = fs.existsSync(probeInHarness)
  const harnessSha = sha256File(probeInHarness)
  const vaultSha = sha256File(probeInVault)
  const hashesMatch = visibleThroughLink && vaultSha !== null && vaultSha === harnessSha

  // 反向：从 harness 路径写入，vault 源目录能否看到
  const reverseContent = 'link-probe-reverse: 从 harness 侧写入\n'
  fs.writeFileSync(probeInHarness, reverseContent, 'utf8')
  const reverseVisible = readText(probeInVault) === reverseContent

  // 清理探针文件：它们是演练产物，不能留在仓库里（否则终态检查会看到未跟踪文件）
  for (const f of [probeInVault, probeInHarness]) {
    try {
      fs.rmSync(f, { force: true })
    } catch {
      /* ignore */
    }
  }

  return {
    name: 'step4-link-state',
    title: '链接状态：harness/skills/<skill> → vault/skills/<skill>（真实 junction，写入互相可见）',
    pass: state === 'linked' && visibleThroughLink && hashesMatch && reverseVisible && isSym,
    details: {
      linkPath,
      target: vaultSkillDir,
      linkType: kind.linkType,
      linkTypeRequested: requestedLinkType,
      linkTypeRaw: kind.linkTypeRaw,
      linkTypeDetectedBy: kind.detectedBy,
      linkTypeDetectionError: kind.error,
      linkState: state,
      linkStateVocabulary: ['linked', 'missing', 'wrong-target', 'real-dir', 'vault-missing'],
      isSymbolicLink: isSym,
      previousStateAtLinkPath: preKind,
      backupDir,
      readlinkTarget,
      realpathTarget: realTarget,
      sameInodeAsTarget: sameInode,
      createError,
      probe: {
        file: probeName,
        writtenToVaultSha256: vaultSha,
        visibleThroughHarnessPath: visibleThroughLink,
        harnessSha256: harnessSha,
        sha256Match: hashesMatch,
        reverseWriteVisibleInVault: reverseVisible,
        cleanedUp: !fs.existsSync(probeInVault)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 6. 主流程
// ---------------------------------------------------------------------------

/**
 * 构造「本地夹具版 runCompanion」。
 * 与 src/main/wslBridge.ts 的 runCompanion 语义一致：
 *   - 跑 companion（stdout 恒为单个 JSON）→ 用与 extractJson 同款的逻辑解析（容忍噪声/空字节/BOM）
 *   - 解析失败 → parseError，绝不假装成功
 * 差别只有一个：wsl.exe 换成本机 node + 仓库里的 src/companion/skm.ts，
 * 且 SKM_VAULT 指向夹具里的 wsl-side 目录（模拟 WSL 侧 vault）。
 */
function makeCompanionFn(paths) {
  const skmPath = path.join(REPO_ROOT, 'src', 'companion', 'skm.ts')
  const logFile = path.join(paths.root, '.verify-companion-gitlog.jsonl')
  // 预加载脚本必须落成真实文件：Windows 上 node --import 只认 file:// URL（data: URL 会直接报错）
  const preloadFile = path.join(paths.root, '.verify-child-preload.mjs')
  fs.writeFileSync(preloadFile, CHILD_PRELOAD, 'utf8')
  const preloadUrl = pathToFileURL(preloadFile).href

  const run = async (vaultPath, args, timeoutMs = 120000) => {
    fs.rmSync(logFile, { force: true })
    const r = cp.spawnSync(
      process.execPath,
      ['--no-warnings', '--import', preloadUrl, skmPath, ...args, '--json'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          SKM_VAULT: vaultPath,
          SV_GIT_LOG: logFile,
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C'
        }
      }
    )
    // 子进程里 companion 真实发出的 git 命令 → 汇入报告
    if (fs.existsSync(logFile)) {
      for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          childGitCalls.push({ ...JSON.parse(line), side: 'wsl', api: 'companion-child' })
        } catch {
          /* 忽略坏行 */
        }
      }
    }
    const stdout = (r.stdout ?? '').toString()
    const stderr = (r.stderr ?? '').toString()
    const parsed = extractJsonLikeBridge(stdout)
    return {
      ok: r.status === 0 && parsed !== null,
      status: r.status ?? -1,
      stdout,
      stderr,
      parsed: parsed ?? undefined,
      parseError: parsed
        ? undefined
        : `无法从 companion 输出解析 JSON: ${(stdout || stderr).slice(0, 300)}`
    }
  }

  const fn = async (distro, args, timeoutMs = 120000) => run(paths.wslSide, args, timeoutMs)
  fn.runIn = run
  return fn
}

/** 与 src/main/wslBridge.ts 的 extractJson 同款（去空字节/BOM → 首个 { 到末 }） */
function extractJsonLikeBridge(text) {
  const clean = String(text ?? '')
    .replace(/\0/g, '')
    .replace(/^\uFEFF/, '')
  const start = clean.indexOf('{')
  if (start < 0) return null
  const end = clean.lastIndexOf('}')
  if (end <= start) return null
  try {
    return JSON.parse(clean.slice(start, end + 1))
  } catch {
    return null
  }
}

async function main() {
  const { fixture, paths, branch, skillName } = loadFixture(fixtureRoot)

  // 顺序要求：先打补丁（.ts 解析钩子 + git 调用记录），再 import 产品模块。
  installGitRecorder()
  installTsHooks()

  // 真实产品模块（零构建直接跑 TS 源码）
  const syncMod = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'main', 'sync.ts')).href)
  const gitMod = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'main', 'git.ts')).href)
  const winLinksMod = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'main', 'winLinks.ts')).href)
  const registryMod = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'shared', 'registry.ts')).href)
  const frontmatterMod = await import(
    pathToFileURL(path.join(REPO_ROOT, 'src', 'shared', 'frontmatter.ts')).href
  )

  // 新版 git.ts 提供异步 gitAsync（产品已从 spawnSync 切到 spawn）；旧版只有同步 git()
  const gitRun = gitMod.gitAsync ?? gitMod.git
  const supportsDeps = typeof gitMod.gitAsync === 'function'

  const companionFn = makeCompanionFn(paths)

  const ctx = {
    paths,
    branch,
    skillName,
    fixture,
    syncAll: syncMod.syncAll,
    gitRun,
    supportsDeps,
    getLinkState: winLinksMod.getLinkState,
    createJunction: winLinksMod.createJunction,
    parseRegistry: registryMod.parseRegistry,
    parseFrontmatter: frontmatterMod.parseFrontmatter,
    runCompanion: companionFn,
    runCompanionIn: companionFn.runIn,
    companionFn,
    /**
     * 旧版 syncAll（无 deps 注入）的手工编排分支：严格复刻 src/main/sync.ts 的命令序列
     * （add -A → status → commit → push → companion sync → pull --no-rebase --no-edit）。
     */
    syncAllLegacy: async (settings, c) => {
      const steps = []
      const conflicts = []
      const record = (side, cmd, r) =>
        steps.push({ side, cmd, ok: r.ok, detail: (r.stderr || r.stdout || '').trim().slice(-600) })
      const g = await gitRun(settings.vaultPath, ['add', '-A'])
      record('windows', 'git add -A', g)
      const st = await gitRun(settings.vaultPath, ['status', '--porcelain'])
      if (st.stdout.trim()) {
        const cm = await gitRun(settings.vaultPath, ['commit', '-m', `skillvault sync ${new Date().toISOString()}`])
        record('windows', 'git commit', cm)
      } else {
        steps.push({ side: 'windows', cmd: 'git status（无变更，跳过 commit）', ok: true, detail: 'clean' })
      }
      const push = await gitRun(settings.vaultPath, ['push', 'origin', 'main'])
      record('windows', 'git push origin main', push)
      const comp = await c.companionFn(settings.wslDistro, ['sync'], 180000)
      const p = comp.parsed
      if (comp.ok && p && typeof p === 'object') {
        for (const s of p.steps ?? []) steps.push({ side: 'wsl', cmd: s.cmd, ok: s.ok, detail: (s.detail ?? '').slice(-600) })
        for (const cf of p.conflicts ?? []) conflicts.push(`wsl: ${cf}`)
      } else {
        steps.push({ side: 'wsl', cmd: 'skm sync', ok: false, detail: (comp.stderr || comp.parseError || '').slice(-600) })
        conflicts.push(`wsl companion 调用失败: ${(comp.stderr || comp.parseError || '').slice(-600)}`)
      }
      const pull = await gitRun(settings.vaultPath, ['pull', '--no-rebase', '--no-edit', 'origin', 'main'])
      record('windows', 'git pull --no-rebase origin main', pull)
      if (!pull.ok) {
        const mergeHead = await gitRun(settings.vaultPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
        if (mergeHead.ok) {
          const uf = await gitRun(settings.vaultPath, ['diff', '--name-only', '--diff-filter=U'])
          const files = uf.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
          await gitRun(settings.vaultPath, ['merge', '--abort'])
          conflicts.push(`windows pull 遇到合并冲突，已中止 merge 并保留双方改动待人工处理:\n${files.join('\n')}`)
        } else {
          conflicts.push(`windows pull 失败:\n${(pull.stderr || pull.stdout).trim()}`)
        }
      }
      return { steps, conflicts, aborted: false }
    }
  }

  const steps = []
  steps.push(step0Precheck(ctx))
  steps.push(await resetFixtureToBaseline(ctx))

  if (!steps[0].pass || !steps[1].pass) {
    // 前置检查不过就没必要继续跑同步（后续步骤必然连环失败，报告噪音大）
    const report = buildReport({ fixture, paths, branch, skillName, steps, abortedEarly: true })
    emit(report)
    return 1
  }

  steps.push(await step1WindowsPush(ctx))
  steps.push(await step2WslSideSync(ctx))
  steps.push(await step3ConflictDrill(ctx))
  steps.push(await step4LinkState(ctx))

  // 终态检查：vault 工作区必须干净，且无任何残留合并/变基状态
  const finalStatus = gitProbe(paths.vault, ['status', '--porcelain'])
  const finalResidual = residualState(paths.vault)
  const finalBranch = gitProbe(paths.vault, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  steps.push({
    name: 'step5-final-clean-state',
    title: '终态检查：vault 工作区干净 + 无残留合并/变基状态 + 仍在 main 分支',
    pass: finalStatus.stdout.trim() === '' && !finalResidual.any && finalBranch === branch,
    details: {
      finalGitStatusPorcelain: finalStatus.stdout,
      finalGitStatusIsEmpty: finalStatus.stdout.trim() === '',
      residualState: finalResidual,
      branch: finalBranch,
      expectedBranch: branch
    }
  })

  const report = buildReport({ fixture, paths, branch, skillName, steps, abortedEarly: false })
  emit(report)
  return report.ok ? 0 : 1
}

function buildReport({ fixture, paths, branch, skillName, steps, abortedEarly }) {
  const allPass = steps.every((s) => s.pass)
  const vaultHead = gitProbe(paths.vault, ['rev-parse', 'HEAD']).stdout.trim()
  const wslHead = gitProbe(paths.wslSide, ['rev-parse', 'HEAD']).stdout.trim()
  const bareHead = gitProbe(paths.bare, ['rev-parse', 'HEAD']).stdout.trim()
  const finalStatus = gitProbe(paths.vault, ['status', '--porcelain'])
  const dump = (c) => ({
    cmd: c.cmd,
    cwd: c.cwd,
    side: c.side ?? 'windows',
    api: c.api ?? 'node-fs',
    exitCode: c.exitCode,
    ok: c.ok,
    stdoutTail: tail(c.stdout, 500),
    stderrTail: tail(c.stderr, 500)
  })
  return {
    tool: 'scripts/verify-roundtrip.mjs',
    ok: allPass,
    abortedEarly,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    gitVersion: gitProbe(paths.vault, ['--version']).stdout.trim(),
    fixtureRoot: paths.root,
    fixtureCreatedAt: fixture.createdAt ?? null,
    branch,
    skillName,
    paths,
    commits: { vault: vaultHead, wslSide: wslHead, bare: bareHead },
    steps,
    // 产品真实执行过的 git 命令（含退出码与输出尾部）——由 spawnSync/spawn 补丁 + companion 子进程日志采集
    gitCommands: [...gitCalls.map(dump), ...childGitCalls.map(dump)],
    // 本脚本用到的每条 git 命令在产品源码中的出处（文件 + 行号），供评审者逐行核对
    sourceEvidence: extractSourceEvidence(),
    finalGitStatusPorcelain: finalStatus.stdout,
    finalGitStatusIsEmpty: finalStatus.stdout.trim() === ''
  }
}

function emit(report) {
  const json = JSON.stringify(report, null, 2)
  // 报告落盘：评审者可以直接打开看，也可以用机器读
  try {
    fs.mkdirSync(path.dirname(report.paths.acceptanceReport), { recursive: true })
    fs.writeFileSync(report.paths.acceptanceReport, json + '\n', 'utf8')
  } catch {
    /* 落盘失败不掩盖主结果 */
  }
  process.stdout.write(json + '\n')
  printHumanSummary(report)
}

function printHumanSummary(report) {
  const lines = []
  lines.push('')
  lines.push('================ SkillVault 双端往返验收 ================')
  lines.push(`夹具根目录 : ${report.fixtureRoot}`)
  lines.push(`分支       : ${report.branch}    技能: ${report.skillName}`)
  lines.push(`Node / Git : ${report.node} / ${report.gitVersion}`)
  lines.push(
    `提交 SHA   : vault=${report.commits.vault.slice(0, 10)}  wsl=${report.commits.wslSide.slice(0, 10)}  bare=${report.commits.bare.slice(0, 10)}`
  )
  lines.push('')
  for (const s of report.steps) {
    lines.push(`${s.pass ? '[通过]' : '[失败]'} ${s.name}`)
    lines.push(`        ${s.title}`)
  }
  lines.push('')
  lines.push(`git 命令条数 : ${report.gitCommands.length}`)
  lines.push(
    `最终 git status --porcelain : ${report.finalGitStatusIsEmpty ? '(空，干净)' : JSON.stringify(report.finalGitStatusPorcelain)}`
  )
  lines.push(`验收报告     : ${report.paths.acceptanceReport}`)
  lines.push(`总体结论     : ${report.ok ? '全部通过 ✅' : '存在失败项 ❌'}`)
  lines.push('=========================================================')
  lines.push('')
  process.stderr.write(lines.join('\n'))
}

try {
  process.exitCode = await main()
} catch (e) {
  process.stderr.write(`verify-roundtrip 失败: ${e instanceof Error ? e.stack : String(e)}\n`)
  process.exitCode = 2
}
