// 接口中心运行时测试：store 档案库（seal 往返/视图脱敏/plainStore 降级/编辑留空/删除清 active/损坏回落）
// + apihubSwitch 骨架（临时目录真 fs + fake sealer + 固定时钟：各适配器写入/备份命名/zcode blocked 语义/校验失败逐字节回滚）
// + apihubReadCurrent 脱敏红线与命中档案 / N/A 适配器。
// 假 key 一律运行时 sampleKey 生成（绝不写真凭据字面量）；临时写入一律经 writeTmp 受控守卫（resolve 后必须仍位于临时根内）；
// fixtures 零模板字面量拼内容（显式 '+' 拼接 / JSON.stringify / tomlAssign），真实配置零接触。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apihubImportCurrent, apihubReadCurrent, apihubSwitch, type ApiHubDeps } from '../src/main/apihub'
import {
  apiHubStoreFile,
  deleteHubProfile,
  emptyHubStore,
  hubDecryptKey,
  hubProfileView,
  listHubViews,
  loadHubStore,
  saveHubStore,
  upsertHubProfile
} from '../src/main/apihub/store'
import type { KimiSealer } from '../src/main/kimi/profiles'
import { tomlAssign } from '../src/main/kimi/tomlEdit'
import type { ApiHubProfileInput, ApiHubSwitchResult, ApiHubSwitchStart } from '../src/shared/types'

/** 运行时生成假样本密钥（仅测试用途，非真实凭据） */
function sampleKey(kind: string): string {
  return ['test', 'sample', kind, Math.random().toString(36).slice(2, 6)].join('-')
}

/** fake sealer：enc1: 前缀 + base64（与 kimi-switcher 测试同款语义） */
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

/** 固定时钟：备份名可精确断言（bak_20260902_120000） */
const FIXED = new Date(2026, 8, 2, 12, 0, 0)

/** 临时目录受控写入：拼接后必须仍位于 dir 内（防路径逃逸，红线双保险） */
function writeTmp(dir: string, name: string, content: string): string {
  const target = dir + path.sep + name
  const base = path.resolve(dir) + path.sep
  if (!target.startsWith(base)) throw new Error('临时写入越界: ' + name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  return target
}

/** 临时目录受控读取：同样要求目标在 dir 内 */
function readTmp(dir: string, name: string): string {
  const target = dir + path.sep + name
  const base = path.resolve(dir) + path.sep
  if (!target.startsWith(base)) throw new Error('临时读取越界: ' + name)
  return fs.readFileSync(target, 'utf8')
}

// ---------- fixtures（全部运行时假 key；内容行显式拼接，零模板字面量） ----------

const K1 = sampleKey('claude-cur')
const K2 = sampleKey('claude-prof')
const K3 = sampleKey('codex-cur')
const K4 = sampleKey('codex-prof')
const K5 = sampleKey('grok-cur')
const K6 = sampleKey('grok-prof')
const K7 = sampleKey('zcode-cur')
const K8 = sampleKey('zcode-prof')

function claudeSettings(k: string): string {
  return [
    '{',
    '  "model": "opus",',
    '  "env": {',
    '    "ANTHROPIC_BASE_URL": "http://127.0.0.1:15721",',
    '    "ANTHROPIC_AUTH_TOKEN": ' + JSON.stringify(k),
    '  },',
    '  "includeCoAuthoredBy": false',
    '}'
  ].join('\n')
}

function codexAuth(k: string): string {
  return JSON.stringify({ OPENAI_API_KEY: k, auth_mode: 'apikey' }, null, 2)
}

const codexConfig = [
  'model_provider = "custom"',
  'model = "gpt-5.6-sol"',
  '',
  '[model_providers.custom]',
  'name = "micu"',
  'base_url = "https://www.micuapi.ai/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  '',
  '[plugins."documents@openai"]',
  'enabled = true',
  ''
].join('\n')

function grokConfig(k: string): string {
  return [
    '[models]',
    'default = "grok-4.6"',
    '',
    '[model."grok-4.6"]',
    'model = "grok-4.6"',
    'base_url = "https://www.micuapi.ai/v1"',
    'name = "Micu"',
    'api_backend = "responses"',
    'context_window = 500000',
    tomlAssign('api_key', k),
    '',
    '[ui]',
    'max_thoughts_width = 120',
    '',
    '[cli]',
    'installer = "internal"',
    ''
  ].join('\n')
}

function zcodeConfig(kSel: string, kOther: string, idA = 'plan-a', idB = 'plan-b'): string {
  return JSON.stringify({
    provider: {
      // 缺省 id 不含冒号；真机形态（builtin:xxx，id 本身含冒号）由用例显式传入
      [idA]: {
        name: 'Plan A',
        kind: 'anthropic',
        options: { apiKey: kSel, baseURL: 'https://open.bigmodel.cn/api/anthropic' },
        enabled: true,
        source: 'custom'
      },
      [idB]: {
        name: 'Plan B',
        kind: 'anthropic',
        options: { apiKey: kOther, baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic' },
        enabled: false,
        source: 'custom'
      }
    }
  }) + '\n'
}

const zcodeSetting = JSON.stringify({
  modelProviderFamilySelectedKeys: { bigmodel: 'coding-plan:builtin:plan-a', zai: 'coding-plan:builtin:zai-x' },
  providerFamilyDomain: 'bigmodel'
}) + '\n'

/** 真机形态 selected：家族前缀 + ':' + providerId（providerId 自身含冒号） */
const zcodeSettingColonId = JSON.stringify({
  modelProviderFamilySelectedKeys: { bigmodel: 'coding-plan:builtin:builtin:plan-a', zai: 'coding-plan:builtin:zai-x' },
  providerFamilyDomain: 'bigmodel'
}) + '\n'

const ZCODE_FIELDS_EXPLICIT: Record<string, string> = {
  providerId: 'custom-x',
  providerName: 'Custom X',
  baseURL: 'https://x/api/anthropic',
  kind: 'anthropic',
  selectedKeyForm: 'coding-plan:builtin:custom-x'
}

const ZCODE_FIELDS_DERIVE: Record<string, string> = {
  providerId: 'custom-x',
  providerName: 'Custom X',
  baseURL: 'https://x/api/anthropic',
  kind: 'anthropic'
}

// ---------- 环境 ----------

let ud = ''
let home = ''

beforeEach(() => {
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'apihub-rt-ud-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'apihub-rt-home-'))
})

afterEach(() => {
  fs.rmSync(ud, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

function deps(overrides: Partial<ApiHubDeps> = {}): ApiHubDeps {
  return {
    homeDir: home,
    userDataDir: ud,
    sealer: fakeSealer(),
    clock: () => FIXED,
    zcodeRunning: async () => false,
    ...overrides
  }
}

function mkInput(adapterId: ApiHubProfileInput['adapterId'], name: string, fields: Record<string, string>): ApiHubProfileInput {
  return { adapterId, name, fields }
}

// ---------- store 档案库 ----------

describe('apihub store 档案库', () => {
  it('upsert + seal 往返：入库为密文，读回解密一致，绝不落明文', () => {
    const p = upsertHubProfile(ud, mkInput('claude-cli', 'Micu', { baseUrl: 'https://api.micu.com' }), K2, fakeSealer())
    const saved = loadHubStore(ud).byAdapter['claude-cli'] ?? []
    expect(saved).toHaveLength(1)
    expect(saved[0].apiKeySealed).not.toBe(K2)
    expect(saved[0].apiKeySealed).not.toContain(K2)
    expect(hubDecryptKey(saved[0], fakeSealer())).toBe(K2)
    expect(p.id).toBe(saved[0].id)
  })

  it('视图脱敏：只含尾 4 位与长度，绝无全值与密文', () => {
    const p = upsertHubProfile(ud, mkInput('claude-cli', 'Micu', { baseUrl: 'https://api.micu.com' }), K2, fakeSealer())
    const views = listHubViews(loadHubStore(ud), 'claude-cli', fakeSealer())
    expect(views).toHaveLength(1)
    expect(views[0].apiKeyTail).toBe(K2.slice(-4))
    expect(views[0].apiKeyLen).toBe(K2.length)
    const s = JSON.stringify(views)
    expect(s).not.toContain(K2)
    expect(s).not.toContain(p.apiKeySealed)
  })

  it('视图解密失败（密文不来自本机）：tail/len 如实回 null，不抛不伪造', () => {
    upsertHubProfile(ud, mkInput('claude-cli', 'Micu', { baseUrl: 'https://api.micu.com' }), K2, fakeSealer())
    const broken: KimiSealer = {
      isEncryptionAvailable: () => true,
      encrypt: (x) => Buffer.from(x, 'utf8').toString('base64'),
      decrypt: () => {
        throw new Error('DPAPI 失效')
      }
    }
    const views = listHubViews(loadHubStore(ud), 'claude-cli', broken)
    expect(views[0].apiKeyTail).toBeNull()
    expect(views[0].apiKeyLen).toBeNull()
  })

  it('plainStore 降级：无 DPAPI 时 base64 落盘带标记，读回一致', () => {
    const p = upsertHubProfile(
      ud,
      mkInput('codex', 'DS', { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'chat' }),
      K4,
      fakeSealer(false)
    )
    expect(p.plainStore).toBe(true)
    const saved = (loadHubStore(ud).byAdapter['codex'] ?? [])[0]
    expect(saved.plainStore).toBe(true)
    expect(saved.apiKeySealed).not.toContain(K4)
    expect(hubDecryptKey(saved, fakeSealer(false))).toBe(K4)
    const v = hubProfileView(saved, fakeSealer(false))
    expect(v.plainStore).toBe(true)
    expect(v.apiKeyTail).toBe(K4.slice(-4))
  })

  it('编辑留空 = 不改 key：sealed 原样保留；填新 key 则重 seal；目录不重复', () => {
    const fieldsB: Record<string, string> = { modelId: 'grok-y', baseUrl: 'https://y/v1', apiBackend: 'chat', contextWindow: '262144' }
    const a = upsertHubProfile(
      ud,
      mkInput('grok', 'G1', { modelId: 'grok-x', baseUrl: 'https://x/v1', apiBackend: 'chat', contextWindow: '262144' }),
      K6,
      fakeSealer()
    )
    const b = upsertHubProfile(ud, { id: a.id, adapterId: 'grok', name: 'G1 改名', fields: fieldsB }, '', fakeSealer())
    expect(b.apiKeySealed).toBe(a.apiKeySealed)
    expect(hubDecryptKey(b, fakeSealer())).toBe(K6)
    const c = upsertHubProfile(ud, { id: a.id, adapterId: 'grok', name: 'G1', fields: fieldsB }, K5, fakeSealer())
    expect(c.apiKeySealed).not.toBe(a.apiKeySealed)
    expect(hubDecryptKey(c, fakeSealer())).toBe(K5)
    expect(loadHubStore(ud).byAdapter['grok']).toHaveLength(1)
  })

  it('删除非生效档案保留 active；删除生效档案清 active；删除不存在抛错', () => {
    const a = upsertHubProfile(ud, mkInput('claude-cli', 'A', { baseUrl: 'https://a.com' }), sampleKey('claude-del-a'), fakeSealer())
    const b = upsertHubProfile(ud, mkInput('claude-cli', 'B', { baseUrl: 'https://b.com' }), sampleKey('claude-del-b'), fakeSealer())
    const st1 = loadHubStore(ud)
    st1.activeByAdapter['claude-cli'] = a.id
    saveHubStore(ud, st1)
    // 删非生效 → active 保持
    const st2 = deleteHubProfile(ud, 'claude-cli', b.id)
    expect(st2.activeByAdapter['claude-cli']).toBe(a.id)
    // 删生效 → active 清空
    const st3 = deleteHubProfile(ud, 'claude-cli', a.id)
    expect(st3.activeByAdapter['claude-cli']).toBeNull()
    expect(() => deleteHubProfile(ud, 'claude-cli', a.id)).toThrow('找不到要删除的档案')
  })

  it('损坏/版本不符回落空库；active 指向缺失档案被剔除', () => {
    fs.writeFileSync(apiHubStoreFile(ud), 'not-json-at-all', 'utf8')
    expect(loadHubStore(ud)).toEqual(emptyHubStore())
    fs.writeFileSync(apiHubStoreFile(ud), JSON.stringify({ version: 99, byAdapter: {}, activeByAdapter: {} }), 'utf8')
    expect(loadHubStore(ud)).toEqual(emptyHubStore())
    // active 指向已被删除的档案：档案保留、active 剔除
    const seeded = {
      version: 1,
      byAdapter: {
        'claude-cli': [{ id: 'ah-x', adapterId: 'claude-cli', name: 'X', fields: { baseUrl: 'https://x.com' }, apiKeySealed: fakeSealer().encrypt(K2) }]
      },
      activeByAdapter: { 'claude-cli': 'ah-gone' }
    }
    fs.writeFileSync(apiHubStoreFile(ud), JSON.stringify(seeded), 'utf8')
    const st = loadHubStore(ud)
    expect((st.byAdapter['claude-cli'] ?? []).map((p) => p.id)).toEqual(['ah-x'])
    expect(st.activeByAdapter['claude-cli'] ?? null).toBeNull()
  })
})

// ---------- apihubSwitch 骨架（临时目录演练） ----------

describe('apihubSwitch 骨架（临时目录演练）', () => {
  it('claude：写入正确 + 备份命名 bak_20260902_120000 + active 登记 + 无 tmp 残留', async () => {
    writeTmp(home, path.join('.claude', 'settings.json'), claudeSettings(K1))
    const p = upsertHubProfile(ud, mkInput('claude-cli', 'New', { baseUrl: 'https://api.new.com' }), K2, fakeSealer())
    const before = readTmp(home, path.join('.claude', 'settings.json'))
    const r = (await apihubSwitch('claude-cli', p.id, deps())) as ApiHubSwitchResult
    expect(r.backupFiles).toHaveLength(1)
    expect(path.basename(r.backupFiles[0])).toBe('settings.json.bak_20260902_120000')
    expect(fs.readFileSync(r.backupFiles[0], 'utf8')).toBe(before)
    const obj = JSON.parse(readTmp(home, path.join('.claude', 'settings.json')))
    expect(Object.keys(obj)).toEqual(['model', 'env', 'includeCoAuthoredBy'])
    expect(obj.env.ANTHROPIC_BASE_URL).toBe('https://api.new.com')
    expect(obj.env.ANTHROPIC_AUTH_TOKEN).toBe(K2)
    expect(obj.model).toBe('opus')
    expect(obj.includeCoAuthoredBy).toBe(false)
    expect(loadHubStore(ud).activeByAdapter['claude-cli']).toBe(p.id)
    expect(fs.readdirSync(path.join(home, '.claude')).filter((f) => f.includes('.tmp-'))).toEqual([])
    expect(JSON.stringify(r)).not.toContain(K2)
  })

  it('claude：目标缺失 → 全新建档、零备份、目录递归创建', async () => {
    const p = upsertHubProfile(ud, mkInput('claude-cli', 'New', { baseUrl: 'https://api.new.com' }), K2, fakeSealer())
    const r = (await apihubSwitch('claude-cli', p.id, deps())) as ApiHubSwitchResult
    expect(r.backupFiles).toEqual([])
    const obj = JSON.parse(readTmp(home, path.join('.claude', 'settings.json')))
    expect(obj.env.ANTHROPIC_BASE_URL).toBe('https://api.new.com')
    expect(obj.env.ANTHROPIC_AUTH_TOKEN).toBe(K2)
  })

  it('codex：双文件写入正确 + 两份备份 + 既有复合键段零改动', async () => {
    writeTmp(home, path.join('.codex', 'auth.json'), codexAuth(K3))
    writeTmp(home, path.join('.codex', 'config.toml'), codexConfig)
    const p = upsertHubProfile(
      ud,
      mkInput('codex', 'DS', { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'chat' }),
      K4,
      fakeSealer()
    )
    const beforeAuth = readTmp(home, path.join('.codex', 'auth.json'))
    const beforeCfg = readTmp(home, path.join('.codex', 'config.toml'))
    const r = (await apihubSwitch('codex', p.id, deps())) as ApiHubSwitchResult
    expect(r.backupFiles.map((f) => path.basename(f))).toEqual(['auth.json.bak_20260902_120000', 'config.toml.bak_20260902_120000'])
    expect(fs.readFileSync(r.backupFiles[0], 'utf8')).toBe(beforeAuth)
    expect(fs.readFileSync(r.backupFiles[1], 'utf8')).toBe(beforeCfg)
    const auth = JSON.parse(readTmp(home, path.join('.codex', 'auth.json')))
    expect(auth.OPENAI_API_KEY).toBe(K4)
    expect(auth.auth_mode).toBe('apikey')
    const cfg = readTmp(home, path.join('.codex', 'config.toml'))
    expect(cfg).toContain('model_provider = "deepseek"')
    expect(cfg).toContain('[model_providers.deepseek]')
    expect(cfg).toContain('base_url = "https://api.deepseek.com/v1"')
    expect(cfg).toContain('wire_api = "chat"')
    expect(cfg).toContain('[plugins."documents@openai"]')
    expect(loadHubStore(ud).activeByAdapter['codex']).toBe(p.id)
    expect(fs.readdirSync(path.join(home, '.codex')).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('grok：写入正确且 [ui]/[cli] 段零改动', async () => {
    writeTmp(home, path.join('.grok', 'config.toml'), grokConfig(K5))
    const p = upsertHubProfile(
      ud,
      mkInput('grok', 'X', { modelId: 'grok-x', baseUrl: 'https://api.x.com/v1', name: 'X', apiBackend: 'chat', contextWindow: '262144' }),
      K6,
      fakeSealer()
    )
    const r = (await apihubSwitch('grok', p.id, deps())) as ApiHubSwitchResult
    expect(r.backupFiles.map((f) => path.basename(f))).toEqual(['config.toml.bak_20260902_120000'])
    const cfg = readTmp(home, path.join('.grok', 'config.toml'))
    expect(cfg).toContain('default = "grok-x"')
    expect(cfg).toContain('[model."grok-x"]')
    expect(cfg).toContain(tomlAssign('api_key', K6))
    expect(cfg).toContain('[ui]\nmax_thoughts_width = 120')
    expect(cfg).toContain('[cli]\ninstaller = "internal"')
    expect(cfg).not.toContain(K5)
    expect(loadHubStore(ud).activeByAdapter['grok']).toBe(p.id)
  })

  it('zcode：运行中未确认 → blocked 语义，文件与档案库分毫不动', async () => {
    writeTmp(home, path.join('.zcode', 'v2', 'config.json'), zcodeConfig(K7, K8))
    writeTmp(home, path.join('.zcode', 'v2', 'setting.json'), zcodeSetting)
    const p = upsertHubProfile(ud, mkInput('zcode', 'Custom X', ZCODE_FIELDS_EXPLICIT), K6, fakeSealer())
    const beforeCfg = readTmp(home, path.join('.zcode', 'v2', 'config.json'))
    const beforeSt = readTmp(home, path.join('.zcode', 'v2', 'setting.json'))
    const r = (await apihubSwitch('zcode', p.id, deps({ zcodeRunning: async () => true }))) as ApiHubSwitchStart
    expect(r.blocked).toBe(true)
    expect(r.running).toBe(true)
    expect(r.processName).toBe('ZCode.exe')
    expect(readTmp(home, path.join('.zcode', 'v2', 'config.json'))).toBe(beforeCfg)
    expect(readTmp(home, path.join('.zcode', 'v2', 'setting.json'))).toBe(beforeSt)
    expect(loadHubStore(ud).activeByAdapter['zcode'] ?? null).toBeNull()
    expect(fs.readdirSync(path.join(home, '.zcode', 'v2')).some((f) => f.startsWith('config.json.bak_'))).toBe(false)
  })

  it('zcode：确认后（confirmed）写入正确，其余 provider 条目与 zai 选中键保留', async () => {
    writeTmp(home, path.join('.zcode', 'v2', 'config.json'), zcodeConfig(K7, K8))
    writeTmp(home, path.join('.zcode', 'v2', 'setting.json'), zcodeSetting)
    const p = upsertHubProfile(ud, mkInput('zcode', 'Custom X', ZCODE_FIELDS_EXPLICIT), K6, fakeSealer())
    const r = (await apihubSwitch('zcode', p.id, deps({ zcodeRunning: async () => true }), { confirmed: true })) as ApiHubSwitchResult
    expect(r.backupFiles).toHaveLength(2)
    const cfg = JSON.parse(readTmp(home, path.join('.zcode', 'v2', 'config.json')))
    expect(cfg.provider['custom-x'].options.baseURL).toBe('https://x/api/anthropic')
    expect(cfg.provider['custom-x'].options.apiKey).toBe(K6)
    expect(cfg.provider['custom-x'].enabled).toBe(true)
    expect(cfg.provider['plan-a'].options.apiKey).toBe(K7)
    const st = JSON.parse(readTmp(home, path.join('.zcode', 'v2', 'setting.json')))
    expect(st.modelProviderFamilySelectedKeys.bigmodel).toBe('coding-plan:builtin:custom-x')
    expect(st.modelProviderFamilySelectedKeys.zai).toBe('coding-plan:builtin:zai-x')
    expect(loadHubStore(ud).activeByAdapter['zcode']).toBe(p.id)
    expect(r.warning ?? '').toContain('重启')
  })

  it('zcode：未运行且未确认 → 直接执行（选中键形态按缺省派生）', async () => {
    writeTmp(home, path.join('.zcode', 'v2', 'config.json'), zcodeConfig(K7, K8))
    writeTmp(home, path.join('.zcode', 'v2', 'setting.json'), zcodeSetting)
    const p = upsertHubProfile(ud, mkInput('zcode', 'Custom X', ZCODE_FIELDS_DERIVE), K6, fakeSealer())
    const r = (await apihubSwitch('zcode', p.id, deps())) as ApiHubSwitchResult
    expect(r.backupFiles).toHaveLength(2)
    const st = JSON.parse(readTmp(home, path.join('.zcode', 'v2', 'setting.json')))
    expect(st.modelProviderFamilySelectedKeys.bigmodel).toBe('coding-plan:builtin:custom-x')
    expect(JSON.stringify(r)).not.toContain(K6)
  })

  it('校验失败（Proxy fs 模拟重读坏内容）：逐字节回滚后抛错，备份在场', async () => {
    writeTmp(home, path.join('.claude', 'settings.json'), claudeSettings(K1))
    const p = upsertHubProfile(ud, mkInput('claude-cli', 'New', { baseUrl: 'https://api.new.com' }), K2, fakeSealer())
    const before = fs.readFileSync(path.join(home, '.claude', 'settings.json'))
    let reads = 0
    const realReadFileSync = fs.readFileSync
    const flakyFs = new Proxy(fs, {
      get(target, prop, recv) {
        if (prop === 'readFileSync') {
          return (file: fs.PathOrFileDescriptor, ...rest: unknown[]): string | Buffer => {
            if (typeof file === 'string' && path.resolve(file) === path.resolve(home, '.claude', 'settings.json')) {
              reads++
              if (reads === 2) return '' // 第二次读 = 写盘后的重读校验，模拟读到坏内容
            }
            return (realReadFileSync as (...a: unknown[]) => string | Buffer)(file, ...rest)
          }
        }
        return Reflect.get(target, prop, recv)
      }
    }) as typeof fs
    await expect(apihubSwitch('claude-cli', p.id, deps({ fsMod: flakyFs }))).rejects.toThrow('重读校验失败')
    // 回滚：与切换前逐字节一致（Buffer 级比较）
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'))).toEqual(before)
    expect(fs.readdirSync(path.join(home, '.claude')).some((f) => f.startsWith('settings.json.bak_'))).toBe(true)
  })

  it('档案不存在：抛错且现有文件不动、无备份无 tmp', async () => {
    writeTmp(home, path.join('.claude', 'settings.json'), claudeSettings(K1))
    const before = readTmp(home, path.join('.claude', 'settings.json'))
    await expect(apihubSwitch('claude-cli', 'ah-nope', deps())).rejects.toThrow('找不到档案')
    expect(readTmp(home, path.join('.claude', 'settings.json'))).toBe(before)
    expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['settings.json'])
  })

  it('N/A 适配器不支持切换', async () => {
    await expect(apihubSwitch('deepseek', 'ah-x', deps())).rejects.toThrow('不支持切换')
  })
})

// ---------- apihubReadCurrent 脱敏红线 ----------

describe('apihubReadCurrent 脱敏红线', () => {
  it('claude：baseUrl/tail 脱敏 + 命中档案', async () => {
    writeTmp(home, path.join('.claude', 'settings.json'), claudeSettings(K1))
    const p = upsertHubProfile(ud, mkInput('claude-cli', 'Cur', { baseUrl: 'http://127.0.0.1:15721' }), K2, fakeSealer())
    const cur = await apihubReadCurrent('claude-cli', deps())
    expect(cur.available).toBe(true)
    expect(cur.baseUrl).toBe('http://127.0.0.1:15721')
    expect(cur.apiKeyTail).toBe(K1.slice(-4))
    expect(cur.apiKeyLen).toBe(K1.length)
    expect(cur.matchedProfileId).toBe(p.id)
    expect(cur.activeId).toBeNull()
    const s = JSON.stringify(cur)
    expect(s).not.toContain(K1)
    expect(s).not.toContain(K2)
  })

  it('codex：detail.modelProvider + providerId/baseUrl 双字段命中', async () => {
    writeTmp(home, path.join('.codex', 'auth.json'), codexAuth(K3))
    writeTmp(home, path.join('.codex', 'config.toml'), codexConfig)
    const p = upsertHubProfile(
      ud,
      mkInput('codex', 'Micu', { providerId: 'custom', baseUrl: 'https://www.micuapi.ai/v1', wireApi: 'responses' }),
      K4,
      fakeSealer()
    )
    const cur = await apihubReadCurrent('codex', deps())
    expect(cur.detail.modelProvider).toBe('custom')
    expect(cur.baseUrl).toBe('https://www.micuapi.ai/v1')
    expect(cur.apiKeyTail).toBe(K3.slice(-4))
    expect(cur.matchedProfileId).toBe(p.id)
    expect(JSON.stringify(cur)).not.toContain(K3)
  })

  it('grok：default/detail + 命中', async () => {
    writeTmp(home, path.join('.grok', 'config.toml'), grokConfig(K5))
    const p = upsertHubProfile(
      ud,
      mkInput('grok', 'Micu', { modelId: 'grok-4.6', baseUrl: 'https://www.micuapi.ai/v1', apiBackend: 'responses', contextWindow: '500000' }),
      K6,
      fakeSealer()
    )
    const cur = await apihubReadCurrent('grok', deps())
    expect(cur.detail.defaultModel).toBe('grok-4.6')
    expect(cur.baseUrl).toBe('https://www.micuapi.ai/v1')
    expect(cur.apiKeyTail).toBe(K5.slice(-4))
    expect(cur.matchedProfileId).toBe(p.id)
    expect(JSON.stringify(cur)).not.toContain(K5)
  })

  it('zcode：providers 数 + selected + 命中', async () => {
    writeTmp(home, path.join('.zcode', 'v2', 'config.json'), zcodeConfig(K7, K8))
    writeTmp(home, path.join('.zcode', 'v2', 'setting.json'), zcodeSetting)
    const p = upsertHubProfile(
      ud,
      mkInput('zcode', 'Plan A', { providerId: 'plan-a', providerName: 'Plan A', baseURL: 'https://open.bigmodel.cn/api/anthropic', kind: 'anthropic' }),
      K6,
      fakeSealer()
    )
    const cur = await apihubReadCurrent('zcode', deps())
    expect(cur.detail.providers.startsWith('2 条')).toBe(true)
    expect(cur.detail.selected).toBe('coding-plan:builtin:plan-a')
    expect(cur.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(cur.apiKeyTail).toBe(K7.slice(-4))
    expect(cur.matchedProfileId).toBe(p.id)
    const s = JSON.stringify(cur)
    expect(s).not.toContain(K7)
    expect(s).not.toContain(K8)
  })

  it('N/A 适配器：available=false + naReason + 无 configPaths', async () => {
    const a = await apihubReadCurrent('claude-desktop', deps())
    expect(a.available).toBe(false)
    expect((a.naReason ?? '').length).toBeGreaterThan(0)
    expect(a.configPaths).toEqual([])
    const b = await apihubReadCurrent('deepseek', deps())
    expect(b.available).toBe(false)
    expect(b.naReason ?? '').toContain('PWA')
  })

  it('zcode 真机形态：provider id 含冒号 → readCurrent 命中 + importCurrent 成功 + selectedKeyForm 取实际形态', async () => {
    writeTmp(home, path.join('.zcode', 'v2', 'config.json'), zcodeConfig(K7, K8, 'builtin:plan-a', 'builtin:plan-b'))
    writeTmp(home, path.join('.zcode', 'v2', 'setting.json'), zcodeSettingColonId)
    const cur0 = await apihubReadCurrent('zcode', deps())
    expect(cur0.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(cur0.apiKeyTail).toBe(K7.slice(-4))
    const imp = await apihubImportCurrent('zcode', deps())
    expect(imp.imported).toBe(true)
    expect(imp.profile?.fields.providerId).toBe('builtin:plan-a')
    expect(imp.profile?.fields.selectedKeyForm).toBe('coding-plan:builtin:builtin:plan-a')
    const cur1 = await apihubReadCurrent('zcode', deps())
    expect(cur1.matchedProfileId).toBe(imp.profile?.id)
    expect(cur1.activeId).toBe(imp.profile?.id)
    expect(JSON.stringify(cur1)).not.toContain(K7)
  })

  it('grok 真机形态：[model."X"] 引号节名导入成功', async () => {
    writeTmp(home, path.join('.grok', 'config.toml'), grokConfig(K5))
    const imp = await apihubImportCurrent('grok', deps())
    expect(imp.imported).toBe(true)
    expect(imp.profile?.fields.modelId).toBe('grok-4.6')
    expect(imp.profile?.fields.baseUrl).toBe('https://www.micuapi.ai/v1')
    expect(imp.profile?.fields.contextWindow).toBe('500000')
    expect(imp.profile?.fields.apiBackend).toBe('responses')
  })
})

// ---------- 回归：切换骨架的回滚正确性（backup 索引错位 / 中途写失败 / zcode knownForms / BOM） ----------

describe('apihubSwitch 回滚回归', () => {
  it('codex：auth.json 不存在 + config.toml 存在，校验失败回滚不因 backup 下标错位崩（旧 bug：TypeError 吞掉原错误）', async () => {
    // 只放 config.toml（auth.json 缺失）→ 备份只有 1 项；写盘成功后让第二个文件被外部破坏 → 校验失败进回滚
    writeTmp(home, path.join('.codex', 'config.toml'), codexConfig)
    const beforeCfg = readTmp(home, path.join('.codex', 'config.toml'))
    const p = upsertHubProfile(
      ud,
      mkInput('codex', 'DS', { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'chat' }),
      K4,
      fakeSealer()
    )
    // 拦截 renameSync：config.toml 换名后立刻破坏它（模拟另一进程覆盖），迫使 verify 失败
    const fsMod = Object.create(fs) as typeof fs
    fsMod.renameSync = ((tmp: fs.PathLike, to: fs.PathLike) => {
      fs.renameSync(tmp, to)
      if (String(to).endsWith('config.toml')) fs.writeFileSync(to, 'CORRUPTED', 'utf8')
    }) as typeof fs.renameSync
    await expect(apihubSwitch('codex', p.id, deps({ fsMod }))).rejects.toThrow('重读校验失败')
    // config.toml 必须从备份恢复为逐字节原文；auth.json 原本不存在 → 回滚后仍不存在
    expect(readTmp(home, path.join('.codex', 'config.toml'))).toBe(beforeCfg)
    expect(fs.existsSync(path.join(home, '.codex', 'auth.json'))).toBe(false)
  })

  it('codex：双文件写盘中途失败 → 已写入的 auth.json 也从备份恢复（不留新旧不匹配的配置对）', async () => {
    writeTmp(home, path.join('.codex', 'auth.json'), codexAuth(K3))
    writeTmp(home, path.join('.codex', 'config.toml'), codexConfig)
    const beforeAuth = readTmp(home, path.join('.codex', 'auth.json'))
    const beforeCfg = readTmp(home, path.join('.codex', 'config.toml'))
    const p = upsertHubProfile(
      ud,
      mkInput('codex', 'DS', { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', wireApi: 'chat' }),
      K4,
      fakeSealer()
    )
    // 第二个文件（config.toml）rename 时抛 EPERM：第一个 auth.json 已写入，必须回滚
    const fsMod = Object.create(fs) as typeof fs
    fsMod.renameSync = ((tmp: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith('config.toml')) throw new Error('EPERM: 文件被占用')
      fs.renameSync(tmp, to)
    }) as typeof fs.renameSync
    await expect(apihubSwitch('codex', p.id, deps({ fsMod }))).rejects.toThrow('EPERM')
    expect(readTmp(home, path.join('.codex', 'auth.json'))).toBe(beforeAuth)
    expect(readTmp(home, path.join('.codex', 'config.toml'))).toBe(beforeCfg)
    expect(loadHubStore(ud).activeByAdapter['codex'] ?? null).toBeNull()
  })

  it('zcode：setting.json 里的历史形态参与派生（knownForms 传空串的旧 bug：非标准形态被静默改写）', async () => {
    const settingCustom = JSON.stringify({
      modelProviderFamilySelectedKeys: { bigmodel: 'myfamily:myprov', zai: 'coding-plan:builtin:zai-x' },
      providerFamilyDomain: 'bigmodel'
    }) + '\n'
    writeTmp(home, path.join('.zcode', 'v2', 'config.json'), zcodeConfig(K7, K8))
    writeTmp(home, path.join('.zcode', 'v2', 'setting.json'), settingCustom)
    const p = upsertHubProfile(
      ud,
      mkInput('zcode', 'MyProv', { providerId: 'myprov', providerName: 'My Provider', baseURL: 'https://my/api/anthropic', kind: 'anthropic' }),
      K8,
      fakeSealer()
    )
    await apihubSwitch('zcode', p.id, deps({ zcodeRunning: async () => false })) as ApiHubSwitchResult
    const st = JSON.parse(readTmp(home, path.join('.zcode', 'v2', 'setting.json')))
    // 复用历史形态，而不是兜底公式 coding-plan:builtin:myprov
    expect(st.modelProviderFamilySelectedKeys.bigmodel).toBe('myfamily:myprov')
  })

  it('BOM：带 UTF-8 BOM 的 JSON 目标文件可正常切换（读入即剥 BOM）', async () => {
    writeTmp(home, path.join('.claude', 'settings.json'), '\uFEFF' + claudeSettings(K1))
    const p = upsertHubProfile(ud, mkInput('claude-cli', 'New', { baseUrl: 'https://api.new.com' }), K2, fakeSealer())
    const r = (await apihubSwitch('claude-cli', p.id, deps())) as ApiHubSwitchResult
    expect(r.backupFiles).toHaveLength(1)
    const obj = JSON.parse(readTmp(home, path.join('.claude', 'settings.json')))
    expect(obj.env.ANTHROPIC_BASE_URL).toBe('https://api.new.com')
  })
})
