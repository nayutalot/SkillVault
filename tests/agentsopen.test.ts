// 子智能体 .md 打开动作的安全边界（与 skillopen.test 同级的无头覆盖）
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isKnownAgentFile,
  isValidAgentMdName,
  rememberAgentFiles,
  resolveVaultAgentMd
} from '../src/main/agentsOpen'

const VAULT = 'C:\\Users\\sakuya\\SkillVault'

describe('isValidAgentMdName', () => {
  it('接受合法 kebab-case .md', () => {
    expect(isValidAgentMdName('omni-agent.md')).toBe(true)
    expect(isValidAgentMdName('omni-agent-pro.md')).toBe(true)
    expect(isValidAgentMdName('a.md')).toBe(true)
    expect(isValidAgentMdName('a1-b2.md')).toBe(true)
  })

  it('拒绝空/非字符串/超长', () => {
    expect(isValidAgentMdName('')).toBe(false)
    expect(isValidAgentMdName(undefined)).toBe(false)
    expect(isValidAgentMdName(123)).toBe(false)
    expect(isValidAgentMdName(`${'a'.repeat(129)}.md`)).toBe(false)
  })

  it('拒绝大写、下划线、空格、点开头、多层点、数字开头缺失', () => {
    expect(isValidAgentMdName('Omni-Agent.md')).toBe(false)
    expect(isValidAgentMdName('omni_agent.md')).toBe(false)
    expect(isValidAgentMdName('omni agent.md')).toBe(false)
    expect(isValidAgentMdName('.hidden.md')).toBe(false)
    expect(isValidAgentMdName('-lead.md')).toBe(false)
    expect(isValidAgentMdName('a..md')).toBe(false)
  })

  it('拒绝非 .md 扩展名与双扩展名', () => {
    expect(isValidAgentMdName('omni-agent.txt')).toBe(false)
    expect(isValidAgentMdName('omni-agent.js')).toBe(false)
    expect(isValidAgentMdName('omni-agent.md.txt')).toBe(false)
    expect(isValidAgentMdName('omni-agent.MD')).toBe(false)
  })

  it('拒绝目录穿越与路径注入形态', () => {
    expect(isValidAgentMdName('..')).toBe(false)
    expect(isValidAgentMdName('../..md')).toBe(false)
    expect(isValidAgentMdName('..\\..\\win.ini')).toBe(false)
    expect(isValidAgentMdName('a/b.md')).toBe(false)
    expect(isValidAgentMdName('C:\\evil.md')).toBe(false)
    expect(isValidAgentMdName('a.md/../../x')).toBe(false)
  })
})

describe('resolveVaultAgentMd', () => {
  it('合法文件名解析到 vault\\agents\\<file>', () => {
    const md = resolveVaultAgentMd(VAULT, 'omni-agent.md')
    expect(md.toLowerCase()).toBe(path.resolve(VAULT, 'agents', 'omni-agent.md').toLowerCase())
  })

  it('非法文件名抛错（含穿越、注入、大写、非 md）', () => {
    expect(() => resolveVaultAgentMd(VAULT, '..\\..\\Windows\\win.ini')).toThrow(/非法 agent 文件名/)
    expect(() => resolveVaultAgentMd(VAULT, 'C:\\evil.md')).toThrow(/非法 agent 文件名/)
    expect(() => resolveVaultAgentMd(VAULT, 'Omni-Agent.md')).toThrow(/非法 agent 文件名/)
    expect(() => resolveVaultAgentMd(VAULT, 'omni-agent.txt')).toThrow(/非法 agent 文件名/)
    expect(() => resolveVaultAgentMd(VAULT, '')).toThrow(/非法 agent 文件名/)
    // @ts-expect-error 防御性：非字符串
    expect(() => resolveVaultAgentMd(VAULT, null)).toThrow(/非法 agent 文件名/)
  })

  it('即使文件名合法，解析结果也必须严格位于 agents 前缀内（纵深防御，非前缀同名目录不放过）', () => {
    // vaultPath 带 .. 归一化后前缀仍正确
    const md = resolveVaultAgentMd('C:\\a\\b\\..\\vault', 'omni-agent.md')
    expect(md.toLowerCase()).toBe(path.resolve('C:\\a\\vault', 'agents', 'omni-agent.md').toLowerCase())
    // agentsX（前缀粘连但非同目录）不允许：正则已禁点，路径拼接层面再由 startsWith(agents + sep) 兜底
    expect(() => resolveVaultAgentMd(VAULT, 'a.md')).not.toThrow()
  })
})

describe('rememberAgentFiles / isKnownAgentFile', () => {
  it('扫描登记后命中，覆盖上次集合', () => {
    rememberAgentFiles(['omni-agent.md', 'omni-agent-pro.md'])
    expect(isKnownAgentFile('omni-agent.md')).toBe(true)
    expect(isKnownAgentFile('omni-agent-pro.md')).toBe(true)
    rememberAgentFiles(['omni-agent.md'])
    expect(isKnownAgentFile('omni-agent-pro.md')).toBe(false)
  })

  it('未登记/非法输入一律拒绝；清空后全部拒绝', () => {
    rememberAgentFiles(['omni-agent.md'])
    expect(isKnownAgentFile('not-scanned.md')).toBe(false)
    expect(isKnownAgentFile('')).toBe(false)
    expect(isKnownAgentFile('../x')).toBe(false)
    expect(isKnownAgentFile(undefined)).toBe(false)
    rememberAgentFiles([])
    expect(isKnownAgentFile('omni-agent.md')).toBe(false)
  })
})
