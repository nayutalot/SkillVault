// github 通道（DeepSeek Harness）：GitHub Releases 检测 + 源码包下载解包 + 多步更新流水线。
// 上游实况：github.com/deepseek-ai/deepseek-harness 的 Releases 全部为 prerelease（/releases/latest 恒空）
// → 必须 list ?per_page=10 后用 compareSemver 自选最高。网络一律经 curl.exe 子进程（与 winget/npm 同模式），
// 解包用 Windows 自带 tar.exe（System32 bsdtar），npm 重建复用 npm 通道的路径解析 —— 零新依赖、不写凭据。
// 门禁写法：静态正则、无捕获组数据流、内容拼接一律 '+'（错误消息少量插值）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execAsync, execCmdArgs, execCmdLine, defaultSpawner, type ExecHandle, type ExecOptions } from './exec'
import { resolveNpmCmdPath } from './npm'
import { compareSemver, isSafeTag, parseSemver, semverFromTag } from './versionCompare'

export const GITHUB_REPO = 'deepseek-ai/deepseek-harness'
/** unauthenticated /releases 列表：latest 端点对全 prerelease 仓库返回 404，故列 10 条自选最高 */
export const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases?per_page=10'
export const GITHUB_TARBALL_URL_PREFIX = 'https://github.com/' + GITHUB_REPO + '/archive/refs/tags/'

/** 查询超时：curl --max-time 30（spec），exec 侧 35s 让 curl 先自退出以给出干净错误 */
export const GITHUB_RELEASE_TIMEOUT_MS = 35_000
/** 下载超时：curl -L --max-time 300，exec 侧 330s 同理 */
export const GITHUB_DOWNLOAD_TIMEOUT_MS = 330_000
/** tar 解包超时 */
export const GITHUB_EXTRACT_TIMEOUT_MS = 120_000

/** DeepSeek 本体安装目录默认值（settings.deepseekHarnessRoot 缺省；更新前绝不写入此目录，只读检测） */
export const DEEPSEEK_DEFAULT_ROOT = 'D:\\Apps\\deepseek-harness'
/** ARP 注册表里的展示名（installRoot 缺失时回退展示版本用） */
export const DEEPSEEK_ARP_DISPLAY_NAME = 'DeepSeek Harness'

// ---------- 本地安装版本 ----------

export type LocalVersionResult = { version: string } | { missing: true } | { error: string }

/** 读 <installRoot>/package.json 的 version；目录不存在 → missing（调用方回落 ARP 展示） */
export function readLocalPackageVersion(installRoot: string): LocalVersionResult {
  let rootOk = false
  try {
    rootOk = fs.statSync(installRoot).isDirectory()
  } catch {
    rootOk = false
  }
  if (!rootOk) return { missing: true }
  let raw: string
  try {
    raw = fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8')
  } catch (e) {
    return { error: '读取 package.json 失败: ' + String(e instanceof Error ? e.message : e).slice(0, 120) }
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.trim()) return { version: parsed.version.trim() }
    return { error: 'package.json 缺少 version 字段: ' + installRoot }
  } catch {
    return { error: 'package.json 不是有效 JSON: ' + installRoot }
  }
}

// ---------- Releases 查询 ----------

export type GithubReleaseInfo = { tag: string; version: string; publishedAt: string }
export type GithubFetchResult = { ok: true; tag: string; version: string; publishedAt: string } | { ok: false; error: string }

type RawRelease = { tag_name?: unknown; published_at?: unknown; draft?: unknown }

/** 从 releases 数组选 compareSemver 最高者；全部不可解析 → null */
export function selectLatestTag(tags: string[]): string | null {
  let best: string | null = null
  for (const t of tags) {
    if (typeof t !== 'string' || !t.trim() || !parseSemver(t)) continue
    if (best === null || (compareSemver(t, best) ?? 0) > 0) best = t
  }
  return best
}

/**
 * 解析 curl 输出为 releases 列表（取 tag_name + published_at，跳过 draft）。
 * 非数组（限流/错误对象）→ ok:false；message 含 rate limit → 明确提示限流。
 */
export function parseReleasesJson(stdout: string): { ok: true; items: GithubReleaseInfo[] } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(stdout ?? ''))
  } catch {
    return { ok: false, error: 'GitHub Releases 响应不是有效 JSON: ' + String(stdout ?? '').slice(0, 120) }
  }
  if (!Array.isArray(parsed)) {
    const msg = typeof (parsed as { message?: unknown })?.message === 'string' ? String((parsed as { message?: unknown }).message) : ''
    if (msg.toLowerCase().includes('rate limit')) {
      return { ok: false, error: 'GitHub API 限流，稍后再试（' + msg.slice(0, 120) + '）' }
    }
    return { ok: false, error: 'GitHub Releases 响应异常: ' + (msg || String(stdout ?? '').slice(0, 120)) }
  }
  const items: GithubReleaseInfo[] = []
  for (const r of parsed as RawRelease[]) {
    if (typeof r !== 'object' || r === null) continue
    if (r.draft === true) continue
    if (typeof r.tag_name !== 'string' || !r.tag_name) continue
    items.push({
      tag: r.tag_name,
      version: semverFromTag(r.tag_name),
      publishedAt: typeof r.published_at === 'string' ? r.published_at : ''
    })
  }
  return { ok: true, items }
}

export type GithubFetchDeps = {
  spawner?: ExecOptions['spawner']
  timeoutMs?: number
  /** 句柄回调：子进程启动即上报（更新流水线据此支持在前 3 步取消） */
  onHandle?: (h: ExecHandle) => void
}

/** 查询最新 release（含 prerelease）：curl.exe -s --max-time 30 <api>；限流/网络失败如实透出 */
export async function fetchLatestRelease(deps: GithubFetchDeps = {}): Promise<GithubFetchResult> {
  const h = execAsync('curl.exe', ['-s', '--max-time', '30', GITHUB_RELEASES_API_URL], {
    timeoutMs: deps.timeoutMs ?? GITHUB_RELEASE_TIMEOUT_MS,
    spawner: deps.spawner
  })
  deps.onHandle?.(h)
  const r = await h.done
  if (!r.ok && !r.stdout.trim()) {
    return { ok: false, error: 'GitHub Releases 查询失败: ' + (r.stderr || 'curl 退出码 ' + r.status).slice(0, 200) }
  }
  const parsed = parseReleasesJson(r.stdout)
  if (!parsed.ok) return parsed
  const tag = selectLatestTag(parsed.items.map((x) => x.tag))
  if (!tag) return { ok: false, error: 'Releases 列表为空或无可比较的版本 tag' }
  const hit = parsed.items.find((x) => x.tag === tag)
  return { ok: true, tag, version: semverFromTag(tag), publishedAt: hit?.publishedAt ?? '' }
}

// ---------- 下载与解包 ----------

export type GithubFileResult = { ok: true; path: string } | { ok: false; error: string }

export type GithubDeps = {
  spawner?: ExecOptions['spawner']
  timeoutMs?: number
  /** 下载输出目录（默认 os.tmpdir()；测试注入） */
  tmpDir?: string
  /** 文件大小探测（默认 fs.statSync；测试注入） */
  fileStat?: (p: string) => { size: number } | null
  /** 句柄回调：子进程启动即上报（更新流水线据此支持在下载步取消） */
  onHandle?: (h: ExecHandle) => void
}

function defaultFileStat(p: string): { size: number } | null {
  try {
    const st = fs.statSync(p)
    return st.isFile() ? { size: st.size } : null
  } catch {
    return null
  }
}

/** 下载 tag 源码包到 tmp：curl.exe -L --fail --max-time 300 -o <tmp>\dsh-<tag>.tar.gz；校验存在且 >1KB。
 *  --fail：HTTP 4xx/5xx 时 curl 以 22 退出而不是把错误页 body 写进 -o 文件（否则 404 HTML 会进 tar 解包报出离题错误）。 */
export async function downloadReleaseTarball(tag: string, deps: GithubDeps = {}): Promise<GithubFileResult> {
  if (!isSafeTag(tag)) return { ok: false, error: 'tag 含不安全字符，拒绝下载: ' + String(tag).slice(0, 60) }
  const out = path.join(deps.tmpDir ?? os.tmpdir(), 'dsh-' + tag + '.tar.gz')
  const url = GITHUB_TARBALL_URL_PREFIX + tag + '.tar.gz'
  const h = execAsync('curl.exe', ['-L', '--fail', '--max-time', '300', '-o', out, url], {
    timeoutMs: deps.timeoutMs ?? GITHUB_DOWNLOAD_TIMEOUT_MS,
    spawner: deps.spawner
  })
  deps.onHandle?.(h)
  const r = await h.done
  if (!r.ok) {
    return { ok: false, error: '源码包下载失败（curl 退出码 ' + r.status + '）: ' + (r.stderr || r.stdout || '无输出').slice(-300) }
  }
  const stat = (deps.fileStat ?? defaultFileStat)(out)
  if (!stat) return { ok: false, error: '下载后未找到源码包: ' + out }
  if (stat.size <= 1024) return { ok: false, error: '下载的源码包过小（' + stat.size + ' 字节），疑似失败响应: ' + out }
  return { ok: true, path: out }
}

/** 解包 tar.gz 到 staging：Windows 自带 tar.exe；GitHub 包有单层顶层目录 → 自动展平到 staging 根 */
export async function extractTarball(
  tarball: string,
  stagingRoot: string,
  deps: { spawner?: ExecOptions['spawner']; timeoutMs?: number; onHandle?: (h: ExecHandle) => void } = {}
): Promise<GithubFileResult> {
  try {
    fs.mkdirSync(stagingRoot, { recursive: true })
  } catch (e) {
    return { ok: false, error: '无法创建解包目录: ' + String(e instanceof Error ? e.message : e).slice(0, 120) }
  }
  const h = execAsync('tar.exe', ['-xzf', tarball, '-C', stagingRoot], {
    timeoutMs: deps.timeoutMs ?? GITHUB_EXTRACT_TIMEOUT_MS,
    spawner: deps.spawner
  })
  deps.onHandle?.(h)
  const r = await h.done
  if (!r.ok) {
    return { ok: false, error: 'tar 解包失败（退出码 ' + r.status + '）: ' + (r.stderr || r.stdout || '无输出').slice(-300) }
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(stagingRoot, { withFileTypes: true })
  } catch (e) {
    return { ok: false, error: '解包目录不可读: ' + String(e instanceof Error ? e.message : e).slice(0, 120) }
  }
  if (entries.length === 0) return { ok: false, error: '解包结果为空（tar 未产出内容）: ' + stagingRoot }
  if (entries.length === 1 && entries[0].isDirectory()) {
    const wrapper = path.join(stagingRoot, entries[0].name)
    let inner: fs.Dirent[]
    try {
      inner = fs.readdirSync(wrapper, { withFileTypes: true })
    } catch (e) {
      return { ok: false, error: '顶层目录不可读: ' + String(e instanceof Error ? e.message : e).slice(0, 120) }
    }
    try {
      for (const d of inner) {
        const dest = path.join(stagingRoot, d.name)
        if (fs.existsSync(dest)) return { ok: false, error: '展平时目标已存在，拒绝覆盖: ' + dest }
        fs.renameSync(path.join(wrapper, d.name), dest)
      }
      fs.rmSync(wrapper, { recursive: true, force: true })
    } catch (e) {
      return { ok: false, error: '展平顶层目录失败: ' + String(e instanceof Error ? e.message : e).slice(0, 160) }
    }
  }
  return { ok: true, path: stagingRoot }
}

// ---------- 一键更新流水线（仅用户点击触发；下载 → 解包 → npm install → 校验入口 → 换目录 → 版本校验） ----------

export type GithubUpdateDeps = {
  spawner?: ExecOptions['spawner']
  /** 时间戳后缀（<root>.bak-<ts> / <root>.update-<ts>；测试注入保证确定性） */
  nowMs?: () => number
  /** 下载输出目录（默认 os.tmpdir()） */
  tmpDir?: string
}

/** 取消哨兵：与非取消类失败区分（取消时绝不留下半换名状态） */
class FlowCancelled extends Error {}

function compactTs(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => (n < 10 ? '0' + String(n) : String(n))
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

function rmRf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    /* 清理失败尽力而为（staging 残留不影响安装目录） */
  }
}

/**
 * 多步更新 → 合成为既有 job 机制可用的 ExecHandle（done + cancel）。
 * - 每步进度经 opts.onLine 增量进 job 日志；
 * - cancel = 杀当前子进程 + 清理 staging（换目录开始后不可取消，保证绝不半换名）；
 * - 任何一步失败：中止并保留 staging 供排查；换目录后校验失败 → 回滚换名。
 */
export function githubUpdateHandle(
  installRoot: string,
  opts: ExecOptions,
  deps: GithubUpdateDeps = {}
): { handle: ExecHandle; commandText: string } {
  const spawner = deps.spawner ?? defaultSpawner
  const nowMs = deps.nowMs ?? Date.now
  let cancelled = false
  let swapStarted = false
  let current: ExecHandle | null = null
  let currentStaging: string | null = null

  const emit = (line: string): void => {
    opts.onLine?.(line, 'stdout')
  }
  const run = async (h: ExecHandle): Promise<ExecResultLike> => {
    current = h
    try {
      return await h.done
    } finally {
      current = null
    }
  }
  // 步骤 1-3（fetch/download/extract）经 onHandle 登记 current，取消时才能真杀掉 curl/tar
  const runT = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p
    } finally {
      current = null
    }
  }
  const ensureLive = (): void => {
    if (cancelled) throw new FlowCancelled()
  }

  const done = (async (): Promise<ExecResultLike> => {
    let staging = ''
    try {
      emit('[1/6] 查询 GitHub Releases（' + GITHUB_REPO + '）…')
      ensureLive()
      const rel = await runT(fetchLatestRelease({ spawner, onHandle: (h) => (current = h) }))
      if (!rel.ok) throw new Error(rel.error)
      const target = semverFromTag(rel.tag)
      emit('    最新 ' + rel.tag + '（' + rel.version + (rel.publishedAt ? '，发布于 ' + rel.publishedAt : '') + '）')
      if (!isSafeTag(rel.tag)) throw new Error('tag 含不安全字符，拒绝更新: ' + rel.tag.slice(0, 60))
      if (!fs.existsSync(installRoot)) {
        throw new Error('未找到本地安装目录: ' + installRoot + '（可在设置中指定目录）')
      }

      const ts = compactTs(nowMs())
      staging = installRoot + '.update-' + ts
      currentStaging = staging
      const bak = installRoot + '.bak-' + ts

      emit('[2/6] 下载源码包 dsh-' + rel.tag + '.tar.gz …')
      ensureLive()
      const dl = await runT(downloadReleaseTarball(rel.tag, { spawner, tmpDir: deps.tmpDir, onHandle: (h) => (current = h) }))
      if (!dl.ok) throw new Error(dl.error)
      emit('    已下载 ' + dl.path)

      emit('[3/6] 解包到 ' + staging)
      ensureLive()
      const ex = await runT(extractTarball(dl.path, staging, { spawner, onHandle: (h) => (current = h) }))
      if (!ex.ok) throw new Error(ex.error)
      // 解包成功后源码包不再需要（staging 保留供排查；tarball 体积大，不留 tmp 慢性堆积）
      try {
        fs.rmSync(dl.path, { force: true })
      } catch {
        /* 清理失败可忽略 */
      }

      emit('[4/6] npm install --no-audit --no-fund（staging 内重建依赖，约需数分钟）')
      ensureLive()
      const npmPath = await resolveNpmCmdPath({ spawner })
      const npmOpts: ExecOptions = {
        timeoutMs: opts.timeoutMs,
        spawner,
        cwd: staging,
        detached: opts.detached,
        env: opts.env,
        onLine: opts.onLine
      }
      const install = npmPath
        ? await run(execCmdArgs([npmPath, 'install', '--no-audit', '--no-fund'], npmOpts))
        : await run(execCmdLine('npm install --no-audit --no-fund', npmOpts))
      ensureLive()
      if (!install.ok) {
        throw new Error('npm install 失败（退出码 ' + install.status + '）: ' + (install.stderr || install.stdout || '无输出').slice(-400) + '（staging 已保留供排查: ' + staging + '）')
      }

      const binJs = path.join(staging, 'apps', 'cli', 'lib', 'bin.js')
      if (!fs.existsSync(binJs)) {
        emit('    staging 缺少 apps/cli/lib/bin.js，执行 npm run build:lib 兜底…')
        const build = npmPath
          ? await run(execCmdArgs([npmPath, 'run', 'build:lib'], npmOpts))
          : await run(execCmdLine('npm run build:lib', npmOpts))
        ensureLive()
        if (!build.ok) {
          throw new Error('npm run build:lib 失败（退出码 ' + build.status + '）: ' + (build.stderr || build.stdout || '无输出').slice(-400) + '（staging 已保留供排查: ' + staging + '）')
        }
        if (!fs.existsSync(binJs)) {
          throw new Error('构建后仍未找到 apps/cli/lib/bin.js（staging 已保留供排查: ' + staging + '）')
        }
      }

      emit('[5/6] 换目录：旧目录备份为 ' + bak + '（数据目录 ~/.dsh 不受影响）')
      ensureLive()
      swapStarted = true
      try {
        fs.renameSync(installRoot, bak)
      } catch (e) {
        throw new Error('旧目录改名失败（' + bak + '）: ' + String(e instanceof Error ? e.message : e).slice(0, 160))
      }
      try {
        fs.renameSync(staging, installRoot)
      } catch (e) {
        try {
          fs.renameSync(bak, installRoot)
        } catch {
          /* 回滚失败只能如实报告两个路径 */
        }
        throw new Error('新目录就位失败，已回滚: ' + String(e instanceof Error ? e.message : e).slice(0, 160))
      }

      emit('[6/6] 校验新目录版本（期望 ' + target + '）…')
      const v = readLocalPackageVersion(installRoot)
      const actual = 'version' in v ? v.version : ''
      const same = 'version' in v && (compareSemver(v.version, target) ?? null) === 0
      if (!same) {
        try {
          fs.renameSync(installRoot, staging + '-failed')
        } catch {
          /* 保留失败目录失败则只能报告 */
        }
        let restored = true
        try {
          fs.renameSync(bak, installRoot)
          emit('    版本不符，已回滚到旧目录')
        } catch {
          restored = false
          emit('    警告：回滚换名失败，请人工检查 ' + bak)
        }
        // 回滚成败必须如实写入错误消息（它就是 job.error 展示给用户的结论）
        throw new Error(
          '更新后版本校验失败（期望 ' + target + '，实际 ' + (actual || (v as { error?: string }).error || '未知') + '），' +
            (restored ? '已回滚到旧目录' : '回滚失败：旧目录仍在 ' + bak + '，安装目录暂缺，请人工把 ' + bak + ' 改回 ' + installRoot)
        )
      }
      emit('✓ 更新完成：' + installRoot + ' → ' + actual + '（旧目录备份: ' + bak + '）')
      return { ok: true, status: 0, stdout: '', stderr: '' }
    } catch (e) {
      if (e instanceof FlowCancelled || cancelled) {
        // 取消：清理 staging（换目录开始后不可取消，绝不留下半换名状态）
        if (!swapStarted && staging) rmRf(staging)
        return { ok: false, status: -1, stdout: '', stderr: '已被用户取消' }
      }
      // 非取消失败：保留 staging 供排查（错误消息已注明路径）
      return { ok: false, status: -1, stdout: '', stderr: String(e instanceof Error ? e.message : e).slice(0, 1200) }
    }
  })()

  return {
    handle: {
      done,
      cancel: (): void => {
        cancelled = true
        current?.cancel()
        if (!swapStarted && currentStaging) rmRf(currentStaging)
      }
    },
    commandText: 'GitHub Releases 更新（' + GITHUB_REPO + '）：下载源码包 → 解包 → npm install → 换目录'
  }
}

type ExecResultLike = { ok: boolean; status: number; stdout: string; stderr: string }
