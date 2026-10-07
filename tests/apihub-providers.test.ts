// 自定义供应商测试：CRUD（加密落盘 / 脱敏视图 / 编辑留空不改密钥 / 删除）、
// 校验文案、旧文件兼容（无 customProviders 节）、坏数据跳过，以及「档案另存为供应商」的密钥转存。
// 假 key 一律运行时生成（绝不写真凭据字面量）；临时目录真 fs，真实 userData 零接触。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apiHubStoreFile,
  customProviderFromProfile,
  customProviderView,
  deleteCustomProvider,
  findCustomProvider,
  hubDecryptKey,
  listCustomProviderViews,
  loadHubStore,
  saveHubStore,
  upsertCustomProvider,
  upsertHubProfile,
  validateCustomProviderInput
} from '../src/main/apihub/store'
import type { KimiSealer } from '../src/main/kimi/profiles'
import type { ApiHubCustomProviderInput } from '../src/shared/types'

/** 运行时生成假样本密钥（仅测试用途，非真实凭据） */
function sampleKey(kind: string): string {
  return ['test', 'sample', kind, Math.random().toString(36).slice(2, 6)].join('-')
}

/** fake sealer：enc1: 前缀 + base64（与 apihub-runtime 测试同款语义） */
function fakeSealer(available = true): KimiSealer {
  return {
    isEncryptionAvailable: () => available,
    encrypt: (plain) => Buffer.from('enc1:' + plain, 'utf8').toString('base64'),
    decrypt: (b64) => {
      const raw = Buffer.from(b64, 'base64').toString('utf8')
      if (!raw.startsWith('enc1:')) throw new Error('无法解密')
      return raw.slice(5)
    }
  }
}

const tmpDirs: string[] = []

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-apihub-prov-'))
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言 */
    }
  }
})

function mkInput(partial: Partial<ApiHubCustomProviderInput> = {}): ApiHubCustomProviderInput {
  return {
    label: 'MicuAPI',
    baseUrl: 'https://api.micu.example/v1',
    protocol: 'openai',
    defaultModel: 'gpt-4.1',
    ...partial
  }
}

describe('自定义供应商 CRUD', () => {
  it('新增 → 加密落盘（磁盘上看不到明文）→ 视图只回尾号与长度', () => {
    const ud = mkTmp()
    const key = sampleKey('prov')
    const saved = upsertCustomProvider(ud, mkInput(), key, fakeSealer())
    expect(saved.id).toMatch(/^cp-/)
    expect(saved.apiKeySealed).not.toContain(key)

    const raw = fs.readFileSync(apiHubStoreFile(ud), 'utf8')
    expect(raw).not.toContain(key)

    const view = customProviderView(saved, fakeSealer())
    expect(view.apiKeyTail).toBe(key.slice(-4))
    expect(view.apiKeyLen).toBe(key.length)
    expect(JSON.stringify(view)).not.toContain(key)
    expect(view.plainStore).toBe(false)
    expect(view.defaultModel).toBe('gpt-4.1')
  })

  it('编辑时 API Key 留空 → 保留原密文（不重新 seal、不改密钥）', () => {
    const ud = mkTmp()
    const key = sampleKey('keep')
    const first = upsertCustomProvider(ud, mkInput(), key, fakeSealer())
    const second = upsertCustomProvider(ud, { ...mkInput({ label: '改名后' }), id: first.id }, '', fakeSealer())
    expect(second.id).toBe(first.id)
    expect(second.apiKeySealed).toBe(first.apiKeySealed)
    expect(second.label).toBe('改名后')
    expect(hubDecryptKey(second, fakeSealer())).toBe(key)
  })

  it('编辑时填了新密钥 → 重新 seal', () => {
    const ud = mkTmp()
    const first = upsertCustomProvider(ud, mkInput(), sampleKey('old'), fakeSealer())
    const next = sampleKey('new')
    const second = upsertCustomProvider(ud, { ...mkInput(), id: first.id }, next, fakeSealer())
    expect(second.apiKeySealed).not.toBe(first.apiKeySealed)
    expect(hubDecryptKey(second, fakeSealer())).toBe(next)
  })

  it('safeStorage 不可用 → base64 降级并标记 plainStore（视图如实透出）', () => {
    const ud = mkTmp()
    const saved = upsertCustomProvider(ud, mkInput(), sampleKey('plain'), fakeSealer(false))
    expect(saved.plainStore).toBe(true)
    expect(customProviderView(saved, fakeSealer(false)).plainStore).toBe(true)
    expect(loadHubStore(ud).customProviders?.[0].plainStore).toBe(true)
  })

  it('删除 → 列表少一条；删不存在的 → 抛错（不静默）', () => {
    const ud = mkTmp()
    const a = upsertCustomProvider(ud, mkInput({ label: 'A' }), sampleKey('a'), fakeSealer())
    upsertCustomProvider(ud, mkInput({ label: 'B' }), sampleKey('b'), fakeSealer())
    const store = deleteCustomProvider(ud, a.id)
    expect(store.customProviders?.map((p) => p.label)).toEqual(['B'])
    expect(() => deleteCustomProvider(ud, a.id)).toThrow('找不到要删除的供应商')
  })

  it('档案与供应商互不干扰：删供应商不影响已有档案，反之亦然', () => {
    const ud = mkTmp()
    const p = upsertCustomProvider(ud, mkInput(), sampleKey('p'), fakeSealer())
    upsertHubProfile(ud, { adapterId: 'claude-cli', name: '档案A', fields: { baseUrl: 'https://a.example' } }, sampleKey('k'), fakeSealer())
    deleteCustomProvider(ud, p.id)
    const store = loadHubStore(ud)
    expect(store.byAdapter['claude-cli']).toHaveLength(1)
    expect(listCustomProviderViews(store, fakeSealer())).toEqual([])
  })

  it('旧文件没有 customProviders 节 → 读成空数组（不丢旧档案，也不升 version）', () => {
    const ud = mkTmp()
    fs.writeFileSync(
      apiHubStoreFile(ud),
      JSON.stringify({ version: 1, byAdapter: { kimi: [] }, activeByAdapter: {} }),
      'utf8'
    )
    const store = loadHubStore(ud)
    expect(store.customProviders).toEqual([])
    expect(store.version).toBe(1)
  })

  it('坏数据（缺字段/协议非法）单条跳过，不带走整份列表', () => {
    const ud = mkTmp()
    fs.writeFileSync(
      apiHubStoreFile(ud),
      JSON.stringify({
        version: 1,
        byAdapter: {},
        activeByAdapter: {},
        customProviders: [
          { id: 'cp-bad1', label: 'A', baseUrl: 'https://a', protocol: 'soap', apiKeySealed: 'x' },
          { id: 'cp-bad2', label: 'B', baseUrl: 'https://b', protocol: 'openai' },
          { id: 'cp-ok', label: 'C', baseUrl: 'https://c', protocol: 'anthropic', apiKeySealed: 'cipher', createdAt: 5 }
        ]
      }),
      'utf8'
    )
    const list = loadHubStore(ud).customProviders ?? []
    expect(list.map((p) => p.id)).toEqual(['cp-ok'])
    expect(list[0].createdAt).toBe(5)
  })

  it('saveHubStore/loadHubStore 往返：供应商与档案一起落盘', () => {
    const ud = mkTmp()
    const store = loadHubStore(ud)
    store.customProviders = []
    saveHubStore(ud, store)
    upsertCustomProvider(ud, mkInput({ label: '往返' }), sampleKey('rt'), fakeSealer())
    const back = loadHubStore(ud)
    expect(findCustomProvider(back, back.customProviders![0].id)?.label).toBe('往返')
  })
})

describe('自定义供应商校验', () => {
  it('名称/地址/协议逐项校验，文案指出要改哪里', () => {
    expect(validateCustomProviderInput(mkInput({ label: '  ' }))).toContain('名称')
    expect(validateCustomProviderInput(mkInput({ baseUrl: '' }))).toContain('API 地址')
    expect(validateCustomProviderInput(mkInput({ baseUrl: 'ftp://x' }))).toContain('http://')
    expect(validateCustomProviderInput(mkInput({ protocol: 'soap' as never }))).toContain('接口格式')
    expect(validateCustomProviderInput(mkInput())).toBeNull()
  })

  it('校验失败时 upsert 抛错且不落盘', () => {
    const ud = mkTmp()
    expect(() => upsertCustomProvider(ud, mkInput({ baseUrl: 'nope' }), sampleKey('x'), fakeSealer())).toThrow('API 地址')
    expect(fs.existsSync(apiHubStoreFile(ud))).toBe(false)
  })

  it('新增时 API Key 为空 → 抛错；编辑不存在 → 抛错', () => {
    const ud = mkTmp()
    expect(() => upsertCustomProvider(ud, mkInput(), '', fakeSealer())).toThrow('API Key 不能为空')
    expect(() => upsertCustomProvider(ud, mkInput({ id: 'cp-nope' }), sampleKey('y'), fakeSealer())).toThrow('找不到要编辑的供应商')
  })
})

describe('档案另存为自定义供应商', () => {
  it('密钥密文原样转存（明文一次都不出现），地址/模型/接口格式按档案字段映射', () => {
    const ud = mkTmp()
    const key = sampleKey('profile')
    const profile = upsertHubProfile(
      ud,
      {
        adapterId: 'kimi',
        name: '我的 Kimi 中转',
        fields: { providerId: 'myprov', modelId: 'kimi-k3', baseUrl: 'https://kimi.example/v1', type: 'anthropic' }
      },
      key,
      fakeSealer()
    )
    const p = customProviderFromProfile(ud, 'kimi', profile.id, undefined, fakeSealer())
    expect(p.apiKeySealed).toBe(profile.apiKeySealed)
    expect(hubDecryptKey(p, fakeSealer())).toBe(key)
    expect(p.baseUrl).toBe('https://kimi.example/v1')
    expect(p.defaultModel).toBe('kimi-k3')
    expect(p.protocol).toBe('anthropic')
    expect(p.label).toBe('我的 Kimi 中转')
    expect(loadHubStore(ud).customProviders).toHaveLength(1)
  })

  it('zcode 的 baseURL 字段名与 kind 也能识别', () => {
    const ud = mkTmp()
    const profile = upsertHubProfile(
      ud,
      { adapterId: 'zcode', name: 'Z', fields: { providerId: 'z', providerName: 'Z', baseURL: 'https://z.example/api/anthropic', kind: 'anthropic' } },
      sampleKey('z'),
      fakeSealer()
    )
    const p = customProviderFromProfile(ud, 'zcode', profile.id, '另存名', fakeSealer())
    expect(p.baseUrl).toBe('https://z.example/api/anthropic')
    expect(p.protocol).toBe('anthropic')
    expect(p.label).toBe('另存名')
  })

  it('档案没有地址 / 档案不存在 → 抛错（不生成一条没用的供应商）', () => {
    const ud = mkTmp()
    expect(() => customProviderFromProfile(ud, 'claude-cli', 'ah-none', undefined, fakeSealer())).toThrow('找不到要另存的档案')
    const profile = upsertHubProfile(
      ud,
      { adapterId: 'claude-cli', name: '没地址', fields: {} },
      sampleKey('noaddr'),
      fakeSealer()
    )
    expect(() => customProviderFromProfile(ud, 'claude-cli', profile.id, undefined, fakeSealer())).toThrow('没有填 API 地址')
  })
})
