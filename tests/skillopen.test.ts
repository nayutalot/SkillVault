import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isKnownCopyPath,
  isKnownSkillName,
  isValidSkillName,
  normalizeCopyPath,
  rememberCopyPaths,
  rememberSkillNames,
  resolveVaultSkillDir,
  resolveVaultSkillMd,
  scanCopyPaths
} from '../src/main/skillOpen'
import { WSL_VAULT } from '../src/shared/paths'

const VAULT = 'C:\\Users\\sakuya\\SkillVault'

describe('isValidSkillName', () => {
  it('接受合法 kebab-case', () => {
    expect(isValidSkillName('hatch-pet')).toBe(true)
    expect(isValidSkillName('a')).toBe(true)
    expect(isValidSkillName('skill-2-b')).toBe(true)
  })

  it('拒绝空/非字符串/超长', () => {
    expect(isValidSkillName('')).toBe(false)
    expect(isValidSkillName(undefined)).toBe(false)
    expect(isValidSkillName(123)).toBe(false)
    expect(isValidSkillName('a'.repeat(129))).toBe(false)
  })

  it('拒绝大写（大小写绕过 attempt）、下划线、点、空格、斜杠、反斜杠、冒号', () => {
    expect(isValidSkillName('Hatch-Pet')).toBe(false)
    expect(isValidSkillName('hatch_pet')).toBe(false)
    expect(isValidSkillName('hatch.pet')).toBe(false)
    expect(isValidSkillName('hatch pet')).toBe(false)
    expect(isValidSkillName('hatch/pet')).toBe(false)
    expect(isValidSkillName('hatch\\pet')).toBe(false)
    expect(isValidSkillName('C:\\evil')).toBe(false)
  })

  it('拒绝目录穿越形态：.. 开头、内嵌 ..、绝对路径注入', () => {
    expect(isValidSkillName('..')).toBe(false)
    expect(isValidSkillName('../etc')).toBe(false)
    expect(isValidSkillName('..\\..\\windows')).toBe(false)
    expect(isValidSkillName('a..b')).toBe(false)
    expect(isValidSkillName('.hidden')).toBe(false)
    expect(isValidSkillName('-lead')).toBe(false)
    expect(isValidSkillName('%2e%2e')).toBe(false) // 点不合法
  })
})

describe('resolveVaultSkillDir / resolveVaultSkillMd', () => {
  it('合法名解析到 vault\\skills\\<name>', () => {
    const dir = resolveVaultSkillDir(VAULT, 'hatch-pet')
    expect(dir.toLowerCase()).toBe(path.resolve(VAULT, 'skills', 'hatch-pet').toLowerCase())
    expect(resolveVaultSkillMd(VAULT, 'hatch-pet').toLowerCase()).toBe(
      path.resolve(VAULT, 'skills', 'hatch-pet', 'SKILL.md').toLowerCase()
    )
  })

  it('非法名抛错（含 ..、绝对路径注入、大写绕过）', () => {
    expect(() => resolveVaultSkillDir(VAULT, '..\\..\\Windows\\System32')).toThrow(/非法 skill 名/)
    expect(() => resolveVaultSkillDir(VAULT, 'C:\\Windows\\System32')).toThrow(/非法 skill 名/)
    expect(() => resolveVaultSkillDir(VAULT, 'Hatch-Pet')).toThrow(/非法 skill 名/)
    expect(() => resolveVaultSkillDir(VAULT, '')).toThrow(/非法 skill 名/)
    expect(() => resolveVaultSkillMd(VAULT, 'a/b')).toThrow(/非法 skill 名/)
    // @ts-expect-error 防御性：非字符串
    expect(() => resolveVaultSkillDir(VAULT, null)).toThrow(/非法 skill 名/)
  })

  it('规格注入样本全部拒绝：../x、a/b、A_B、空串、大写（不执行任何路径拼接外的副作用）', () => {
    for (const bad of ['../x', 'a/b', 'A_B', '', 'HATCH-PET', '..']) {
      expect(() => resolveVaultSkillDir(VAULT, bad)).toThrow(/非法 skill 名/)
    }
  })

  it('即使名字合法，解析结果也必须位于 skills 前缀内（纵深防御）', () => {
    // vaultPath 本身带 .. 归一化后仍应正确加前缀
    const dir = resolveVaultSkillDir('C:\\a\\b\\..\\vault', 'foo')
    expect(dir.toLowerCase()).toBe(path.resolve('C:\\a\\vault', 'skills', 'foo').toLowerCase())
  })
})

// ---------- 打开动作的「当前扫描结果」成员校验 ----------

describe('rememberSkillNames / isKnownSkillName', () => {
  it('扫描登记后命中，覆盖上次集合', () => {
    rememberSkillNames(['hatch-pet', 'math-modeling'])
    expect(isKnownSkillName('hatch-pet')).toBe(true)
    rememberSkillNames(['micu-gpt-image'])
    expect(isKnownSkillName('hatch-pet')).toBe(false)
    expect(isKnownSkillName('micu-gpt-image')).toBe(true)
  })

  it('未登记/非法输入一律拒绝', () => {
    rememberSkillNames(['hatch-pet'])
    expect(isKnownSkillName('not-scanned')).toBe(false)
    expect(isKnownSkillName('')).toBe(false)
    expect(isKnownSkillName('../x')).toBe(false)
    expect(isKnownSkillName(undefined)).toBe(false)
    rememberSkillNames([])
    expect(isKnownSkillName('hatch-pet')).toBe(false)
  })
})

// ---------- copyPath 白名单 ----------

describe('copyPath 白名单', () => {
  beforeEach(() => {
    rememberCopyPaths([
      'C:\\Users\\sakuya\\SkillVault\\skills\\hatch-pet',
      'C:\\Users\\sakuya\\.zcode\\skills\\hatch-pet',
      `${WSL_VAULT}/skills/hatch-pet`,
      '/root/.zcode/skills/hatch-pet'
    ])
  })

  afterEach(() => {
    rememberCopyPaths([])
  })

  it('白名单内原值通过', () => {
    expect(isKnownCopyPath('C:\\Users\\sakuya\\SkillVault\\skills\\hatch-pet')).toBe(true)
    expect(isKnownCopyPath(`${WSL_VAULT}/skills/hatch-pet`)).toBe(true)
  })

  it('Windows 路径大小写不敏感、正反斜杠等价', () => {
    expect(isKnownCopyPath('c:\\users\\SAKUYA\\skillvault\\skills\\HATCH-PET')).toBe(true)
    expect(isKnownCopyPath('C:/Users/sakuya/SkillVault/skills/hatch-pet')).toBe(true)
  })

  it('白名单外的路径拒绝', () => {
    expect(isKnownCopyPath('C:\\Windows\\System32')).toBe(false)
    expect(isKnownCopyPath('C:\\Users\\sakuya\\SkillVault\\skills\\other-skill')).toBe(false)
    expect(isKnownCopyPath('/etc/passwd')).toBe(false)
    expect(isKnownCopyPath('')).toBe(false)
    // @ts-expect-error 防御性
    expect(isKnownCopyPath(undefined)).toBe(false)
  })

  it('路径穿越改写后仍不匹配', () => {
    expect(isKnownCopyPath('C:\\Users\\sakuya\\SkillVault\\skills\\hatch-pet\\..\\..\\..\\other')).toBe(false)
    expect(isKnownCopyPath(`${WSL_VAULT}/skills/hatch-pet/../../../etc`)).toBe(false)
  })

  it('normalizeCopyPath 归一化规则', () => {
    expect(normalizeCopyPath('C:\\A\\B\\')).toBe('c:\\a\\b')
    expect(normalizeCopyPath('/root/x/')).toBe('/root/x')
    expect(normalizeCopyPath('/root/./y/../x')).toBe('/root/x')
  })
})

describe('scanCopyPaths', () => {
  it('由扫描结果构造：vault 真身、WSL vault、各 agent 链接位置', () => {
    const paths = scanCopyPaths(
      VAULT,
      [{ name: 'foo' }, { name: 'bar' }],
      [
        { platform: 'windows', skillsDir: 'C:\\ag1\\skills' },
        { platform: 'linux', skillsDir: '/root/.zcode/skills' }
      ],
      WSL_VAULT
    )
    expect(paths).toContain('C:\\Users\\sakuya\\SkillVault\\skills\\foo')
    expect(paths).toContain(`${WSL_VAULT}/skills/bar`)
    expect(paths.filter((p) => p.startsWith('C:\\ag1\\skills'))).toHaveLength(2)
    expect(paths.filter((p) => p.startsWith('/root/.zcode/skills'))).toHaveLength(2)
    expect(paths).toHaveLength(2 * 4)
  })
})
