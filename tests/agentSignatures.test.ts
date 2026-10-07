// agentSignatures：签名表完整性 + discoverFromHome / genericSweep（全部内存 fake exists/list，零真实 IO）
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_SIGNATURES, discoverFromHome, genericSweep, type DiscoverDeps } from '../src/shared/agentSignatures'

/** 跨平台 home：只用 path.join 派生期望值，测试与实现同源 */
const HOME = path.join(path.sep, 'home', 'u')
const J = (...parts: string[]): string => path.join(HOME, ...parts)

/** 内存 fake：exists 命中集合 + list 目录表（模拟真实实现只回子目录名），并记录被 list 的目录（验证扫描深度） */
function fakeIo(exists: string[], lists: Record<string, string[]> = {}): { io: DiscoverDeps; listed: string[] } {
  const set = new Set(exists)
  const listed: string[] = []
  return {
    listed,
    io: {
      exists: (p) => set.has(p),
      list: (d) => {
        listed.push(d)
        return lists[d] ?? []
      }
    }
  }
}

describe('AGENT_SIGNATURES 签名表', () => {
  it('sigId 唯一、dotDirs/skillsSubdirs/label 非空', () => {
    const ids = AGENT_SIGNATURES.map((s) => s.sigId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of AGENT_SIGNATURES) {
      expect(s.sigId.trim()).not.toBe('')
      expect(s.label.trim()).not.toBe('')
      expect(s.dotDirs.length).toBeGreaterThan(0)
      expect(s.dotDirs.every((d) => d.trim() && !path.isAbsolute(d))).toBe(true)
      expect(s.skillsSubdirs.length).toBeGreaterThan(0)
      expect(Array.isArray(s.cliNames)).toBe(true)
    }
  })

  it('覆盖种子清单（含多布局与 agentsSubdirs 的有无）', () => {
    const byId = new Map(AGENT_SIGNATURES.map((s) => [s.sigId, s]))
    for (const id of [
      'claude',
      'codex',
      'zcode',
      'kimi',
      'dsh',
      'grok',
      'gemini',
      'qwen',
      'opencode',
      'kilo',
      'pi',
      'crush',
      'goose',
      'copilot',
      'cursor',
      'agents-shared'
    ]) {
      expect(byId.has(id)).toBe(true)
    }
    expect(byId.get('opencode')?.dotDirs).toEqual(['.opencode', '.config/opencode'])
    expect(byId.get('crush')?.dotDirs).toEqual(['.config/crush'])
    expect(byId.get('claude')?.agentsSubdirs).toEqual(['agents'])
    expect(byId.get('zcode')?.agentsSubdirs).toEqual(['agents'])
    expect(byId.get('agents-shared')?.agentsSubdirs).toEqual(['agents'])
    expect(byId.get('codex')?.agentsSubdirs).toBeUndefined()
    expect(byId.get('claude')?.label).toBe('Claude Code')
  })
})

describe('discoverFromHome', () => {
  it('命中 dotDir：给出 skillsDir，agentsDir 存在时才带上', () => {
    const { io } = fakeIo([J('.claude'), J('.claude', 'skills'), J('.claude', 'agents')])
    const out = discoverFromHome(HOME, io)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      sigId: 'claude',
      label: 'Claude Code',
      dotDir: '.claude',
      skillsDir: J('.claude', 'skills'),
      agentsDir: J('.claude', 'agents')
    })
    expect(out[0].generic).toBeUndefined()
  })

  it('agents 子目录不存在时不带 agentsDir（字段缺省，不写 undefined 之外的占位）', () => {
    const { io } = fakeIo([J('.zcode'), J('.zcode', 'skills')])
    const out = discoverFromHome(HOME, io)
    expect(out[0].agentsDir).toBeUndefined()
  })

  it('多布局：顶层缺失时回落 .config/<name>', () => {
    const { io } = fakeIo([J('.config', 'opencode'), J('.config', 'opencode', 'skills')])
    const out = discoverFromHome(HOME, io)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ sigId: 'opencode', dotDir: '.config/opencode', skillsDir: J('.config', 'opencode', 'skills') })
  })

  it('多布局：顶层存在时优先顶层（数组顺序即优先级）', () => {
    const { io } = fakeIo([J('.opencode'), J('.config', 'opencode')])
    const out = discoverFromHome(HOME, io)
    expect(out).toHaveLength(1)
    expect(out[0].dotDir).toBe('.opencode')
  })

  it('skills 子目录尚未创建：dotDir 存在即算已安装，skillsDir 指向首个声明路径', () => {
    const { io } = fakeIo([J('.codex')])
    const out = discoverFromHome(HOME, io)
    expect(out).toHaveLength(1)
    expect(out[0].skillsDir).toBe(J('.codex', 'skills'))
  })

  it('未命中任何签名 → 空数组（绝不臆造 agent）', () => {
    const { io } = fakeIo([J('.unknown-thing')])
    expect(discoverFromHome(HOME, io)).toEqual([])
  })

  it('多 agent 同时命中：按签名表顺序返回', () => {
    const { io } = fakeIo([J('.claude'), J('.codex'), J('.agents')])
    const out = discoverFromHome(HOME, io)
    expect(out.map((c) => c.sigId)).toEqual(['claude', 'codex', 'agents-shared'])
  })
})

describe('genericSweep 兜底扫描', () => {
  it('未知点目录含 skills/<name>/SKILL.md → generic 候选', () => {
    const skills = J('.acme', 'skills')
    const { io } = fakeIo([skills, path.join(skills, 'alpha', 'SKILL.md')], {
      [HOME]: ['.acme'],
      [skills]: ['alpha']
    })
    const out = genericSweep(HOME, io)
    expect(out).toEqual([
      { sigId: 'generic:.acme', label: '.acme', dotDir: '.acme', skillsDir: skills, generic: true }
    ])
  })

  it('跳过签名已覆盖的目录（.claude 等）与非点开头目录', () => {
    const claudeSkills = J('.claude', 'skills')
    const plainSkills = J('plain', 'skills')
    const { io } = fakeIo([claudeSkills, plainSkills, J('.claude', 'skills', 'x', 'SKILL.md')], {
      [HOME]: ['.claude', 'plain', 'docs'],
      [claudeSkills]: ['x'],
      [plainSkills]: ['x']
    })
    expect(genericSweep(HOME, io)).toEqual([])
  })

  it('skills 下没有任何含 SKILL.md 的子目录 → 不生成候选', () => {
    const skills = J('.maybe', 'skills')
    const { io } = fakeIo([skills], { [HOME]: ['.maybe'], [skills]: ['empty-skill'] })
    expect(genericSweep(HOME, io)).toEqual([])
  })

  it('深度限制：只到 skills/<name>/SKILL.md 一层，更深层 SKILL.md 不算（且不 list 更深目录）', () => {
    const skills = J('.deep', 'skills')
    const deepMd = path.join(skills, 'a', 'b', 'SKILL.md')
    const { io, listed } = fakeIo([skills, deepMd], { [HOME]: ['.deep'], [skills]: ['a'] })
    expect(genericSweep(HOME, io)).toEqual([])
    // 只 list 过 home 与 skills/；绝不整树遍历（最深处 = home/<dot>/skills，即 2 段）
    expect(listed).toEqual([HOME, skills])
    const depth = (p: string): number => path.relative(HOME, p).split(path.sep).filter(Boolean).length
    expect(listed.every((d) => depth(d) <= 2)).toBe(true)
  })

  it('结果按目录名排序（合并写盘顺序稳定）', () => {
    const a = J('.alpha', 'skills')
    const b = J('.beta', 'skills')
    const { io } = fakeIo([a, b, path.join(a, 's', 'SKILL.md'), path.join(b, 's', 'SKILL.md')], {
      [HOME]: ['.beta', '.alpha'],
      [a]: ['s'],
      [b]: ['s']
    })
    expect(genericSweep(HOME, io).map((c) => c.sigId)).toEqual(['generic:.alpha', 'generic:.beta'])
  })
})
