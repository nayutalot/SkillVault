// 档案库单测：seal/读回、plainStore 降级、编辑留空保留 key、校验、删除、导入解析。
// 假密钥一律 fakeKey() 运行时拼接（源码零凭据形字面量）+ 临时目录，绝不触碰真实 userData。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decryptKey,
  deleteProfile,
  listProfileViews,
  loadStore,
  profileInputFromConfigText,
  profilesFile,
  saveStore,
  upsertProfile,
  type KimiSealer
} from '../src/main/kimi/profiles'
import type { KimiProfileInput } from '../src/shared/types'
import { fakeKey, KIMI_KEY, SAMPLE } from './helpers/kimi-sample'

/** 假 sealer：可识别的 enc1: 前缀 + base64；decrypt 遇到外来密文抛错（模拟换机 DPAPI 失效） */
function fakeSealer(available = true): KimiSealer {
  return {
    isEncryptionAvailable: () => available,
    encrypt: (plain) => Buffer.from(`enc1:${plain}`, 'utf8').toString('base64'),
    decrypt: (b64) => {
      const raw = Buffer.from(b64, 'base64').toString('utf8')
      if (!raw.startsWith('enc1:')) throw new Error('无法解密（密文不来自本机）')
      return raw.slice(5)
    }
  }
}

const BASE_INPUT: KimiProfileInput = {
  name: 'MicuAPI',
  providerId: 'micuapi',
  type: 'openai',
  baseUrl: 'https://www.micuapi.ai/v1',
  modelId: 'kimi-k3',
  modelDisplay: 'Kimi K3 (MicuAPI)',
  maxContext: 1048576,
  capabilities: ['thinking', 'tool_use'],
  thinkingEnabled: true
}

let dir = ''
let configDir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-profiles-'))
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-config-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(configDir, { recursive: true, force: true })
})

describe('upsertProfile / seal 读回', () => {
  it('新增档案：立即 seal 落库，读回解密一致，文件不含明文', () => {
    const p = upsertProfile(dir, BASE_INPUT, KIMI_KEY, fakeSealer())
    const store = loadStore(dir)
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0]?.id).toBe(p.id)
    expect(decryptKey(store.profiles[0]!, fakeSealer())).toBe(KIMI_KEY)
    // 明文绝不落盘：档案库 JSON 中只有密文的 base64（解密一致已在上面断言）
    const raw = fs.readFileSync(profilesFile(dir), 'utf8')
    expect(raw).not.toContain(KIMI_KEY)
    expect(raw).not.toContain('enc1:') // 落盘的是 base64 密文，不是编码前的中间形态
    expect(store.profiles[0]?.plainStore).toBeUndefined()
  })

  it('safeStorage 不可用：降级 base64 明文并标记 plainStore:true，读回可解', () => {
    const PLAIN_KEY = fakeKey('plain-store-xyz')
    const p = upsertProfile(dir, BASE_INPUT, PLAIN_KEY, fakeSealer(false))
    expect(p.plainStore).toBe(true)
    const store = loadStore(dir)
    expect(decryptKey(store.profiles[0]!, fakeSealer(false))).toBe(PLAIN_KEY)
  })

  it('编辑留空 key：沿用原 sealed；填新 key：重新 seal', () => {
    const OLD_KEY = fakeKey('old-value-0001')
    const NEW_KEY = fakeKey('new-value-002')
    const p = upsertProfile(dir, BASE_INPUT, OLD_KEY, fakeSealer())
    const before = loadStore(dir).profiles[0]!.apiKeySealed
    const edited = upsertProfile(dir, { ...BASE_INPUT, id: p.id, name: 'MicuAPI 改' }, '', fakeSealer())
    expect(edited.name).toBe('MicuAPI 改')
    expect(loadStore(dir).profiles[0]!.apiKeySealed).toBe(before)
    const rekeyed = upsertProfile(dir, { ...BASE_INPUT, id: p.id }, NEW_KEY, fakeSealer())
    expect(loadStore(dir).profiles[0]!.apiKeySealed).not.toBe(before)
    expect(decryptKey(rekeyed, fakeSealer())).toBe(NEW_KEY)
  })

  it('编辑不存在的 id：抛错', () => {
    expect(() => upsertProfile(dir, { ...BASE_INPUT, id: 'kp-nope' }, '', fakeSealer())).toThrow('找不到要编辑的档案')
  })
})

describe('validateProfileInput', () => {
  const cases: [string, KimiProfileInput][] = [
    ['档案名为空', { ...BASE_INPUT, name: ' ' }],
    ['providerId 非法（大写）', { ...BASE_INPUT, providerId: 'Micu' }],
    ['providerId 非法（连字符开头）', { ...BASE_INPUT, providerId: '-micu' }],
    ['providerId 非法（空）', { ...BASE_INPUT, providerId: '' }],
    ['Base URL 非协议开头', { ...BASE_INPUT, baseUrl: 'www.micuapi.ai/v1' }],
    ['模型 ID 为空', { ...BASE_INPUT, modelId: '' }],
    ['maxContext 非正整数', { ...BASE_INPUT, maxContext: 0 }],
    ['maxContext 小数', { ...BASE_INPUT, maxContext: 1.5 }]
  ]
  for (const [label, input] of cases) {
    it(`拒绝：${label}`, () => {
      expect(() => upsertProfile(dir, input, fakeKey('x'), fakeSealer())).toThrow()
    })
  }
})

describe('deleteProfile / loadStore 容错', () => {
  it('删除档案；删除生效档案时 activeId 置空；删不存在的 id 抛错', () => {
    const a = upsertProfile(dir, BASE_INPUT, fakeKey('a-00000000001'), fakeSealer())
    const b = upsertProfile(dir, { ...BASE_INPUT, providerId: 'other', modelId: 'm2' }, fakeKey('b-00000000002'), fakeSealer())
    let store = loadStore(dir)
    store.activeId = a.id
    saveStore(dir, store)
    store = deleteProfile(dir, a.id)
    expect(store.profiles.map((p) => p.id)).toEqual([b.id])
    expect(store.activeId).toBeNull()
    expect(() => deleteProfile(dir, 'kp-nope')).toThrow('找不到要删除的档案')
  })

  it('loadStore：文件缺失 / JSON 损坏 / 版本不匹配 / activeId 悬空 → 回落空库或清洗', () => {
    expect(loadStore(dir)).toEqual({ version: 1, profiles: [], activeId: null })
    fs.writeFileSync(profilesFile(dir), '{broken', 'utf8')
    expect(loadStore(dir).profiles).toEqual([])
    fs.writeFileSync(profilesFile(dir), JSON.stringify({ version: 99, profiles: [], activeId: null }), 'utf8')
    expect(loadStore(dir).profiles).toEqual([])
    const p = upsertProfile(dir, BASE_INPUT, fakeKey('hang-000001'), fakeSealer())
    fs.writeFileSync(profilesFile(dir), JSON.stringify({ version: 1, profiles: [p], activeId: 'kp-gone' }), 'utf8')
    expect(loadStore(dir).activeId).toBeNull()
  })

  it('saveStore 原子落盘：无 .tmp 残留', () => {
    const store = loadStore(dir)
    saveStore(dir, store)
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
  })
})

describe('listProfileViews（脱敏）', () => {
  it('视图只含尾 4 位与长度，绝无全值；解密失败如实回 null', () => {
    upsertProfile(dir, BASE_INPUT, KIMI_KEY, fakeSealer())
    const views = listProfileViews(loadStore(dir), fakeSealer())
    expect(views[0]?.apiKeyTail).toBe('cdef')
    expect(views[0]?.apiKeyLen).toBe(KIMI_KEY.length)
    expect(JSON.stringify(views)).not.toContain(KIMI_KEY)
    // 换了一个"机器"的 sealer：解密失败 → 尾4位未知但不抛
    const broken = listProfileViews(loadStore(dir), {
      isEncryptionAvailable: () => true,
      encrypt: (s) => Buffer.from(s).toString('base64'),
      decrypt: () => {
        throw new Error('DPAPI 失效')
      }
    })
    expect(broken[0]?.apiKeyTail).toBeNull()
    expect(broken[0]?.apiKeyLen).toBeNull()
  })

  it('plainStore 降级态：视图照常给出尾 4 位', () => {
    upsertProfile(dir, BASE_INPUT, fakeKey('abcdefgh0123'), fakeSealer(false))
    const views = listProfileViews(loadStore(dir), fakeSealer(false))
    expect(views[0]?.plainStore).toBe(true)
    expect(views[0]?.apiKeyTail).toBe('0123')
  })
})

describe('profileInputFromConfigText（从当前 config 导入）', () => {
  it('样本 config → 档案输入 + key 全值（内存一瞬间），thinking 取自 [thinking]', () => {
    const { input, apiKeyPlain } = profileInputFromConfigText(SAMPLE)
    expect(apiKeyPlain).toBe(KIMI_KEY)
    expect(input.providerId).toBe('micuapi')
    expect(input.type).toBe('openai')
    expect(input.baseUrl).toBe('https://www.micuapi.ai/v1')
    expect(input.modelId).toBe('kimi-k3')
    expect(input.modelDisplay).toBe('Kimi K3 (MicuAPI)')
    expect(input.maxContext).toBe(1048576)
    expect(input.capabilities).toEqual(['thinking', 'always_thinking', 'image_in', 'video_in', 'tool_use'])
    expect(input.thinkingEnabled).toBe(true)
    expect(input.name).toBe('www.micuapi.ai')
    // 导入 → seal 入库全链路（key 只在本调用与 upsertProfile 参数中存在）
    const p = upsertProfile(dir, input, apiKeyPlain, fakeSealer())
    expect(decryptKey(p, fakeSealer())).toBe(KIMI_KEY)
  })

  it('结构不明拒绝导入：无 default_model / 缺 models 块 / 缺 api_key', () => {
    expect(() => profileInputFromConfigText('[thinking]\nenabled = true')).toThrow('default_model')
    expect(() =>
      profileInputFromConfigText(['default_model = "a/m1"', '', '[providers.a]', 'api_key = "' + fakeKey('1') + '"'].join('\n'))
    ).toThrow('[models]')
    expect(() =>
      profileInputFromConfigText(
        ['default_model = "a/m1"', '', '[providers.a]', 'base_url = "https://x/v1"', '', '[models."a/m1"]', 'provider = "a"', 'model = "m1"'].join('\n')
      )
    ).toThrow('api_key')
  })
})
