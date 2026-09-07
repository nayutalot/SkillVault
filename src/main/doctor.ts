// doctor：vault/裸仓/agent 目录/链接/CRLF/命名 + WSL 侧（经 companion selfcheck）
import fs from 'node:fs'
import path from 'node:path'
import type { DoctorItem, Registry } from '../shared/types'
import type { AppSettings } from './settings'
import { git } from './git'
import {
  createJunction,
  getLinkState,
  isLinkPath,
  listVaultSkills,
  pathExists,
  removeLink,
  vaultSkillDir
} from './winLinks'
import { runCompanion, wslBash } from './wslBridge'
import { agentIncludes } from '../shared/registry'
import { isValidSkillName } from './skillOpen'

const TEXT_EXTS = new Set([
  '.md', '.txt', '.py', '.sh', '.js', '.mjs', '.cjs', '.ts', '.json',
  '.yml', '.yaml', '.toml', '.css', '.html', '.xml', '.svg', '.bat', '.ps1'
])

export type FixOutcome = { message: string }

/** 字节级 CRLF→LF：绝不 decode/re-encode —— GBK/ANSI（中文 Windows 记事本默认编码）或 UTF-16LE 等非 UTF-8
 *  文本文件若按 UTF-8 强解码再写回，非法字节会被替换成 U+FFFD，文件永久乱码且换机器必现。
 *  故这里逐字节扫描，仅当 \r 后紧跟 \n 时删掉 \r；孤立 \r（旧 Mac 行尾）原样保留。
 *  返回转换后的 Buffer；不含 CRLF 时返回 null（调用方跳过写盘，避免无意义重写）。 */
export function crlfToLfBuffer(buf: Buffer): Buffer | null {
  // 先数一遍 CRLF 对数定输出长度：文件可达数 MB，预分配一次遍历直写，避免逐字节 push 数组
  let crlfCount = 0
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) crlfCount++
  }
  if (crlfCount === 0) return null
  const out = Buffer.allocUnsafe(buf.length - crlfCount)
  let w = 0
  for (let i = 0; i < buf.length; i++) {
    // 仅丢弃紧跟 \n 的 \r；末尾孤立 \r 原样保留
    if (buf[i] === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) continue
    out[w++] = buf[i]
  }
  return out
}

function findCrlfFiles(vaultPath: string, limit = 200): string[] {
  const root = path.join(vaultPath, 'skills')
  const found: string[] = []
  if (!fs.existsSync(root)) return found
  const visit = (dir: string): void => {
    if (found.length >= limit) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) visit(full)
      else if (e.isFile() && TEXT_EXTS.has(path.extname(e.name).toLowerCase())) {
        try {
          const buf = fs.readFileSync(full)
          if (buf.includes(Buffer.from('\r\n'))) {
            found.push(path.relative(vaultPath, full).replace(/\\/g, '/'))
            if (found.length >= limit) return
          }
        } catch {
          /* 不可读文件跳过 */
        }
      }
    }
  }
  visit(root)
  return found
}

export async function runDoctor(settings: AppSettings, registry: Registry): Promise<DoctorItem[]> {
  const items: DoctorItem[] = []
  const vault = settings.vaultPath

  // ---- vault / git ----
  if (!fs.existsSync(path.join(vault, '.git'))) {
    items.push({ id: 'vault', severity: 'error', message: `vault 不存在或不是 git 仓库: ${vault}`, fixable: false })
  } else {
    const st = git(vault, ['status', '--porcelain'])
    if (!st.ok) {
      items.push({ id: 'vault-git', severity: 'error', message: `vault git status 失败: ${(st.stderr || '').trim()}`, fixable: false })
    } else if (st.stdout.trim()) {
      items.push({
        id: 'vault-dirty',
        severity: 'warn',
        message: `vault 有 ${st.stdout.trim().split('\n').length} 项未提交变更，请到同步页处理`,
        fixable: false
      })
    } else {
      items.push({ id: 'vault-clean', severity: 'info', message: 'vault git 状态干净', fixable: false })
    }
  }

  // ---- 裸仓 ----
  if (!fs.existsSync(settings.barePath)) {
    items.push({ id: 'bare', severity: 'error', message: `本地裸仓不存在: ${settings.barePath}`, fixable: false })
  } else {
    const r = git(settings.barePath, ['rev-parse', '--is-bare-repository'])
    if (r.ok && r.stdout.trim() === 'true') {
      items.push({ id: 'bare-ok', severity: 'info', message: `裸仓可达: ${settings.barePath}`, fixable: false })
    } else {
      items.push({ id: 'bare-bad', severity: 'error', message: `裸仓异常: ${settings.barePath}`, fixable: false })
    }
  }

  // ---- Windows agent 目录与链接 ----
  for (const agent of registry.agents.filter((a) => a.platform === 'windows')) {
    if (!fs.existsSync(agent.skillsDir)) {
      items.push({
        id: `agent-dir:${agent.name}`,
        severity: 'error',
        message: `agent 目录不存在: ${agent.skillsDir}（${agent.name}）`,
        fixable: true,
        fixId: 'mkdir-agent',
        payload: { agent: agent.name }
      })
      continue
    }
    for (const meta of listVaultSkills(vault)) {
      if (!agentIncludes(agent, meta.name)) continue
      const linkPath = path.join(agent.skillsDir, meta.name)
      const target = vaultSkillDir(vault, meta.name)
      const state = getLinkState(linkPath, target)
      if (state === 'wrong-target') {
        items.push({
          id: `wrong-target:${agent.name}:${meta.name}`,
          severity: 'warn',
          message: `${agent.name}/${meta.name} 链接目标错误（${linkPath}），可重建为指向 vault`,
          fixable: true,
          fixId: 'relink',
          // payload 仅携带定位用名字；applyFix 一律按 registry/vault 重新推导路径，绝不直接使用回传路径
          payload: { agent: agent.name, skill: meta.name }
        })
      } else if (state === 'vault-missing') {
        items.push({
          id: `dangling:${agent.name}:${meta.name}`,
          severity: 'error',
          message: `${agent.name}/${meta.name} 链接指向的 vault 目录缺失: ${target}`,
          fixable: false
        })
      } else if (state === 'real-dir') {
        items.push({
          id: `real-dir:${agent.name}:${meta.name}`,
          severity: 'warn',
          message: `${agent.name}/${meta.name} 是真实目录而非链接（${linkPath}），建议动作：到导入页 re-import 该目录`,
          fixable: false
        })
      } else if (state === 'missing') {
        items.push({
          id: `unlinked:${agent.name}:${meta.name}`,
          severity: 'info',
          message: `${agent.name}/${meta.name} 未链接`,
          fixable: true,
          fixId: 'relink',
          payload: { agent: agent.name, skill: meta.name }
        })
      }
    }
  }

  // ---- vault 内 CRLF ----
  const crlf = findCrlfFiles(vault)
  if (crlf.length) {
    items.push({
      id: 'crlf',
      severity: 'warn',
      message: `vault 内 ${crlf.length} 个文本文件含 CRLF（示例: ${crlf.slice(0, 3).join(', ')}），可统一转换为 LF`,
      fixable: true,
      fixId: 'crlf',
      payload: { files: crlf }
    })
  }

  // ---- 命名规范 ----
  for (const meta of listVaultSkills(vault)) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name)) {
      items.push({
        id: `naming:${meta.name}`,
        severity: 'warn',
        message: `skill 名 "${meta.name}" 不符合小写 kebab-case 规范`,
        fixable: false
      })
    }
    if (!meta.hasSkillMd) {
      items.push({
        id: `no-skill-md:${meta.name}`,
        severity: 'warn',
        message: `skill "${meta.name}" 缺少 SKILL.md`,
        fixable: false
      })
    }
  }

  // ---- WSL 侧（异步调 companion selfcheck，不阻塞事件循环）----
  const sc = await runCompanion(settings.wslDistro, ['selfcheck'], 120000)
  const p = sc.parsed as
    | { ok?: boolean; identity?: { name?: string; email?: string }; originOk?: boolean; execIssues?: { rel: string }[]; mntLinks?: { agent: string; skill: string; target: string }[] }
    | undefined
  if (!sc.ok || !p || typeof p !== 'object' || p.ok !== true) {
    items.push({
      id: 'wsl',
      severity: 'warn',
      message: `WSL companion 不可用（检查 clone /root/skill-vault 与 bin/skm.mjs）: ${(sc.parseError || sc.stderr || sc.stdout).slice(0, 200)}`,
      fixable: false
    })
  } else {
    const idName = (p.identity?.name ?? '').trim()
    const idEmail = (p.identity?.email ?? '').trim()
    if (!idName || !idEmail) {
      items.push({ id: 'wsl-identity', severity: 'warn', message: 'WSL 侧 git 身份未配置（user.name/user.email）', fixable: true, fixId: 'wsl-identity' })
    }
    if (!p.originOk) {
      items.push({ id: 'wsl-origin', severity: 'error', message: 'WSL clone 的 origin 不可达', fixable: false })
    }
    if ((p.execIssues ?? []).length) {
      items.push({
        id: 'wsl-exec',
        severity: 'warn',
        message: `WSL 侧 ${p.execIssues!.length} 个含 shebang 的脚本缺执行位（示例: ${p.execIssues!.slice(0, 3).map((x) => x.rel).join(', ')}）`,
        fixable: true,
        fixId: 'wsl-exec'
      })
    }
    for (const m of p.mntLinks ?? []) {
      items.push({
        id: `wsl-mnt:${m.agent}:${m.skill}`,
        severity: 'warn',
        message: `WSL ${m.agent}/${m.skill} 是 /mnt 式旧链接 → ${m.target}，建议替换为指向 ~/skill-vault 的原生相对链接`,
        fixable: true,
        fixId: 'wsl-mnt',
        payload: { skill: m.skill, agent: m.agent }
      })
    }
  }

  return items
}

/** 一键修复；返回结果说明。
 *  安全边界：payload 只取定位用的名字（agent/skill），一切路径由本函数从 settings/registry/扫描结果重新推导，
 *  回传的 linkPath/vaultSkillDir/skillsDir/files 等路径字段一律不采信（渲染层回传数据可被注入）。 */
export async function applyFix(settings: AppSettings, registry: Registry, item: DoctorItem): Promise<FixOutcome> {
  const payload = (item.payload ?? {}) as Record<string, string>
  const vault = settings.vaultPath
  switch (item.fixId) {
    case 'mkdir-agent': {
      const agent = registry.agents.find((a) => a.name === payload.agent && a.platform === 'windows')
      if (!agent) throw new Error(`registry 中找不到 Windows agent: ${String(payload.agent ?? '')}`)
      fs.mkdirSync(agent.skillsDir, { recursive: true })
      return { message: `已创建目录: ${agent.skillsDir}` }
    }
    case 'relink': {
      const agent = registry.agents.find((a) => a.name === payload.agent && a.platform === 'windows')
      if (!agent) throw new Error(`registry 中找不到 Windows agent: ${String(payload.agent ?? '')}`)
      const skill = String(payload.skill ?? '')
      if (!isValidSkillName(skill)) throw new Error(`非法 skill 名: ${JSON.stringify(skill)}`)
      const target = vaultSkillDir(vault, skill)
      if (!pathExists(target)) throw new Error(`vault 目标不存在: ${target}`)
      const linkPath = path.join(agent.skillsDir, skill)
      if (fs.existsSync(linkPath)) {
        if (!isLinkPath(linkPath)) throw new Error(`目标是真实目录/文件，拒绝覆盖: ${linkPath}（请先 re-import）`)
        removeLink(linkPath)
      }
      createJunction(target, linkPath)
      return { message: `已重建链接: ${linkPath} → ${target}` }
    }
    case 'crlf': {
      // 服务端重新扫描当前 CRLF 清单（runDoctor 与 applyFix 之间 vault 可能已变化；也杜绝回传相对路径越界）
      const files = findCrlfFiles(vault)
      const skillsRoot = path.resolve(path.join(vault, 'skills')).toLowerCase()
      // containment：rel 由 findCrlfFiles 生成，仍显式校验解析结果不越出 <vault>\skills（门禁要求）
      const safeFull = (rel: string): string | null => {
        const full = path.resolve(vault, ...rel.split('/'))
        return full.toLowerCase().startsWith(skillsRoot + path.sep) ? full : null
      }
      let converted = 0
      for (const rel of files) {
        const full = safeFull(rel)
        if (!full) continue
        try {
          const buf = fs.readFileSync(full)
          if (buf.includes(0)) continue // 含 NUL：UTF-16 / 二进制文件，不解码不重写，绝不碰
          const lf = crlfToLfBuffer(buf)
          if (!lf) continue // 扫描与修复之间文件可能已变化，无 CRLF 就不写盘
          fs.writeFileSync(full, lf) // Buffer 直写，无 encoding 参数：GBK 等非 UTF-8 字节逐字节保真，不会转码成乱码
          converted++
        } catch {
          /* 单文件失败跳过，不中断整体转换 */
        }
      }
      // 只提交实际转换过的文件，绝不 add -A（否则用户 vault 里无关的未提交草稿会被卷进本次提交）
      if (converted > 0 && fs.existsSync(path.join(vault, '.git'))) {
        for (const rel of files) {
          if (safeFull(rel)) git(vault, ['add', '--', rel])
        }
        const st = git(vault, ['status', '--porcelain'])
        if (st.stdout.trim()) {
          const c = git(vault, ['commit', '-m', 'skill-manager: convert CRLF to LF'])
          return { message: `已转换 ${converted} 个文件为 LF${c.ok ? ' 并提交' : '（提交失败: ' + (c.stderr || c.stdout).trim().slice(0, 120) + '）'}` }
        }
      }
      return { message: converted > 0 ? `已转换 ${converted} 个文件为 LF` : '没有需要转换的文件' }
    }
    case 'wsl-exec': {
      const r = await runCompanion(settings.wslDistro, ['fix-permissions'], 120000)
      if (!r.ok || !r.parsed) throw new Error(`fix-permissions 失败: ${(r.stderr || r.parseError || '').slice(0, 200)}`)
      const fixed = (r.parsed as { fixed?: string[] }).fixed ?? []
      return { message: `已为 ${fixed.length} 个脚本补执行位` }
    }
    case 'wsl-mnt': {
      const skill = String(payload.skill ?? '')
      if (!isValidSkillName(skill)) throw new Error(`非法 skill 名: ${JSON.stringify(skill)}`)
      const r = await runCompanion(settings.wslDistro, ['link', skill], 120000)
      if (!r.ok || !r.parsed) throw new Error(`WSL relink 失败: ${(r.stderr || r.parseError || '').slice(0, 200)}`)
      return { message: `WSL 侧已重建 ${skill} 链接（相对路径指向 ~/skill-vault）` }
    }
    case 'wsl-identity': {
      const name = git('.', ['config', '--global', 'user.name']).stdout.trim() || 'skill-manager-wsl'
      const email = git('.', ['config', '--global', 'user.email']).stdout.trim() || 'sakuya@local'
      const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
      const cmd = `git config --global user.name ${q(name)} && git config --global user.email ${q(email)}`
      const r = await wslBash(settings.wslDistro, cmd)
      if (!r.ok) throw new Error(`WSL git 身份配置失败: ${(r.stderr || '').slice(0, 200)}`)
      return { message: `已在 WSL 配置 git 身份: ${name} <${email}>` }
    }
    default:
      throw new Error(`未知修复类型: ${item.fixId ?? '(none)'}`)
  }
}
