import { describe, expect, it } from 'vitest'
import { parseFrontmatter, parseFrontmatterDescription } from '../src/shared/frontmatter'

describe('parseFrontmatterDescription', () => {
  it('单行无引号', () => {
    const md = '---\nname: hatch-pet\ndescription: 养成一只虚拟宠物的小游戏技能\n---\n\n# Hatch Pet\n'
    expect(parseFrontmatterDescription(md)).toBe('养成一只虚拟宠物的小游戏技能')
  })

  it('双引号包裹', () => {
    const md = '---\ndescription: "Has spaces, and: colons"\n---\nbody\n'
    expect(parseFrontmatterDescription(md)).toBe('Has spaces, and: colons')
  })

  it('单引号包裹', () => {
    const md = "---\ndescription: 'quoted text'\n---\nbody\n"
    expect(parseFrontmatterDescription(md)).toBe('quoted text')
  })

  it('缺失 description 键 → 空串', () => {
    const md = '---\nname: foo\nversion: 1\n---\n# Foo\n'
    expect(parseFrontmatterDescription(md)).toBe('')
  })

  it('description 值为空 → 空串', () => {
    const md = '---\ndescription:\n---\n'
    expect(parseFrontmatterDescription(md)).toBe('')
  })

  it('malformed：frontmatter 未闭合 → 空串（保守）', () => {
    const md = '---\nname: foo\ndescription: 断块\n没有闭合线'
    expect(parseFrontmatterDescription(md)).toBe('')
  })

  it('frontmatter 缺失（纯 markdown）→ 空串', () => {
    const md = '# Foo\n\n---\n\n正文里的分隔线不算 frontmatter\n'
    expect(parseFrontmatterDescription(md)).toBe('')
  })

  it('空文本 / 非字符串输入 → 空串', () => {
    expect(parseFrontmatterDescription('')).toBe('')
    // @ts-expect-error 防御性：运行时可能收到 undefined
    expect(parseFrontmatterDescription(undefined)).toBe('')
  })

  it('BOM 与 CRLF 兼容', () => {
    const md = '\uFEFF---\r\nname: foo\r\ndescription: windows 行尾\r\n---\r\nbody\r\n'
    expect(parseFrontmatterDescription(md)).toBe('windows 行尾')
  })

  it('多个 description 键取第一个', () => {
    const md = '---\ndescription: first\ndescription: second\n---\n'
    expect(parseFrontmatterDescription(md)).toBe('first')
  })

  it('块标量（description: |）保留多行（字面量语义）', () => {
    const md = '---\nname: foo\ndescription: |\n  line one\n  line two\n---\nbody\n'
    expect(parseFrontmatterDescription(md)).toBe('line one\nline two')
  })

  it('值内 # 不误伤（无空格前缀）；空格引导的行尾注释按 YAML 规则剥离', () => {
    expect(parseFrontmatterDescription('---\ndescription: C# 风格\n---\n')).toBe('C# 风格')
    expect(parseFrontmatterDescription('---\ndescription: hello # 备注\n---\n')).toBe('hello')
    expect(parseFrontmatterDescription('---\ndescription: C# 风格 # 备注\n---\n')).toBe('C# 风格')
  })

  it('忽略 description 之后的其他键与正文', () => {
    const md = '---\nname: foo\ndescription: real\nother: x\n---\n\ndescription: 不是这里\n'
    expect(parseFrontmatterDescription(md)).toBe('real')
  })
})

describe('parseFrontmatter', () => {
  it('单行英文长文：name + description 均提取', () => {
    const md =
      '---\nname: hatch-pet\ndescription: Create, repair, validate and ship sprite pets with deterministic assembly, QA artifacts, and spriteVersionNumber 2 packaging.\n---\n\n# Hatch Pet\n'
    expect(parseFrontmatter(md)).toEqual({
      name: 'hatch-pet',
      description:
        'Create, repair, validate and ship sprite pets with deterministic assembly, QA artifacts, and spriteVersionNumber 2 packaging.'
    })
  })

  it('单行中文长文：数百字长句完整保留（不截断、不抛错）', () => {
    const long =
      '数学建模竞赛全自动交付技能：用户上传或粘贴赛题后，自动完成问题重述、模型选型、求解代码、灵敏度分析、论文图表与最终 PDF 交付，覆盖评价、优化、预测、统计等常见题型。'
    const md = `---\nname: math-modeling\ndescription: ${long}\n---\n正文\n`
    expect(parseFrontmatter(md)).toEqual({ name: 'math-modeling', description: long })
  })

  it('双引号包裹：剥离引号，值内冒号/逗号保留', () => {
    const md = '---\nname: "quoted-name"\ndescription: "Has spaces, and: colons"\n---\n'
    expect(parseFrontmatter(md)).toEqual({ name: 'quoted-name', description: 'Has spaces, and: colons' })
  })

  it('单引号包裹：剥离引号', () => {
    expect(parseFrontmatter("---\ndescription: 'quoted text'\n---\n")).toEqual({ description: 'quoted text' })
  })

  it('块标量 >- 折叠为单行（空格连接）', () => {
    const md = '---\ndescription: >-\n  folded line one\n  folded line two\n---\n'
    expect(parseFrontmatter(md).description).toBe('folded line one folded line two')
  })

  it('块标量 | 保留多行（换行保留，供详情面板 pre-wrap 展示）', () => {
    const md = '---\ndescription: |\n  literal one\n  literal two\n---\n'
    expect(parseFrontmatter(md).description).toBe('literal one\nliteral two')
  })

  it('无 description 键：description 缺省，不影响 name', () => {
    expect(parseFrontmatter('---\nname: foo\nversion: 1\n---\n# Foo\n')).toEqual({ name: 'foo' })
  })

  it('无 frontmatter（首行是正文/分隔线）→ 空对象', () => {
    expect(parseFrontmatter('# Foo\n\n---\ndescription: 不是 frontmatter\n---\n')).toEqual({})
    expect(parseFrontmatter('')).toEqual({})
    // @ts-expect-error 防御性：运行时可能收到 undefined
    expect(parseFrontmatter(undefined)).toEqual({})
  })

  it('只有 name（description 缺省）→ { name }', () => {
    expect(parseFrontmatter('---\nname: solo\n---\n')).toEqual({ name: 'solo' })
    expect(parseFrontmatter('---\nname: solo\n---\n').description).toBeUndefined()
  })

  it('malformed（未闭合）→ 空对象（保守）', () => {
    expect(parseFrontmatter('---\nname: foo\ndescription: 断块\n没有闭合线')).toEqual({})
  })

  it('description 值为空 → 视为无该键', () => {
    expect(parseFrontmatter('---\nname: foo\ndescription:\n---\n')).toEqual({ name: 'foo' })
  })

  it('同名键取第一个；正文里的同名键不误判', () => {
    expect(parseFrontmatter('---\nname: a\nname: b\ndescription: first\ndescription: second\n---\n')).toEqual({
      name: 'a',
      description: 'first'
    })
    expect(parseFrontmatter('---\nname: foo\ndescription: real\n---\n\ndescription: 不是这里\n')).toEqual({
      name: 'foo',
      description: 'real'
    })
  })

  it('BOM 与 CRLF 兼容', () => {
    expect(parseFrontmatter('\uFEFF---\r\nname: foo\r\ndescription: windows 行尾\r\n---\r\n')).toEqual({
      name: 'foo',
      description: 'windows 行尾'
    })
  })
})
