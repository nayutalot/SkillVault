// SKILL.md frontmatter 的纯函数解析（无 IO、无依赖）。
// Windows 侧扫描（winLinks）与 companion（esbuild 内联打包）共用同一实现。
// 约定：只做简单行解析（`---` 围栏内的 name / description），不做完整 YAML。
// - description 支持单行（含超长中英文）、引号包裹、块标量 `>` / `>-` 折叠与 `|` / `|-` 保留多行
// - 无 frontmatter / 无键 / 值为空 / 未闭合（malformed）→ 对应字段缺省，绝不抛错
// 中文代理对安全：绝不按码元截断字符串，截断一律交给 CSS ellipsis。

export type Frontmatter = { name?: string; description?: string }

/** 剥离成对的包裹引号（单引号或双引号）；不成对则原样返回 */
function stripQuotes(v: string): string {
  if (v.length >= 2) {
    const first = v[0]
    const last = v[v.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return v.slice(1, -1)
  }
  return v
}

/** 去掉行尾注释（仅当 # 前有空格，避免误伤值内的 #，如 C# / markdown 标题） */
function stripTrailingComment(v: string): string {
  const hash = v.indexOf(' #')
  return (hash >= 0 ? v.slice(0, hash) : v).trim()
}

/**
 * 收集块标量缩进体：从 start 行起，收集缩进行与空行，直到非缩进行 / 闭合线 / EOF。
 * - `>` / `>-`（折叠）：行间以空格连接，空行视为换行
 * - `|` / `|-`（保留）：行间保留换行
 * 返回文本与停止行下标（不含）。
 */
function collectBlockScalar(lines: string[], start: number, indicator: string): { text: string; next: number } {
  const folded = indicator[0] === '>'
  const parts: string[] = []
  let j = start
  for (; j < lines.length; j++) {
    const l = lines[j]
    if (l.trim() === '---') break
    if (l.trim() === '') {
      parts.push('')
      continue
    }
    if (/^[ \t]/.test(l)) {
      parts.push(l.trim())
      continue
    }
    break
  }
  while (parts.length && parts[parts.length - 1] === '') parts.pop() // 掐掉尾部空行
  let text = ''
  for (let k = 0; k < parts.length; k++) {
    if (k > 0) text += folded ? (parts[k] === '' || parts[k - 1] === '' ? '\n' : ' ') : '\n'
    text += parts[k]
  }
  return { text: text.trim(), next: j }
}

/**
 * 解析 markdown 文本 frontmatter，提取 name / description。
 * - 首个非空行不是 `---` → {}（无 frontmatter；正文分隔线不误判）
 * - frontmatter 未闭合（malformed）→ {}（保守视为无键）
 * - 同名键取第一个；值为空视为无该键
 */
export function parseFrontmatter(mdText: string): Frontmatter {
  const text = String(mdText ?? '').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (i >= lines.length || lines[i].trim() !== '---') return {}
  i++
  const out: Frontmatter = {}
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---') return out // frontmatter 正常闭合
    const m = /^(name|description)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1] as 'name' | 'description'
    if (out[key] !== undefined) continue // 同名键取第一个
    const raw = m[2].trim()
    if (/^[|>][+-]?$/.test(raw)) {
      const { text: block, next } = collectBlockScalar(lines, i + 1, raw)
      i = next - 1
      if (block) out[key] = stripQuotes(block)
    } else {
      const v = stripQuotes(stripTrailingComment(raw))
      if (v) out[key] = v
    }
  }
  return {} // 走到文件末尾都没遇到闭合 `---` → malformed
}

/** 兼容旧调用：只取 description（缺失为空串） */
export function parseFrontmatterDescription(md: string): string {
  return parseFrontmatter(md).description ?? ''
}
