// WSL 页后端单测：wsl -l -v 表解析（中英表头/星标/空行容忍）、复合指标解析、Get-Process JSON 解析、
// 动作参数构造（fake spawner 断言 argv）、overview 不为取数而 spawn 已停止的发行版。
// 全程不真调 wsl.exe；绝不真执行 terminate/boot/shutdown。
import { describe, expect, it } from 'vitest'
import {
  DISTRO_STATS_CMD,
  distroStats,
  hostVm,
  listDistros,
  parseDistroStats,
  parseHostVm,
  parseWslList,
  wslAction,
  wslActionArgs,
  wslOverview
} from '../src/main/wslmon'
import { fakeSpawner, seqSpawner, type FakeCalls } from './helpers/fakeSpawn'

/** 真机实测样例（WSL_UTF8=1）：Ubuntu 运行中 + docker-desktop 停止 + 星标默认 */
const REAL_WSL_LV = [
  '  NAME              STATE           VERSION',
  '* Ubuntu            Running         2',
  '  docker-desktop    Stopped         2',
  ''
].join('\n')

/** 真机实测复合输出（wsl -d Ubuntu -e sh -c 'cat /proc/meminfo; cat /proc/loadavg; df -h /; cat /proc/uptime'） */
const REAL_COMPOSITE = [
  'MemTotal:       24168120 kB',
  'MemFree:        11234568 kB',
  'MemAvailable:   19600000 kB',
  'Buffers:         1020304 kB',
  'Cached:          8080608 kB',
  '0.00 0.01 0.00 1/363 1340',
  'Filesystem      Size  Used Avail Use% Mounted on',
  '/dev/sdd        1007G   20G  936G   3% /',
  '6660.90 159823.94',
  ''
].join('\n')

describe('parseWslList（表解析，容忍中英表头/星标/空行/噪声）', () => {
  it('真机样例：两条发行版，Ubuntu 默认 + 运行中，docker-desktop 停止', () => {
    const rows = parseWslList(REAL_WSL_LV)
    expect(rows).toEqual([
      { name: 'Ubuntu', state: 'Running', version: '2', isDefault: true },
      { name: 'docker-desktop', state: 'Stopped', version: '2', isDefault: false }
    ])
  })

  it('空输出 → 空数组', () => {
    expect(parseWslList('')).toEqual([])
  })

  it('英文表头行按 state+version 关键字识别并跳过；虚线行跳过', () => {
    const rows = parseWslList(['NAME  STATE  VERSION', '---  -----  -------', '  a  Running  1', ''].join('\n'))
    expect(rows).toEqual([{ name: 'a', state: 'Running', version: '1', isDefault: false }])
  })

  it('中文表头（NAME/状态/版本）不误判为数据行（数据行按 Running/Stopped 校验兜底）', () => {
    const rows = parseWslList(['名称          状态        版本', '* Ubuntu      Running     2'].join('\n'))
    expect(rows).toEqual([{ name: 'Ubuntu', state: 'Running', version: '2', isDefault: true }])
  })

  it('无星标 → isDefault=false；缺 state 的噪声行/提示文本跳过', () => {
    const rows = parseWslList(
      ['适用于 Linux 的 Windows 子系统:', 'Ubuntu Running 2', 'some random line without state', ''].join('\n')
    )
    expect(rows).toEqual([{ name: 'Ubuntu', state: 'Running', version: '2', isDefault: false }])
  })

  it('UTF-16 空字节残留容忍（解析器自身再兜一层）', () => {
    expect(parseWslList('* Ubuntu\0            Running\0         2\0')).toEqual([
      { name: 'Ubuntu', state: 'Running', version: '2', isDefault: true }
    ])
  })

  it('过渡态（Installing/Converting）不再被整行丢弃 → state=Other（旧 bug：发行版从监控里凭空消失）', () => {
    const rows = parseWslList(
      ['  NAME            STATE           VERSION', '  Ubuntu          Installing      2', '  Debian          Running         2', ''].join('\n')
    )
    expect(rows).toEqual([
      { name: 'Ubuntu', state: 'Other', version: '2', isDefault: false },
      { name: 'Debian', state: 'Running', version: '2', isDefault: false }
    ])
  })

  it('发行版名含空格：以末尾版本号锚定（不再依赖 Running/Stopped 关键字定位）', () => {
    const rows = parseWslList('* My Distro X   Running   2')
    expect(rows).toEqual([{ name: 'My Distro X', state: 'Running', version: '2', isDefault: true }])
  })
})

describe('listDistros（fake spawner，不真调 wsl.exe）', () => {
  it('argv/env 断言：wsl.exe -l -v + WSL_UTF8=1；解析真机样例', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const r = await listDistros({ spawner: fakeSpawner({ stdout: REAL_WSL_LV }, calls) })
    expect(r.distros).toHaveLength(2)
    expect(r.error).toBeUndefined()
    const [cmd, args, opts] = calls.spawnArgs[0] as [string, string[], { env: Record<string, string> }]
    expect(cmd).toBe('wsl.exe')
    expect(args).toEqual(['-l', '-v'])
    expect(opts.env.WSL_UTF8).toBe('1')
  })

  it('失败且无输出 → error 文本透出', async () => {
    const r = await listDistros({ spawner: fakeSpawner({ code: 1, stderr: 'wsl 未安装' }) })
    expect(r.distros).toEqual([])
    expect(r.error).toContain('wsl 未安装')
  })
})

describe('parseDistroStats（复合输出解析）', () => {
  it('真机复合输出：meminfo/loadavg/df/uptime 全部解析', () => {
    const s = parseDistroStats(REAL_COMPOSITE)
    expect(s.memTotalKb).toBe(24168120)
    expect(s.memFreeKb).toBe(11234568)
    expect(s.memAvailKb).toBe(19600000)
    expect(s.load1).toBeCloseTo(0.0)
    expect(s.diskTotal).toBe('1007G')
    expect(s.diskUsed).toBe('20G')
    expect(s.diskAvail).toBe('936G')
    expect(s.diskPct).toBe(3)
    expect(s.uptimeSec).toBe(6661)
  })

  it('部分输出：拿到的解析、拿不到的为 null（绝不硬造数值）', () => {
    const s = parseDistroStats('MemTotal: 1000 kB\n')
    expect(s.memTotalKb).toBe(1000)
    expect(s.memFreeKb).toBeNull()
    expect(s.load1).toBeNull()
    expect(s.diskTotal).toBeNull()
    expect(s.uptimeSec).toBeNull()
  })

  it('空输出 → 全 null', () => {
    const s = parseDistroStats('')
    expect(s.memTotalKb).toBeNull()
    expect(s.load1).toBeNull()
    expect(s.diskPct).toBeNull()
    expect(s.uptimeSec).toBeNull()
  })
})

describe('parseHostVm / hostVm（Get-Process vmmemWSL JSON）', () => {
  it('单进程对象（PowerShell ConvertTo-Json 非数组形态）→ 解析 WS 字节', () => {
    const v = parseHostVm('{"Name":"vmmemWSL","WS":453627904}')
    expect(v).toEqual({ name: 'vmmemWSL', wsBytes: 453627904 })
  })

  it('多进程数组 → 取第一个 WS>0 的（vmmemWSL 在前）', () => {
    const v = parseHostVm('[{"Name":"vmmemWSL","WS":453627904},{"Name":"vmmem","WS":1234}]')
    expect(v?.name).toBe('vmmemWSL')
  })

  it('空输出 / 畸形 JSON / WS≤0 → null（进程不存在是常态）', () => {
    expect(parseHostVm('')).toBeNull()
    expect(parseHostVm('not json at all')).toBeNull()
    expect(parseHostVm('{"Name":"vmmemWSL","WS":0}')).toBeNull()
    expect(parseHostVm('[{"Name":"vmmemWSL","WS":null}]')).toBeNull()
  })

  it('hostVm：argv 断言 powershell -NoProfile -Command 且脚本读 vmmemWSL,vmmem', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const v = await hostVm({ spawner: fakeSpawner({ stdout: '{"Name":"vmmemWSL","WS":1048576}' }, calls) })
    expect(v?.wsBytes).toBe(1048576)
    const [cmd, args] = calls.spawnArgs[0] as [string, string[]]
    expect(cmd).toBe('powershell.exe')
    expect(args[0]).toBe('-NoProfile')
    expect(args.join(' ')).toContain('Get-Process vmmemWSL,vmmem')
  })
})

describe('wslActionArgs / wslAction（动作参数构造，绝不真执行）', () => {
  it('参数构造：terminate / boot(-e true) / shutdownAll', () => {
    expect(wslActionArgs('terminate', 'Ubuntu')).toEqual(['--terminate', 'Ubuntu'])
    expect(wslActionArgs('boot', 'Ubuntu')).toEqual(['-d', 'Ubuntu', '-e', 'true'])
    expect(wslActionArgs('shutdownAll')).toEqual(['--shutdown'])
  })

  it('wslAction argv 断言：terminate 不带 shell', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const r = await wslAction('terminate', 'docker-desktop', { spawner: fakeSpawner({}, calls) })
    expect(r.ok).toBe(true)
    const [cmd, args, opts] = calls.spawnArgs[0] as [string, string[], { shell?: boolean }]
    expect(cmd).toBe('wsl.exe')
    expect(args).toEqual(['--terminate', 'docker-desktop'])
    expect(opts.shell).toBeFalsy()
  })

  it('terminate/boot 缺发行版名 → 抛错且绝不 spawn', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const sp = fakeSpawner({}, calls)
    await expect(wslAction('terminate', '', { spawner: sp })).rejects.toThrow('需要发行版名')
    await expect(wslAction('boot', '  ', { spawner: sp })).rejects.toThrow('需要发行版名')
    expect(calls.spawnArgs).toHaveLength(0)
  })

  it('非法动作 → 抛错', async () => {
    await expect(wslAction('install' as never, 'Ubuntu', { spawner: fakeSpawner({}) })).rejects.toThrow('非法的 WSL 动作')
  })
})

describe('distroStats（复合读取）', () => {
  it('argv 断言：wsl -d <name> -e sh -c 复合命令 + WSL_UTF8；数值解析', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const r = await distroStats('Ubuntu', { spawner: fakeSpawner({ stdout: REAL_COMPOSITE }, calls) })
    expect(r.error).toBeUndefined()
    expect(r.stats.memTotalKb).toBe(24168120)
    const [cmd, args, opts] = calls.spawnArgs[0] as [string, string[], { env: Record<string, string> }]
    expect(cmd).toBe('wsl.exe')
    expect(args).toEqual(['-d', 'Ubuntu', '-e', 'sh', '-c', DISTRO_STATS_CMD])
    expect(opts.env.WSL_UTF8).toBe('1')
  })

  it('读取失败 → error 文本透出，stats 仍给已解析部分', async () => {
    const r = await distroStats('Broken', { spawner: fakeSpawner({ code: 1, stderr: 'wsl 检测到 localhost 代理配置' }) })
    expect(r.error).toContain('代理')
  })
})

describe('wslOverview（不为取数而启动已停止的发行版）', () => {
  it('真机形态：Ubuntu Running 带 stats；docker-desktop Stopped 只标状态；绝不 spawn -d docker-desktop', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    // 依次被调用：1) wsl -l -v  2) powershell hostVm  3) wsl -d Ubuntu -e sh -c ...（仅 Ubuntu）
    const sp = seqSpawner(
      [
        { stdout: REAL_WSL_LV },
        { stdout: '{"Name":"vmmemWSL","WS":453627904}' },
        { stdout: REAL_COMPOSITE }
      ],
      calls
    )
    const r = await wslOverview({ spawner: sp })
    expect(r.host?.wsBytes).toBe(453627904)
    expect(r.distros).toHaveLength(2)
    const ubuntu = r.distros.find((d) => d.name === 'Ubuntu')
    const dd = r.distros.find((d) => d.name === 'docker-desktop')
    expect(ubuntu?.stats?.memTotalKb).toBe(24168120)
    expect(ubuntu?.managedByDocker).toBe(false)
    expect(dd?.state).toBe('Stopped')
    expect(dd?.stats).toBeNull()
    expect(dd?.managedByDocker).toBe(true)
    // spawn 序列：-l -v、powershell、仅 -d Ubuntu（绝无 -d docker-desktop）
    const cmds = calls.spawnArgs.map((a) => (a[1] as string[]).join(' '))
    expect(cmds.some((c) => c.includes('-l -v'))).toBe(true)
    expect(cmds.some((c) => c.includes('Get-Process'))).toBe(true)
    expect(cmds.filter((c) => c.includes('-d Ubuntu')).length).toBe(1)
    expect(cmds.some((c) => c.includes('docker-desktop'))).toBe(false)
  })

  it('docker-desktop 即使 Running 也不取 stats（由 Docker Desktop 管理）', async () => {
    const calls: FakeCalls = { spawnArgs: [], kills: 0 }
    const sp = seqSpawner(
      [
        { stdout: '* docker-desktop    Running         2\n' },
        { stdout: '' } // powershell：vmmem 缺席
      ],
      calls
    )
    const r = await wslOverview({ spawner: sp })
    expect(r.host).toBeNull()
    expect(r.distros[0].managedByDocker).toBe(true)
    expect(r.distros[0].stats).toBeNull()
    // 只应有 -l -v 与 powershell 两次调用，绝无 -d
    expect(calls.spawnArgs.length).toBe(2)
    expect(calls.spawnArgs.every((a) => !(a[1] as string[]).includes('-d'))).toBe(true)
  })
})
