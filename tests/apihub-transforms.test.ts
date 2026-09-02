// 接口中心 transforms 测试：fixtures 全部为运行时生成的假 key（sampleKey），真实配置零接触。
import { describe, expect, it } from 'vitest'
import {
  claudeApplyEnv,
  claudeParseEnv,
  claudeVerify,
  codexApplyAuth,
  codexApplyConfig,
  codexParseAuth,
  codexParseConfig,
  codexVerify,
  grokApply,
  grokParse,
  grokVerify,
  kimiApplyConfig,
  tomlSetKey,
  zcodeApplyConfig,
  zcodeApplySetting,
  zcodeDeriveSelectedForm,
  zcodeParse,
  zcodeVerify
} from '../src/main/apihub/transforms'
import { tomlAssign } from '../src/main/kimi/tomlEdit'

/** 运行时生成假样本密钥（仅测试用途，非真实凭据） */
function sampleKey(kind: string): string {
  return ['test', 'sample', kind, Math.random().toString(36).slice(2, 6)].join('-')
}

const K1 = sampleKey('claude-a')
const K2 = sampleKey('claude-b')
const K3 = sampleKey('codex-a')
const K4 = sampleKey('codex-b')
const K5 = sampleKey('grok-a')
const K6 = sampleKey('grok-b')
const K7 = sampleKey('zcode-a')
const K8 = sampleKey('zcode-b')

const CLAUDE_SETTINGS = [
  '{',
  '  "model": "opus",',
  '  "env": {',
  '    "ANTHROPIC_BASE_URL": "http://127.0.0.1:15721",',
  '    "ANTHROPIC_AUTH_TOKEN": ' + JSON.stringify(K1),
  '  },',
  '  "includeCoAuthoredBy": false',
  '}'
].join('\n')

const CODEX_AUTH = JSON.stringify({ OPENAI_API_KEY: K3, auth_mode: 'apikey' }, null, 2)

const CODEX_CONFIG = [
  'model_provider = "custom"',
  'model = "gpt-5.6-sol"',
  'disable_response_storage = true',
  '',
  '[model_providers.custom]',
  'name = "micu"',
  'base_url = "https://www.micuapi.ai/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  '',
  '[marketplaces.openai-primary-runtime]',
  'source_type = "local"',
  '',
  '[plugins."documents@openai-primary-runtime"]',
  'enabled = true',
  ''
].join('\n')

const GROK_CONFIG = [
  '[models]',
  'default = "grok-4.6"',
  '',
  '[model."grok-4.6"]',
  'model = "grok-4.6"',
  'base_url = "https://www.micuapi.ai/v1"',
  'name = "Micu"',
  'api_backend = "responses"',
  'context_window = 500000',
  tomlAssign('api_key', K5),
  '',
  '[marketplace]',
  'default_skills_installs_purged = true',
  '',
  '[ui]',
  'max_thoughts_width = 120',
  '',
  '[cli]',
  'installer = "internal"',
  ''
].join('\n')

const ZCODE_CONFIG = JSON.stringify({
  provider: {
    'builtin:plan-a': {
      name: 'Plan A',
      kind: 'anthropic',
      options: { apiKey: K7, baseURL: 'https://open.bigmodel.cn/api/anthropic' },
      enabled: true,
      source: 'custom'
    },
    'builtin:plan-b': {
      name: 'Plan B',
      kind: 'anthropic',
      options: { apiKey: K8, baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic' },
      enabled: false,
      source: 'custom'
    }
  }
}) + '\n'

const ZCODE_SETTING = JSON.stringify({
  modelProviderFamilySelectedKeys: { bigmodel: 'coding-plan:builtin:builtin:plan-a', zai: 'coding-plan:builtin:zai-x' },
  providerFamilyDomain: 'bigmodel'
}) + '\n'

// ---------- claude ----------

describe('transforms: claude env', () => {
  it('parse 读取 baseUrl 与 key 尾 4 位（绝无全值）', () => {
    const d = claudeParseEnv(CLAUDE_SETTINGS)
    expect(d.baseUrl).toBe('http://127.0.0.1:15721')
    expect(d.keyTail).toBe(K1.slice(-4))
    expect(d.keyLen).toBe(K1.length)
    expect(JSON.stringify(d)).not.toContain(K1)
  })

  it('apply 改写两键且其余键与顺序保留', () => {
    const next = claudeApplyEnv(CLAUDE_SETTINGS, 'https://api.new.com', K2)
    const obj = JSON.parse(next)
    expect(Object.keys(obj)).toEqual(['model', 'env', 'includeCoAuthoredBy'])
    expect(obj.env.ANTHROPIC_BASE_URL).toBe('https://api.new.com')
    expect(obj.env.ANTHROPIC_AUTH_TOKEN).toBe(K2)
    expect(obj.model).toBe('opus')
    expect(obj.includeCoAuthoredBy).toBe(false)
  })

  it('apply 在 env 缺失时创建', () => {
    const next = claudeApplyEnv('{"theme":"dark"}', 'https://api.new.com', K2)
    expect(JSON.parse(next).env.ANTHROPIC_AUTH_TOKEN).toBe(K2)
    expect(JSON.parse(next).theme).toBe('dark')
  })

  it('verify 通过与失败两态', () => {
    const next = claudeApplyEnv(CLAUDE_SETTINGS, 'https://api.new.com', K2)
    expect(() => claudeVerify(next, 'https://api.new.com', K2)).not.toThrow()
    expect(() => claudeVerify(next, 'https://other.com', K2)).toThrow(/BASE_URL/)
  })
})

// ---------- codex ----------

describe('transforms: codex 双文件', () => {
  it('parseAuth 读取尾 4 位与 authMode（绝无全值）', () => {
    const d = codexParseAuth(CODEX_AUTH)
    expect(d.keyTail).toBe(K3.slice(-4))
    expect(d.authMode).toBe('apikey')
    expect(JSON.stringify(d)).not.toContain(K3)
  })

  it('applyAuth 改写两键保留其余', () => {
    const next = codexApplyAuth(CODEX_AUTH, K4)
    const obj = JSON.parse(next)
    expect(obj.OPENAI_API_KEY).toBe(K4)
    expect(obj.auth_mode).toBe('apikey')
  })

  it('parseConfig 读取 model_provider 与 provider 块', () => {
    const d = codexParseConfig(CODEX_CONFIG)
    expect(d.modelProvider).toBe('custom')
    expect(d.baseUrl).toBe('https://www.micuapi.ai/v1')
    expect(d.wireApi).toBe('responses')
  })

  it('applyConfig 切换 provider：复合键段零改动', () => {
    const next = codexApplyConfig(CODEX_CONFIG, 'deepseek', 'https://api.deepseek.com/v1', 'chat')
    expect(next).toContain('model_provider = "deepseek"')
    expect(next).toContain('[model_providers.deepseek]')
    expect(next).toContain('base_url = "https://api.deepseek.com/v1"')
    expect(next).toContain('wire_api = "chat"')
    expect(next).toContain('[plugins."documents@openai-primary-runtime"]')
    expect(next).toContain('[marketplaces.openai-primary-runtime]')
    expect(next).toContain('model = "gpt-5.6-sol"')
  })

  it('applyConfig 对既有同 id 块为替换而非追加', () => {
    const once = codexApplyConfig(CODEX_CONFIG, 'custom', 'https://api.other.com/v1', 'chat')
    expect((once.match(/\[model_providers\.custom\]/g) ?? []).length).toBe(1)
    expect(once).toContain('base_url = "https://api.other.com/v1"')
  })

  it('verify 通过与失败两态', () => {
    const auth = codexApplyAuth(CODEX_AUTH, K4)
    const cfg = codexApplyConfig(CODEX_CONFIG, 'deepseek', 'https://api.deepseek.com/v1', 'chat')
    expect(() => codexVerify(auth, cfg, 'deepseek', 'https://api.deepseek.com/v1', K4)).not.toThrow()
    expect(() => codexVerify(auth, cfg, 'deepseek', 'https://api.deepseek.com/v1', sampleKey('codex-wrong'))).toThrow(/尾 4 位/)
  })
})

// ---------- grok ----------

describe('transforms: grok config.toml', () => {
  it('parse 读取 default/块字段/key 尾 4 位（绝无全值）', () => {
    const d = grokParse(GROK_CONFIG)
    expect(d.defaultModel).toBe('grok-4.6')
    expect(d.modelId).toBe('grok-4.6')
    expect(d.baseUrl).toBe('https://www.micuapi.ai/v1')
    expect(d.name).toBe('Micu')
    expect(d.contextWindow).toBe(500000)
    expect(d.keyTail).toBe(K5.slice(-4))
    expect(JSON.stringify(d)).not.toContain(K5)
  })

  it('apply 替换既有块并保留 [ui]/[cli]/[marketplace]', () => {
    const next = grokApply(GROK_CONFIG, { modelId: 'grok-x', baseUrl: 'https://api.x.com/v1', name: 'X', apiBackend: 'chat', contextWindow: 262144 }, K6)
    expect(next).toContain('default = "grok-x"')
    expect(next).toContain('[model."grok-x"]')
    expect(next).toContain('base_url = "https://api.x.com/v1"')
    expect(next).toContain(tomlAssign('api_key', K6))
    expect(next).toContain('[ui]\nmax_thoughts_width = 120')
    expect(next).toContain('[cli]\ninstaller = "internal"')
    expect(next).toContain('[marketplace]')
    expect(next).not.toContain('grok-4.6')
    expect(next).not.toContain(K5)
  })

  it('apply 对空文本可从零构建', () => {
    const next = grokApply('', { modelId: 'grok-x', baseUrl: 'https://api.x.com/v1', name: 'X', apiBackend: 'responses', contextWindow: 131072 }, K6)
    expect(grokParse(next).defaultModel).toBe('grok-x')
  })

  it('verify 通过与失败两态', () => {
    const next = grokApply(GROK_CONFIG, { modelId: 'grok-x', baseUrl: 'https://api.x.com/v1', name: 'X', apiBackend: 'chat', contextWindow: 262144 }, K6)
    expect(() => grokVerify(next, { modelId: 'grok-x', baseUrl: 'https://api.x.com/v1' }, K6)).not.toThrow()
    expect(() => grokVerify(next, { modelId: 'grok-x', baseUrl: 'https://api.x.com/v1' }, sampleKey('grok-wrong'))).toThrow(/尾 4 位/)
  })
})

// ---------- zcode ----------

describe('transforms: zcode 双文件', () => {
  it('parse 读取 providers/selected/knownForms（key 绝无全值）', () => {
    const d = zcodeParse(ZCODE_CONFIG, ZCODE_SETTING)
    expect(d.providers.length).toBe(2)
    expect(d.selected).toBe('coding-plan:builtin:builtin:plan-a')
    expect(d.knownForms).toContain('coding-plan:builtin:zai-x')
    expect(d.providers[0].keyTail).toBe(K7.slice(-4))
    expect(JSON.stringify(d)).not.toContain(K7)
  })

  it('applyConfig upsert 新条目且保留既有条目', () => {
    const next = zcodeApplyConfig(ZCODE_CONFIG, { providerId: 'custom-x', providerName: 'Custom X', baseURL: 'https://x/api/anthropic', kind: 'anthropic' }, sampleKey('zcode-new'))
    const obj = JSON.parse(next)
    expect(obj.provider['custom-x'].options.baseURL).toBe('https://x/api/anthropic')
    expect(obj.provider['custom-x'].enabled).toBe(true)
    expect(obj.provider['builtin:plan-a'].name).toBe('Plan A')
  })

  it('applySetting 写 bigmodel 选中且保留其余键', () => {
    const next = zcodeApplySetting(ZCODE_SETTING, 'coding-plan:builtin:custom-x')
    const obj = JSON.parse(next)
    expect(obj.modelProviderFamilySelectedKeys.bigmodel).toBe('coding-plan:builtin:custom-x')
    expect(obj.modelProviderFamilySelectedKeys.zai).toBe('coding-plan:builtin:zai-x')
    expect(obj.providerFamilyDomain).toBe('bigmodel')
  })

  it('selectedKey 形态派生：命中复用 / 缺省构造', () => {
    expect(zcodeDeriveSelectedForm(['coding-plan:builtin:zai-x', 'oauth:builtin:custom-x'], 'custom-x')).toBe('oauth:builtin:custom-x')
    expect(zcodeDeriveSelectedForm(['coding-plan:builtin:zai-x'], 'custom-x')).toBe('coding-plan:builtin:custom-x')
  })

  it('verify 通过与失败两态', () => {
    const nk = sampleKey('zcode-new')
    const cfg = zcodeApplyConfig(ZCODE_CONFIG, { providerId: 'custom-x', providerName: 'X', baseURL: 'https://x/api/anthropic', kind: 'anthropic' }, nk)
    const st = zcodeApplySetting(ZCODE_SETTING, 'coding-plan:builtin:custom-x')
    expect(() => zcodeVerify(cfg, st, 'custom-x', 'https://x/api/anthropic', 'coding-plan:builtin:custom-x', nk)).not.toThrow()
    expect(() => zcodeVerify(cfg, st, 'custom-x', 'https://x/api/anthropic', 'coding-plan:builtin:custom-x', sampleKey('zcode-wrong'))).toThrow(/尾 4 位/)
  })
})

// ---------- tomlSetKey ----------

describe('transforms: tomlSetKey', () => {
  it('顶层既有键替换', () => {
    expect(tomlSetKey('a = 1\nmodel_provider = "x"\n', null, 'model_provider', 'y')).toContain('model_provider = "y"')
  })
  it('顶层缺键插到首个节头前', () => {
    const out = tomlSetKey('[s]\nk = 1\n', null, 'model_provider', 'y')
    expect(out.startsWith('model_provider = "y"')).toBe(true)
  })
  it('节内既有键替换、缺键追加、整节缺失创建', () => {
    const text = '[models]\ndefault = "a"\n\n[ui]\nk = 1\n'
    expect(tomlSetKey(text, '[models]', 'default', 'b')).toContain('default = "b"')
    expect(tomlSetKey(text, '[models]', 'extra', 'v')).toContain('extra = "v"')
    const created = tomlSetKey(text, '[fresh]', 'k', 'v')
    expect(created).toContain('[fresh]')
    expect(created).toContain('k = "v"')
  })
  it('CRLF 语义保持', () => {
    const crlf = 'model_provider = "a"\r\n[ui]\r\nk = 1\r\n'
    const out = tomlSetKey(crlf, null, 'model_provider', 'b')
    expect(out).toContain('\r\n')
    expect(out).not.toContain('\n\n')
    // 回归：split('\n') 拆 CRLF 会留 '\r' 尾巴，join('\r\n') 后变 '\r\r\n' 损坏全文件（Codex CLI 随即无法解析）
    expect(out).not.toContain('\r\r')
    expect(out).toBe('model_provider = "b"\r\n[ui]\r\nk = 1\r\n')
  })
  it('CRLF 节内替换同样不产生 \\r\\r', () => {
    const crlf = '[thinking]\r\nenabled = false\r\nother = 1\r\n'
    const out = tomlSetKey(crlf, '[thinking]', 'other', '2')
    expect(out).not.toContain('\r\r')
    expect(out).toBe('[thinking]\r\nenabled = false\r\nother = "2"\r\n')
  })
})

// ---------- CRLF 回归：codex/grok/kimi 的完整改写链路 ----------

describe('transforms: CRLF 文件改写不损坏（回归）', () => {
  it('codexApplyConfig：CRLF config.toml 改写后每行仍是 \\r\\n（绝无 \\r\\r）', () => {
    const K = sampleKey('crlf-codex')
    const crlf = ['model_provider = "old"\r\n', '\r\n', '[model_providers.old]\r\n', 'name = "old"\r\n', 'base_url = "https://old/v1"\r\n', 'wire_api = "chat"\r\n'].join('')
    const out = codexApplyConfig(crlf, 'deepseek', 'https://api.deepseek.com/v1', 'responses')
    expect(out).not.toContain('\r\r')
    // 校验链路可读回（旧 bug 下 codexVerify 靠 trim 吃掉 \r 而侥幸通过，文件已损坏）
    expect(() => codexVerify(JSON.stringify({ OPENAI_API_KEY: K, auth_mode: 'apikey' }), out, 'deepseek', 'https://api.deepseek.com/v1', K)).not.toThrow()
  })

  it('grokApply：CRLF config.toml 切换 model 后绝无 \\r\\r（removeBlock 旧 bug 回归）', () => {
    const K = sampleKey('crlf-grok')
    const crlf = [
      '[models]\r\n',
      'default = "old-model"\r\n',
      '\r\n',
      '[model."old-model"]\r\n',
      'model = "old-model"\r\n',
      'base_url = "https://old/v1"\r\n',
      'name = "Old"\r\n',
      'api_backend = "responses"\r\n',
      'context_window = 100000\r\n',
      'api_key = "' + K + '"\r\n'
    ].join('')
    const out = grokApply(crlf, { modelId: 'grok-new', baseUrl: 'https://api.new/v1', name: 'New', apiBackend: 'chat', contextWindow: 262144 }, sampleKey('crlf-grok-new'))
    expect(out).not.toContain('\r\r')
    // 旧块（含旧 key）必须被整块移除，不能残留过期凭据
    expect(out).not.toContain(K)
    expect(out).not.toContain('[model."old-model"]')
  })

  it('kimiApplyConfig：[thinking] 键级改写保留块内未知键（整块替换旧 bug 回归）', () => {
    const K = sampleKey('kimi-thinking')
    const text = [
      '[thinking]',
      'enabled = false',
      'budget_tokens = 4096',
      '',
      '[providers.kimi]',
      'type = "openai"',
      'base_url = "https://old/v1"',
      'api_key = "old-key"',
      ''
    ].join('\n')
    const out = kimiApplyConfig(text, {
      providerId: 'kimi',
      modelId: 'kimi-k3',
      baseUrl: 'https://api.new/v1',
      type: 'openai',
      modelDisplay: 'Kimi K3',
      maxContext: 131072,
      capabilities: ['thinking'],
      thinkingEnabled: true
    }, K)
    expect(out).toContain('enabled = true')
    // 用户手工加的键必须原样保留
    expect(out).toContain('budget_tokens = 4096')
    expect(out).toContain('[thinking]')
  })
})
