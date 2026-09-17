// 无头迁移脚本（不依赖 GUI）：tsx scripts/migrate.ts <init|wsl|dryrun|import|link|verify|all>
// 数据面零云远端：C:\Users\sakuya\SkillVault.git 是唯一 origin，两侧 push/pull 均指向它。
/* eslint-disable no-console */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { git } from '../src/main/git'
import { loadSettings } from '../src/main/settings'
import {
  createJunction,
  getLinkState,
  isLinkPath,
  listVaultSkills,
  removeLink,
  scanWindowsAgents,
  vaultSkillDir
} from '../src/main/winLinks'
import { executeImport, planImport } from '../src/main/importer'
import { runCompanion, wslBash } from '../src/main/wslBridge'
import { agentIncludes, parseRegistry } from '../src/shared/registry'
import type { AgentScan, LinkState, Registry } from '../src/shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const settings = loadSettings(null)
const VAULT = settings.vaultPath
const BARE = settings.barePath
const DISTRO = settings.wslDistro
const WSL_VAULT = '/root/skill-vault'

// 迁移源（侦察已确认的真身；.zcode 下 hatch-pet / micu-gpt-image 旧 junction 不在此列，由 link 阶段重建）
const IMPORT_SOURCES = [
  'C:\\Users\\sakuya\\.codex\\skills\\hatch-pet',
  'C:\\Users\\sakuya\\.codex\\skills\\micu-gpt-image',
  'C:\\Users\\sakuya\\.agents\\skills\\math-modeling',
  'C:\\Users\\sakuya\\.zcode\\skills\\migrate-subagents'
]

const GITATTRIBUTES = [
  '* text=auto eol=lf',
  '*.png binary',
  '*.jpg binary',
  '*.jpeg binary',
  '*.ico binary',
  '*.zip binary',
  ''
].join('\n')

const REGISTRY_TEXT =
  JSON.stringify(
    {
      version: 2,
      agents: [
        {
          name: 'zcode-win',
          platform: 'windows',
          skillsDir: 'C:\\Users\\sakuya\\.zcode\\skills',
          agentsDir: 'C:\\Users\\sakuya\\.zcode\\agents',
          include: ['*']
        },
        { name: 'codex-win', platform: 'windows', skillsDir: 'C:\\Users\\sakuya\\.codex\\skills', include: ['*'] },
        { name: 'agents-win', platform: 'windows', skillsDir: 'C:\\Users\\sakuya\\.agents\\skills', include: ['*'] },
        {
          name: 'zcode-wsl',
          platform: 'linux',
          skillsDir: '/root/.zcode/skills',
          agentsDir: '/root/.zcode/agents',
          include: ['*']
        }
      ]
    },
    null,
    2
  ) + '\n'

const README = [
  '# Skill Vault',
  '',
  '跨 Windows / WSL 的 Skill 中央仓库（数据面零云远端）。',
  '',
  '## 架构',
  '',
  '    C:\\Users\\sakuya\\SkillVault.git  本地裸仓（唯一 origin，两侧 push/pull 它）',
  '    C:\\Users\\sakuya\\SkillVault      Windows 工作克隆（主编辑面）',
  '    /root/skill-vault      WSL 工作克隆（origin=/mnt/c/Users/sakuya/SkillVault.git）',
  '',
  '链接规则：',
  '    Windows: 各 agent skills 目录下 junction -> C:\\Users\\sakuya\\SkillVault\\skills\\<name>（绝对路径）',
  '    WSL    : 相对 symlink /root/.zcode/skills/<name> -> ../../skill-vault/skills/<name>',
  '',
  'registry.json 定义 agent 清单；bin/skm.mjs 是 WSL 伴生 CLI（scan/link/unlink/sync/fix-permissions/selfcheck，--json）。',
  '',
  '## 常用命令',
  '',
  '    Windows 侧（SkillVault GUI 同步页）: 双侧 add/commit/push/pull 编排',
  '    WSL 侧: node /root/skill-vault/bin/skm.mjs sync --json',
  '',
  '## 排障简表',
  '',
  '    链接悬空/目标错误   -> Skill Manager 体检页一键修复（重建 junction/symlink）',
  '    /mnt 式旧链接       -> skm link <skill>（体检页可修复）',
  '    脚本失去执行位      -> skm fix-permissions（skills/*/scripts/ 下含 shebang 的文件 chmod +x）',
  '    CRLF 混入           -> .gitattributes 已强制 eol=lf；体检页可一键转换',
  '    同步冲突            -> 同步页原样展示 git 输出，人工解决后重跑，绝不 force',
  ''
].join('\n')

function shq(s: string): string {
  return /^[\w./=:-]+$/.test(s) ? s : `'` + s.replace(/'/g, `'\\''`) + `'`
}

const section = (t: string): void => console.log(`\n========== ${t} ==========`)
const info = (m: string): void => console.log('  ' + m)
function die(m: string): never {
  console.error('FATAL: ' + m)
  process.exit(1)
}

function winIdentity(): { name: string; email: string } {
  const name = git('.', ['config', '--global', 'user.name']).stdout.trim()
  const email = git('.', ['config', '--global', 'user.email']).stdout.trim()
  return { name: name || 'skill-manager', email: email || 'sakuya@local' }
}

function ensureVaultGitIdentity(): void {
  if (!git(VAULT, ['config', 'user.name']).stdout.trim()) git(VAULT, ['config', 'user.name', winIdentity().name])
  if (!git(VAULT, ['config', 'user.email']).stdout.trim()) git(VAULT, ['config', 'user.email', winIdentity().email])
}

function commitAll(msg: string): boolean {
  git(VAULT, ['add', '-A'])
  const st = git(VAULT, ['status', '--porcelain'])
  if (!st.stdout.trim()) {
    info('vault 无变更，跳过 commit: ' + msg)
    return false
  }
  const c = git(VAULT, ['commit', '-m', msg])
  if (!c.ok) die('commit 失败: ' + (c.stderr || c.stdout))
  info('commit: ' + msg)
  return true
}

function readVaultRegistry(): Registry {
  const file = path.join(VAULT, 'registry.json')
  if (!fs.existsSync(file)) die('registry.json 不存在，请先运行 init')
  const r = parseRegistry(fs.readFileSync(file, 'utf8'))
  if (!r.ok) die('registry 解析失败: ' + r.error)
  return r.registry
}

function wslPathOf(winPath: string): string {
  // C:\Users\sakuya\SkillVault.git -> /mnt/c/Users/sakuya/SkillVault.git
  return '/mnt/' + winPath[0].toLowerCase() + winPath.slice(2).replace(/\\/g, '/')
}

/** Windows vault push → 裸仓 → WSL pull（迁移中保证两侧数据一致，绝不 force） */
async function propagate(): Promise<void> {
  const p = git(VAULT, ['push', 'origin', 'main'])
  if (!p.ok) die('push 失败: ' + (p.stderr || p.stdout))
  info('push → ' + BARE)
  const r = await wslBash(
    DISTRO,
    `git -C ${WSL_VAULT} config core.fileMode false && git -C ${WSL_VAULT} pull --rebase origin main`
  )
  if (!r.ok) die('WSL pull 失败: ' + (r.stderr || r.stdout))
  await wslBash(DISTRO, `chmod +x ${WSL_VAULT}/bin/skm.mjs 2>/dev/null; true`)
  info('WSL pull --rebase origin main → OK')
}

// ---------------- 阶段命令 ----------------

function cmdInit(): void {
  section('init：本地裸仓 + 工作克隆 + 种子文件')
  if (!fs.existsSync('C:\\Users\\sakuya')) die('C 盘用户目录不存在')

  if (!fs.existsSync(BARE)) {
    const r = git('C:/Users/sakuya', ['init', '--bare', '-b', 'main', BARE])
    if (!r.ok) die('git init --bare 失败: ' + (r.stderr || r.stdout))
    info('已创建裸仓: ' + BARE)
  } else {
    info('裸仓已存在: ' + BARE)
  }
  git(BARE, ['config', 'core.autocrlf', 'false'])

  if (!fs.existsSync(path.join(VAULT, '.git'))) {
    fs.mkdirSync(VAULT, { recursive: true })
    let r = git(VAULT, ['init', '-b', 'main'])
    if (!r.ok) die('git init 失败: ' + (r.stderr || r.stdout))
    r = git(VAULT, ['remote', 'add', 'origin', BARE])
    if (!r.ok) die('remote add 失败: ' + (r.stderr || r.stdout))
    info('已创建工作克隆: ' + VAULT)
  } else {
    info('工作克隆已存在: ' + VAULT)
  }
  git(VAULT, ['config', 'core.autocrlf', 'false'])
  ensureVaultGitIdentity()

  fs.mkdirSync(path.join(VAULT, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(VAULT, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(VAULT, '.gitattributes'), GITATTRIBUTES)
  fs.writeFileSync(path.join(VAULT, 'registry.json'), REGISTRY_TEXT)
  fs.writeFileSync(path.join(VAULT, 'README.md'), README)

  const skm = path.join(ROOT, 'out', 'skm.mjs')
  if (fs.existsSync(skm)) {
    fs.copyFileSync(skm, path.join(VAULT, 'bin', 'skm.mjs'))
    info('已部署 companion: bin/skm.mjs (' + fs.statSync(skm).size + ' bytes)')
  } else {
    info('警告: out/skm.mjs 不存在（先运行 pnpm build:companion），本次不部署 companion')
  }

  commitAll('skill-manager: init vault')
  const p = git(VAULT, ['push', '-u', 'origin', 'main'])
  if (!p.ok) die('push 失败: ' + (p.stderr || p.stdout))
  info('首推完成 → ' + BARE + ' (main)')
}

async function cmdWsl(): Promise<void> {
  section('wsl：身份 + 克隆 + companion 就绪')
  const chk = await wslBash(DISTRO, 'git --version && node -v')
  if (!chk.ok) die('WSL 不可用或缺少 git/node: ' + chk.stderr)
  info('WSL: ' + chk.stdout.trim().replace(/\n/g, ' / '))

  const curName = (await wslBash(DISTRO, 'git config --global user.name')).stdout.trim()
  const curEmail = (await wslBash(DISTRO, 'git config --global user.email')).stdout.trim()
  if (!curName || !curEmail) {
    const w = winIdentity()
    const name = curName || (w.name !== 'skill-manager' ? w.name : 'skill-manager-wsl')
    const email = curEmail || (w.email !== 'sakuya@local' ? w.email : 'sakuya@local')
    const r = await wslBash(
      DISTRO,
      `git config --global user.name ${shq(name)} && git config --global user.email ${shq(email)}`
    )
    if (!r.ok) die('WSL git 身份配置失败: ' + r.stderr)
    info(`已配置 WSL git 身份: ${name} <${email}>`)
  } else {
    info(`WSL git 身份已存在: ${curName} <${curEmail}>`)
  }
  await wslBash(DISTRO, 'git config --global core.autocrlf false && git config --global init.defaultBranch main')

  const hasRepo = (await wslBash(DISTRO, `test -d ${WSL_VAULT}/.git && echo yes || echo no`)).stdout.trim()
  if (hasRepo === 'yes') {
    const r = await wslBash(DISTRO, `git -C ${WSL_VAULT} config core.fileMode false && git -C ${WSL_VAULT} pull --rebase origin main`)
    info('已存在 clone，pull --rebase: ' + (r.ok ? 'OK' : r.stderr))
  } else {
    const exists = (await wslBash(DISTRO, `test -e ${WSL_VAULT} && echo exists || echo absent`)).stdout.trim()
    if (exists === 'exists') die('/root/skill-vault 已存在但不是 git 仓库，请人工处理')
    const r = await wslBash(DISTRO, `git clone ${shq(wslPathOf(BARE))} ${shq(WSL_VAULT)}`)
    if (!r.ok) die('clone 失败: ' + (r.stderr || r.stdout))
    info('已 clone → /root/skill-vault')
  }
  await wslBash(DISTRO, `chmod +x ${WSL_VAULT}/bin/skm.mjs 2>/dev/null; true`)
  const log = await wslBash(DISTRO, `git -C ${WSL_VAULT} log --oneline -3`)
  info('WSL git log:\n' + log.stdout.trim().split('\n').map((l) => '    ' + l).join('\n'))
}

function cmdDryrun(): void {
  section('dryrun：4 个导入源干跑（不做任何修改）')
  for (const src of IMPORT_SOURCES) {
    console.log(`\n--- ${src} ---`)
    if (!fs.existsSync(src)) {
      info('源不存在，跳过')
      continue
    }
    const p = planImport(src, VAULT)
    if (!p.ok) {
      console.log(`  [不可导入] ${p.error}`)
      continue
    }
    console.log(`  skill 名 : ${p.skillName}（kebab 合法: ${p.nameOk}）`)
    console.log(`  SKILL.md : ${p.hasSkillMd ? '存在' : '缺失'}`)
    console.log(`  真身路径 : ${p.sourceRealPath}${p.sourceIsLink ? '（源路径是链接）' : ''}`)
    console.log(`  规模     : ${p.fileCount} 个文件 / ${p.totalBytes} 字节`)
    console.log(`  vault 目标: ${p.targetDir}`)
    console.log(`  vault 冲突: ${p.vaultConflict ? '是（将拒绝）' : '无'}`)
    for (const a of p.actions) console.log('    · ' + a)
  }
}

function cmdImport(): void {
  section('import：实跑导入（先校验后删除）')
  for (const src of IMPORT_SOURCES) {
    console.log(`\n--- ${src} ---`)
    if (!fs.existsSync(src)) {
      info('源不存在，跳过')
      continue
    }
    try {
      const r = executeImport(src, VAULT)
      for (const s of r.steps) info(s)
      info(`完成: ${r.skillName}（${r.fileCount} 文件）`)
    } catch (e) {
      die(`导入 ${src} 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  section('import 后 vault git log')
  console.log(
    git(VAULT, ['log', '--oneline', '-10'])
      .stdout.trim()
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n')
  )
}

async function cmdLink(): Promise<void> {
  section('link：Windows junction 全量建链 + WSL companion link')
  const registry = readVaultRegistry()
  const skills = listVaultSkills(VAULT).map((s) => s.name)
  if (!skills.length) die('vault 中没有 skill，请先 import')
  info('vault skills: ' + skills.join(', '))
  propagate()

  for (const agent of registry.agents.filter((a) => a.platform === 'windows')) {
    if (!fs.existsSync(agent.skillsDir)) {
      fs.mkdirSync(agent.skillsDir, { recursive: true })
      info(`创建 agent 目录: ${agent.skillsDir}`)
    }
    for (const skill of skills) {
      if (!agentIncludes(agent, skill)) continue
      const linkPath = path.join(agent.skillsDir, skill)
      const target = vaultSkillDir(VAULT, skill)
      const st = getLinkState(linkPath, target)
      if (st === 'linked') {
        info(`skip  ${agent.name}/${skill}（已链接）`)
        continue
      }
      if (st === 'real-dir') die(`真实目录冲突: ${linkPath}（请先人工 re-import）`)
      if (st === 'vault-missing') die(`vault 目标缺失: ${target}`)
      if (isLinkPath(linkPath)) {
        removeLink(linkPath)
        info(`移除旧链接 ${agent.name}/${skill}（${st}）`)
      }
      createJunction(target, linkPath)
      info(`junction ${agent.name}/${skill} → ${target}`)
    }
  }

  for (const skill of skills) {
    const c = await runCompanion(DISTRO, ['link', skill], 120000)
    const p = c.parsed as { results?: string[] } | undefined
    if (!c.ok || !p) die(`WSL companion link ${skill} 失败: ${(c.stderr || c.parseError || '').slice(0, 300)}`)
    for (const r of p.results ?? []) info('WSL ' + r)
  }
}

async function cmdVerify(): Promise<void> {
  section('verify：最终矩阵 / 链接透读 / git log')
  await propagate()
  const registry = readVaultRegistry()
  const skills = listVaultSkills(VAULT).map((s) => s.name)

  const winAgents = scanWindowsAgents(VAULT, registry)
  const c = await runCompanion(DISTRO, ['scan'], 120000)
  const p = c.parsed as { ok?: boolean; agents?: AgentScan[] } | undefined
  const wslAgents: AgentScan[] = c.ok && p && p.ok === true ? (p.agents ?? []).filter((a) => a.platform === 'linux') : []
  if (!wslAgents.length) info('警告: WSL companion scan 不可用: ' + (c.stderr || c.parseError || '').slice(0, 200))
  const agents = [...winAgents, ...wslAgents]

  const sym: Record<LinkState, string> = {
    linked: '✓',
    missing: '✗',
    'wrong-target': '~',
    'real-dir': '!',
    'vault-missing': '∅'
  }

  console.log('')
  const header = 'skill'.padEnd(24) + agents.map((a) => a.name.padEnd(14)).join('')
  console.log('  ' + header)
  console.log('  ' + '-'.repeat(header.length))
  let linkedCells = 0
  let totalCells = 0
  for (const skill of skills) {
    const row =
      ('  ' + skill).padEnd(26) +
      agents
        .map((a) => {
          const st = (a.links[skill] ?? 'missing') as LinkState
          totalCells++
          if (st === 'linked') linkedCells++
          return (sym[st] + ' ' + st).padEnd(14)
        })
        .join('')
    console.log(row)
  }
  console.log(`\n  链接统计: ${linkedCells}/${totalCells} linked`)

  section('透读 SKILL.md 首行（逐条链接）')
  let readFail = 0
  for (const a of agents) {
    for (const skill of skills) {
      if (a.links[skill] !== 'linked') continue
      try {
        if (a.platform === 'windows') {
          const line = fs.readFileSync(path.join(a.skillsDir, skill, 'SKILL.md'), 'utf8').split(/\r?\n/)[0]
          console.log(`  [${a.name}] ${skill}: ${line}`)
        } else {
          const r = await wslBash(DISTRO, `head -1 ${shq(`${a.skillsDir}/${skill}/SKILL.md`)}`)
          const line = r.stdout.trim()
          if (!r.ok || !line) {
            readFail++
            console.log(`  [${a.name}] ${skill}: 读取失败 ${r.stderr.slice(0, 100)}`)
          } else {
            console.log(`  [${a.name}] ${skill}: ${line}`)
          }
        }
      } catch (e) {
        readFail++
        console.log(`  [${a.name}] ${skill}: 读取异常 ${String(e)}`)
      }
    }
  }

  section('vault git log（Windows 工作克隆）')
  console.log(
    git(VAULT, ['log', '--oneline', '-12'])
      .stdout.trim()
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n')
  )
  const wst = git(VAULT, ['status', '--porcelain'])
  info('windows status: ' + (wst.stdout.trim() ? '\n' + wst.stdout : 'clean'))

  section('WSL git log（/root/skill-vault）')
  const wlog = await wslBash(DISTRO, `git -C ${WSL_VAULT} log --oneline -12 && echo --- && git -C ${WSL_VAULT} status --porcelain && echo CLEAN-CHECK`)
  console.log(
    wlog.stdout
      .trim()
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n')
  )

  if (readFail > 0) die(`有 ${readFail} 条链接透读失败`)
  if (linkedCells !== totalCells) die(`矩阵未全绿：${linkedCells}/${totalCells}`)
  console.log('\nVERIFY PASS: 矩阵全绿，全部链接可透读。')
}

// ---------------- main ----------------

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? ''
  switch (cmd) {
    case 'init':
      return cmdInit()
    case 'wsl':
      return cmdWsl()
    case 'dryrun':
      return cmdDryrun()
    case 'import':
      return cmdImport()
    case 'link':
      return cmdLink()
    case 'verify':
      return cmdVerify()
    case 'all':
      cmdInit()
      await cmdWsl()
      cmdImport()
      await cmdLink()
      return cmdVerify()
    default:
      console.log('用法: tsx scripts/migrate.ts <init|wsl|dryrun|import|link|verify|all>')
      console.log('推荐顺序: init → wsl → dryrun（人工核对）→ import → link → verify')
      process.exit(cmd ? 1 : 0)
  }
}

void main()
