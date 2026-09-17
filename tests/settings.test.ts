// settings.ts 行为回归：默认值不共享数组引用 / 端口整数校验 / 原子写落盘。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/main/settings'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-settings-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('loadSettings 默认值隔离', () => {
  it('无配置文件时 remoteTargets 是新数组：原地 push 不污染模块级默认值（旧 bug：浅拷贝共享引用）', () => {
    const a = loadSettings(dir)
    const b = loadSettings(dir)
    expect(a.remoteTargets).not.toBe(b.remoteTargets)
    expect(a.remoteTargets).not.toBe(DEFAULT_SETTINGS.remoteTargets)
    a.remoteTargets.push({
      id: 't1',
      kind: 'ssh',
      label: 'L',
      enabled: false,
      host: 'h',
      port: 22
    })
    expect(loadSettings(dir).remoteTargets).toHaveLength(0)
    expect(DEFAULT_SETTINGS.remoteTargets).toHaveLength(0)
  })

  it('configDir=null（无头脚本）同样返回独立数组', () => {
    const a = loadSettings(null)
    const b = loadSettings(null)
    expect(a.remoteTargets).not.toBe(b.remoteTargets)
  })
})

describe('parseRemoteTargets 端口校验', () => {
  it('小数/负数/越界端口字段被丢弃（条目保留），整数端口保留', () => {
    const raw = [
      { id: 'a', kind: 'ssh', label: 'A', enabled: true, host: 'h', port: 2.5 },
      { id: 'b', kind: 'ssh', label: 'B', enabled: true, host: 'h', port: -22 },
      { id: 'c', kind: 'ssh', label: 'C', enabled: true, host: 'h', port: 70000 },
      { id: 'd', kind: 'ssh', label: 'D', enabled: true, host: 'h', port: 2222 }
    ]
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ remoteTargets: raw }), 'utf8')
    const s = loadSettings(dir)
    // 条目都保留（label/host 等仍有效），但非法端口字段绝不落盘（否则拼进 ssh -p 必失败）
    expect(s.remoteTargets.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(s.remoteTargets.map((t) => t.port ?? null)).toEqual([null, null, null, 2222])
  })
})

describe('saveSettings 原子写', () => {
  it('落盘后可读回，且不残留 .tmp 临时文件', () => {
    const s = loadSettings(dir)
    s.vaultPath = 'D:\\new-vault'
    saveSettings(dir, s)
    expect(loadSettings(dir).vaultPath).toBe('D:\\new-vault')
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([])
  })
})
