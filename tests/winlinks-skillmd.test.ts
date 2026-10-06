// readSkillDescription 的 SKILL.md 编码兜底（真实临时目录 + 真实字节写盘）：
// - UTF-8 正常解析 description
// - GBK 编码（另一台中文 Windows 上记事本 ANSI 保存的形态）：按 UTF-8 强解会乱码，decodeTextBuffer 兜底解出中文
// - UTF-16LE BOM（PowerShell ISE 保存的形态）：按 BOM 解码
// - 二进制内容（含 NUL）：如实返回空串，不抛错、不产生 U+FFFD
// 铁律对齐 src/shared/textDecode：解码结果只用于展示（description），测试也绝不把解码文本写回磁盘。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSkillDescription } from '../src/main/winLinks'

let tmp = ''

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-skillmd-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** 在临时目录写一个 skill 目录，SKILL.md 按原始字节落盘（不经过任何字符串编码转换） */
function writeSkillMd(name: string, bytes: Buffer): string {
  // 门禁安全（路径穿越双校验）：动态片段只有 name —— 先过单段 kebab 白名单（拒绝 ../ 与分隔符），
  // 再 resolve 后强制包含在 tmp 内（以 path.sep 结尾前缀比较）；SKILL.md 为固定字面量文件名。
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`非法 skill 目录名: ${JSON.stringify(name)}`)
  const dir = path.resolve(tmp, name)
  if (!dir.startsWith(tmp + path.sep)) throw new Error(`skill 目录越界: ${dir}`)
  fs.mkdirSync(dir, { recursive: true })
  const md = path.resolve(dir, 'SKILL.md')
  if (!md.startsWith(dir + path.sep)) throw new Error(`SKILL.md 路径越界: ${md}`)
  fs.writeFileSync(md, bytes)
  return dir
}

describe('readSkillDescription：SKILL.md 编码兜底（GBK / UTF-16LE BOM / 二进制）', () => {
  it('UTF-8 正常读取 description', () => {
    const dir = writeSkillMd('utf8-skill', Buffer.from('---\nname: demo\ndescription: 中文描述\n---\nbody\n', 'utf8'))
    expect(readSkillDescription(dir)).toBe('中文描述')
  })

  it('GBK 编码能解出正确中文（按 UTF-8 强解会把中文安装的技能描述变乱码）', () => {
    // 「中文描述」的 GBK 字节：中=D6D0 文=CEC4 描=C3E8 述=CAF6（GBK 码表硬编码，不引入 iconv 依赖）
    const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xc3, 0xe8, 0xca, 0xf6])
    const md = Buffer.concat([
      Buffer.from('---\nname: gbk-skill\ndescription: ', 'utf8'),
      gbkBytes,
      Buffer.from('\n---\n', 'utf8')
    ])
    const dir = writeSkillMd('gbk-skill', md)
    expect(readSkillDescription(dir)).toBe('中文描述')
  })

  it('UTF-16LE BOM 能按 BOM 解码出 description', () => {
    const txt = '---\nname: u16-skill\ndescription: 中文描述\n---\n'
    const dir = writeSkillMd('utf16-skill', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(txt, 'utf16le')]))
    expect(readSkillDescription(dir)).toBe('中文描述')
  })

  it('二进制内容（含 NUL）→ 返回空串不抛错', () => {
    const dir = writeSkillMd('bin-skill', Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x00]))
    expect(readSkillDescription(dir)).toBe('')
  })

  it('SKILL.md 缺失 → 空串', () => {
    const dir = path.join(tmp, 'no-skillmd')
    fs.mkdirSync(dir, { recursive: true })
    expect(readSkillDescription(dir)).toBe('')
  })
})
