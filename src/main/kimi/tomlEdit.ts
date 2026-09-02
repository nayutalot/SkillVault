// Kimi Code CLI config.toml 的文本块级操作。
// 刻意不做完整 TOML 解析器：块级文本替换最稳妥，[thinking]、[server] 等未知段落与未知键全部原样保留。
// 红线：本文件的函数绝不输出 api_key 全值（parseKimiConfigDisplay 只返回尾 4 位与长度）。
import type { KimiConfigDisplay, KimiModelDisplay, KimiProviderDisplay } from '../../shared/types'

/** 顶格段落头行：[providers.x] / [models."a/b"] / [thinking] …（前置空白视为非顶格，不匹配） */
const HEADER_RE = /^\[(.+)\]\s*$/

/** 按文本实际行尾拆行（保留 CRLF / LF 语义，join 时用同一 eol 还原） */
function splitLines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.length ? text.split(eol) : []
  // 若文本以换行结尾，split 会多出一个空尾元素——保留它以便无损 join
  return { lines, eol }
}

function joinLines(lines: string[], eol: string): string {
  return lines.join(eol)
}

/** 判断某行是否顶格段落头 */
function isHeaderLine(line: string): boolean {
  return HEADER_RE.test(line)
}

/**
 * upsertBlock：把 header 指向的块（从 header 行到下一个顶格 `[` 行或 EOF）替换为 blockLines；
 * 不存在则追加到文末（前置一个空行）。header 匹配是整行精确比较（trim 后），
 * 因此 [models."a/b"] 绝不会误伤 [models] 或 [providers.a]。
 */
export function upsertBlock(text: string, header: string, blockLines: string[]): string {
  if (!header.startsWith('[') || !header.endsWith(']')) throw new Error(`header 必须是 [xxx] 形态: ${header}`)
  if (blockLines.length === 0) throw new Error('blockLines 不能为空')
  const { lines, eol } = splitLines(text)
  const idx = lines.findIndex((l) => l.trim() === header)
  if (idx >= 0) {
    // 块范围 = [idx, 下一个顶格头 或 EOF)
    let end = lines.length
    for (let i = idx + 1; i < lines.length; i++) {
      if (isHeaderLine(lines[i])) {
        end = i
        break
      }
    }
    // 去掉块尾连续空行（属分隔符，不属于块内容），替换后补回一个空行保持块间空行惯例
    while (end > idx && lines[end - 1].trim() === '') end--
    lines.splice(idx, end - idx, ...blockLines)
    const after = lines[idx + blockLines.length]
    if (after !== undefined && after.trim() !== '') lines.splice(idx + blockLines.length, 0, '')
  } else {
    // 追加到文末：确保前有换行与一个空行分隔
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    if (lines.length) lines.push('')
    lines.push(...blockLines)
    lines.push('') // 文件以换行结尾
  }
  return joinLines(lines, eol)
}

/**
 * setDefaultModel：替换顶格 default_model = "..." 行；不存在时插入到首个顶格段落头之前（无头则放文首）。
 */
export function setDefaultModel(text: string, model: string): string {
  const { lines, eol } = splitLines(text)
  const line = `default_model = ${tomlQuote(model)}`
  const idx = lines.findIndex((l) => /^default_model\s*=/.test(l))
  if (idx >= 0) {
    lines[idx] = line
    return joinLines(lines, eol)
  }
  const firstHeader = lines.findIndex(isHeaderLine)
  if (firstHeader < 0) {
    lines.unshift(line, '')
  } else {
    lines.splice(firstHeader, 0, line, '')
  }
  return joinLines(lines, eol)
}

/** TOML 基本字符串引号包裹（转义反斜杠与双引号；key/value 均走这里） */
export function tomlQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** 构造节头行：[section.name]（apihub 适配器共用，集中一处便于审计） */
export function tomlHeader(section: string): string {
  return '[' + section + ']'
}

/** 构造单行 key = "value" 赋值行（value 一律经 tomlQuote；apihub 适配器共用） */
export function tomlAssign(key: string, value: string): string {
  return key + ' = ' + tomlQuote(value)
}

/** 构造无引号原始值赋值行（数字/布尔）：key = raw */
export function tomlAssignRaw(key: string, raw: string): string {
  return key + ' = ' + raw
}

// ---------- 只读解析（UI 脱敏展示用） ----------

/** 单行 key = value 的 value 提取（字符串/数字/布尔/单行字符串数组） */
function parseInlineValue(raw: string): string | number | boolean | string[] | undefined {
  const v = raw.trim()
  if (!v) return undefined
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    // 取首引号到末引号之间并反转义（api_key 等普通值不含转义，此处仅兜底）
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  if (v.startsWith('[') && v.endsWith(']')) {
    // 单行字符串数组：[ "a", "b" ]（TOML 多行数组不在支持范围，Kimi 配置为单行）
    const inner = v.slice(1, -1)
    const out: string[] = []
    const re = /"((?:[^"\\]|\\.)*)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(inner))) out.push(m[1].replace(/\\(["\\])/g, '$1'))
    return out
  }
  return undefined
}

/** key = value 行拆分（返回 null 表示不是赋值行） */
function parseAssign(line: string): { key: string; value: string } | null {
  const m = /^([^#=]+?)\s*=\s*(.*)$/.exec(line)
  if (!m) return null
  return { key: m[1].trim(), value: m[2] }
}

/**
 * 提取某 provider 块的 api_key 全值——仅供 导入档案 / 切换写入 两条主进程路径在内存中使用，
 * 调用方必须立即 seal 或写入 config.toml，绝不允许落日志/缓存/仓库。UI 展示一律走 parseKimiConfigDisplay。
 */
export function extractProviderSecret(text: string, providerId: string): string | null {
  const { lines } = splitLines(text)
  const header = `[providers.${providerId}]`
  let inside = false
  for (const line of lines) {
    if (isHeaderLine(line)) {
      inside = line.trim() === header
      continue
    }
    if (!inside) continue
    const a = parseAssign(line)
    if (a && a.key === 'api_key') {
      const v = parseInlineValue(a.value)
      return typeof v === 'string' ? v : null
    }
  }
  return null
}

/** api_key 脱敏：只留尾 4 位与长度 */
export function maskSecret(key: string): { tail: string; len: number } {
  return { tail: key.slice(-4), len: key.length }
}

/**
 * 只读解析 config.toml 供 UI 展示：default_model、providers（api_key 只回尾 4 位与长度）、models。
 * 绝不返回 api_key 全值（测试里有断言兜底）。
 */
export function parseKimiConfigDisplay(text: string): KimiConfigDisplay {
  const { lines } = splitLines(text)
  const out: KimiConfigDisplay = { defaultModel: null, providers: [], models: [] }
  let header = '' // 当前所在顶格头（'' = 顶层）
  for (const line of lines) {
    if (isHeaderLine(line)) {
      header = (HEADER_RE.exec(line) as RegExpExecArray)[1].trim()
      continue
    }
    const a = parseAssign(line)
    if (!a) continue
    if (header === '' && a.key === 'default_model') {
      const v = parseInlineValue(a.value)
      if (typeof v === 'string') out.defaultModel = v
      continue
    }
    // providers.<id>（id 按白名单形态：字母数字开头，字母数字连字符）
    const pm = /^providers\.([A-Za-z0-9][A-Za-z0-9-]*)$/.exec(header)
    if (pm) {
      let p = out.providers.find((x) => x.id === pm[1])
      if (!p) {
        p = { id: pm[1] }
        out.providers.push(p)
      }
      if (a.key === 'type' && typeof parseInlineValue(a.value) === 'string') p.type = parseInlineValue(a.value) as string
      if (a.key === 'base_url' && typeof parseInlineValue(a.value) === 'string')
        p.baseUrl = parseInlineValue(a.value) as string
      if (a.key === 'api_key' && typeof parseInlineValue(a.value) === 'string') {
        const { tail, len } = maskSecret(parseInlineValue(a.value) as string)
        p.apiKeyTail = tail
        p.apiKeyLen = len
      }
      continue
    }
    // models."<composite>"（复合引号键）或 models.<bare>（裸键兜底）
    const mm = /^models\.(?:"([^"]+)"|([^".\]]+))$/.exec(header)
    if (mm) {
      const id = mm[1] ?? mm[2]
      let mo = out.models.find((x) => x.id === id)
      if (!mo) {
        mo = { id }
        out.models.push(mo)
      }
      const v = parseInlineValue(a.value)
      if (a.key === 'provider' && typeof v === 'string') mo.provider = v
      if (a.key === 'model' && typeof v === 'string') mo.model = v
      if (a.key === 'display_name' && typeof v === 'string') mo.displayName = v
      if (a.key === 'max_context_size' && typeof v === 'number') mo.maxContext = v
      if (a.key === 'capabilities' && Array.isArray(v)) mo.capabilities = v
      continue
    }
  }
  return out
}

/** 备份文件时间戳：yyyyMMdd_HHmmss（与既有 config.toml.bak_20260814_175416 惯例一致） */
export function backupStamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** [thinking] 块的 enabled 值（缺省 false；找不到块/键时不硬解） */
export function thinkingEnabledOf(text: string): boolean {
  const { lines } = splitLines(text)
  let header = ''
  let value = false
  for (const line of lines) {
    if (isHeaderLine(line)) {
      header = line.trim()
      continue
    }
    if (header === '[thinking]') {
      const a = parseAssign(line)
      if (a && a.key === 'enabled') value = a.value.trim() === 'true'
    }
  }
  return value
}
