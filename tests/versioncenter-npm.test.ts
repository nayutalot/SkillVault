import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  NPM_NOT_FOUND_ERROR,
  npmInstalled,
  npmLatest,
  npmCmdCandidates,
  parseNpmLsDependencies,
  parseNpmViewVersion,
  resolveNpmCmdPath
} from '../src/main/versionCenter/npm'
import { execCmdLine } from '../src/main/versionCenter/exec'
import type { Spawner } from '../src/main/wslBridge'

/** 本机实测的 npm ls -g --depth=0 --json 输出（节选） */
const NPM_LS_JSON = JSON.stringify({
  name: 'npm',
  dependencies: {
    '@agentclientprotocol/claude-agent-acp': { version: '0.37.0', overridden: false },
    '@anthropic-ai/claude-code': { version: '2.1.150', overridden: false },
    pnpm: { version: '11.24.0', overridden: false }
  }
})

describe('parseNpmLsDependencies', () => {
  it('解析 dependencies → Map（含 scoped 包名）', () => {
    const map = parseNpmLsDependencies(NPM_LS_JSON)
    expect(map.get('@anthropic-ai/claude-code')).toBe('2.1.150')
    expect(map.get('pnpm')).toBe('11.24.0')
    expect(map.size).toBe(3)
  })

  it('空 dependencies → 空 Map（合法）', () => {
    expect(parseNpmLsDependencies(JSON.stringify({ name: 'npm', dependencies: {} })).size).toBe(0)
  })

  it('非 JSON（npm 报错文本）→ 空 Map，不抛错', () => {
    expect(parseNpmLsDependencies("'npm' 不是内部或外部命令").size).toBe(0)
    expect(parseNpmLsDependencies('').size).toBe(0)
  })

  it('缺 version 字段的条目被跳过', () => {
    const map = parseNpmLsDependencies(JSON.stringify({ dependencies: { a: {}, b: { version: '1.0.0' } } }))
    expect(map.size).toBe(1)
    expect(map.get('b')).toBe('1.0.0')
  })
})

describe('parseNpmViewVersion', () => {
  it('纯版本输出', () => {
    expect(parseNpmViewVersion('2.1.257\n')).toBe('2.1.257')
  })

  it('stdout 混入告警行时取最后一个版本形行', () => {
    expect(parseNpmViewVersion('npm warn Unknown project config "x".\nv1.2.3\n')).toBe('v1.2.3')
  })

  it('无版本形行 → null', () => {
    expect(parseNpmViewVersion('npm error 404 Not Found')).toBeNull()
    expect(parseNpmViewVersion('')).toBeNull()
  })
})

// ---------- 通道函数（fake spawner；npm 实际经 cmd.exe /d /s /c 执行） ----------

function fakeSpawner(spec: { stdout?: string; stderr?: string; code?: number } = {}, calls: { spawnArgs: unknown[][] } = { spawnArgs: [] }): Spawner {
  return (cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess => {
    calls.spawnArgs.push([cmd, args, opts])
    const child = new EventEmitter() as unknown as ChildProcess
    child.stdout = new EventEmitter() as unknown as ChildProcess['stdout']
    child.stderr = new EventEmitter() as unknown as ChildProcess['stderr']
    child.kill = vi.fn(() => true)
    child.unref = vi.fn()
    queueMicrotask(() => {
      if (spec.stdout !== undefined) child.stdout!.emit('data', Buffer.from(spec.stdout))
      if (spec.stderr !== undefined) child.stderr!.emit('data', Buffer.from(spec.stderr))
      child.emit('close', spec.code ?? 0)
    })
    return child
  }
}

describe('npmInstalled / npmLatest', () => {
  /** where 调用现在也经 cmd.exe 参数数组通道（chcp 65001，防 GBK 乱码）：按 args 内容识别 */
  const isWhereCall = (args: readonly string[]): boolean => args.includes('where.exe')

  it('npm ls -g：先 where.exe（经 cmd chcp 通道）解析 npm.cmd，再经 cmd.exe 参数数组执行（chcp 65001 前缀 + 绝对路径）', async () => {
    const calls = { spawnArgs: [] as unknown[][] }
    const spawner: Spawner = (cmd, args, opts) => {
      if (isWhereCall(args)) return fakeSpawner({ stdout: 'C:\\npm\\path\\npm.cmd\r\n' }, calls)(cmd, args, opts)
      return fakeSpawner({ stdout: NPM_LS_JSON }, calls)(cmd, args, opts)
    }
    const fileExists = (p: string): boolean => p === 'C:\\npm\\path\\npm.cmd'
    const r = await npmInstalled({ spawner, fileExists })
    if (!('map' in r)) throw new Error('应当成功')
    expect(r.map.get('@anthropic-ai/claude-code')).toBe('2.1.150')
    // 第一次调用：cmd.exe 参数数组（chcp 前缀 + where.exe npm.cmd）
    const [whereCmd, whereArgs] = calls.spawnArgs[0] as [string, string[]]
    expect(whereCmd).toBe('cmd.exe')
    expect(whereArgs.slice(3, 9)).toEqual(['chcp', '65001', '>nul', '&&', 'where.exe', 'npm.cmd'])
    // 第二次调用：cmd.exe 参数数组（chcp 前缀 + 解析出的绝对路径；含空格路径不坏引号语义）
    const [cmd, args] = calls.spawnArgs[1] as [string, string[]]
    expect(cmd).toBe('cmd.exe')
    expect(args.slice(0, 8)).toEqual(['/d', '/s', '/c', 'chcp', '65001', '>nul', '&&', 'C:\\npm\\path\\npm.cmd'])
    expect(args.slice(8)).toEqual(['ls', '-g', '--depth=0', '--json'])
  })

  it('where 未命中但常见安装位候选存在 → 用候选路径执行（env 与 fileExists 可注入）', async () => {
    const calls = { spawnArgs: [] as unknown[][] }
    const spawner: Spawner = (cmd, args, opts) => {
      if (isWhereCall(args)) return fakeSpawner({ code: 1 }, calls)(cmd, args, opts)
      return fakeSpawner({ stdout: NPM_LS_JSON }, calls)(cmd, args, opts)
    }
    const r = await npmInstalled({
      spawner,
      env: { ProgramFiles: 'C:\\PF', APPDATA: 'C:\\AD' },
      fileExists: (p) => p === 'C:\\PF\\nodejs\\npm.cmd'
    })
    if (!('map' in r)) throw new Error('应当成功')
    expect(r.map.get('pnpm')).toBe('11.24.0')
    const tuple = calls.spawnArgs[calls.spawnArgs.length - 1] as [string, string[]]
    expect(tuple[0]).toBe('cmd.exe')
    expect((tuple[1] as string[])[7]).toBe('C:\\PF\\nodejs\\npm.cmd')
    expect((tuple[1] as string[]).slice(3, 7)).toEqual(['chcp', '65001', '>nul', '&&'])
  })

  it('where 输出乱码/失效路径（fileExists 不过）→ 回落到候选探测，绝不带乱码路径执行', async () => {
    const calls = { spawnArgs: [] as unknown[][] }
    const spawner: Spawner = (cmd, args, opts) => {
      if (isWhereCall(args)) return fakeSpawner({ stdout: 'C:\\\ufffd\ufffd\\npm.cmd\r\n' }, calls)(cmd, args, opts)
      return fakeSpawner({ stdout: NPM_LS_JSON }, calls)(cmd, args, opts)
    }
    const r = await npmInstalled({
      spawner,
      env: { ProgramFiles: 'C:\\PF', APPDATA: 'C:\\AD' },
      fileExists: (p) => p === 'C:\\AD\\npm\\npm.cmd'
    })
    if (!('map' in r)) throw new Error('应当成功')
    const last = calls.spawnArgs[calls.spawnArgs.length - 1] as [string, string[]]
    expect((last[1] as string[])[7]).toBe('C:\\AD\\npm\\npm.cmd')
  })

  it('where 与常见安装位全部失败 → 明确错误「未找到 npm.cmd」，绝不以乱码报 check-failed', async () => {
    const calls = { spawnArgs: [] as unknown[][] }
    const spawner: Spawner = (cmd, args, opts) => fakeSpawner({ code: 1 }, calls)(cmd, args, opts)
    const p = await resolveNpmCmdPath({ spawner, env: {}, fileExists: () => false })
    expect(p).toBeNull()
    const r = await npmInstalled({ spawner, env: {}, fileExists: () => false })
    if ('map' in r) throw new Error('应当失败')
    expect(r.error).toBe(NPM_NOT_FOUND_ERROR)
    expect(r.error).toContain('未找到 npm.cmd')
    // 全失败路径不应再跑 npm 命令（第一条 where 之外的 cmd.exe 调用只能是解析用途，不盲跑裸 npm）
    const npmRuns = calls.spawnArgs.filter((c) => {
      const a = (c as [string, string[]])[1]
      return a.includes('ls') || a.includes('view')
    })
    expect(npmRuns.length).toBe(0)
  })

  it('npm view：参数数组含 chcp 前缀 + 解析路径 + 包名与 version；返回最新版本', async () => {
    const calls = { spawnArgs: [] as unknown[][] }
    const spawner: Spawner = (cmd, args, opts) => {
      if (isWhereCall(args)) return fakeSpawner({ stdout: 'C:\\npm\\path\\npm.cmd\n' }, calls)(cmd, args, opts)
      return fakeSpawner({ stdout: '2.1.257\n' }, calls)(cmd, args, opts)
    }
    const r = await npmLatest('@anthropic-ai/claude-code', { spawner, fileExists: (p) => p === 'C:\\npm\\path\\npm.cmd' })
    expect(r).toEqual({ version: '2.1.257' })
    const args = (calls.spawnArgs[1] as [string, string[]])[1]
    expect(args.slice(7)).toEqual(['C:\\npm\\path\\npm.cmd', 'view', '@anthropic-ai/claude-code', 'version'])
  })

  it('npm view 失败 → error', async () => {
    const spawner: Spawner = (cmd, args, opts) => {
      if (isWhereCall(args)) return fakeSpawner({ stdout: 'C:\\npm\\path\\npm.cmd\n' }, calls)(cmd, args, opts)
      return fakeSpawner({ code: 1, stdout: 'npm error 404', stderr: 'network error' }, calls)(cmd, args, opts)
    }
    const calls = { spawnArgs: [] as unknown[][] }
    const r = await npmLatest('@anthropic-ai/claude-code', { spawner, fileExists: (p) => p === 'C:\\npm\\path\\npm.cmd' })
    if ('version' in r && r.version) throw new Error('应当失败')
    expect(r.error).toContain('npm view 失败')
    expect(r.error).toContain('network error')
  })
})

describe('npmCmdCandidates', () => {
  it('由 ProgramFiles / APPDATA 组装候选；缺环境变量时跳过该候选', () => {
    expect(npmCmdCandidates({ ProgramFiles: 'C:\\PF', APPDATA: 'C:\\AD' })).toEqual([
      'C:\\PF\\nodejs\\npm.cmd',
      'C:\\AD\\npm\\npm.cmd'
    ])
    expect(npmCmdCandidates({})).toEqual([])
  })
})

describe('execCmdLine chcp 前缀（UTF-8 解码通道）', () => {
  it('经 cmd.exe 的单行命令统一加 chcp 65001 >nul && 前缀', async () => {
    const calls = { spawnArgs: [] as unknown[][] }
    const r = await execCmdLine('npm --version', { timeoutMs: 5000, spawner: fakeSpawner({ stdout: '11.0.0' }, calls) }).done
    expect(r.stdout).toBe('11.0.0')
    const [cmd, args] = calls.spawnArgs[0] as [string, string[]]
    expect(cmd).toBe('cmd.exe')
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(args[3]).toBe('chcp 65001 >nul && npm --version')
  })
})
