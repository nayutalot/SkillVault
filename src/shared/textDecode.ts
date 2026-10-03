// 文本解码兜底（只读展示用）：按 BOM → 严格 UTF-8 → GBK 的顺序探测，绝不产生 U+FFFD 乱码。
// 背景：另一台中文 Windows 上，记事本 ANSI 保存的是 GBK、PowerShell ISE 保存的是 UTF-16LE；
// 这些文件按 UTF-8 强解码会在界面上显示乱码。本模块让读取方「要么解对，要么如实报不可读」。
// 铁律：GBK / UTF-16 解码结果只允许用于展示（描述、预览），调用方绝不把它写回磁盘——
// 写回等于静默转码，二进制误判时会把文件写坏。字节级修改（如 CRLF→LF）必须走 Buffer，不经过本模块。
// 依赖说明：GBK / UTF-16 解码用 Node 内置 TextDecoder（Node ≥14 默认 full-icu，Electron 33 = Node 20 可用），零新依赖。

export type DecodedEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'gbk'

export type DecodedText = { text: string; encoding: DecodedEncoding }

/** 无 BOM 的 UTF-16BE：字节两两交换后按 LE 解（swap16 要求偶数长度，奇数丢弃尾字节） */
function decodeUtf16be(buf: Buffer): string {
  const even = buf.length % 2 ? buf.subarray(0, buf.length - 1) : buf
  const swapped = Buffer.from(even)
  swapped.swap16()
  return new TextDecoder('utf-16le').decode(swapped)
}

/**
 * 把文件字节解码为文本；解不了（二进制 / 未知编码）返回 null，调用方按不可读处理。
 * - BOM 优先：UTF-8 / UTF-16LE / UTF-16BE 直接按 BOM 解；
 * - 无 BOM 且含 NUL 字节：大概率无 BOM 的 UTF-16 或二进制 → 不猜，拒绝；
 * - 严格 UTF-8（fatal）：非法序列抛错，绝不静默替换成 U+FFFD；
 * - GBK 兜底（fatal + U+FFFD 复查）：仍失败 → null。
 * 空文件返回 { text: '', encoding: 'utf8' }（展示为空串而非报错）。
 */
export function decodeTextBuffer(buf: Buffer): DecodedText | null {
  if (!buf || buf.length === 0) return { text: '', encoding: 'utf8' }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf8-bom' }
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf16le' }
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: decodeUtf16be(buf.subarray(2)), encoding: 'utf16be' }
  }
  if (buf.includes(0)) return null
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf8' }
  } catch {
    /* 非 UTF-8，落到 GBK 兜底 */
  }
  try {
    const text = new TextDecoder('gbk', { fatal: true }).decode(buf)
    if (text.includes('\uFFFD')) return null
    return { text, encoding: 'gbk' }
  } catch {
    return null
  }
}
