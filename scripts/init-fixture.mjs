#!/usr/bin/env node
// ============================================================================
// scripts/init-fixture.mjs —— 一次性「可丢弃」的 SkillVault 测试夹具生成器
// ----------------------------------------------------------------------------
// 为什么需要它（评审背景）：
//   SkillVault 的核心链路是「Windows 侧 vault ⇄ 本地裸仓 ⇄ WSL 侧 vault」。
//   真机上跑这套链路要动用户自己的 ~/SkillVault、~/SkillVault.git、~/.zcode/skills……
//   一旦脚本写错路径，评审者真实的技能库可能被删、被覆盖、被提交进历史。
//   所以本脚本只做一件事：在 OS 临时目录里造一套**完全隔离**的沙盘
//   （bare 裸仓 + vault 工作仓 + wsl-side 第二克隆 + 两个假 harness 目录），
//   让人可以放心地跑 verify-roundtrip.mjs，验证完直接删掉整个临时目录即可。
//
// 硬性约束（与本仓库其它脚本一致）：
//   - 零 npm 依赖：只用 node:fs / node:path / node:child_process / node:os
//   - ESM（.mjs），直接 `node scripts/init-fixture.mjs <dir>` 即可运行，零构建步骤
//   - 绝不触碰用户 HOME / 真实 harness 配置 / fixture 根目录之外的任何路径
//   - git 身份**只写仓库本地配置**（--local），绝不写 --global，绝不污染用户全局 gitconfig
//
// 用法：
//   node scripts/init-fixture.mjs [目标根目录] [--force]
//   node scripts/init-fixture.mjs --help
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** 应用硬编码的分支名：src/main/sync.ts 与 src/companion/skm.ts 里 push/pull 的都是 main */
const BRANCH = 'main'
/** 夹具内 git 身份：固定值 → 同一夹具重建出同样的 author/committer，便于评审者比对 */
const FIXTURE_USER_NAME = 'SkillVault Fixture'
const FIXTURE_USER_EMAIL = 'fixture@example.invalid'
/** 默认夹具根目录：OS 临时目录下的 skillvault-fixture（一次性、可整个删掉） */
const DEFAULT_ROOT = path.join(os.tmpdir(), 'skillvault-fixture')
/** 夹具里演示用的 skill 名 */
const SKILL_NAME = 'demo-skill'

// ---------------------------------------------------------------------------
// 基础设施：git 调用与打印
// ---------------------------------------------------------------------------

/**
 * 执行一条 git 命令。
 * - 显式注入 `-c core.quotepath=false -c i18n.logOutputEncoding=UTF-8`：
 *   与 src/main/git.ts 的 GIT_TEXT_ARGS 完全一致，防止中文路径被输出成 \346 八进制转义。
 * - env 里带 GIT_TERMINAL_PROMPT=0：origin 需要认证时立刻失败，而不是挂住等输入。
 * - 全部在指定 cwd 里跑，绝不依赖调用者当前的 shell 目录。
 */
function git(cwd, args, { allowFail = false, extraConfig = [] } = {}) {
  const r = spawnSync(
    'git',
    [
      '-c',
      'core.quotepath=false',
      '-c',
      'i18n.logOutputEncoding=UTF-8',
      // extraConfig：针对单条命令追加的临时 -c 配置（例如 clone 时禁用换行转换）
      ...extraConfig.flatMap((kv) => ['-c', kv]),
      ...args
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
    }
  )
  const stdout = (r.stdout ?? '').toString()
  const stderr = (r.stderr ?? '').toString()
  if (r.error || (r.status !== 0 && !allowFail)) {
    const err = new Error(
      `git ${args.join(' ')} 失败（cwd=${cwd}, status=${r.status ?? -1}）\n${stderr || stdout || String(r.error ?? '')}`
    )
    err.stdout = stdout
    err.stderr = stderr
    err.status = r.status ?? -1
    throw err
  }
  return { ok: r.status === 0, status: r.status ?? -1, stdout, stderr }
}

/** 删除目录内容（保留目录本身）；用于 --force 时的「清空后重建」 */
function emptyDir(dir) {
  for (const name of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true })
  }
}

/** 写文件（自动建父目录） */
function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

// ---------------------------------------------------------------------------
// registry.json —— v3 形态
// ---------------------------------------------------------------------------
// 形态取自源码，不是猜的：
//   - src/shared/types.ts   → `export type Registry = { version: 3; agents: RegistryAgent[] }`
//   - src/shared/registry.ts → parseRegistry() 的校验规则（第 80~152 行）
//   - src/shared/registry.ts → defaultRegistry() 的 builtin 条目写法（第 15~60 行）
// v3 必填：name / platform('windows'|'linux') / skillsDir / include(非空字符串数组)
// v3 可选：agentsDir / label / source('builtin'|'discovered'|'manual') / enabled(boolean) / sigId / status('active'|'missing')
// 校验器要求 version 只能是 1|2|3；这里直接写 3（当前 REGISTRY_VERSION）。
function buildRegistry(root) {
  return {
    version: 3,
    agents: [
      {
        name: 'fixture-win',
        label: 'Fixture Harness（Windows 侧）',
        platform: 'windows',
        skillsDir: path.join(root, 'harness-a', 'skills'),
        agentsDir: path.join(root, 'harness-a', 'agents'),
        include: ['*'],
        source: 'builtin',
        enabled: true
      },
      {
        name: 'fixture-win-b',
        label: 'Fixture Harness B（Windows 侧）',
        platform: 'windows',
        skillsDir: path.join(root, 'harness-b', 'skills'),
        agentsDir: path.join(root, 'harness-b', 'agents'),
        include: ['*'],
        source: 'manual',
        enabled: true
      },
      {
        name: 'fixture-wsl',
        label: 'Fixture Harness（WSL 侧，路径为 Linux 形态的模拟值）',
        platform: 'linux',
        skillsDir: '/root/.zcode/skills',
        agentsDir: '/root/.zcode/agents',
        include: ['*'],
        source: 'builtin',
        enabled: true
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// 样例 skill 内容
// ---------------------------------------------------------------------------
/**
 * SKILL.md 里的 frontmatter 必须是合法 YAML —— src/shared/frontmatter.ts 只认
 * `---` 围栏内的 name / description 两个键（支持引号包裹与 > / | 块标量）。
 * 这里写成最朴素的单行写法，避免任何解析歧义。
 */
function skillMd() {
  return [
    '---',
    `name: ${SKILL_NAME}`,
    'description: SkillVault 夹具用的示例技能，用于演示双端同步与冲突演练。',
    '---',
    '',
    '# demo-skill',
    '',
    '这是 SkillVault 测试夹具里的示例技能，不含任何真实业务逻辑。',
    ''
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function usage() {
  process.stdout.write(
    [
      '用法: node scripts/init-fixture.mjs [目标根目录] [--force]',
      '',
      '在 OS 临时目录（或指定目录）里生成一套隔离的 SkillVault 测试夹具：',
      '  <root>/bare/         裸仓（git init --bare），模拟「中心真相源」',
      '  <root>/vault/        Windows 侧工作仓（分支固定 main）',
      '  <root>/wsl-side/     WSL 侧工作仓（第二次克隆，模拟 /root/skill-vault）',
      '  <root>/harness-a/    假 Agent 配置目录（skills/ + agents/），链接目标',
      '  <root>/harness-b/    假 Agent 配置目录（skills/ + agents/），链接目标',
      '  <root>/fixture.json  机器可读的夹具清单（路径 / 分支 / commit SHA）',
      '',
      '选项:',
      '  --force   目标目录已存在且非空时，先清空其内容再重建（默认直接拒绝）',
      '  --help    显示本帮助',
      '',
      '示例:',
      '  node scripts/init-fixture.mjs',
      '  node scripts/init-fixture.mjs "$TMP/skillvault-fixture" --force',
      ''
    ].join('\n')
  )
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
    return 0
  }
  const force = argv.includes('--force')
  const positional = argv.filter((a) => !a.startsWith('--'))
  const rootArg = positional[0]
  const root = path.resolve(rootArg ?? DEFAULT_ROOT)

  // --- 安全护栏 1：目标目录必须是「我们自己造的名字」或明确指定的路径，且绝不等于用户 HOME ---
  const home = path.resolve(os.homedir())
  if (root === home || root === path.parse(root).root) {
    throw new Error(`拒绝在 ${root} 建夹具：请勿指向用户主目录或磁盘根目录`)
  }

  // --- 安全护栏 2：非空目录必须显式 --force ---
  const exists = fs.existsSync(root)
  if (exists && !fs.statSync(root).isDirectory()) {
    throw new Error(`目标路径存在且不是目录: ${root}`)
  }
  if (exists) {
    const entries = fs.readdirSync(root)
    if (entries.length > 0 && !force) {
      throw new Error(
        `目标目录非空，拒绝覆盖: ${root}\n（确需重建请加 --force；该操作会删除该目录下的全部内容）`
      )
    }
    if (entries.length > 0) emptyDir(root)
  } else {
    fs.mkdirSync(root, { recursive: true })
  }

  // --- 目录骨架 ---
  const bare = path.join(root, 'bare')
  const vault = path.join(root, 'vault')
  const wslSide = path.join(root, 'wsl-side')
  const harnessA = path.join(root, 'harness-a')
  const harnessB = path.join(root, 'harness-b')
  for (const d of [bare, vault, wslSide, harnessA, harnessB]) {
    fs.mkdirSync(d, { recursive: true })
  }
  // 两个假 harness 目录：skills/ 与 agents/ 分别是「技能链接目标」和「子智能体目录链接目标」
  for (const h of [harnessA, harnessB]) {
    fs.mkdirSync(path.join(h, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(h, 'agents'), { recursive: true })
  }

  // --- 1. 裸仓 ---
  // 必须 --bare：裸仓只有对象库没有工作区，是产品里「零云远端」的中心仓库角色。
  git(root, ['init', '--bare', bare])
  // 身份**只写本地配置**：绝不用 --global，否则会污染评审者机器上的 gitconfig。
  git(bare, ['config', 'user.name', FIXTURE_USER_NAME, '--local'])
  git(bare, ['config', 'user.email', FIXTURE_USER_EMAIL, '--local'])
  // init.defaultBranch=main 写本地：保证裸仓 HEAD 指向 main 而不是 master
  // （app 的 push/pull 全部硬编码 main，分支名不一致会直接 404 / refspec 不匹配）
  git(bare, ['config', 'init.defaultBranch', BRANCH, '--local'])
  git(bare, ['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`])

  // --- 2. Windows 侧 vault 工作仓 ---
  // git init -b main：显式指定初始分支（老版本 git 不支持 -b 时退回 init + checkout -b）
  const init = git(root, ['init', '-b', BRANCH, vault], { allowFail: true })
  if (!init.ok) {
    git(vault, ['init'])
    git(vault, ['checkout', '-b', BRANCH])
  }
  git(vault, ['config', 'user.name', FIXTURE_USER_NAME, '--local'])
  git(vault, ['config', 'user.email', FIXTURE_USER_EMAIL, '--local'])
  git(vault, ['config', 'init.defaultBranch', BRANCH, '--local'])
  // 关掉自动换行转换：夹具里的文件内容要逐字节可复现，CRLF 转换会让 SHA-256 对不上
  git(vault, ['config', 'core.autocrlf', 'false', '--local'])
  git(vault, ['remote', 'add', 'origin', bare])

  // --- 3. 播种样例 skill + registry.json ---
  writeFile(path.join(vault, 'skills', SKILL_NAME, 'SKILL.md'), skillMd())
  writeFile(
    path.join(vault, 'skills', SKILL_NAME, 'notes.txt'),
    'demo-skill 的附加文件。\n用途：验证「一个 skill 目录里不止 SKILL.md」时同步与链接依然成立。\n'
  )
  writeFile(path.join(vault, 'registry.json'), JSON.stringify(buildRegistry(root), null, 2) + '\n')

  // --- 4. 首次提交 + 推送到裸仓 ---
  git(vault, ['add', '-A'])
  git(vault, ['commit', '-m', 'chore: 初始化 SkillVault 测试夹具'])
  git(vault, ['push', '-u', 'origin', BRANCH])

  // --- 5. WSL 侧第二克隆 ---
  // 模拟「另一台机器（WSL）克隆同一裸仓」：先确保裸仓 HEAD 指向 main，否则 clone 出来的
  // 分支会跟着裸仓 HEAD 走（可能是 master），后续 pull/push main 全部对不上。
  git(bare, ['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`])
  // clone 时禁用换行转换：裸仓里存的是 LF，若工作区被转成 CRLF，`git status` 会永远显示
  // "modified"，后面每次同步都会凭空产生一个空提交，评审者会误判成同步 bug。
  // 这里用单条命令的临时 -c 配置，不写进仓库的 .git/config（保持夹具配置最简）。
  git(root, ['clone', bare, wslSide], { extraConfig: ['core.autocrlf=false'] })
  git(wslSide, ['config', 'user.name', FIXTURE_USER_NAME, '--local'])
  git(wslSide, ['config', 'user.email', FIXTURE_USER_EMAIL, '--local'])
  git(wslSide, ['config', 'core.autocrlf', 'false', '--local'])
  git(wslSide, ['config', 'init.defaultBranch', BRANCH, '--local'])
  // 显式切到 main：clone 出来的默认分支可能不是 main（取决于裸仓 HEAD 与 clone 时机）
  git(wslSide, ['checkout', BRANCH], { allowFail: true })
  git(wslSide, ['branch', '--set-upstream-to', `origin/${BRANCH}`, BRANCH], { allowFail: true })
  // 换行转换同样要压掉：Windows 上 clone 出来的文件可能是 CRLF，与裸仓里的 LF 不一致，
  // `git status` 会永远显示 "modified"，之后每次同步都会凭空产生一个空提交。
  git(wslSide, ['config', 'core.autocrlf', 'false', '--local'])

  // --- 6. 收集事实（供机器读取与评审者核对） ---
  const vaultHead = git(vault, ['rev-parse', 'HEAD']).stdout.trim()
  const wslHead = git(wslSide, ['rev-parse', 'HEAD']).stdout.trim()
  const bareHead = git(bare, ['rev-parse', BRANCH]).stdout.trim()
  const vaultBranch = git(vault, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  const wslBranch = git(wslSide, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  const bareHeadSymref = git(bare, ['symbolic-ref', 'HEAD']).stdout.trim()
  const vaultStatus = git(vault, ['status', '--porcelain']).stdout.trim()
  const wslStatus = git(wslSide, ['status', '--porcelain']).stdout.trim()

  const fixture = {
    // 生成信息：便于评审者知道这是哪一版夹具
    generator: 'scripts/init-fixture.mjs',
    createdAt: new Date().toISOString(),
    // 全部绝对路径（Windows 上带盘符）——verify-roundtrip.mjs 直接吃这份 JSON
    root,
    paths: {
      root,
      bare,
      vault,
      wslSide,
      harnessA,
      harnessB,
      harnessASkills: path.join(harnessA, 'skills'),
      harnessAAgents: path.join(harnessA, 'agents'),
      harnessBSkills: path.join(harnessB, 'skills'),
      harnessBAgents: path.join(harnessB, 'agents'),
      registry: path.join(vault, 'registry.json'),
      skillDir: path.join(vault, 'skills', SKILL_NAME),
      skillMd: path.join(vault, 'skills', SKILL_NAME, 'SKILL.md'),
      fixtureJson: path.join(root, 'fixture.json'),
      acceptanceReport: path.join(root, 'acceptance-report.json')
    },
    branch: BRANCH,
    commits: { vault: vaultHead, wslSide: wslHead, bare: bareHead },
    bareHeadSymref,
    branches: { vault: vaultBranch, wslSide: wslBranch },
    skillName: SKILL_NAME,
    registryVersion: 3,
    gitIdentity: { name: FIXTURE_USER_NAME, email: FIXTURE_USER_EMAIL },
    clean: { vault: vaultStatus === '', wslSide: wslStatus === '' }
  }

  // --- 7. 落盘 + 打印 ---
  writeFile(fixture.paths.fixtureJson, JSON.stringify(fixture, null, 2) + '\n')
  process.stdout.write(JSON.stringify(fixture, null, 2) + '\n')

  // 人读摘要写 stderr（stdout 保持纯 JSON，便于管道 `| jq` 解析）
  process.stderr.write(
    [
      '',
      'SkillVault 测试夹具已就绪：',
      `  根目录    : ${root}`,
      `  裸仓      : ${bare}`,
      `  Windows 仓: ${vault}（分支 ${vaultBranch}）`,
      `  WSL 侧 仓 : ${wslSide}（分支 ${wslBranch}）`,
      `  假 harness: ${harnessA} / ${harnessB}`,
      `  首个提交  : ${vaultHead}`,
      `  裸仓 HEAD : ${bareHeadSymref}`,
      '',
      '下一步：node scripts/verify-roundtrip.mjs ' + root,
      ''
    ].join('\n')
  )
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  process.stderr.write(`init-fixture 失败: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
}
