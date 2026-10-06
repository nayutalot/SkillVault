import { describe, expect, it } from 'vitest'
import { decodeTextBuffer } from '../src/shared/textDecode'

describe('decodeTextBuffer', () => {
  it('合法 UTF-8（含中文）原样解码，标记 utf8', () => {
    const buf = Buffer.from('# 标题\n中文内容', 'utf8')
    expect(decodeTextBuffer(buf)).toEqual({ text: '# 标题\n中文内容', encoding: 'utf8' })
  })

  it('空文件返回空文本而非 null', () => {
    expect(decodeTextBuffer(Buffer.alloc(0))).toEqual({ text: '', encoding: 'utf8' })
  })

  it('UTF-8 BOM 被剥掉，标记 utf8-bom', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('描述', 'utf8')])
    expect(decodeTextBuffer(buf)).toEqual({ text: '描述', encoding: 'utf8-bom' })
  })

  it('UTF-16LE BOM（PowerShell ISE / 记事本 Unicode）正确解码', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文ABC', 'utf16le')])
    expect(decodeTextBuffer(buf)).toEqual({ text: '中文ABC', encoding: 'utf16le' })
  })

  it('UTF-16BE BOM 正确解码', () => {
    // Buffer 无 utf16be 编码：LE 编码后字节两两交换构造 BE 字节
    const le = Buffer.from('中文', 'utf16le')
    const be = Buffer.from(le)
    be.swap16()
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), be])
    expect(decodeTextBuffer(buf)).toEqual({ text: '中文', encoding: 'utf16be' })
  })

  it('GBK 字节按 GBK 解码，绝不出现 U+FFFD', () => {
    // 「中文」的 GBK 编码：D6 D0 CE C4
    const buf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeTextBuffer(buf)).toEqual({ text: '中文', encoding: 'gbk' })
  })

  it('非法 UTF-8 且非 GBK 的二进制返回 null（二进制 PNG 头）', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    // PNG 头含 NUL → 直接拒绝
    expect(decodeTextBuffer(buf)).toBeNull()
  })

  it('无 BOM 含 NUL 的数据拒绝（疑似无 BOM UTF-16 / 二进制），不猜编码', () => {
    const buf = Buffer.from([0x61, 0x00, 0x62, 0x00])
    expect(decodeTextBuffer(buf)).toBeNull()
  })

  it('非法 UTF-8 序列走 GBK 兜底或拒绝，绝不返回含 U+FFFD 的文本', () => {
    // 0x80 单独出现：非法 UTF-8；GBK 中 0x80 是非法字节 → fatal 抛错 → null
    const buf = Buffer.from([0x80, 0x81, 0x82])
    const r = decodeTextBuffer(buf)
    if (r) expect(r.text.includes('\uFFFD')).toBe(false)
    else expect(r).toBeNull()
  })
})
