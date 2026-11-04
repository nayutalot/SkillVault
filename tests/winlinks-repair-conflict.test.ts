// agentsDir 一键修复的「差异可见性」回归：
// 背景：修复会把目标端同名不同 inode 的旧文件移入回收目录。旧文件里可能含有用户
// 尚未合入 vault 的改动 —— 移走不等于「冲突已解决」。因此修复必须在动手前算清差异，
// 并把「谁不同、差多少字节、谁的修改时间更新、旧文件去哪了」一并回传（steps + conflicts）。
// 本文件覆盖：修复后 conflicts 的内容、planAgentsDirRepair 的处置判定、回收文件仍可读回。
// 临时目录真 fs + fs.linkSync 造硬链接；写盘一律路径 resolve + startsWith(root+sep) 受控守卫。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  planAgentsDirRepair,
  repairAgentsDirHardlinks,
  vaultAgentsDir
} from '../src/main/winLinks'

let tmp = ''
let vault = ''
let agentsDir = ''

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-repair-conflict-'))
  vault = path.join(tmp, 'vault')
  agentsDir = path.join(tmp, 'agents-real')
  fs.mkdirSync(vaultAgentsDir(vault), { recursive: true })
  writeMd(vaultAgentsDir(vault), 'omni-agent.md', 'vault-side-content')
  writeMd(vaultAgentsDir(vault), 'omni-agent-pro.md', 'vault-side-pro')
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

/** 在 agentsDir 里建立指向 vault 同名文件的硬链接（同一 inode） */
function linkMd(name: string): void {
  const src = path.join(vaultAgentsDir(vault), name)
  const dst = path.join(agentsDir, name)
  const base = path.resolve(tmp) + path.sep
  if (!path.resolve(dst).startsWith(base)) throw new Error('临时链接越界: ' + name)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.linkSync(src, dst)
}

/** 把目标端文件的修改时间显式设为某个时间点（让「谁更新」可确定，不依赖测试机时钟） */
function setMtime(file: string, iso: string): void {
  const t = new Date(iso)
  fs.utimesSync(file, t, t)
}

describe('repairAgentsDirHardlinks：修复前先展示差异', () => {
  it('目标端与 vault 内容不同 → conflicts 记录差异（含两边字节数与修改时间），旧文件仍可从回收目录读回', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    // 目标端是用户自己改过的版本（尚未合入 vault）
    const dstContent = 'user-edited-not-merged-back'
    const srcContent = 'vault-side-content'
    writeMd(agentsDir, 'omni-agent.md', dstContent)
    setMtime(path.join(agentsDir, 'omni-agent.md'), '2026-11-04T10:22:31.000Z')
    setMtime(path.join(vaultAgentsDir(vault), 'omni-agent.md'), '2026-10-01T09:00:00.000Z')

    const trashRoot = path.join(tmp, 'trash')
    const r = repairAgentsDirHardlinks(vault, agentsDir, { trashRoot })

    expect(r.state).toBe('linked')
    expect(r.conflicts).toHaveLength(1)
    const c = r.conflicts![0]
    expect(c.file).toBe('omni-agent.md')
    // reason 必须点名差异（字节数）与两边的修改时间，供人工核对
    expect(c.reason).toContain('不一致')
    expect(c.reason).toContain(`${Buffer.byteLength(dstContent)} 字节`)
    expect(c.reason).toContain(`${Buffer.byteLength(srcContent)} 字节`)
    expect(c.reason).toContain('2026-11-04')
    expect(c.reason).toContain('2026-10-01')
    // trashPath 指向回收目录里的实际文件
    expect(c.trashPath).toBeTruthy()
    expect(fs.existsSync(c.trashPath!)).toBe(true)
    expect(fs.readFileSync(c.trashPath!, 'utf8')).toBe(dstContent)
    // 步骤日志里也要写出差异（旧版只写「同名但非同一文件，旧文件移入 …」）
    const step = r.steps.find((s) => s.includes('omni-agent.md') && s.includes('移入'))
    expect(step).toBeTruthy()
    expect(step).toContain('内容不同')
    expect(step).toContain(`${Buffer.byteLength(dstContent)} 字节`)
    expect(step).toContain(`${Buffer.byteLength(srcContent)} 字节`)
    expect(step).toContain('2026-11-04')
    expect(step).toContain('2026-10-01')
  })

  it('目标端与 vault 内容一致但 inode 不同 → 仍然 replace，但 conflicts 为空（内容没丢，无需人工核对）', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    writeMd(agentsDir, 'omni-agent.md', 'vault-side-content')
    // 显式把目标端改旧：内容一致且不比 vault 新 → 没有需要人工核对的差异
    setMtime(path.join(agentsDir, 'omni-agent.md'), '2026-09-01T00:00:00.000Z')

    const r = repairAgentsDirHardlinks(vault, agentsDir, { trashRoot: path.join(tmp, 'trash') })

    expect(r.state).toBe('linked')
    // 仍然完成了替换（目标端现在是 vault 的硬链接）
    const a = fs.statSync(path.join(vaultAgentsDir(vault), 'omni-agent.md'))
    const b = fs.statSync(path.join(agentsDir, 'omni-agent.md'))
    expect(a.ino).toBe(b.ino)
    expect(r.steps.some((s) => s.includes('omni-agent.md') && s.includes('内容一致'))).toBe(true)
    expect(r.conflicts ?? []).toEqual([])  })

  it('目标端比 vault 更新 → conflicts 有条目，plan 里 dstNewerThanSrc 为 true', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    writeMd(agentsDir, 'omni-agent.md', 'vault-side-content')
    // 内容一样、但目标端被改得更晚：可能用户动过它 → 需要人工核对
    setMtime(path.join(vaultAgentsDir(vault), 'omni-agent.md'), '2026-09-01T00:00:00.000Z')
    setMtime(path.join(agentsDir, 'omni-agent.md'), '2026-11-04T10:22:31.000Z')

    const plan = planAgentsDirRepair(vault, agentsDir)
    const entry = plan.entries.find((e) => e.file === 'omni-agent.md')
    expect(entry?.action).toBe('replace')
    expect(entry?.dstNewerThanSrc).toBe(true)
    expect(entry?.contentSame).toBe(true)
    expect(plan.conflictCount).toBeGreaterThan(0)

    const r = repairAgentsDirHardlinks(vault, agentsDir, { trashRoot: path.join(tmp, 'trash') })
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts![0].file).toBe('omni-agent.md')
    expect(r.conflicts![0].reason).toContain('2026-11-04')
    expect(r.conflicts![0].trashPath).toBeTruthy()
    expect(fs.existsSync(r.conflicts![0].trashPath!)).toBe(true)
  })

  it('vault 缺的多余文件 → conflicts 有一条 remove-extra 条目（reason 说明 vault 没有该文件）', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    linkMd('omni-agent.md')
    linkMd('omni-agent-pro.md')
    const extraContent = 'my-own-extra-file'
    writeMd(agentsDir, 'stray.md', extraContent)
    setMtime(path.join(agentsDir, 'stray.md'), '2026-11-04T10:22:31.000Z')

    const trashRoot = path.join(tmp, 'trash')
    const r = repairAgentsDirHardlinks(vault, agentsDir, { trashRoot })

    expect(r.state).toBe('linked')
    expect(r.conflicts).toHaveLength(1)
    const c = r.conflicts![0]
    expect(c.file).toBe('stray.md')
    expect(c.reason).toContain('vault 中没有这个文件')
    expect(c.reason).toContain(`${Buffer.byteLength(extraContent)} 字节`)
    expect(c.reason).toContain('2026-11-04')
    expect(c.trashPath).toBeTruthy()
    expect(fs.readFileSync(c.trashPath!, 'utf8')).toBe(extraContent)
    const step = r.steps.find((s) => s.includes('stray.md') && s.includes('多余文件'))
    expect(step).toContain(`${Buffer.byteLength(extraContent)} 字节`)
    expect(step).toContain('2026-11-04')
  })
})

describe('planAgentsDirRepair：修复前的处置预检', () => {
  it('已是同一 inode → keep；vault 有而目标端缺 → add；目标端多出的 → remove-extra', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    linkMd('omni-agent.md') // 与 vault 同一 inode
    linkMd('omni-agent-pro.md')
    writeMd(agentsDir, 'stray.md', 'extra')
    writeMd(vaultAgentsDir(vault), 'brand-new.md', 'new')

    const plan = planAgentsDirRepair(vault, agentsDir)
    const byFile = new Map(plan.entries.map((e) => [e.file, e]))

    expect(byFile.get('omni-agent.md')?.action).toBe('keep')
    expect(byFile.get('omni-agent.md')?.contentSame).toBe(true)
    expect(byFile.get('omni-agent-pro.md')?.action).toBe('keep')
    // vault 有、目标端没有 → 直接建链
    expect(byFile.get('brand-new.md')?.action).toBe('add')
    expect(byFile.get('brand-new.md')?.dstSize).toBeUndefined()
    expect(byFile.get('brand-new.md')?.srcSize).toBe('new'.length)
    // 目标端多出的 → 移入回收
    expect(byFile.get('stray.md')?.action).toBe('remove-extra')
    expect(byFile.get('stray.md')?.srcSize).toBeUndefined()
    expect(byFile.get('stray.md')?.dstSize).toBe('extra'.length)
    // 计划本身不产生任何副作用：目录内容不变
    expect(fs.existsSync(path.join(agentsDir, 'stray.md'))).toBe(true)
    expect(fs.existsSync(path.join(agentsDir, 'brand-new.md'))).toBe(false)
  })

  it('同名但不同 inode → replace，并带上两边的字节数与修改时间', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    writeMd(agentsDir, 'omni-agent.md', 'other')
    setMtime(path.join(vaultAgentsDir(vault), 'omni-agent.md'), '2026-10-01T09:00:00.000Z')
    setMtime(path.join(agentsDir, 'omni-agent.md'), '2026-11-04T10:22:31.000Z')

    const plan = planAgentsDirRepair(vault, agentsDir)
    const e = plan.entries.find((x) => x.file === 'omni-agent.md')
    expect(e?.action).toBe('replace')
    expect(e?.contentSame).toBe(false)
    expect(e?.dstSize).toBe('other'.length)
    expect(e?.srcSize).toBe('vault-side-content'.length)
    expect(e?.dstMtime).toBe('2026-11-04T10:22:31.000Z')
    expect(e?.srcMtime).toBe('2026-10-01T09:00:00.000Z')
    expect(e?.dstNewerThanSrc).toBe(true)
    expect(plan.conflictCount).toBe(1)
  })
})

describe('既有行为不回归', () => {
  it('修复后目录状态仍为 linked（硬链接共享），同 inode 跳过、缺失补齐', () => {
    fs.mkdirSync(agentsDir, { recursive: true })
    linkMd('omni-agent.md')
    const r = repairAgentsDirHardlinks(vault, agentsDir, { trashRoot: path.join(tmp, 'trash') })
    expect(r.state).toBe('linked')
    expect(r.note).toBe('硬链接共享')
    expect(r.steps.some((s) => s.includes('跳过') && s.includes('omni-agent.md'))).toBe(true)
    const a = fs.statSync(path.join(vaultAgentsDir(vault), 'omni-agent-pro.md'))
    const b = fs.statSync(path.join(agentsDir, 'omni-agent-pro.md'))
    expect(a.ino).toBe(b.ino)
  })

  it('无冲突时 conflicts 为空数组（无冲突 = 不需要人工核对）', () => {
    const r = repairAgentsDirHardlinks(vault, agentsDir, { trashRoot: path.join(tmp, 'trash') })
    expect(r.state).toBe('linked')
    expect(r.conflicts).toEqual([])
  })
})
