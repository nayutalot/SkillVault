import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createJunction,
  getLinkState,
  normalizeWinPath,
  removeLink,
  scanWindowsAgents
} from '../src/main/winLinks'
import { defaultRegistry } from '../src/shared/registry'

let tmp = ''
let vault = ''
let agentDir = ''

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-link-'))
  vault = path.join(tmp, 'vault')
  agentDir = path.join(tmp, 'agent-skills')
  fs.mkdirSync(path.join(vault, 'skills', 'foo'), { recursive: true })
  fs.writeFileSync(path.join(vault, 'skills', 'foo', 'SKILL.md'), '# Foo\n')
  fs.mkdirSync(agentDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('normalizeWinPath', () => {
  it('去掉 \\\\?\\ 前缀并归一化小写', () => {
    expect(normalizeWinPath('\\\\?\\C:\\A\\B')).toBe('c:\\a\\b')
    expect(normalizeWinPath('C:/A/B/')).toBe(path.normalize('c:\\a\\b'))
  })

  it('junction readlink 结果与目标归一化相等', () => {
    const link = path.join(agentDir, 'foo')
    createJunction(path.join(vault, 'skills', 'foo'), link)
    const read = fs.readlinkSync(link)
    expect(normalizeWinPath(read)).toBe(normalizeWinPath(path.join(vault, 'skills', 'foo')))
  })
})

describe('getLinkState', () => {
  const target = () => path.join(vault, 'skills', 'foo')

  it('linked：指向 vault 目标', () => {
    const link = path.join(agentDir, 'foo')
    createJunction(target(), link)
    expect(getLinkState(link, target())).toBe('linked')
  })

  it('wrong-target：指向别处', () => {
    const other = path.join(tmp, 'other')
    fs.mkdirSync(other)
    const link = path.join(agentDir, 'foo')
    createJunction(other, link)
    expect(getLinkState(link, target())).toBe('wrong-target')
  })

  it('wrong-target：普通文件占位', () => {
    const link = path.join(agentDir, 'foo')
    fs.writeFileSync(link, 'x')
    expect(getLinkState(link, target())).toBe('wrong-target')
  })

  it('real-dir：同名真实目录', () => {
    const link = path.join(agentDir, 'foo')
    fs.mkdirSync(link)
    expect(getLinkState(link, target())).toBe('real-dir')
  })

  it('missing：路径不存在', () => {
    expect(getLinkState(path.join(agentDir, 'foo'), target())).toBe('missing')
  })

  it('vault-missing：链接正确但 vault 目标被删（悬空）', () => {
    const link = path.join(agentDir, 'foo')
    createJunction(target(), link)
    fs.rmSync(target(), { recursive: true, force: true })
    expect(getLinkState(link, target())).toBe('vault-missing')
  })
})

describe('removeLink', () => {
  it('仅删除链接本身，不动目标内容', () => {
    const link = path.join(agentDir, 'foo')
    createJunction(path.join(vault, 'skills', 'foo'), link)
    removeLink(link)
    expect(fs.existsSync(link)).toBe(false)
    expect(fs.existsSync(path.join(vault, 'skills', 'foo', 'SKILL.md'))).toBe(true)
  })

  it('拒绝删除真实目录', () => {
    const real = path.join(agentDir, 'real')
    fs.mkdirSync(real)
    expect(() => removeLink(real)).toThrow(/不是链接/)
  })
})

describe('scanWindowsAgents', () => {
  it('按 registry 扫描各 agent 的链接状态', () => {
    const reg = {
      version: 2 as const,
      agents: [
        { name: 'a1', platform: 'windows' as const, skillsDir: path.join(tmp, 'a1'), include: ['*'] },
        { name: 'a2', platform: 'windows' as const, skillsDir: path.join(tmp, 'a2'), include: ['*'] },
        { name: 'a3', platform: 'windows' as const, skillsDir: path.join(tmp, 'a3'), include: ['*'] }
      ]
    }
    fs.mkdirSync(path.join(tmp, 'a1'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'a2'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'a3', 'foo'), { recursive: true })
    createJunction(path.join(vault, 'skills', 'foo'), path.join(tmp, 'a1', 'foo'))

    const scans = scanWindowsAgents(vault, reg)
    expect(scans).toHaveLength(3)
    expect(scans[0].links['foo']).toBe('linked')
    expect(scans[1].links['foo']).toBe('missing')
    expect(scans[2].links['foo']).toBe('real-dir')
  })

  it('默认 registry 结构可被扫描逻辑接受（4 agents）', () => {
    const scans = scanWindowsAgents(vault, defaultRegistry())
    expect(scans.map((s) => s.name)).toEqual(['zcode-win', 'codex-win', 'agents-win'])
  })

  it('配置了 agentsDir 的 agent：扫描整目录链接状态并附带 vault agents/*.md 清单', () => {
    fs.mkdirSync(path.join(vault, 'agents'), { recursive: true })
    fs.writeFileSync(path.join(vault, 'agents', 'omni-agent.md'), '---\nname: omni-agent\n---\n', 'utf8')
    fs.writeFileSync(path.join(vault, 'agents', 'omni-agent-pro.md'), '---\nname: omni-agent-pro\n---\n', 'utf8')
    const linkedDir = path.join(tmp, 'agents-linked')
    fs.mkdirSync(linkedDir, { recursive: true })
    createJunction(path.join(vault, 'agents'), path.join(linkedDir, 'agents'))
    const reg = {
      version: 2 as const,
      agents: [
        { name: 'with-agents', platform: 'windows' as const, skillsDir: agentDir, agentsDir: path.join(linkedDir, 'agents'), include: ['*'] },
        { name: 'unlinked-agents', platform: 'windows' as const, skillsDir: agentDir, agentsDir: path.join(tmp, 'agents-absent'), include: ['*'] },
        { name: 'no-agents', platform: 'windows' as const, skillsDir: agentDir, include: ['*'] }
      ]
    }
    const scans = scanWindowsAgents(vault, reg)
    expect(scans[0].agentsDirState).toBe('linked')
    expect(scans[0].agentFiles).toEqual(['omni-agent-pro.md', 'omni-agent.md'].sort())
    expect(scans[1].agentsDirState).toBe('missing')
    expect(scans[1].agentFiles).toEqual(scans[0].agentFiles)
    // 未配置 agentsDir 的 agent 不带 agentsDir 字段
    expect(scans[2].agentsDir).toBeUndefined()
    expect(scans[2].agentsDirState).toBeUndefined()
    expect(scans[2].agentFiles).toBeUndefined()
  })
})
