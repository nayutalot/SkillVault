import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelJob,
  findRunningProcess,
  jobSnapshot,
  readVersionCache,
  requestUpdateOne,
  runVersionCheckAll,
  runVersionCheckSingle,
  startUpdateJob,
  writeVersionCache
} from '../src/main/versionCenter/jobs'
import { findCatalogEntry } from '../src/main/versionCenter/catalog'
import type { Spawner } from '../src/main/wslBridge'

// ---------- 基础设施：按 (cmd, args) 路由的可注入 fake spawner ----------

type FakeSpec = { stdout?: string; stderr?: string; code?: number; error?: Error; neverClose?: boolean }
type Dispatch = (cmd: string, args: readonly string[]) => FakeSpec | undefined
type Calls = { spawnArgs: unknown[][]; kills: number }

function dispatchSpawner(dispatch: Dispatch, calls: Calls): Spawner {
  return (cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess => {
    calls.spawnArgs.push([cmd, [...args], opts])
    const spec = dispatch(cmd, args) ?? {}
    const child = new EventEmitter() as unknown as ChildProcess
    child.stdout = new EventEmitter() as unknown as ChildProcess['stdout']
    child.stderr = new EventEmitter() as unknown as ChildProcess['stderr']
    ;(child as { pid?: number }).pid = 7000 + calls.spawnArgs.length
    child.kill = vi.fn(() => {
      calls.kills++
      queueMicrotask(() => child.emit('close', null))
      return true
    })
    child.unref = vi.fn()
    queueMicrotask(() => {
      if (spec.stdout !== undefined) child.stdout!.emit('data', Buffer.from(spec.stdout))
      if (spec.stderr !== undefined) child.stderr!.emit('data', Buffer.from(spec.stderr))
      if (spec.error) {
        child.emit('error', spec.error)
        return
      }
      if (spec.neverClose) return
      child.emit('close', spec.code ?? 0)
    })
    return child
  }
}

// ---------- 真实格式样本（与真机实测一致） ----------

const UPGRADE_TABLE = [
  'Name                Id                        Version       Available     Source',
  '--------------------------------------------------------------------------------',
  'Claude              Anthropic.Claude          1.26832.0.0   1.30096.1     winget',
  'Claude Code         Anthropic.ClaudeCode      2.1.143       2.1.248       winget',
  '',
  '2 upgrades available.',
  ''
].join('\r\n')

function wingetListOut(id: string, installed: string, available?: string): string {
  return [
    'Name   Id   Version   Available   Source',
    '----------------------------------------',
    `App ${id} ${installed}${available ? ` ${available}` : ''} winget`,
    ''
  ].join('\r\n')
}

const NPM_LS_JSON = JSON.stringify({
  dependencies: { '@anthropic-ai/claude-code': { version: '2.1.150', overridden: false } }
})

const REG_SAMPLE = [
  '',
  'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\c330d982aee38d3ec1bea31c8d549b98',
  '    DisplayName    REG_SZ    DeepSeek Harness',
  '    DisplayVersion    REG_SZ    1.0',
  '',
  ''
].join('\r\n')

/** GitHub Releases API 应答样本（全 prerelease 仓库：必须 list 后自选最高，/releases/latest 恒空） */
const RELEASES_JSON = JSON.stringify([
  { tag_name: 'dsh-v0.1.1-rc.2', published_at: '2026-08-21T12:35:08Z', prerelease: true, draft: false },
  { tag_name: 'dsh-v0.1.2-alpha.4', published_at: '2026-09-01T15:45:07Z', prerelease: true, draft: false }
])

/** deepseek 本体目录：指向不存在的路径 → 走 ARP 回退展示分支（与真机安装解耦，保证测试确定性） */
const NO_DSH_ROOT = path.join(os.tmpdir(), 'vc-no-dsh-root-' + Math.random().toString(36).slice(2))

const KIMI_BIN = process.env['USERPROFILE'] ? path.join(process.env['USERPROFILE'], '.kimi-code', 'bin', 'kimi.exe') : 'kimi.exe'
const GROK_BIN = process.env['USERPROFILE'] ? path.join(process.env['USERPROFILE'], '.grok', 'bin', 'grok.exe') : 'grok.exe'

/** 标准检查场景路由：8 条目全部按侦察数据应答 */
function checkDispatch(state: {
  npmViewVersion?: string
  npmViewError?: boolean
  zcodeInstalled?: string
  failAll?: boolean
  tasklist?: string
}): Dispatch {
  return (cmd, args) => {
    if (state.failAll) return { error: new Error('spawn ENOENT') }
    if (cmd === 'winget' && args[0] === 'upgrade' && !args.includes('--id')) return { stdout: UPGRADE_TABLE }
    if (cmd === 'winget' && args[0] === 'upgrade') return { stdout: '成功更新\r\n' }
    if (cmd === 'winget' && args[0] === 'list') {
      const id = args[2] as string
      if (id === 'Anthropic.Claude') return { stdout: wingetListOut(id, '1.26832.0.0', '1.30096.1') }
      if (id === 'Anthropic.ClaudeCode') return { stdout: wingetListOut(id, '2.1.143', '2.1.248') }
      if (id === 'OpenAI.Codex') {
        return {
          stdout: [
            'Name   Id   Version   Available   Source',
            '----------------------------------------',
            'ChatGPT MSIX\\OpenAI.Codex_26.825.6671.0_x64__2p2nqsd0c76g0 26.825.6671.0',
            ''
          ].join('\r\n')
        }
      }
      if (id === 'ZhipuAI.ZCode') return { stdout: wingetListOut(id, state.zcodeInstalled ?? '3.10.2') }
      return { stdout: '' }
    }
    if (cmd === 'cmd.exe') {
      // execCmdArgs 通道：'/d /s /c chcp 65001 >nul && <命令...>'（按 join 后的路由）
      const line = (args as readonly string[]).join(' ')
      if (line.includes('where.exe npm.cmd')) return { stdout: '' }
      if (line.includes(' ls -g --depth=0 --json')) return { stdout: NPM_LS_JSON }
      if (line.includes(' view @anthropic-ai/claude-code version')) {
        return state.npmViewError
          ? { code: 1, stderr: 'npm error network' }
          : { stdout: `${state.npmViewVersion ?? '2.1.257'}\n` }
      }
      if (line.includes('reg query')) return { stdout: REG_SAMPLE }
    }
    if (args[0] === '--version') {
      if (cmd === KIMI_BIN) return { stdout: '0.36.0\n' }
      if (cmd === GROK_BIN) return { stdout: 'grok 1.0.5 (5115b46bc9)\n' }
    }
    if (cmd === 'reg') return { stdout: REG_SAMPLE }
    if (cmd === 'curl.exe' && (args as readonly string[]).some((a) => String(a).includes('api.github.com'))) {
      return { stdout: RELEASES_JSON }
    }
    if (cmd === 'tasklist') return { stdout: state.tasklist ?? '' }
    return {}
  }
}

// ---------- 缓存文件基建 ----------

const tmpFiles: string[] = []

function newCacheFile(): string {
  // 门禁安全（路径穿越防护）：目录由 mkdtemp 生成、文件名是本函数内的固定字面量（无外部输入），
  // resolve 后仍强制校验包含在临时目录内（以 path.sep 结尾前缀比较）才返回
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-cache-'))
  const f = path.resolve(dir, 'cache.json')
  if (!f.startsWith(dir + path.sep)) throw new Error(`缓存路径越界: ${f}`)
  tmpFiles.push(dir)
  return f
}

afterEach(() => {
  for (const d of tmpFiles.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* 清理失败忽略 */
    }
  }
})

// ---------- checkAll ----------

describe('runVersionCheckAll（fake spawner 全场景）', () => {
  it('全量并行检查：8 条目状态与侦察数据一致；结果写入缓存 stale=false', async () => {
    const calls: Calls = { spawnArgs: [], kills: 0 }
    const cacheFile = newCacheFile()
    const r = await runVersionCheckAll({
      spawner: dispatchSpawner(checkDispatch({}), calls),
      cacheFile,
      now: () => 1234,
      deepseekRoot: NO_DSH_ROOT
    })
    expect(r.stale).toBe(false)
    expect(r.ts).toBe(1234)
    const by = new Map(r.statuses.map((s) => [s.id, s]))
    expect(r.statuses.length).toBe(8)
    expect(by.get('claude-code-npm')).toMatchObject({ state: 'upgradable', installed: '2.1.150', latest: '2.1.257' })
    expect(by.get('claude-code-winget')).toMatchObject({ state: 'upgradable', installed: '2.1.143', latest: '2.1.248' })
    expect(by.get('claude-desktop')).toMatchObject({ state: 'upgradable', installed: '1.26832.0.0', latest: '1.30096.1' })
    expect(by.get('codex-desktop')).toMatchObject({ state: 'up-to-date', installed: '26.825.6671.0' })
    expect(by.get('kimi-cli')).toMatchObject({ state: 'unknown', installed: '0.36.0' })
    expect(by.get('grok-cli')).toMatchObject({ state: 'unknown', installed: 'grok 1.0.5 (5115b46bc9)' })
    // deepseek：github 通道；安装目录缺失 → unknown + ARP 注册表版本回退展示
    const dsh = by.get('deepseek-harness')
    expect(dsh).toMatchObject({ channelKind: 'github', state: 'unknown', installed: '1.0', latest: '0.1.2-alpha.4' })
    expect(dsh?.note).toContain('未找到本地安装')
    expect(dsh?.note).toContain('可在设置中指定目录')
    expect(dsh?.note).toContain('1.0')
    expect(by.get('zcode')).toMatchObject({ state: 'up-to-date', installed: '3.10.2' })
    expect(by.get('zcode')?.hint).toContain('更新会关闭正在运行的 ZCode')

    const cached = readVersionCache(cacheFile)
    expect(cached?.ts).toBe(1234)
    expect(cached?.statuses.length).toBe(8)
  })

  it('每条独立失败：仅 npm view 挂 → 该条 unknown（已装版本已知），其余正常，缓存仍写入', async () => {
    const cacheFile = newCacheFile()
    const r = await runVersionCheckAll({
      spawner: dispatchSpawner(checkDispatch({ npmViewError: true }), { spawnArgs: [], kills: 0 }),
      cacheFile,
      deepseekRoot: NO_DSH_ROOT
    })
    const by = new Map(r.statuses.map((s) => [s.id, s]))
    const npmEntry = by.get('claude-code-npm')
    expect(npmEntry?.state).toBe('unknown')
    expect(npmEntry?.installed).toBe('2.1.150')
    expect(npmEntry?.note).toContain('npm view 失败')
    expect(by.get('claude-desktop')?.state).toBe('upgradable')
    expect(r.stale).toBe(false)
    expect(readVersionCache(cacheFile)?.statuses.length).toBe(8)
  })

  it('全部失败 → 回落缓存 stale=true 并给 reason', async () => {
    const cacheFile = newCacheFile()
    writeVersionCache(cacheFile, { ts: 42, statuses: [{ id: 'x', name: 'X', channel: 'c', channelKind: 'npm', state: 'unknown' }] })
    const r = await runVersionCheckAll({
      spawner: dispatchSpawner(checkDispatch({ failAll: true }), { spawnArgs: [], kills: 0 }),
      cacheFile,
      deepseekRoot: NO_DSH_ROOT
    })
    expect(r.stale).toBe(true)
    expect(r.ts).toBe(42)
    expect(r.reason).toContain('回落')
    expect(r.statuses[0].id).toBe('x')
  })

  it('单条重查：未知 id 抛错；正常 id 返回单元素并回填缓存', async () => {
    const cacheFile = newCacheFile()
    await expect(runVersionCheckSingle('no-such-id', {})).rejects.toThrow('版本目录中不存在该条目')
    const r = await runVersionCheckSingle('zcode', {
      spawner: dispatchSpawner(checkDispatch({ zcodeInstalled: '3.10.3' }), { spawnArgs: [], kills: 0 }),
      cacheFile
    })
    expect(r.statuses.length).toBe(1)
    expect(r.statuses[0]).toMatchObject({ id: 'zcode', installed: '3.10.3', state: 'up-to-date' })
    expect(readVersionCache(cacheFile)?.statuses.map((s) => s.id)).toContain('zcode')
  })
})

// ---------- 预检与更新 job 状态机 ----------

describe('findRunningProcess / 预检', () => {
  it('tasklist 命中 ZCode.exe → 返回进程名', async () => {
    const calls: Calls = { spawnArgs: [], kills: 0 }
    const r = await findRunningProcess(['ZCode.exe'], {
      spawner: dispatchSpawner(checkDispatch({ tasklist: '"ZCode.exe","1234","Console","1","1,234 K"\r\n' }), calls)
    })
    expect(r).toBe('ZCode.exe')
  })

  it('tasklist 空 → null', async () => {
    const r = await findRunningProcess(['claude.exe'], {
      spawner: dispatchSpawner(checkDispatch({ tasklist: '信息: 没有运行的任务匹配指定的条件。\r\n' }), { spawnArgs: [], kills: 0 })
    })
    expect(r).toBeNull()
  })
})

describe('updateOne → job 状态机（运行中预检 / 完成 / 失败 / 取消 / 并发拒绝）', () => {
  it('zcode 在运行：未确认 → blocked 且绝不启动更新；确认后 job 执行并自动重查回填 3.10.3', async () => {
    const calls: Calls = { spawnArgs: [], kills: 0 }
    const cacheFile = newCacheFile()
    const spawner = dispatchSpawner(checkDispatch({ zcodeInstalled: '3.10.3', tasklist: '"ZCode.exe","1234","Console","1","1,234 K"\r\n' }), calls)
    const deps = { spawner, cacheFile }

    const pf = await requestUpdateOne('zcode', false, deps)
    expect(pf).toEqual({ blocked: true, running: true, processName: 'ZCode.exe' })
    // 预检阶段绝不允许出现更新命令
    expect(calls.spawnArgs.some((c) => (c[1] as string[]).includes('--id') && c[0] === 'winget' && (c[1] as string[])[0] === 'upgrade')).toBe(false)

    const start = await requestUpdateOne('zcode', true, deps)
    expect(start.blocked).toBe(false)
    const jobId = start.jobId as string
    expect(jobSnapshot(jobId).status).toBe('running')
    // 更新命令 detached
    const upCall = calls.spawnArgs.find((c) => c[0] === 'winget' && (c[1] as string[])[0] === 'upgrade' && (c[1] as string[]).includes('--id'))
    expect((upCall?.[2] as { detached?: boolean }).detached).toBe(true)

    await vi.waitFor(() => expect(jobSnapshot(jobId).status).toBe('done'))
    const job = jobSnapshot(jobId)
    expect(job.after).toMatchObject({ id: 'zcode', installed: '3.10.3', state: 'up-to-date' })
    expect(job.log[0]).toContain('$ winget upgrade --id ZhipuAI.ZCode')
    expect(job.log.some((l) => l.includes('重新检查'))).toBe(true)
    const cached = readVersionCache(cacheFile)
    expect(cached?.statuses.find((s) => s.id === 'zcode')?.installed).toBe('3.10.3')
  })

  it('更新命令失败（非零退出）→ job failed 且 error 带输出尾部', async () => {
    const calls: Calls = { spawnArgs: [], kills: 0 }
    const spawner: Spawner = (cmd, args, opts) => {
      if (cmd === 'winget' && (args as readonly string[]).includes('--id')) {
        return dispatchSpawner(() => ({ code: 1, stdout: '', stderr: 'winget 更新失败' }), calls)(cmd, args, opts)
      }
      return dispatchSpawner(() => ({}), calls)(cmd, args, opts)
    }
    const start = startUpdateJob(findCatalogEntry('claude-desktop')!, { spawner })
    const jobId = start.jobId
    await vi.waitFor(() => expect(jobSnapshot(jobId).status).toBe('failed'))
    const job = jobSnapshot(jobId)
    expect(job.error).toContain('winget 更新失败')
    expect(job.log.some((l) => l.includes('✗ 更新命令失败'))).toBe(true)
  })

  it('取消：running 中 cancelJob → status=cancelled，进程树被杀（taskkill + kill），迟到 close 不改状态', async () => {
    const calls: Calls = { spawnArgs: [], kills: 0 }
    const spawner: Spawner = (cmd, args, opts) => {
      if ((cmd === KIMI_BIN || cmd === GROK_BIN) && args[0] === 'update') {
        return dispatchSpawner(() => ({ neverClose: true }), calls)(cmd, args, opts)
      }
      return dispatchSpawner(() => ({}), calls)(cmd, args, opts)
    }
    const start = startUpdateJob(findCatalogEntry('kimi-cli')!, { spawner })
    const jobId = start.jobId
    expect(jobSnapshot(jobId).status).toBe('running')
    expect(cancelJob(jobId)).toBe(true)
    expect(jobSnapshot(jobId).status).toBe('cancelled')
    expect(calls.kills).toBeGreaterThanOrEqual(1)
    expect(cancelJob(jobId)).toBe(false) // 幂等：已取消不再重复杀
    await new Promise((r) => setTimeout(r, 20))
    expect(jobSnapshot(jobId).status).toBe('cancelled')
  })

  it('同一条目并发更新被拒绝；未知条目直接抛错；未知 jobId 查询抛错', async () => {
    const calls: Calls = { spawnArgs: [], kills: 0 }
    const spawner: Spawner = (cmd, args, opts) => {
      if ((cmd === KIMI_BIN || cmd === GROK_BIN) && args[0] === 'update') {
        return dispatchSpawner(() => ({ neverClose: true }), calls)(cmd, args, opts)
      }
      return dispatchSpawner(() => ({}), calls)(cmd, args, opts)
    }
    const start = startUpdateJob(findCatalogEntry('grok-cli')!, { spawner })
    expect(() => startUpdateJob(findCatalogEntry('grok-cli')!, { spawner })).toThrow('已在更新中')
    await expect(requestUpdateOne('no-such', true, { spawner })).rejects.toThrow('版本目录中不存在该条目')
    expect(() => jobSnapshot('vc-nope')).toThrow('更新任务不存在')
    expect(() => cancelJob('vc-nope')).toThrow('更新任务不存在')
    cancelJob(start.jobId)
  })

  it('自带更新器通道：kimi 更新成功 → job done；更新命令为其 update 子命令', async () => {
    const calls: Calls = { spawnArgs: [], kills: 0 }
    const spawner: Spawner = (cmd, args, opts) => {
      if (cmd === KIMI_BIN && args[0] === 'update') {
        return dispatchSpawner(() => ({ stdout: 'checking... done, updated to 0.37.0\r\n' }), calls)(cmd, args, opts)
      }
      if (args[0] === '--version') return dispatchSpawner(() => ({ stdout: '0.36.0\n' }), calls)(cmd, args, opts)
      return dispatchSpawner(() => ({}), calls)(cmd, args, opts)
    }
    const start = startUpdateJob(findCatalogEntry('kimi-cli')!, { spawner })
    const jobId = start.jobId
    await vi.waitFor(() => expect(jobSnapshot(jobId).status).toBe('done'))
    const job = jobSnapshot(jobId)
    expect(job.log[0]).toBe('$ ' + KIMI_BIN + ' update')
    // 重查条目回填（--version 仍回答 0.36.0 的 fake 场景）
    expect(job.after?.installed).toBe('0.36.0')
    expect(job.log[job.log.length - 1]).toContain('更新完成')
  })
})
