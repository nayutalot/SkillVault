// 子智能体 agentsDir 的硬链接共享识别 + 一键修复（真实目录形态）：
// - agentsDirStateOf：junction/symlink 语义不变；真实目录 + 每个 vault .md 同名同 inode（dev+ino）→ linked（附注「硬链接共享」）
// - 缺名 / 多余 .md / 同名不同 inode / stat 异常 → real-dir（可修复）
// - repairAgentsDirHardlinks：vault 为源重建硬链接（同 inode 跳过 / 同名异文件移入回收目录 / 多余 .md 移入回收目录）
// 临时目录真 fs + fs.linkSync 造硬链接；写盘一律路径 resolve + startsWith(root+sep) 受控守卫。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENTS_DIR_HARDLINK_NOTE,
  agentsDirStateOf,
  createJunction,
  isHardlinkSharedAgentsDir,
  repairAgentsDirHardlinks,
  scanWindowsAgent,
  vaultAgentsDir
} from '../src/main/winLinks'
import type { RegistryAgent } from '../src/shared/types'

let tmp = ''
let vault = ''
let agentsDir = ''

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-agentsdir-'))
  vault = path.join(tmp, 'vault')
  agentsDir = path.join(tmp, 'agents-real')
  fs.mkdirSync(vaultAgentsDir(vault), { recursive: true })
  writeMd(vaultAgentsDir(vault), 'omni-agent.md')
  writeMd(vaultAgentsDir(vault), 'omni-agent-pro.md')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** 受控 .md 写入：resolve 后必须仍在 tmp 内（防路径逃逸守卫） */
function writeMd(dir: string, name: string, content = '---\nname: x\n---\n'): void {
  const target = dir + path.sep + name
  const base = path.resolve(tmp) + path.sep
  if (!target.startsWith(base)) throw new Error('临时写入越界: ' + name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
}

/** 在 agentsDir 里建立指向 vault 同名文件的硬链接（内容为零字节拷贝语义的同一文件） */
function linkMd(name: string): void {
  const src = path.join(vaultAgentsDir(vault), name)
  const dst = path.join(agentsDir, name)
  const base = path.resolve(tmp) + path.sep
  if (!path.resolve(dst).startsWith(base)) throw new Error('临时链接越界: ' + name)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.linkSync(src, dst)
}

const agent = (): RegistryAgent => ({
  name: 'zcode-win',
  platform: 'windows',
  skillsDir: path.join(tmp, 'skills'),
  agentsDir,
  include: ['*']
})

describe('agentsDirStateOf：硬链接共享目录识别', () => {
  it('真实目录 + vault 每个 .md 同名同 inode（fs.linkSync）→ linked + 附注「硬链接共享」', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    linkMd('omni-agent.md')
    linkMd('omni-agent-pro.md')
    expect(agentsDirStateOf(vault, agentsDir)).toEqual({ state: 'linked', note: AGENTS_DIR_HARDLINK_NOTE })
    const scan = scanWindowsAgent(vault, agent())
    expect(scan.agentsDirState).toBe('linked')
    expect(scan.agentsDirNote).toBe('硬链接共享')
  })

  it('junction 形态：仍是 linked 且无硬链接附注（现状不变）', () => {
    createJunction(vaultAgentsDir(vault), agentsDir)
    expect(agentsDirStateOf(vault, agentsDir)).toEqual({ state: 'linked' })
    expect(scanWindowsAgent(vault, agent()).agentsDirNote).toBeUndefined()
  })

  it('目录缺一个 vault .md → real-dir（冲突，可修复）', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    linkMd('omni-agent.md')
    expect(agentsDirStateOf(vault, agentsDir).state).toBe('real-dir')
  })

  it('目录有 vault 没有的多余 .md → real-dir', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    linkMd('omni-agent.md')
    linkMd('omni-agent-pro.md')
    writeMd(agentsDir, 'stray.md')
    expect(agentsDirStateOf(vault, agentsDir).state).toBe('real-dir')
  })

  it('同名但不同 inode（独立文件）→ real-dir', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    writeMd(agentsDir, 'omni-agent.md', 'independent content')
    linkMd('omni-agent-pro.md')
    expect(agentsDirStateOf(vault, agentsDir).state).toBe('real-dir')
    expect(isHardlinkSharedAgentsDir(agentsDir, vault)).toBe(false)
  })

  it('目录不存在 → missing；vault agents 为空且目录也为空 → linked', () => {
    expect(agentsDirStateOf(vault, agentsDir).state).toBe('missing')
    fs.rmSync(vaultAgentsDir(vault), { recursive: true, force: true })
    fs.mkdirSync(vaultAgentsDir(vault), { recursive: true })
    fs.mkdirSync(agentsDir, { recursive: true })
    expect(agentsDirStateOf(vault, agentsDir)).toEqual({ state: 'linked', note: AGENTS_DIR_HARDLINK_NOTE })
  })
})

describe('repairAgentsDirHardlinks（一键修复）', () => {
  it('vault 新增 .md → 修复后目录补齐硬链接（同 inode），finalState=linked；同名同 inode 跳过', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    linkMd('omni-agent.md')
    writeMd(vaultAgentsDir(vault), 'extra-new.md')
    const r = repairAgentsDirHardlinks(vault, agentsDir, { trashRoot: path.join(tmp, 'trash') })
    expect(r.state).toBe('linked')
    expect(r.note).toBe('硬链接共享')
    expect(r.steps.some((s) => s.includes('跳过') && s.includes('omni-agent.md'))).toBe(true)
    expect(r.steps.some((s) => s.includes('extra-new.md'))).toBe(true)
    // 硬链接语义：dev+ino 与 vault 侧一致
    const a = fs.statSync(path.join(vaultAgentsDir(vault), 'extra-new.md'))
    const b = fs.statSync(path.join(agentsDir, 'extra-new.md'))
    expect(a.dev).toBe(b.dev)
    expect(a.ino).toBe(b.ino)
  })

  it('目录多余 .md → 移入回收目录（不直接删除）；同名不同 inode → 旧文件移入回收目录后重建', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    linkMd('omni-agent.md')
    writeMd(agentsDir, 'stray.md', 'stray-bytes')
    writeMd(agentsDir, 'omni-agent-pro.md', 'stale-inode-content')
    const trashRoot = path.join(tmp, 'trash')
    const r = repairAgentsDirHardlinks(vault, agentsDir, { trashRoot })
    expect(r.state).toBe('linked')
    expect(fs.existsSync(path.join(agentsDir, 'stray.md'))).toBe(false)
    const trashed = fs.readdirSync(trashRoot)
    expect(trashed).toContain('stray.md')
    expect(fs.readFileSync(path.join(trashRoot, 'stray.md'), 'utf8')).toBe('stray-bytes')
    // 重建后 omni-agent-pro.md 与 vault 同 inode
    const a = fs.statSync(path.join(vaultAgentsDir(vault), 'omni-agent-pro.md'))
    const b = fs.statSync(path.join(agentsDir, 'omni-agent-pro.md'))
    expect(a.ino).toBe(b.ino)
  })

  it('目录缺失（ZCode 重启后 junction 被替换）→ 创建目录并全量硬链接', () => {
    const r = repairAgentsDirHardlinks(vault, agentsDir, { trashRoot: path.join(tmp, 'trash') })
    expect(r.state).toBe('linked')
    expect(r.steps.some((s) => s.includes('已创建目录'))).toBe(true)
    expect(fs.readdirSync(agentsDir).sort()).toEqual(['omni-agent-pro.md', 'omni-agent.md'])
  })

  it('junction 形态也可修复为硬链接目录（先解除链接再重建）', () => {
    createJunction(vaultAgentsDir(vault), agentsDir)
    const r = repairAgentsDirHardlinks(vault, agentsDir, { trashRoot: path.join(tmp, 'trash') })
    expect(r.steps.some((s) => s.includes('已移除既有链接'))).toBe(true)
    expect(r.state).toBe('linked')
    const st = fs.lstatSync(agentsDir)
    expect(st.isSymbolicLink()).toBe(false)
    expect(st.isDirectory()).toBe(true)
  })

  it('vault agents 目录不存在 → 抛错（无源可链，不破坏目标目录）', () => {
    fs.rmSync(vaultAgentsDir(vault), { recursive: true, force: true })
    fs.mkdirSync(agentsDir, { recursive: true })
    writeMd(agentsDir, 'keep.md')
    expect(() => repairAgentsDirHardlinks(vault, agentsDir, { trashRoot: path.join(tmp, 'trash') })).toThrow('vault 中不存在 agents 目录')
    expect(fs.existsSync(path.join(agentsDir, 'keep.md'))).toBe(true)
  })

  it('同一回收目录内同名备份不互相覆盖（追加 .1 序号；旧 bug：第二次修复静默覆盖第一次的备份）', () => {
    const trash = path.join(tmp, 'shared-trash')
    // 第一次修复：agentsDir 的 stray.md 进回收
    fs.mkdirSync(agentsDir, { recursive: true })
    writeMd(agentsDir, 'stray.md', 'first stray')
    // 第二个 vault/agentsDir 组合，同名 stray.md（模拟同秒内两个 agent 各修一次、共用同一回收目录）
    const vault2 = path.join(tmp, 'vault2')
    const agentsDir2 = path.join(tmp, 'agents2')
    fs.mkdirSync(vaultAgentsDir(vault2), { recursive: true })
    writeMd(vaultAgentsDir(vault2), 'omni-agent.md')
    writeMd(vaultAgentsDir(vault2), 'omni-agent-pro.md')
    fs.mkdirSync(agentsDir2, { recursive: true })
    writeMd(agentsDir2, 'stray.md', 'second stray')
    repairAgentsDirHardlinks(vault, agentsDir, { trashRoot: trash })
    repairAgentsDirHardlinks(vault2, agentsDir2, { trashRoot: trash })
    // 两份同名备份都必须还在（第二份带 .1 序号）
    expect(fs.readFileSync(path.join(trash, 'stray.md'), 'utf8')).toBe('first stray')
    expect(fs.readFileSync(path.join(trash, 'stray.1.md'), 'utf8')).toBe('second stray')
  })
})
