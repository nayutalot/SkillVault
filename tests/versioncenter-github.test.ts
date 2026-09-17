// github 通道（DeepSeek Harness）单测：
// - 纯解析（parseReleasesJson / selectLatestTag）与 fetchLatestRelease / downloadReleaseTarball / extractTarball（fake spawner）
// - 更新流水线全链（fake spawner + 真实临时目录）：成功换目录 / 版本不符回滚 / build:lib 失败保留 staging / 取消清理 staging
// 绝不触网：curl.exe / tar.exe 全部由 fake spawner 模拟；fake curl 在 -o 路径真实落盘、fake tar 真实产出解包内容，
// 使后续基于真实 fs 的校验/换目录步骤按生产语义执行。目录后缀时间戳经 deps.now 注入，断言不依赖时区。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  GITHUB_RELEASES_API_URL,
  GITHUB_TARBALL_URL_PREFIX,
  downloadReleaseTarball,
  extractTarball,
  fetchLatestRelease,
  githubUpdateHandle,
  parseReleasesJson,
  readLocalPackageVersion,
  selectLatestTag
} from '../src/main/versionCenter/github'
import {
  cancelJob,
  jobSnapshot,
  requestUpdateOne,
  runVersionCheckSingle,
  startUpdateJob,
  type VCDeps
} from '../src/main/versionCenter/jobs'
import { findCatalogEntry, type CatalogEntry } from '../src/main/versionCenter/catalog'
import type { Spawner } from '../src/main/wslBridge'

const RELEASE_TAG = 'dsh-v0.1.2-alpha.4'
const RELEASE_VERSION = '0.1.2-alpha.4'
const FIXED_NOW = 1_756_800_000_000 // 注入的固定时间戳（仅作后缀，断言用动态目录名）

const RELEASES_JSON = JSON.stringify([
  { tag_name: 'dsh-v0.1.1-rc.2', published_at: '2026-08-21T12:35:08Z', prerelease: true, draft: false },
  { tag_name: RELEASE_TAG, published_at: '2026-09-01T15:45:07Z', prerelease: true, draft: false },
  { tag_name: 'dsh-v0.1.0-rc.8', published_at: '2026-08-19T15:37:57Z', prerelease: true, draft: false }
])

const RATE_LIMIT_JSON = JSON.stringify({
  message:
    'API rate limit exceeded for 127.0.0.1. (But here is the good news: Authenticated requests get a higher rate limit.)',
  documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting'
})

// ---------- fake 基建：按 (cmd,args) 路由的 fake spawner（支持 spawn 时同步副作用 + stdout 注入） ----------

type FakeSpec = { stdout?: string; stderr?: string; code?: number; effect?: () => void }
type Dispatch = (cmd: string, args: readonly string[], opts: SpawnOptions) => FakeSpec | undefined
type Calls = { spawnArgs: unknown[][]; kills: number }

function dispatchSpawner(dispatch: Dispatch, calls: Calls): Spawner {
  return (cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess => {
    calls.spawnArgs.push([cmd, [...args], opts])
    const spec = dispatch(cmd, args, opts) ?? {}
    spec.effect?.()
    const child = new EventEmitter() as unknown as ChildProcess
    child.stdout = new EventEmitter() as unknown as ChildProcess['stdout']
    child.stderr = new EventEmitter() as unknown as ChildProcess['stderr']
    ;(child as { pid?: number }).pid = 9000 + calls.spawnArgs.length
    child.kill = vi.fn(() => {
      calls.kills++
      queueMicrotask(() => child.emit('close', null))
      return true
    })
    child.unref = vi.fn()
    queueMicrotask(() => {
      if (spec.stdout !== undefined) child.stdout!.emit('data', Buffer.from(spec.stdout))
      if (spec.stderr !== undefined) child.stderr!.emit('data', Buffer.from(spec.stderr))
      child.emit('close', spec.code ?? 0)
    })
    return child
  }
}

/** 更新流水线场景路由：fake curl（API 空应答 + 下载落盘）、fake tar（解包产出）、where/npm（cmd.exe 路由） */
function updateFlowDispatch(scene: {
  tarballBytes?: number
  stagedVersion?: string
  stagedWithBin?: boolean
  buildLibFails?: boolean
  npmInstallFails?: boolean
}): Dispatch {
  const writeBinJs = (root: string): void => {
    const libDir = path.join(root, 'apps', 'cli', 'lib')
    fs.mkdirSync(libDir, { recursive: true })
    fs.writeFileSync(path.join(libDir, 'bin.js'), '// fake entry\n', 'utf8')
  }
  return (cmd, args, opts) => {
    if (cmd === 'curl.exe' && args.some((a) => String(a).includes('api.github.com'))) return { stdout: RELEASES_JSON }
    if (cmd === 'curl.exe') {
      const list = args
      const out = String(list[list.indexOf('-o') + 1])
      return { effect: () => fs.writeFileSync(out, Buffer.alloc(scene.tarballBytes ?? 8192, 7)) }
    }
    if (cmd === 'tar.exe') {
      // args: [-xzf, tarball, -C, staging] → 模拟 bsdtar 解出 GitHub 单层顶层目录
      const staging = String(args[3])
      return {
        effect: () => {
          const wrapper = path.join(staging, 'deepseek-harness-' + RELEASE_TAG)
          fs.mkdirSync(wrapper, { recursive: true })
          fs.writeFileSync(
            path.join(wrapper, 'package.json'),
            JSON.stringify({ name: '@deepseek-ai/dsh-root', version: scene.stagedVersion ?? RELEASE_VERSION }),
            'utf8'
          )
          if (scene.stagedWithBin) writeBinJs(wrapper)
        }
      }
    }
    if (cmd === 'where.exe' && args[0] === 'npm.cmd') return { stdout: 'C:\\npm\\path\\npm.cmd\r\n' }
    if (cmd === 'cmd.exe') {
      const line = args.join(' ')
      if (line.includes(' install --no-audit --no-fund')) {
        return scene.npmInstallFails ? { code: 1, stderr: 'npm install boom' } : {}
      }
      if (line.includes(' run build:lib')) {
        if (scene.buildLibFails) return { code: 1, stderr: 'build:lib boom' }
        return { effect: () => typeof opts.cwd === 'string' && writeBinJs(opts.cwd) }
      }
    }
    return undefined
  }
}

const REG_SAMPLE = [
  '',
  'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\c330d982',
  '    DisplayName    REG_SZ    DeepSeek Harness',
  '    DisplayVersion    REG_SZ    1.0',
  ''
].join('\r\n')

function deepseekEntry(): CatalogEntry {
  const e = findCatalogEntry('deepseek-harness')
  if (!e) throw new Error('catalog 缺少 deepseek-harness')
  return e
}

function vcDeps(spawner: Spawner, deepseekRoot: string): VCDeps {
  return { spawner, deepseekRoot, now: () => FIXED_NOW }
}

// ---------- 纯解析 ----------

describe('parseReleasesJson / selectLatestTag', () => {
  it('解析 releases 数组：跳过 draft、取 tag 与 publishedAt', () => {
    const r = parseReleasesJson(
      JSON.stringify([
        { tag_name: 'dsh-v0.1.1-rc.2', published_at: '2026-08-21T12:35:08Z', draft: false },
        { tag_name: 'dsh-draft-skip', published_at: '2026-09-02T00:00:00Z', draft: true },
        { tag_name: RELEASE_TAG, published_at: '2026-09-01T15:45:07Z', draft: false, prerelease: true }
      ])
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items.length).toBe(2)
    expect(r.items[0]).toMatchObject({ tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2', publishedAt: '2026-08-21T12:35:08Z' })
  })

  it('HTTP 403 限流体（非数组对象带 message）→ 明确的限流提示', () => {
    const r = parseReleasesJson(RATE_LIMIT_JSON)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('GitHub API 限流')
    expect(r.error).toContain('稍后再试')
  })

  it('非 JSON / 其他错误对象 / 空表 → 如实报错', () => {
    const bad = parseReleasesJson('<html>gateway error</html>')
    expect(bad.ok).toBe(false)
    const obj = parseReleasesJson(JSON.stringify({ message: 'Not Found' }))
    expect(obj.ok).toBe(false)
    if (!obj.ok) expect(obj.error).toContain('Not Found')
    expect(selectLatestTag([])).toBeNull()
    expect(selectLatestTag(['junk', '!!!'])).toBeNull()
  })

  it('selectLatestTag 用 compareSemver 选最高（全 prerelease 仓库同样成立）', () => {
    expect(selectLatestTag(['dsh-v0.1.1-rc.2', RELEASE_TAG, 'dsh-v0.1.0-rc.8'])).toBe(RELEASE_TAG)
    expect(selectLatestTag(['dsh-v0.1.2-alpha.4', 'dsh-v0.1.2'])).toBe('dsh-v0.1.2')
    expect(selectLatestTag(['dsh-v0.1.0-rc.9', 'dsh-v0.1.0-rc.10'])).toBe('dsh-v0.1.0-rc.10')
  })
})

// ---------- fetchLatestRelease / downloadReleaseTarball / extractTarball ----------

describe('fetchLatestRelease（fake curl）', () => {
  it('返回最高 release（tag/version/publishedAt）；curl args 带 api URL 与 --max-time 30', async () => {
    const calls: Calls = { spawnArgs: [], kills: 0 }
    const r = await fetchLatestRelease({
      spawner: dispatchSpawner((cmd) => (cmd === 'curl.exe' ? { stdout: RELEASES_JSON } : undefined), calls)
    })
    expect(r).toMatchObject({ ok: true, tag: RELEASE_TAG, version: RELEASE_VERSION, publishedAt: '2026-09-01T15:45:07Z' })
    expect(calls.spawnArgs.length).toBe(1)
    expect(calls.spawnArgs[0][0]).toBe('curl.exe')
    const args = calls.spawnArgs[0][1] as readonly string[]
    expect(args).toContain(GITHUB_RELEASES_API_URL)
    expect(args).toContain('--max-time')
    expect(args).toContain('30')
  })

  it('限流体 → ok:false 提示限流；curl 非零退出且无输出 → ok:false 透出原因', async () => {
    const rateLimited = await fetchLatestRelease({
      spawner: dispatchSpawner(() => ({ stdout: RATE_LIMIT_JSON }), { spawnArgs: [], kills: 0 })
    })
    expect(rateLimited.ok).toBe(false)
    if (!rateLimited.ok) expect(rateLimited.error).toContain('限流')

    const failed = await fetchLatestRelease({
      spawner: dispatchSpawner(() => ({ code: 7, stderr: 'curl: (7) Failed to connect' }), { spawnArgs: [], kills: 0 })
    })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error).toContain('GitHub Releases 查询失败')
  })
})

describe('downloadReleaseTarball / extractTarball / readLocalPackageVersion（真实临时目录）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vcgh-dl-'))

  afterAll(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true })
    } catch {
      /* 清理失败忽略 */
    }
  })

  it('下载成功：-L/--max-time 300/-o/URL 参数正确；文件存在且 >1KB', async () => {
    const calls: Calls = { spawnArgs: [], kills: 0 }
    const tmpDir = path.join(base, 'dl-ok')
    fs.mkdirSync(tmpDir, { recursive: true })
    const r = await downloadReleaseTarball(RELEASE_TAG, {
      tmpDir,
      spawner: dispatchSpawner((cmd, args) => {
        if (cmd !== 'curl.exe') return undefined
        const list = args
        const out = String(list[list.indexOf('-o') + 1])
        return {
          effect: () => fs.writeFileSync(out, Buffer.alloc(4096, 1))
        }
      }, calls)
    })
    expect(calls.spawnArgs.length).toBe(1)
    const args = calls.spawnArgs[0][1] as readonly string[]
    expect(args[0]).toBe('-L')
    expect(args).toContain('300')
    expect(args).toContain(GITHUB_TARBALL_URL_PREFIX + RELEASE_TAG + '.tar.gz')
    expect(String(args[args.indexOf('-o') + 1]).startsWith(tmpDir)).toBe(true)
    expect(r.ok).toBe(true)
    if (r.ok) expect(fs.statSync(r.path).size).toBe(4096)
  })

  it('文件未产出 / 过小 / tag 不安全 → 报错；不安全 tag 绝不 spawn', async () => {
    const noFile = await downloadReleaseTarball(RELEASE_TAG, {
      tmpDir: base,
      spawner: dispatchSpawner(() => ({}), { spawnArgs: [], kills: 0 })
    })
    expect(noFile.ok).toBe(false)
    if (!noFile.ok) expect(noFile.error).toContain('未找到源码包')

    const tiny = await downloadReleaseTarball(RELEASE_TAG, {
      tmpDir: base,
      spawner: dispatchSpawner((_cmd, args) => {
        const list = args
        const out = String(list[list.indexOf('-o') + 1])
        return { effect: () => fs.writeFileSync(out, Buffer.alloc(64, 1)) }
      }, { spawnArgs: [], kills: 0 })
    })
    expect(tiny.ok).toBe(false)
    if (!tiny.ok) expect(tiny.error).toContain('过小')

    const calls: Calls = { spawnArgs: [], kills: 0 }
    const evil = await downloadReleaseTarball('../evil', { tmpDir: base, spawner: dispatchSpawner(() => ({}), calls) })
    expect(evil.ok).toBe(false)
    if (!evil.ok) expect(evil.error).toContain('不安全')
    expect(calls.spawnArgs.length).toBe(0)
  })

  it('extractTarball：单层顶层目录自动展平到 staging 根', async () => {
    const staging = path.join(base, 'ex-ok')
    const wrapper = path.join(staging, 'deepseek-harness-' + RELEASE_TAG)
    fs.mkdirSync(wrapper, { recursive: true })
    fs.writeFileSync(path.join(wrapper, 'package.json'), '{"version":"1"}', 'utf8')
    fs.mkdirSync(path.join(wrapper, 'apps'), { recursive: true })
    fs.writeFileSync(path.join(wrapper, 'apps', 'a.txt'), 'x', 'utf8')
    const r = await extractTarball(path.join(base, 'x.tar.gz'), staging, {
      spawner: dispatchSpawner((cmd, args) => {
        expect(cmd).toBe('tar.exe')
        expect(args[0]).toBe('-xzf')
        expect(args[2]).toBe('-C')
        expect(args[3]).toBe(staging)
        return {}
      }, { spawnArgs: [], kills: 0 })
    })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(staging, 'package.json'))).toBe(true)
    expect(fs.existsSync(path.join(staging, 'apps', 'a.txt'))).toBe(true)
    expect(fs.readdirSync(staging).length).toBe(2) // 顶层目录已被展平移除
  })

  it('extractTarball：tar 失败 / 解包结果为空 → 报错', async () => {
    const fail = await extractTarball('nope.tar.gz', path.join(base, 'ex-fail'), {
      spawner: dispatchSpawner(() => ({ code: 1, stderr: 'tar: error is not recoverable' }), { spawnArgs: [], kills: 0 })
    })
    expect(fail.ok).toBe(false)
    if (!fail.ok) expect(fail.error).toContain('tar 解包失败')

    const empty = await extractTarball('e.tar.gz', path.join(base, 'ex-empty'), {
      spawner: dispatchSpawner(() => ({}), { spawnArgs: [], kills: 0 })
    })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error).toContain('解包结果为空')
  })

  it('readLocalPackageVersion：正常 / 目录缺失 / JSON 损坏', () => {
    const root = path.join(base, 'local')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0-rc.5' }), 'utf8')
    expect(readLocalPackageVersion(root)).toEqual({ version: '0.1.0-rc.5' })
    expect(readLocalPackageVersion(path.join(base, 'no-such-dir'))).toEqual({ missing: true })
    fs.writeFileSync(path.join(root, 'package.json'), '{broken', 'utf8')
    const bad = readLocalPackageVersion(root)
    expect('error' in bad).toBe(true)
  })
})

// ---------- checkOne（github 条目，经 runVersionCheckSingle） ----------

describe('checkOne github', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vcgh-check-'))

  afterAll(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true })
    } catch {
      /* 清理失败忽略 */
    }
  })

  it('本地 package.json 0.1.0-rc.5 vs 最新 dsh-v0.1.2-alpha.4 → upgradable（note 带 tag）', async () => {
    const root = path.join(base, 'inst')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'dsh', version: '0.1.0-rc.5' }), 'utf8')
    const r = await runVersionCheckSingle('deepseek-harness', {
      ...vcDeps(dispatchSpawner((cmd) => (cmd === 'curl.exe' ? { stdout: RELEASES_JSON } : undefined), { spawnArgs: [], kills: 0 }), root)
    })
    const s = r.statuses[0]
    expect(s.channelKind).toBe('github')
    expect(s.channel).toContain('GitHub Releases')
    expect(s).toMatchObject({ installed: '0.1.0-rc.5', latest: RELEASE_VERSION, state: 'upgradable' })
    expect(s.note).toContain(RELEASE_TAG)
  })

  it('本地目录缺失 → unknown + ARP 回退展示 1.0 + 指引文案', async () => {
    // reg query 现在也走 cmd.exe chcp 通道（防 GBK 乱码）：按 args 内容路由
    const spawner = dispatchSpawner(
      (cmd, args) =>
        cmd === 'curl.exe'
          ? { stdout: RELEASES_JSON }
          : args.includes('reg')
            ? { stdout: REG_SAMPLE }
            : undefined,
      {
        spawnArgs: [],
        kills: 0
      }
    )
    const r = await runVersionCheckSingle('deepseek-harness', vcDeps(spawner, path.join(base, 'missing-root')))
    const s = r.statuses[0]
    expect(s.state).toBe('unknown')
    expect(s.installed).toBe('1.0')
    expect(s.latest).toBe(RELEASE_VERSION)
    expect(s.note).toContain('未找到本地安装')
    expect(s.note).toContain('可在设置中指定目录')
    expect(s.note).toContain('仅回退展示')
  })

  it('本地存在但查询被限流 → unknown + 限流提示；本地也缺失 → check-failed', async () => {
    const root = path.join(base, 'inst2')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0-rc.5' }), 'utf8')
    const rateSpawner = dispatchSpawner(() => ({ stdout: RATE_LIMIT_JSON }), { spawnArgs: [], kills: 0 })
    const r1 = await runVersionCheckSingle('deepseek-harness', vcDeps(rateSpawner, root))
    expect(r1.statuses[0].state).toBe('unknown')
    expect(r1.statuses[0].installed).toBe('0.1.0-rc.5')
    expect(r1.statuses[0].note).toContain('限流')

    const r2 = await runVersionCheckSingle('deepseek-harness', vcDeps(rateSpawner, path.join(base, 'gone')))
    expect(r2.statuses[0].state).toBe('check-failed')
    expect(r2.statuses[0].note).toContain('限流')
  })
})

// ---------- 一键更新流水线（fake spawner + 真实临时目录，绝不触网） ----------

describe('一键更新流水线', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vcgh-upd-'))

  function newInstallRoot(name: string): string {
    const root = path.join(base, name)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.1.0-rc.5' }),
      'utf8'
    )
    fs.writeFileSync(path.join(root, 'old-marker.txt'), 'old', 'utf8')
    return root
  }

  function listBase(prefix: string): string[] {
    return fs.readdirSync(base).filter((n) => n.startsWith(prefix))
  }

  afterAll(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true })
    } catch {
      /* 清理失败忽略 */
    }
  })

  it('成功链：下载→解包→npm install→换目录→校验通过；旧目录备份；job done 后自动重查为 up-to-date', async () => {
    const root = newInstallRoot('ok-root')
    const calls: Calls = { spawnArgs: [], kills: 0 }
    const start = startUpdateJob(deepseekEntry(), vcDeps(dispatchSpawner(updateFlowDispatch({ stagedWithBin: true }), calls), root))
    expect(start.status).toBe('running')
    await vi.waitFor(() => expect(jobSnapshot(start.jobId).status).toBe('done'), { timeout: 5000 })
    const job = jobSnapshot(start.jobId)
    // 换目录结果
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))).toMatchObject({ version: RELEASE_VERSION })
    expect(fs.existsSync(path.join(root, 'apps', 'cli', 'lib', 'bin.js'))).toBe(true)
    // 旧目录备份
    const baks = listBase('ok-root.bak-')
    expect(baks.length).toBe(1)
    expect(JSON.parse(fs.readFileSync(path.join(base, baks[0], 'package.json'), 'utf8'))).toMatchObject({ version: '0.1.0-rc.5' })
    expect(fs.existsSync(path.join(base, baks[0], 'old-marker.txt'))).toBe(true)
    // staging 已清理
    expect(listBase('ok-root.update-')).toEqual([])
    // 自动重查：新目录 == 最新 → up-to-date
    expect(job.after).toMatchObject({ id: 'deepseek-harness', installed: RELEASE_VERSION, state: 'up-to-date' })
    // 日志步骤齐全；npm install 的 cwd 指向 staging
    expect(job.log.some((l) => l.includes('[1/6]'))).toBe(true)
    expect(job.log.some((l) => l.includes('[4/6]') && l.includes('npm install --no-audit --no-fund'))).toBe(true)
    expect(job.log.some((l) => l.includes('[5/6]') && l.includes('.bak-'))).toBe(true)
    expect(job.log.some((l) => l.includes('[6/6]'))).toBe(true)
    const npmCall = calls.spawnArgs.find((c) => (c[1] as readonly string[]).join(' ').includes(' install --no-audit --no-fund'))
    const cwd = (npmCall?.[2] as { cwd?: string } | undefined)?.cwd ?? ''
    expect(cwd.startsWith(path.join(base, 'ok-root.update-'))).toBe(true)
  }, 15000)

  it('版本不符 → 回滚换名；旧目录原样；job failed 且保留 -failed 目录供排查', async () => {
    const root = newInstallRoot('rb-root')
    const start = startUpdateJob(
      deepseekEntry(),
      vcDeps(dispatchSpawner(updateFlowDispatch({ stagedWithBin: true, stagedVersion: '9.9.9' }), { spawnArgs: [], kills: 0 }), root)
    )
    await vi.waitFor(() => expect(jobSnapshot(start.jobId).status).toBe('failed'), { timeout: 5000 })
    const job = jobSnapshot(start.jobId)
    expect(job.error).toContain('校验失败')
    expect(job.error).toContain('已回滚')
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))).toMatchObject({ version: '0.1.0-rc.5' })
    expect(fs.existsSync(path.join(root, 'old-marker.txt'))).toBe(true)
    expect(listBase('rb-root.bak-')).toEqual([])
    expect(listBase('rb-root.update-').length).toBe(1)
    expect(listBase('rb-root.update-')[0].endsWith('-failed')).toBe(true)
  }, 15000)

  it('入口缺失且 build:lib 失败 → 中止并保留 staging；安装目录不受影响', async () => {
    const root = newInstallRoot('bl-root')
    const start = startUpdateJob(
      deepseekEntry(),
      vcDeps(dispatchSpawner(updateFlowDispatch({ stagedWithBin: false, buildLibFails: true }), { spawnArgs: [], kills: 0 }), root)
    )
    await vi.waitFor(() => expect(jobSnapshot(start.jobId).status).toBe('failed'), { timeout: 5000 })
    const job = jobSnapshot(start.jobId)
    expect(job.error).toContain('build:lib 失败')
    expect(job.error).toContain('staging 已保留')
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))).toMatchObject({ version: '0.1.0-rc.5' })
    expect(listBase('bl-root.update-').length).toBe(1)
    expect(listBase('bl-root.bak-')).toEqual([])
  }, 15000)

  it('取消：npm install 挂起时 cancel → job cancelled、进程树被杀、staging 清理、安装目录不受影响', async () => {
    const root = newInstallRoot('cx-root')
    const calls: Calls = { spawnArgs: [], kills: 0 }
    const hungInstallSpawner: Spawner = (cmd, args, opts) => {
      if (cmd === 'cmd.exe' && (args as readonly string[]).join(' ').includes(' install --no-audit --no-fund')) {
        calls.spawnArgs.push([cmd, [...args], opts])
        const child = new EventEmitter() as unknown as ChildProcess
        child.stdout = new EventEmitter() as unknown as ChildProcess['stdout']
        child.stderr = new EventEmitter() as unknown as ChildProcess['stderr']
        ;(child as { pid?: number }).pid = 4321
        child.kill = vi.fn(() => {
          calls.kills++
          queueMicrotask(() => child.emit('close', null))
          return true
        })
        child.unref = vi.fn()
        return child // 永不 close，只能靠取消
      }
      return dispatchSpawner(updateFlowDispatch({ stagedWithBin: true }), calls)(cmd, args, opts)
    }
    const start = startUpdateJob(deepseekEntry(), vcDeps(hungInstallSpawner, root))
    const stagingName = 'cx-root.update-'
    await vi.waitFor(
      () => {
        expect(listBase(stagingName).length).toBe(1) // 解包已产出 staging
        expect(jobSnapshot(start.jobId).log.some((l) => l.includes('[4/6]'))).toBe(true)
      },
      { timeout: 5000 }
    )
    expect(cancelJob(start.jobId)).toBe(true)
    await vi.waitFor(() => expect(jobSnapshot(start.jobId).status).toBe('cancelled'), { timeout: 5000 })
    expect(calls.kills).toBeGreaterThanOrEqual(1)
    expect(listBase(stagingName)).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))).toMatchObject({ version: '0.1.0-rc.5' })
    expect(listBase('cx-root.bak-')).toEqual([])
  }, 15000)

  it('未确认请求 → blocked（确认门槛，绝不启动）；确认后目录缺失快速失败并给指引', async () => {
    const root = newInstallRoot('gate-root')
    const deps = vcDeps(dispatchSpawner(updateFlowDispatch({}), { spawnArgs: [], kills: 0 }), root)
    const pre = await requestUpdateOne('deepseek-harness', false, deps)
    expect(pre).toMatchObject({ blocked: true })
    expect(pre.jobId).toBeUndefined()

    const gone = await requestUpdateOne('deepseek-harness', true, vcDeps(deps.spawner as Spawner, path.join(base, 'no-root-here')))
    expect(gone.blocked).toBe(false)
    await vi.waitFor(() => expect(jobSnapshot(gone.jobId as string).status).toBe('failed'), { timeout: 5000 })
    expect(jobSnapshot(gone.jobId as string).error).toContain('未找到本地安装目录')
  }, 15000)

  it('githubUpdateHandle 直连：staging cwd 传入 npm；命令文本可读（用于 job 首行）', async () => {
    const root = newInstallRoot('direct-root')
    const calls: Calls = { spawnArgs: [], kills: 0 }
    const { handle, commandText } = githubUpdateHandle(
      path.join(base, 'no-root-direct'),
      { timeoutMs: 20_000, spawner: dispatchSpawner(updateFlowDispatch({}), calls) },
      { spawner: dispatchSpawner(updateFlowDispatch({}), calls), nowMs: () => FIXED_NOW }
    )
    expect(commandText).toContain('GitHub Releases')
    await vi.waitFor(async () => {
      const r = await handle.done
      expect(r.ok).toBe(false)
      expect(r.stderr).toContain('未找到本地安装目录')
    }, { timeout: 5000 })
  }, 15000)
})
