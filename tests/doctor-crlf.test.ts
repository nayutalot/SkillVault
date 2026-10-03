// doctor CRLF 一键修复的字节级安全：GBK/UTF-16 等非 UTF-8 文件绝不被 UTF-8 强解码写坏成乱码。
// 背景：中文 Windows 记事本默认 GBK/ANSI 编码，旧实现 buf.toString('utf8') + writeFileSync('utf8')
// 会把非法字节替换成 U+FFFD 永久写坏（跨机器打开必现乱码）；新实现逐字节删除 \r\n 中的 \r，其余字节不动。
// 临时目录真 fs 造 vault/skills 结构；applyFix 用最小 cast 构造 settings/item/registry（仅走 crlf 分支所需字段）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyFix, crlfToLfBuffer } from '../src/main/doctor'
import type { AppSettings } from '../src/main/settings'
import type { DoctorItem, Registry } from '../src/shared/types'

let tmp = ''
let skills = ''

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-doctor-crlf-'))
  skills = path.join(tmp, 'skills')
  fs.mkdirSync(skills, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** GBK「中文」的四个字节（高位字节），UTF-8 强解码会得到 U+FFFD，用于验证逐字节保真 */
const GBK_BYTES = [0xd6, 0xd0, 0xce, 0xc4]

describe('crlfToLfBuffer：字节级 CRLF→LF', () => {
  it('纯 LF（含空文件）返回 null，调用方跳过写盘', () => {
    expect(crlfToLfBuffer(Buffer.from('a\nb\nc\n'))).toBeNull()
    expect(crlfToLfBuffer(Buffer.alloc(0))).toBeNull()
  })

  it('CRLF 正确转 LF，其余字节不变', () => {
    expect(crlfToLfBuffer(Buffer.from('a\r\nb\r\nc'))).toEqual(Buffer.from('a\nb\nc'))
  })

  it('GBK 高位字节夹杂 CRLF：转换后 GBK 字节逐字节保留（不被解码成 U+FFFD）', () => {
    const src = Buffer.concat([
      Buffer.from(GBK_BYTES),
      Buffer.from('\r\n', 'latin1'),
      Buffer.from(GBK_BYTES),
      Buffer.from('\r\n', 'latin1')
    ])
    expect(crlfToLfBuffer(src)).toEqual(
      Buffer.concat([Buffer.from(GBK_BYTES), Buffer.from('\n', 'latin1'), Buffer.from(GBK_BYTES), Buffer.from('\n', 'latin1')])
    )
  })

  it('孤立 \\r（旧 Mac 行尾）不动：纯孤立 \\r 无 CRLF → null；与 CRLF 混合时只删 CRLF 的 \\r', () => {
    expect(crlfToLfBuffer(Buffer.from('a\rb\rc\r'))).toBeNull()
    expect(crlfToLfBuffer(Buffer.from('\ra\r\nb\r'))).toEqual(Buffer.from('\ra\nb\r'))
  })

  it('连续 \\r\\n\\r\\n 全部处理，末尾孤立 \\r 保留', () => {
    // 输入 = CRLF CRLF 'x' CRLF CR：前三组 CRLF 全转 \n，末尾孤立 \r 原样保留
    expect(crlfToLfBuffer(Buffer.from('\r\n\r\nx\r\n\r'))).toEqual(Buffer.from('\n\nx\n\r'))
  })
})

describe("applyFix 'crlf'：端到端字节保真", () => {
  it('GBK 文件去 CRLF 且字节保真；含 NUL（UTF-16/二进制）文件逐字节未动且不计数', async () => {
    // GBK 编码的 .ps1（中文 Windows 记事本另存 ANSI 的典型形态）：文本 CRLF + GBK 高位字节
    const gbkSrc = Buffer.concat([
      Buffer.from('---\r\nname: gbk-skill\r\n---\r\n', 'latin1'),
      Buffer.from(GBK_BYTES),
      Buffer.from('\r\nbody\r\n', 'latin1')
    ])
    const gbkPath = path.join(skills, 'gbk-skill.ps1')
    fs.writeFileSync(gbkPath, gbkSrc)
    // 含 NUL 的文件（UTF-16LE/二进制特征）：也有 CRLF，会被扫描命中，但必须被 NUL 守卫跳过
    const nulSrc = Buffer.from('a\x00b\r\nc\x00d\r\n', 'latin1')
    const nulPath = path.join(skills, 'utf16-skill.md')
    fs.writeFileSync(nulPath, nulSrc)

    const r = await applyFix(
      { vaultPath: tmp } as AppSettings,
      { agents: [] } as unknown as Registry, // Registry 要求 version:2 字面量，最小构造经 unknown 断言
      { fixId: 'crlf' } as DoctorItem
    )

    // 计数只含实际写盘的 GBK 文件（NUL 文件被跳过不计）
    expect(r.message).toContain('已转换 1 个文件')
    // GBK 文件：CRLF 已去，GBK 字节逐字节保真（旧实现此处会变成 U+FFFD 乱码）
    expect(fs.readFileSync(gbkPath)).toEqual(
      Buffer.concat([
        Buffer.from('---\nname: gbk-skill\n---\n', 'latin1'),
        Buffer.from(GBK_BYTES),
        Buffer.from('\nbody\n', 'latin1')
      ])
    )
    // NUL 文件：不解码不重写，逐字节未动
    expect(fs.readFileSync(nulPath)).toEqual(nulSrc)
  })
})
