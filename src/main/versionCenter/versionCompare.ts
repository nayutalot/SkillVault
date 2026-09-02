// versionCompare：纯函数 semver 风格版本比较（零依赖，不引 semver 包）。
// 规则：从字符串中提取第一段「纯数字点分」版本核心（自动剥离 "grok 1.0.5 (5115b46bc9)"、"v1.2.3" 之类前缀噪声），
// 按段比较数字、缺省段按 0 补齐；任一侧提取不到可比较核心 → 返回 null（UI 显示「未知」）。

/** 提取版本核心：字符串中第一个「数字（.数字)*」片段 */
export function extractVersionCore(s: string): string | null {
  const m = String(s ?? '').match(/\d+(?:\.\d+)*/)
  return m ? m[0] : null
}

export type VersionOrdering = -1 | 0 | 1 | null

/**
 * 比较两个版本字符串：a<b → -1，a=b → 0，a>b → 1，不可比 → null。
 * 兼容多段数字版本（1.26832.0.0 / 26.825.6671.0 / 0.36.0）与前缀噪声。
 */
export function compareVersions(a: string, b: string): VersionOrdering {
  const ca = extractVersionCore(a)
  const cb = extractVersionCore(b)
  if (!ca || !cb) return null
  const pa = ca.split('.').map((x) => Number.parseInt(x, 10))
  const pb = cb.split('.').map((x) => Number.parseInt(x, 10))
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

// ---------- semver prerelease 扩展（GitHub Releases 通道专用） ----------
// 规则（semver 规范的实用子集）：解析 v?major.minor.patch[-prerelease]（容许前缀噪声，取首个版本形 token）；
// 核心各段数值比较（缺省段补 0）；核心相同 → 无 prerelease 者更新；都有 prerelease → 按点分段比较
//（数字段数值比、字母段字典序、数字段 < 字母段）；任一侧解析失败 → null（UI 显示「未知」）。
// 纯函数 + 静态正则（门禁约束：不动态构造 RegExp、不用捕获组做数据流）。

/** 版本 token（可含 prerelease 后缀）：静态正则，非捕获组 */
const SEMVER_TOKEN = /\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?/
/** 纯数字段（prerelease 段分类用） */
const NUMERIC_SEGMENT = /^\d+$/
/** tag/文件名安全字符（downloadReleaseTarball 的 tag 白名单） */
const SAFE_TAG = /^[0-9A-Za-z][0-9A-Za-z._-]*$/

export function isSafeTag(tag: string): boolean {
  return SAFE_TAG.test(tag)
}

export type SemverParsed = { core: number[]; pre: string[] }

/** 解析 v?N(.N)*(-pre(.pre)*)?；容许前缀噪声（如 "dsh-v0.1.2-alpha.4"、"grok 1.0.5 (hash)"）；解析失败 → null */
export function parseSemver(s: string): SemverParsed | null {
  const text = String(s ?? '').trim()
  if (!text) return null
  const m = SEMVER_TOKEN.exec(text)
  if (!m) return null
  const token = m[0]
  const dash = token.indexOf('-')
  const coreText = dash >= 0 ? token.slice(0, dash) : token
  const preText = dash >= 0 ? token.slice(dash + 1) : ''
  const core = coreText.split('.').map((x) => Number.parseInt(x, 10))
  if (core.some((n) => !Number.isFinite(n))) return null
  return { core, pre: preText ? preText.split('.') : [] }
}

function compareCore(a: number[], b: number[]): -1 | 0 | 1 {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

function comparePreSegments(a: string[], b: string[]): -1 | 0 | 1 {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    const xn = NUMERIC_SEGMENT.test(x)
    const yn = NUMERIC_SEGMENT.test(y)
    if (xn && yn) {
      const xv = Number.parseInt(x, 10)
      const yv = Number.parseInt(y, 10)
      if (xv < yv) return -1
      if (xv > yv) return 1
    } else if (xn !== yn) {
      return xn ? -1 : 1 // 数字段 < 字母段（semver 规则）
    } else if (x < y) {
      return -1
    } else if (x > y) {
      return 1
    }
  }
  if (a.length < b.length) return -1 // 前缀相等时段少者小
  if (a.length > b.length) return 1
  return 0
}

/** 无 prerelease > 有 prerelease；都有则逐段比较 */
function comparePre(a: string[], b: string[]): -1 | 0 | 1 {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  return comparePreSegments(a, b)
}

/**
 * 带 prerelease 的版本比较：a<b → -1，a=b → 0，a>b → 1，任一侧不可解析 → null。
 * 实测链路：本地 0.1.0-rc.5 < 0.1.1-rc.2 < 0.1.2-alpha.4 < 0.1.2；tag 噪声（dsh-v 前缀）自动剥离。
 */
export function compareSemver(a: string, b: string): VersionOrdering {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return null
  const core = compareCore(pa.core, pb.core)
  if (core !== 0) return core
  return comparePre(pa.pre, pb.pre)
}

/** 从 tag 提取规范化版本串（如 dsh-v0.1.2-alpha.4 → 0.1.2-alpha.4）；解析失败原样返回 */
export function semverFromTag(tag: string): string {
  const p = parseSemver(tag)
  if (!p) return String(tag ?? '')
  const coreText = p.core.join('.')
  return p.pre.length ? coreText + '-' + p.pre.join('.') : coreText
}
