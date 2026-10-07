// 导入自动扫描（skillScan）的无头覆盖：真实临时目录树 + 注入式 fs 边界断言。
// 覆盖点：命中 / 缺 SKILL.md 静默跳过 / 已入库跳过 / 重名冲突 / 坏目录 errors / 额外目录递归 /
//        注册表里停用与 missing 条目被排除 / 链接解析 / 只扫一层不整树遍历。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { realScanDeps, scanImportCandidates, type SkillScanDeps } from '../src/main/skillScan'
import { createJunction } from '../src/main/winLinks'
import { REGISTRY_VERSION } from '../src/shared/registry'
import type { Registry, RegistryAgent } from '../src/shared/types'

let tmp = ''
let vault = ''
let winHome = ''

/** 造一个 skill 目录（含 SKILL.md + 一个文件；内容不影响扫描判定） */
function makeSkill(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${path.basename(dir)}\n`)
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
}

function agent(name: string, skillsDir: string, patch: Partial<RegistryAgent> = {}): RegistryAgent {
  return { name, platform: 'windows', skillsDir, include: ['*'], source: 'discovered', enabled: true, ...patch }
}

function reg(...agents: RegistryAgent[]): Registry {
  return { version: REGISTRY_VERSION, agents }
}

/** 扫描用的默认 IO：真实 fs（临时目录树），可覆写单点做边界断言 */
function io(over: Partial<SkillScanDeps> = {}): SkillScanDeps {
  return { ...realScanDeps(), ...over }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-scan-'))
  vault = path.join(tmp, 'SkillVault')
  winHome = path.join(tmp, 'home')
  fs.mkdirSync(path.join(vault, 'skills'), { recursive: true })
  fs.mkdirSync(winHome, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('scanImportCandidates', () => {
  it('命中：含 SKILL.md 的子目录成为候选，缺 SKILL.md 的与普通文件静默跳过', () => {
    const zcode = path.join(winHome, '.zcode', 'skills')
    makeSkill(path.join(zcode, 'alpha'))
    makeSkill(path.join(zcode, 'beta'))
    fs.mkdirSync(path.join(zcode, 'not-a-skill')) // 无 SKILL.md：不是候选，也不报错
    fs.writeFileSync(path.join(zcode, 'README.md'), 'not a dir')

    const r = scanImportCandidates(vault, reg(agent('zcode-win', zcode)), undefined, { io: io() })

    expect(r.candidates.map((c) => c.skillName).sort()).toEqual(['alpha', 'beta'])
    expect(r.candidates.every((c) => c.hasSkillMd && c.status === 'importable')).toBe(true)
    expect(r.candidates.every((c) => !c.vaultConflict && !c.isLink)).toBe(true)
    expect(r.candidates[0].dir).toBe(path.join(zcode, 'alpha'))
    expect(r.candidates[0].sourceAgent).toBe('zcode-win')
    expect(r.candidates[0].depth).toBe(1)
    expect(r.scannedAgents).toEqual([
      { name: 'zcode-win', label: 'zcode-win', skillsDir: zcode, dirCount: 3 }
    ])
    expect(r.errors).toEqual([])
  })

  it('已入库跳过：原位置已是指向 vault 的快捷方式（junction）→ linked，不算可导入', () => {
    const codex = path.join(winHome, '.codex', 'skills')
    fs.mkdirSync(codex, { recursive: true })
    const inVault = path.join(vault, 'skills', 'alpha')
    makeSkill(inVault)
    createJunction(inVault, path.join(codex, 'alpha'))

    const r = scanImportCandidates(vault, reg(agent('codex-win', codex)), undefined, { io: io() })

    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0].status).toBe('linked')
    expect(r.candidates[0].isLink).toBe(true)
    // 真身在库里：skillName 取真身 basename，与库内目录名一致
    expect(r.candidates[0].skillName).toBe('alpha')
    expect(r.errors).toEqual([])
  })

  it('重名冲突：vault 已有同名 skill → conflict（导入会被拒绝，绝不覆盖）', () => {
    const agents = path.join(winHome, '.agents', 'skills')
    makeSkill(path.join(agents, 'alpha'))
    makeSkill(path.join(agents, 'gamma'))
    makeSkill(path.join(vault, 'skills', 'alpha'))

    const r = scanImportCandidates(vault, reg(agent('agents-win', agents)), undefined, { io: io() })

    const byName = Object.fromEntries(r.candidates.map((c) => [c.skillName, c]))
    expect(byName.alpha.status).toBe('conflict')
    expect(byName.alpha.vaultConflict).toBe(true)
    expect(byName.gamma.status).toBe('importable')
  })

  it('坏目录只记 errors 不中断：不存在的 skillsDir 不参与 scannedAgents，其它 agent 照常扫', () => {
    const zcode = path.join(winHome, '.zcode', 'skills')
    makeSkill(path.join(zcode, 'alpha'))
    const missing = path.join(winHome, '.nope', 'skills')

    const r = scanImportCandidates(vault, reg(agent('zcode-win', zcode), agent('nope-win', missing)), undefined, {
      io: io()
    })

    expect(r.candidates.map((c) => c.skillName)).toEqual(['alpha'])
    expect(r.scannedAgents.map((a) => a.name)).toEqual(['zcode-win'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].dir).toBe(missing)
    expect(r.errors[0].reason).toContain('目录不存在')
  })

  it('断链（junction 目标已消失）记 errors，不当候选也不崩', () => {
    const zcode = path.join(winHome, '.zcode', 'skills')
    fs.mkdirSync(zcode, { recursive: true })
    const gone = path.join(tmp, 'gone-target')
    makeSkill(gone)
    createJunction(gone, path.join(zcode, 'broken'))
    fs.rmSync(gone, { recursive: true, force: true })

    const r = scanImportCandidates(vault, reg(agent('zcode-win', zcode)), undefined, { io: io() })

    expect(r.candidates).toEqual([])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].dir).toBe(path.join(zcode, 'broken'))
  })

  it('额外目录：自身含 SKILL.md 直接成候选；否则向下递归至多 2 层，第 3 层不看', () => {
    const extra = path.join(tmp, 'extra')
    makeSkill(path.join(extra, 'one'))
    makeSkill(path.join(extra, 'two', 'nested'))
    makeSkill(path.join(extra, 'deep', 'a', 'b', 'too-deep'))
    fs.mkdirSync(path.join(extra, 'no-skill'), { recursive: true })

    const r = scanImportCandidates(vault, reg(), extra, { io: io() })

    expect(r.candidates.map((c) => c.skillName).sort()).toEqual(['nested', 'one'])
    expect(r.candidates.every((c) => c.sourceAgent === '额外目录')).toBe(true)
    expect(r.candidates.find((c) => c.skillName === 'one')?.depth).toBe(1)
    expect(r.candidates.find((c) => c.skillName === 'nested')?.depth).toBe(2)
    expect(r.errors).toEqual([])
  })

  it('额外目录自身就是 skill 目录 → depth 0 候选', () => {
    const extra = path.join(tmp, 'single-skill')
    makeSkill(extra)

    const r = scanImportCandidates(vault, reg(), extra, { io: io() })

    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0].depth).toBe(0)
    expect(r.candidates[0].dir).toBe(extra)
  })

  it('额外目录不存在 → errors 一条，不抛错', () => {
    const r = scanImportCandidates(vault, reg(), path.join(tmp, 'no-such-dir'), { io: io() })
    expect(r.candidates).toEqual([])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].reason).toContain('目录不存在')
  })

  it('注册表过滤：enabled:false 与 status:missing 的条目一律不扫', () => {
    const a = path.join(winHome, 'a', 'skills')
    const b = path.join(winHome, 'b', 'skills')
    const c = path.join(winHome, 'c', 'skills')
    makeSkill(path.join(a, 'alpha'))
    makeSkill(path.join(b, 'beta'))
    makeSkill(path.join(c, 'gamma'))

    const r = scanImportCandidates(
      vault,
      reg(
        agent('a-win', a),
        agent('b-win', b, { enabled: false }),
        agent('c-win', c, { status: 'missing' })
      ),
      undefined,
      { io: io() }
    )

    expect(r.candidates.map((x) => x.skillName)).toEqual(['alpha'])
    expect(r.scannedAgents.map((x) => x.name)).toEqual(['a-win'])
  })

  it('linux 侧条目不进 Windows 导入扫描（WSL 技能导入不在本次范围）', () => {
    const wsl = path.join(winHome, 'wsl-skills')
    makeSkill(path.join(wsl, 'alpha'))
    const r = scanImportCandidates(
      vault,
      reg({ name: 'zcode-wsl', platform: 'linux', skillsDir: wsl, include: ['*'], source: 'builtin', enabled: true }),
      undefined,
      { io: io() }
    )
    expect(r.candidates).toEqual([])
    expect(r.errors).toEqual([])
  })

  it('同一真身被多个 agent 共享（junction）只报一次候选', () => {
    const real = path.join(tmp, 'shared-body')
    makeSkill(real)
    const a = path.join(winHome, 'a', 'skills')
    const b = path.join(winHome, 'b', 'skills')
    fs.mkdirSync(a, { recursive: true })
    fs.mkdirSync(b, { recursive: true })
    createJunction(real, path.join(a, 'shared'))
    createJunction(real, path.join(b, 'shared'))

    const r = scanImportCandidates(vault, reg(agent('a-win', a), agent('b-win', b)), undefined, { io: io() })

    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0].sourceAgent).toBe('a-win')
    expect(r.scannedAgents.map((x) => x.name)).toEqual(['a-win', 'b-win'])
  })

  it('只扫一层：候选目录内部绝不递归 readdir（IO 不随技能体积放大）', () => {
    const zcode = path.join(winHome, '.zcode', 'skills')
    makeSkill(path.join(zcode, 'alpha'))
    const inner = path.join(zcode, 'alpha')
    const r = scanImportCandidates(vault, reg(agent('zcode-win', zcode)), undefined, {
      io: io({
        readdir: (dir) => {
          // 一旦有人往候选目录内部翻，测试立刻失败
          if (dir.toLowerCase().startsWith(inner.toLowerCase())) throw new Error('不应递归进候选目录: ' + dir)
          return realScanDeps().readdir(dir)
        }
      })
    })
    expect(r.candidates.map((c) => c.skillName)).toEqual(['alpha'])
    expect(r.errors).toEqual([])
  })

  it('vault 尚未初始化（无 skills 目录）也能扫：全部候选为 importable', () => {
    const bare = path.join(tmp, 'empty-vault')
    const zcode = path.join(winHome, '.zcode', 'skills')
    makeSkill(path.join(zcode, 'alpha'))
    const r = scanImportCandidates(bare, reg(agent('zcode-win', zcode)), undefined, { io: io() })
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0].status).toBe('importable')
  })
})
