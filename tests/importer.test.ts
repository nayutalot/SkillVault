import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  executeImport,
  planImport,
  validateSkillName,
  verifyCopy,
  walkFiles
} from '../src/main/importer'
import { createJunction, getLinkState, lstatSafe } from '../src/main/winLinks'

let tmp = ''
let vault = ''
let src = ''

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-import-'))
  vault = path.join(tmp, 'vault')
  fs.mkdirSync(path.join(vault, 'skills'), { recursive: true })
  src = path.join(tmp, 'my-skill')
  fs.mkdirSync(path.join(src, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(src, 'SKILL.md'), '# My Skill\n中文内容\n')
  fs.writeFileSync(path.join(src, 'scripts', 'run.sh'), '#!/usr/bin/env bash\necho hi\n')
  fs.writeFileSync(path.join(src, 'logo.bin'), Buffer.from([0, 1, 2, 255, 254, 0, 7]))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('validateSkillName', () => {
  it('接受合法 kebab-case', () => {
    expect(validateSkillName('foo')).toBe(true)
    expect(validateSkillName('foo-bar-baz2')).toBe(true)
  })
  it('拒绝大写/下划线/空格/空名', () => {
    expect(validateSkillName('Foo')).toBe(false)
    expect(validateSkillName('foo_bar')).toBe(false)
    expect(validateSkillName('foo bar')).toBe(false)
    expect(validateSkillName('')).toBe(false)
    expect(validateSkillName('-foo')).toBe(false)
    expect(validateSkillName('foo-')).toBe(false)
  })
})

describe('planImport', () => {
  it('正常计划：名称、规模、动作列表', () => {
    const p = planImport(src, vault)
    expect(p.ok).toBe(true)
    expect(p.skillName).toBe('my-skill')
    expect(p.hasSkillMd).toBe(true)
    expect(p.fileCount).toBe(3)
    expect(p.totalBytes).toBe(walkFiles(src).reduce((s, f) => s + f.size, 0))
    expect(p.actions.length).toBeGreaterThan(3)
    expect(p.vaultConflict).toBe(false)
  })

  it('拒绝缺 SKILL.md 的目录', () => {
    const d = path.join(tmp, 'no-md')
    fs.mkdirSync(d)
    const p = planImport(d, vault)
    expect(p.ok).toBe(false)
    expect(p.error).toContain('SKILL.md')
  })

  it('拒绝不合规名称', () => {
    const d = path.join(tmp, 'Bad_Name')
    fs.mkdirSync(d)
    fs.writeFileSync(path.join(d, 'SKILL.md'), 'x')
    const p = planImport(d, vault)
    expect(p.ok).toBe(false)
    expect(p.error).toContain('kebab-case')
  })

  it('vault 冲突：已存在同名 skill 时拒绝且不覆盖', () => {
    fs.mkdirSync(path.join(vault, 'skills', 'my-skill'))
    const p = planImport(src, vault)
    expect(p.ok).toBe(false)
    expect(p.vaultConflict).toBe(true)
  })

  it('拒绝 vault 内部目录作为源', () => {
    const inner = path.join(vault, 'skills', 'inner-skill')
    fs.mkdirSync(inner)
    fs.writeFileSync(path.join(inner, 'SKILL.md'), 'x')
    const p = planImport(inner, vault)
    expect(p.ok).toBe(false)
    expect(p.error).toContain('vault 内部')
  })

  it('源是链接时解析到真身', () => {
    const real = path.join(tmp, 'real-body')
    fs.renameSync(src, real)
    fs.writeFileSync(path.join(real, 'SKILL.md'), '# Real\n')
    const link = path.join(tmp, 'link-skill')
    createJunction(real, link)
    const p = planImport(link, vault)
    expect(p.ok).toBe(true)
    expect(p.sourceIsLink).toBe(true)
    expect(p.skillName).toBe('real-body')
  })

  it('拒绝 Windows 保留设备名（con：正则合法但 NTFS 建目录必败，preview 阶段就拦）', () => {
    const d = path.join(tmp, 'con')
    fs.mkdirSync(d)
    fs.writeFileSync(path.join(d, 'SKILL.md'), 'x')
    const p = planImport(d, vault)
    expect(p.ok).toBe(false)
    expect(p.error).toContain('kebab-case')
  })

  it('拒绝含内嵌链接的源目录（静默放行会把链接连同原目录一起删掉，数据凭空丢失）', () => {
    const linkedTarget = path.join(tmp, 'linked-target')
    fs.mkdirSync(linkedTarget)
    fs.writeFileSync(path.join(linkedTarget, 'data.txt'), 'linked content')
    // 源内嵌一个指向外部目录的 junction（walkFiles 会跳过它）
    fs.symlinkSync(linkedTarget, path.join(src, 'linked-dir'), 'junction')
    const p = planImport(src, vault)
    expect(p.ok).toBe(false)
    expect(p.error).toContain('链接')
  })

  it('拒绝超长目标路径（>240 字符，Windows MAX_PATH 预检）', () => {
    const longVault = path.join(tmp, 'v'.repeat(200))
    const p = planImport(src, longVault)
    expect(p.ok).toBe(false)
    expect(p.error).toContain('路径过长')
  })
})

describe('executeImport', () => {
  it('干跑不产生任何修改', () => {
    const r = executeImport(src, vault, { dryRun: true, commit: false })
    expect(r.steps.every((s) => s.startsWith('[干跑]'))).toBe(true)
    expect(fs.existsSync(src)).toBe(true)
    expect(fs.existsSync(path.join(vault, 'skills', 'my-skill'))).toBe(false)
  })

  it('实跑：字节保真、原目录删除、junction 建立', () => {
    const r = executeImport(src, vault, { commit: false })
    expect(r.ok).toBe(true)
    const target = path.join(vault, 'skills', 'my-skill')
    // 字节保真
    expect(fs.readFileSync(path.join(target, 'SKILL.md'))).toEqual(fs.readFileSync(path.join(src, 'SKILL.md')))
    expect(fs.readFileSync(path.join(target, 'logo.bin'))).toEqual(Buffer.from([0, 1, 2, 255, 254, 0, 7]))
    // 原位置变成 junction
    expect(lstatSafe(src)?.isSymbolicLink()).toBe(true)
    expect(getLinkState(src, target)).toBe('linked')
    // 通过链接可读
    expect(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8')).toContain('My Skill')
  })

  it('源是链接：导入真身、仅删链接本身、重建为指向 vault 的链接', () => {
    const real = path.join(tmp, 'real-body')
    fs.renameSync(src, real)
    const link = path.join(tmp, 'link-skill')
    createJunction(real, link)
    const r = executeImport(link, vault, { commit: false })
    expect(r.sourceIsLink).toBe(true)
    // 真身原样保留（仅删了链接本身）
    expect(fs.existsSync(path.join(real, 'SKILL.md'))).toBe(true)
    expect(lstatSafe(real)?.isSymbolicLink()).toBe(false)
    // 原链接位置 → vault
    expect(lstatSafe(link)?.isSymbolicLink()).toBe(true)
    expect(getLinkState(link, path.join(vault, 'skills', 'real-body'))).toBe('linked')
  })

  it('vault 冲突时抛错且源目录不动', () => {
    fs.mkdirSync(path.join(vault, 'skills', 'my-skill'))
    expect(() => executeImport(src, vault, { commit: false })).toThrow(/已存在同名/)
    expect(lstatSafe(src)?.isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(src, 'SKILL.md'))).toBe(true)
  })
})

describe('verifyCopy（先校验后删除的安全闸门）', () => {
  it('一致时通过', () => {
    const dst = path.join(vault, 'skills', 'my-skill')
    fs.mkdirSync(dst, { recursive: true })
    for (const f of walkFiles(src)) {
      const to = path.join(dst, ...f.rel.split('/'))
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(path.join(src, ...f.rel.split('/')), to)
    }
    expect(() => verifyCopy(src, dst)).not.toThrow()
  })

  it('字节不一致时抛错（vault 副本保留）', () => {
    const dst = path.join(vault, 'skills', 'my-skill')
    fs.mkdirSync(dst, { recursive: true })
    for (const f of walkFiles(src)) {
      const to = path.join(dst, ...f.rel.split('/'))
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(path.join(src, ...f.rel.split('/')), to)
    }
    // 篡改一个文件的大小
    fs.writeFileSync(path.join(dst, 'SKILL.md'), '# Tampered\n')
    expect(() => verifyCopy(src, dst)).toThrow(/字节不一致|文件数不一致/)
    // vault 副本仍在（不先删后验）
    expect(fs.existsSync(path.join(dst, 'SKILL.md'))).toBe(true)
  })

  it('文件数不一致时抛错', () => {
    const dst = path.join(vault, 'skills', 'my-skill')
    fs.mkdirSync(dst, { recursive: true })
    fs.copyFileSync(path.join(src, 'SKILL.md'), path.join(dst, 'SKILL.md'))
    expect(() => verifyCopy(src, dst)).toThrow(/文件数不一致/)
  })
})
