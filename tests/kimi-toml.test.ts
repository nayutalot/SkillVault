// tomlEdit 纯函数全套：块替换/追加、复合引号键精确匹配、未知段保留、CRLF、脱敏解析。
// 红线断言：parseKimiConfigDisplay 的结果里绝不允许出现 api_key 全值。
// 假 key 一律 fakeKey() 运行时拼接（门禁安全惯例：源码零凭据形字面量）。
import { describe, expect, it } from 'vitest'
import {
  backupStamp,
  extractProviderSecret,
  maskSecret,
  parseKimiConfigDisplay,
  setDefaultModel,
  thinkingEnabledOf,
  tomlQuote,
  upsertBlock
} from '../src/main/kimi/tomlEdit'
import { fakeKey, KIMI_KEY, SAMPLE } from './helpers/kimi-sample'

describe('upsertBlock', () => {
  it('替换既有块：providers 块被更新，models/thinking/default_model 原样保留', () => {
    const NEW_KEY = fakeKey('ffffffffffffffff')
    const next = upsertBlock(SAMPLE, '[providers.micuapi]', [
      '[providers.micuapi]',
      'type = "openai"',
      'base_url = "https://api.other.com/v1"',
      'api_key = "' + NEW_KEY + '"'
    ])
    expect(next).toContain('base_url = "https://api.other.com/v1"')
    expect(next).toContain('api_key = "' + NEW_KEY + '"')
    expect(next).not.toContain('https://www.micuapi.ai/v1')
    expect(next).toContain('default_model = "micuapi/kimi-k3"')
    expect(next).toContain('[models."micuapi/kimi-k3"]')
    expect(next).toContain('display_name = "Kimi K3 (MicuAPI)"')
    expect(next).toContain('[thinking]\nenabled = true')
  })

  it('追加新块：文末前置一个空行，且文件以换行结尾', () => {
    const APPEND_KEY = fakeKey('2')
    const next = upsertBlock(SAMPLE, '[providers.newprov]', ['[providers.newprov]', 'type = "openai"', 'api_key = "' + APPEND_KEY + '"'])
    expect(next.trimEnd().endsWith('[providers.newprov]')).toBe(false) // 块不止一行
    expect(next.endsWith('\n\n[providers.newprov]\ntype = "openai"\napi_key = "' + APPEND_KEY + '"\n')).toBe(true)
  })

  it('复合引号键精确匹配：[models."a/b"] 不会误伤裸头 [models] 或 providers 块', () => {
    const SIDE_KEY = fakeKey('1')
    const text = [
      '[models]',
      'ignored = true',
      '',
      '[models."a/b"]',
      'model = "b-old"',
      '',
      '[providers.a]',
      'api_key = "' + SIDE_KEY + '"'
    ].join('\n')
    const next = upsertBlock(text, '[models."a/b"]', ['[models."a/b"]', 'model = "b-new"'])
    expect(next).toContain('[models]\nignored = true')
    expect(next).toContain('model = "b-new"')
    expect(next).not.toContain('b-old')
    expect(next).toContain('[providers.a]\napi_key = "' + SIDE_KEY + '"')
  })

  it('providers 键不误伤 models 复合键（替换 [providers.a] 时 models."a/b" 保留）', () => {
    const OLD_KEY = fakeKey('old')
    const NEW_KEY = fakeKey('new')
    const text = ['[providers.a]', 'api_key = "' + OLD_KEY + '"', '', '[models."a/b"]', 'model = "b"'].join('\n')
    const next = upsertBlock(text, '[providers.a]', ['[providers.a]', 'api_key = "' + NEW_KEY + '"'])
    expect(next).toContain('api_key = "' + NEW_KEY + '"')
    expect(next).toContain('[models."a/b"]\nmodel = "b"')
  })

  it('CRLF 输入：替换后仍为 CRLF 行尾', () => {
    const CRLF_KEY = fakeKey('crlf')
    const crlf = SAMPLE.replace(/\n/g, '\r\n')
    const next = upsertBlock(crlf, '[providers.micuapi]', ['[providers.micuapi]', 'api_key = "' + CRLF_KEY + '"'])
    expect(next).toContain('\r\n')
    expect(next).not.toMatch(/[^\r]\n/) // 绝不夹带裸 LF
    expect(next.split('\r\n')).toContain('api_key = "' + CRLF_KEY + '"')
  })

  it('目标块位于文末且无尾换行：替换成功且不动前一块', () => {
    const SIDE_KEY = fakeKey('1')
    const text = ['[providers.a]', 'api_key = "' + SIDE_KEY + '"', '', '[thinking]', 'enabled = false'].join('\n')
    const next = upsertBlock(text, '[thinking]', ['[thinking]', 'enabled = true'])
    expect(next).toContain('api_key = "' + SIDE_KEY + '"')
    expect(next.trimEnd().endsWith('enabled = true')).toBe(true)
  })

  it('替换后若紧贴下一个头，自动补一个空行分隔', () => {
    const text = ['[a]', 'k = 1', '[b]', 'k = 2'].join('\n')
    const next = upsertBlock(text, '[a]', ['[a]', 'k = 3'])
    expect(next).toBe('[a]\nk = 3\n\n[b]\nk = 2')
  })

  it('header 形态非法时抛错', () => {
    expect(() => upsertBlock(SAMPLE, 'providers.x', ['x'])).toThrow()
    expect(() => upsertBlock(SAMPLE, '[x]', [])).toThrow()
  })
})

describe('setDefaultModel', () => {
  it('已有行：原位替换', () => {
    const next = setDefaultModel(SAMPLE, 'other/m2')
    expect(next).toContain('default_model = "other/m2"')
    expect(next.indexOf('default_model')).toBe(0) // 仍在顶部
    expect(next).toContain('[providers.micuapi]')
  })

  it('缺失：插入到首个顶格段落头之前', () => {
    const text = ['[thinking]', 'enabled = true'].join('\n')
    const next = setDefaultModel(text, 'a/b')
    expect(next).toBe('default_model = "a/b"\n\n[thinking]\nenabled = true')
  })

  it('空文件：放文首', () => {
    expect(setDefaultModel('', 'a/b')).toBe('default_model = "a/b"\n')
  })

  it('CRLF：原位替换保持 CRLF', () => {
    const next = setDefaultModel(SAMPLE.replace(/\n/g, '\r\n'), 'x/y')
    expect(next).toContain('default_model = "x/y"')
    expect(next).toContain('\r\n')
  })
})

describe('parseKimiConfigDisplay（脱敏）', () => {
  it('解析 default_model / providers / models，api_key 只有尾 4 位与长度', () => {
    const d = parseKimiConfigDisplay(SAMPLE)
    expect(d.defaultModel).toBe('micuapi/kimi-k3')
    expect(d.providers).toEqual([
      { id: 'micuapi', type: 'openai', baseUrl: 'https://www.micuapi.ai/v1', apiKeyTail: 'cdef', apiKeyLen: KIMI_KEY.length }
    ])
    expect(d.models).toEqual([
      {
        id: 'micuapi/kimi-k3',
        provider: 'micuapi',
        model: 'kimi-k3',
        displayName: 'Kimi K3 (MicuAPI)',
        maxContext: 1048576,
        capabilities: ['thinking', 'always_thinking', 'image_in', 'video_in', 'tool_use']
      }
    ])
  })

  it('红线：结果 JSON 中绝不出现 api_key 全值', () => {
    const full = KIMI_KEY
    const json = JSON.stringify(parseKimiConfigDisplay(SAMPLE))
    expect(json).not.toContain(full)
    expect(json).toContain('cdef')
  })

  it('CRLF 样本照常解析', () => {
    const d = parseKimiConfigDisplay(SAMPLE.replace(/\n/g, '\r\n'))
    expect(d.defaultModel).toBe('micuapi/kimi-k3')
    expect(d.providers[0]?.apiKeyTail).toBe('cdef')
  })

  it('空文本 / 无 default_model：返回空结构不抛', () => {
    expect(parseKimiConfigDisplay('')).toEqual({ defaultModel: null, providers: [], models: [] })
  })

  it('未知段落与未知键被忽略且不影响解析', () => {
    const TAIL_KEY = fakeKey('1234567890')
    const text = ['[server]', 'port = 1', 'secret_marker = "zzz"', '', '[providers.a]', 'api_key = "' + TAIL_KEY + '"'].join('\n')
    const d = parseKimiConfigDisplay(text)
    expect(d.providers).toEqual([{ id: 'a', apiKeyTail: '7890', apiKeyLen: TAIL_KEY.length }])
    expect(JSON.stringify(d)).not.toContain('secret_marker')
  })
})

describe('extractProviderSecret / thinkingEnabledOf / 工具', () => {
  it('extractProviderSecret 取全值（仅导入/切换路径内存使用）', () => {
    expect(extractProviderSecret(SAMPLE, 'micuapi')).toBe(KIMI_KEY)
    expect(extractProviderSecret(SAMPLE, 'nope')).toBeNull()
  })

  it('thinkingEnabledOf：true / false / 缺块', () => {
    expect(thinkingEnabledOf(SAMPLE)).toBe(true)
    expect(thinkingEnabledOf(SAMPLE.replace('enabled = true', 'enabled = false'))).toBe(false)
    expect(thinkingEnabledOf('[providers.a]\napi_key = "k"')).toBe(false)
  })

  it('tomlQuote 转义反斜杠与双引号', () => {
    expect(tomlQuote('a"b\\c')).toBe('"a\\"b\\\\c"')
  })

  it('backupStamp 与既有 .bak_20260814_175416 惯例一致', () => {
    expect(backupStamp(new Date(2026, 7, 14, 17, 54, 16))).toBe('20260814_175416')
    expect(backupStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102_030405')
  })

  it('maskSecret 只留尾 4 位与长度', () => {
    expect(maskSecret(KIMI_KEY)).toEqual({ tail: 'cdef', len: KIMI_KEY.length })
  })
})
