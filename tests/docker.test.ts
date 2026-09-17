// Docker 页后端单测：JSON Lines 解析 / 引擎下线判定 / 动作参数构造（fake spawner 断言 argv）/ startEngine 守卫。
// 全程不真调 docker CLI；危险动作只验证 argv 构造，绝不真执行。
import { describe, expect, it, vi } from 'vitest'
import {
  DOCKER_DESKTOP_EXE,
  containerAction,
  containerActionArgs,
  dockerContainers,
  dockerImages,
  dockerInfo,
  dockerLogs,
  imageRemove,
  imageRemoveArgs,
  isEngineDown,
  mergeStats,
  parseJsonLines,
  startEngine,
  summarizeEngineError
} from '../src/main/docker'
import type { DockerContainer } from '../src/shared/types'
import { fakeSpawner, seqSpawner, type FakeCalls } from './helpers/fakeSpawn'
/** 真机实测的引擎下线 stderr（Docker Desktop 未运行时 docker version 报错原文特征） */
const ENGINE_DOWN_STDERR =
  'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/version": ' +
  'open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'

describe('parseJsonLines（JSON Lines 手写按行解析）', () => {
  it('正常多行：每行一个 JSON 对象', () => {
    const rows = parseJsonLines<{ ID: string }>(
      ['{"ID":"a1"}', '{"ID":"b2"}', '{"ID":"c3"}'].join('\n')
    )
    expect(rows).toEqual([{ ID: 'a1' }, { ID: 'b2' }, { ID: 'c3' }])
  })

  it('空输出 → 空数组', () => {
    expect(parseJsonLines('')).toEqual([])
    expect(parseJsonLines('\n\n')).toEqual([])
  })

  it('畸形行跳过：混入告警噪声不致命，其余行照常解析', () => {
    const rows = parseJsonLines<{ ok: number }>('{bad json\n{"ok":1}\nwarning: something\n')
    expect(rows).toEqual([{ ok: 1 }])
  })

  it('空行跳过', () => {
    const rows = parseJsonLines<{ a: number }>('\n{"a":1}\n\n{"a":2}\n\n')
    expect(rows).toEqual([{ a: 1 }, { a: 2 }])
  })
})

describe('isEngineDown / summarizeEngineError（引擎下线判定特征）', () => {
  it('stderr 含 dockerDesktopLinuxEngine → engine-down', () => {
    expect(isEngineDown(ENGINE_DOWN_STDERR)).toBe(true)
  })

  it('stderr 含 cannot find the file specified → engine-down', () => {
    expect(isEngineDown('open //./pipe/dockerEngine: The system cannot find the file specified.')).toBe(true)
  })

  it('普通错误 stderr 不误判', () => {
    expect(isEngineDown('permission denied')).toBe(false)
    expect(isEngineDown('')).toBe(false)
  })

  it('摘要取第一个非空行并截断', () => {
    const s = summarizeEngineError('\n\n second line \n third')
    expect(s).toBe('second line')
    expect(summarizeEngineError('x'.repeat(500)).length).toBeLessThanOrEqual(220)
    expect(summarizeEngineError('')).toBe('无法连接 Docker 引擎')
  })
})

describe('dockerInfo（fake spawner，不真调 docker）', () => {
  it('在线：解析 Client/Server 版本；argv 为 version --format {{json .}} 模板单 arg', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const sp = fakeSpawner(
      {
        stdout:
          '{"Client":{"Version":"29.7.2"},"Server":{"Version":"29.7.2"}}\n'
      },
      calls
    )
    const r = await dockerInfo({ spawner: sp })
    expect(r.state).toBe('online')
    expect(r.clientVersion).toBe('29.7.2')
    expect(r.serverVersion).toBe('29.7.2')
    const [cmd, args] = calls.spawnArgs[0] as [string, string[]]
    expect(cmd).toBe('docker')
    expect(args).toEqual(['version', '--format', '{{json .}}'])
  })

  it('引擎下线：stderr 命中特征 → state engine-down + 摘要（用户当前实机常态）', async () => {
    const r = await dockerInfo({ spawner: fakeSpawner({ code: 1, stderr: ENGINE_DOWN_STDERR }) })
    expect(r.state).toBe('engine-down')
    expect(r.error).toContain('dockerDesktopLinuxEngine')
  })

  it('其他失败 → state error（不冒充 engine-down）', async () => {
    const r = await dockerInfo({ spawner: fakeSpawner({ code: 125, stderr: 'permission denied while talking to socket' }) })
    expect(r.state).toBe('error')
    expect(r.error).toContain('permission denied')
  })
})

describe('容器行解析 + stats 合并', () => {
  it('ps JSON 行 → 容器行：Names 逗号分隔取首个，字段齐全映射', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const sp = fakeSpawner(
      {
        stdout:
          '{"ID":"abc123","Names":"web,web-alias","Image":"nginx:latest","State":"running","Status":"Up 2 hours","CreatedAt":"2026-09-01 10:00:00 +0800 +08","Ports":"0.0.0.0:8080->80/tcp"}\n'
      },
      calls
    )
    const res = await dockerContainers({ spawner: sp })
    expect(res.containers).toHaveLength(1)
    const c = res.containers[0]
    expect(c.name).toBe('web')
    expect(c.image).toBe('nginx:latest')
    expect(c.state).toBe('running')
    expect(c.ports).toContain('8080->80')
    // ps 之后应再调一次 stats --no-stream
    const second = calls.spawnArgs[1] as [string, string[]]
    expect(second[1]).toEqual(['stats', '--no-stream', '--format', '{{json .}}'])
  })

  it('mergeStats：按容器名合并 CPU/内存；未命中容器保持缺省', () => {
    const base: DockerContainer[] = [
      { id: 'a', name: 'web', image: 'nginx', state: 'running', status: 'Up', created: '', ports: '' },
      { id: 'b', name: 'idle', image: 'redis', state: 'running', status: 'Up', created: '', ports: '' }
    ]
    const merged = mergeStats(base, [
      { Name: 'web', CPUPerc: '0.15%', MemUsage: '12.5MiB / 24GiB' }
    ])
    expect(merged[0].cpuPerc).toBe('0.15%')
    expect(merged[0].memUsage).toBe('12.5MiB / 24GiB')
    expect(merged[1].cpuPerc).toBeUndefined()
  })

  it('ps 失败且无输出 → 空列表不报错（引擎下线由 dockerInfo 单独判定）', async () => {
    const sp = seqSpawner([
      { code: 1, stderr: ENGINE_DOWN_STDERR }
    ])
    const r = await dockerContainers({ spawner: sp })
    expect(r.containers).toEqual([])
    expect(r.error).toBeUndefined()
  })
})

describe('dockerImages', () => {
  it('解析 repo/tag/id/size，created 优先 CreatedSince', async () => {
    const sp = fakeSpawner({
      stdout:
        '{"Repository":"nginx","Tag":"latest","ID":"e784f45604d8","Size":"187.7MB","CreatedAt":"2026-08-01 00:00:00 +0000 UTC","CreatedSince":"4 weeks ago"}\n'
    })
    const r = await dockerImages({ spawner: sp })
    expect(r.images).toEqual([
      { repository: 'nginx', tag: 'latest', id: 'e784f45604d8', size: '187.7MB', created: '4 weeks ago' }
    ])
  })
})

describe('动作参数构造（纯函数）+ 动作执行 argv 断言', () => {
  it('containerActionArgs：start/stop/restart 直呼，remove 用 rm -f', () => {
    expect(containerActionArgs('web', 'start')).toEqual(['start', 'web'])
    expect(containerActionArgs('web', 'stop')).toEqual(['stop', 'web'])
    expect(containerActionArgs('web', 'restart')).toEqual(['restart', 'web'])
    expect(containerActionArgs('web', 'remove')).toEqual(['rm', '-f', 'web'])
  })

  it('imageRemoveArgs：rmi <id>', () => {
    expect(imageRemoveArgs('e784f45604d8')).toEqual(['rmi', 'e784f45604d8'])
  })

  it('containerAction：fake spawner 断言实际 argv（绝不 shell、不拼接字符串）', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    await containerAction('my web', 'remove', { spawner: fakeSpawner({}, calls) })
    const [cmd, args, opts] = calls.spawnArgs[0] as [string, string[], { shell?: boolean }]
    expect(cmd).toBe('docker')
    expect(args).toEqual(['rm', '-f', 'my web'])
    expect(opts.shell).toBeFalsy()
  })

  it('containerAction：容器名缺失 / 非法动作 → 抛错且绝不 spawn', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const sp = fakeSpawner({}, calls)
    await expect(containerAction('', 'start', { spawner: sp })).rejects.toThrow('缺少容器名')
    await expect(containerAction('web', 'exec' as never, { spawner: sp })).rejects.toThrow('非法的容器动作')
    expect(calls.spawnArgs).toHaveLength(0)
  })

  it('imageRemove：动作失败时 detail 保留 stderr 原文', async () => {
    const r = await imageRemove('badid', { spawner: fakeSpawner({ code: 1, stderr: 'No such image' }) })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('No such image')
  })
})

describe('dockerLogs', () => {
  it('argv 断言（logs --tail 200）+ stdout/stderr 合并文本', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const r = await dockerLogs('web', {
      spawner: fakeSpawner({ stdout: 'line1\n', stderr: 'line2\n' }, calls)
    })
    expect(r.ok).toBe(true)
    expect(r.text).toContain('line1')
    expect(r.text).toContain('line2')
    const [cmd, args] = calls.spawnArgs[0] as [string, string[]]
    expect(cmd).toBe('docker')
    expect(args).toEqual(['logs', '--tail', '200', 'web'])
  })

  it('非零退出但无输出 → ok:false 带 error；容器名缺失抛错', async () => {
    const r = await dockerLogs('gone', { spawner: fakeSpawner({ code: 1, stderr: 'No such container: gone' }) })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('No such container')
    await expect(dockerLogs('', { spawner: fakeSpawner({}) })).rejects.toThrow('缺少容器名')
  })
})

describe('startEngine（fs 守卫 + detached 拉起）', () => {
  it('exe 缺失 → ok:false + 路径说明，绝不 spawn', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const r = await startEngine({
      fsMod: { existsSync: vi.fn(() => false) },
      spawner: fakeSpawner({}, calls)
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未找到 Docker Desktop')
    expect(calls.spawnArgs).toHaveLength(0)
  })

  it('exe 存在 → detached + stdio ignore + unref 拉起，返回启动提示', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const existsSync = vi.fn(() => true)
    const r = await startEngine({
      fsMod: { existsSync },
      desktopExe: 'D:\\mock\\Docker Desktop.exe',
      spawner: fakeSpawner({}, calls),
      confirmDelayMs: 5
    })
    expect(r.ok).toBe(true)
    expect(r.hint).toContain('10-30 秒')
    expect(existsSync).toHaveBeenCalledWith('D:\\mock\\Docker Desktop.exe')
    const [cmd, args, opts] = calls.spawnArgs[0] as [string, string[], { detached: boolean; stdio: string }]
    expect(cmd).toBe('D:\\mock\\Docker Desktop.exe')
    expect(args).toEqual([])
    expect(opts.detached).toBe(true)
    expect(opts.stdio).toBe('ignore')
  })

  it('异步 spawn error（权限/组策略拦截）→ 窗口期内如实 ok:false（旧 bug：同步 resolve 让 error 分支成死代码、恒报成功）', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const r = await startEngine({
      fsMod: { existsSync: vi.fn(() => true) },
      desktopExe: 'D:\\mock\\Docker Desktop.exe',
      spawner: fakeSpawner({ error: new Error('spawn EACCES') }, calls),
      confirmDelayMs: 200
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('EACCES')
  })

  it('启动器非零退出 → 窗口期内如实 ok:false', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const r = await startEngine({
      fsMod: { existsSync: vi.fn(() => true) },
      desktopExe: 'D:\\mock\\Docker Desktop.exe',
      spawner: fakeSpawner({ code: 1 }, calls),
      confirmDelayMs: 200
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('异常退出')
  })

  it('默认路径常量指向 Program Files 的 Docker Desktop.exe', () => {
    expect(DOCKER_DESKTOP_EXE).toBe('C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe')
  })
})
