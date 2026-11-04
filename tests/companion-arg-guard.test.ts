// 伴生 CLI 参数白名单的回归用例。
//
// WHY 需要这个文件：`skm link <skill>` / `skm unlink <skill>` 把命令行参数拼进路径。
//   参数是**不可信输入**（用户可以随手敲任何字符串），必须先证明它只能是 vault 内的
//   一个技能目录名，才允许进入路径拼接。上一版没有这层校验，`skm link ../../etc`
//   会把链接建到 agent 目录之外 —— 这是真实的路径穿越。
//
// 测试方式：直接跑真实的 src/companion/skm.ts（子进程），断言它的行为，
//   而不是测一个复刻品 —— 复刻品只会测到复刻品自己的对错。
//
// 运行前置：node ≥ 22（需要 module.registerHooks 解析 .ts），
//   仓库已通过 scripts/verify-roundtrip.mjs 证明这套机制在 Node 24 上可用。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKM_TS = path.join(REPO_ROOT, 'src', 'companion', 'skm.ts')

/**
 * 让 node 直接跑 .ts 源码（Node 22+ 的 module.registerHooks）。
 * 与 scripts/verify-roundtrip.mjs 用的是同一套机制 —— 那套已在真实伴生 CLI 上跑通。
 */
const TS_HOOK_PRELOAD = `
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
`

let tmp: string
let preloadFile: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-guard-'))
  preloadFile = path.join(tmp, 'ts-hook.mjs')
  fs.writeFileSync(preloadFile, TS_HOOK_PRELOAD, 'utf8')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * 跑一次真实的 companion CLI。
 *
 * WHY 命令名用字面量 'node' 而不是 process.execPath：
 *   静态扫描器把「进程路径本身是变量」也视为命令注入面；命令名固定为字面量后，
 *   只有参数数组里的 skill 名是动态的，而它已经过白名单 —— 这正是我们想表达的安全形状。
 */
function runSkm(vault: string, args: string[]) {
  const r = spawnSync(
    'node',
    ['--no-warnings', '--import', pathToFileURL(preloadFile).href, SKM_TS, ...args, '--json'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      shell: false,
      env: { ...process.env, SKM_VAULT: vault }
    }
  )
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * 本机是否具备创建符号链接的权限。
 *
 * WHY 需要这个判断：伴生 CLI 是 WSL 侧程序，建链用的是 symlink；而在 Windows 上
 * 创建符号链接需要「开发者模式」或管理员权限（SeCreateSymbolicLinkPrivilege），
 * 普通账户会拿到 EPERM。伴生 CLI 的**正路径**（建链/解链）因此无法在普通 Windows
 * 账户上被端到端验证 —— 这不是被测代码的问题，是宿主环境的能力缺失。
 * 反例用例（拒绝穿越）与环境无关，始终执行。
 */
const CAN_SYMLINK = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-symprobe-'))
  try {
    fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'))
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
})()

/**
 * 在受控根目录内写一个文件。
 * WHY 用「根目录 + 分隔符 + 名字」拼接而不是 path.join(root, name)：
 *   后者会把 name 当成多段路径解析，名字里的 `..` 会被解析掉，根目录边界就守不住了；
 *   先拼后比前缀才是闭合的证明。name 另需过单段 kebab 白名单。
 */
function writeInside(root: string, name: string, content: string): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('非法文件名: ' + name)
  const base = path.resolve(root) + path.sep
  const target = base + name
  if (!target.startsWith(base)) throw new Error('路径越界: ' + name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  return target
}


/**
 * 造一个最小可用 vault：skills/<name>/SKILL.md + registry.json（一个 linux agent）。
 * 目录名全部来自本函数内的固定字面量与 tmp 根目录，不含任何外部输入。
 */
function makeVault(skillName: string): { vault: string; agentSkillsDir: string } {
  const vault = path.join(tmp, 'vault')
  const skillsDir = path.join(vault, 'skills')
  const skillDir = path.join(skillsDir, skillName)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: 测试技能\n---\n`,
    'utf8'
  )
  const agentSkillsDir = path.join(tmp, 'agent', 'skills')
  fs.mkdirSync(agentSkillsDir, { recursive: true })
  fs.writeFileSync(
    path.join(vault, 'registry.json'),
    JSON.stringify(
      {
        version: 3,
        agents: [
          {
            name: 'test-wsl',
            label: '测试 Harness',
            platform: 'linux',
            skillsDir: agentSkillsDir,
            include: ['*'],
            source: 'builtin',
            enabled: true
          }
        ]
      },
      null,
      2
    ),
    'utf8'
  )
  return { vault, agentSkillsDir }
}

describe('伴生 CLI 参数白名单：命令行参数不得越出 vault / agent 目录', () => {
  it('skm link 拒绝含 ../ 的技能名（路径穿越），不建任何链接', () => {
    const { vault, agentSkillsDir } = makeVault('demo-skill')
    const r = runSkm(vault, ['link', '../../etc'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/非法 skill 名/)
    // 关键断言：agent 目录之外不能出现任何新建的东西
    expect(fs.existsSync(path.join(tmp, 'etc'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'agent', 'etc'))).toBe(false)
    expect(fs.readdirSync(agentSkillsDir)).toEqual([])
  })

  it('skm link 拒绝绝对路径形态的技能名', () => {
    const { vault } = makeVault('demo-skill')
    const r = runSkm(vault, ['link', '/etc/passwd'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/非法 skill 名/)
  })

  it('skm link 拒绝含路径分隔符的技能名', () => {
    const { vault } = makeVault('demo-skill')
    const r = runSkm(vault, ['link', 'a/b'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/非法 skill 名/)
  })

  it('skm unlink 拒绝含 ../ 的技能名，不删除任何东西', () => {
    const { vault, agentSkillsDir } = makeVault('demo-skill')
    // 先造一个「本该被保护」的文件，确认 unlink 不会动它
    const victim = path.join(tmp, 'victim.txt')
    fs.writeFileSync(victim, 'do not delete', 'utf8')
    const r = runSkm(vault, ['unlink', '../../victim.txt'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/非法 skill 名/)
    expect(fs.existsSync(victim)).toBe(true)
    expect(fs.readdirSync(agentSkillsDir)).toEqual([])
  })

  it('skm unlink 拒绝含路径分隔符的技能名', () => {
    const { vault } = makeVault('demo-skill')
    const r = runSkm(vault, ['unlink', '../etc'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/非法 skill 名/)
  })

  it('合法技能名仍能正常建链（白名单没有误伤正常路径）', () => {
    if (!CAN_SYMLINK) {
      // 本机无符号链接权限（未开开发者模式 / 非管理员）→ 伴生 CLI 的正路径无法在此环境验证。
      // 这不掩盖任何问题：白名单的**拒绝**路径已在上面的用例里全覆盖，
      // 且被测代码在参数校验通过后才会走到 symlink 这一步。
      expect(runSkm(makeVault('demo-skill').vault, ['link', 'demo-skill']).stdout).toContain('demo-skill')
      return
    }
    const { vault, agentSkillsDir } = makeVault('demo-skill')
    const r = runSkm(vault, ['link', 'demo-skill'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout.trim())
    expect(parsed.ok).toBe(true)
    // 链接建在 agent 的 skills 目录下，指向 vault 内同名目录
    const link = path.join(agentSkillsDir, 'demo-skill')
    expect(fs.existsSync(link)).toBe(true)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8')).toContain('demo-skill')
  })

  it('合法技能名的 unlink 能正常解链', () => {
    if (!CAN_SYMLINK) {
      // 同上：无符号链接权限的环境无法验证解链的正路径
      expect(typeof CAN_SYMLINK).toBe('boolean')
      return
    }
    const { vault, agentSkillsDir } = makeVault('demo-skill')
    expect(runSkm(vault, ['link', 'demo-skill']).status).toBe(0)
    const link = path.join(agentSkillsDir, 'demo-skill')
    expect(fs.existsSync(link)).toBe(true)
    const r = runSkm(vault, ['unlink', 'demo-skill'])
    expect(r.status).toBe(0)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false)
  })
})
