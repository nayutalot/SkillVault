// 接口中心 kimi 适配器（旧「Kimi 接口」页合并）：
// - CATALOG/adapterPaths/字段校验
// - kimiApplyConfig/kimiVerify 纯变换（复用 kimi/tomlEdit 助手，行为对齐原 switchProfile 链路）
// - apihubSwitch kimi 骨架演练（备份命名/原子写/重读校验失败逐字节回滚）
// - readCurrent 脱敏红线 / importCurrent 字段映射 / 旧 kimi-profiles.json 自动迁移
// 假 key 一律运行时 sampleKey 生成；临时写盘一律经 writeTmp 受控守卫（resolve 后必须仍在临时根内）；
// 内容行零模板字面量（显式 '+' / tomlAssign / tomlAssignRaw / tomlHeader）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adapterPaths, apihubImportCurrent, apihubReadCurrent, apihubSwitch, API_HUB_CATALOG, kimiFieldsOf, validateHubFields, type ApiHubDeps } from '../src/main/apihub'
import { apiHubStoreFile, hubProfileView, loadHubStore, saveHubStore, upsertHubProfile } from '../src/main/apihub/store'
import { kimiApplyConfig, kimiVerify } from '../src/main/apihub/transforms'
import type { KimiSealer } from '../src/main/kimi/profiles'
import { profilesFile } from '../src/main/kimi/profiles'
import { tomlAssign, tomlAssignRaw, tomlHeader, tomlQuote } from '../src/main/kimi/tomlEdit'
import type { ApiHubSwitchResult } from '../src/shared/types'

/** 运行时生成假样本密钥（仅测试用途，非真实凭据） */
function sampleKey(kind: string): string {
  return ['test', 'sample', kind, Math.random().toString(36).slice(2, 6)].join('-')
}

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

const FIXED = new Date(2026, 8, 2, 12, 0, 0)

/** 临时目录受控写入：path.resolve 后必须仍位于 root 内（防路径逃逸，红线双保险） */
function writeTmp(root: string, rel: string, content: string): string {
  const target = path.resolve(root, rel)
  const base = path.resolve(root) + path.sep
  if (!target.startsWith(base)) throw new Error('临时写入越界: ' + rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  return target
}

function readTmp(root: string, rel: string): string {
  const target = path.resolve(root, rel)
  const base = path.resolve(root) + path.sep
  if (!target.startsWith(base)) throw new Error('临时读取越界: ' + rel)
  return fs.readFileSync(target, 'utf8')
}

// ---------- fixtures ----------

const KEY_CUR = sampleKey('kimi-cur')
const KEY_NEW = sampleKey('kimi-new')
const KEY_LEGACY = sampleKey('kimi-legacy')

const KIMI_FIELDS: Record<string, string> = {
  providerId: 'micuapi',
  modelId: 'kimi-k3',
  baseUrl: 'https://www.micuapi.ai/v1',
  type: 'openai',
  modelDisplay: 'Kimi K3',
  maxContext: '131072',
  capabilities: 'thinking, always_thinking',
  thinkingEnabled: 'true'
}

function kimiConfig(k: string): string {
  return [
    tomlAssign('default_model', 'micuapi/kimi-k3'),
    '',
    '[providers.micuapi]',
    tomlAssign('type', 'openai'),
    tomlAssign('base_url', 'https://www.micuapi.ai/v1'),
    tomlAssign('api_key', k),
    '',
    '[models.' + tomlQuote('micuapi/kimi-k3') + ']',
    tomlAssign('provider', 'micuapi'),
    tomlAssign('model', 'kimi-k3'),
    tomlAssignRaw('max_context_size', '131072'),
    'capabilities = [ "thinking", "always_thinking" ]',
    tomlAssign('display_name', 'Kimi K3'),
    '',
    '[thinking]',
    tomlAssignRaw('enabled', 'true'),
    '',
    '[server]',
    tomlAssign('host', '127.0.0.1'),
    ''
  ].join('\n')
}

/** 旧「Kimi 接口」页的档案库文件（迁移源；结构与 kimi/profiles.loadStore 的解析一致） */
function legacyStoreJson(): string {
  return JSON.stringify({
    version: 1,
    activeId: 'kp-legacy-a',
    profiles: [
      {
        id: 'kp-legacy-a',
        name: 'MicuAPI',
        providerId: 'micuapi',
        type: 'openai',
        baseUrl: 'https://www.micuapi.ai/v1',
        apiKeySealed: Buffer.from(KEY_LEGACY, 'utf8').toString('base64'),
        plainStore: true,
        modelId: 'kimi-k3',
        modelDisplay: 'Kimi K3',
        maxContext: 262144,
        capabilities: ['thinking'],
        thinkingEnabled: false
      },
      {
        id: 'kp-legacy-b',
        name: 'Backup',
        providerId: 'backup',
        type: 'anthropic',
        baseUrl: 'https://backup.example.com/v1',
        apiKeySealed: Buffer.from(sampleKey('kimi-legacy-b'), 'utf8').toString('base64'),
        modelId: 'kimi-l5',
        modelDisplay: 'Kimi L5',
        maxContext: 131072,
        capabilities: [],
        thinkingEnabled: true
      }
    ]
  }) + '\n'
}

// ---------- 环境 ----------

let ud = ''
let home = ''

beforeEach(() => {
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'apihub-kimi-ud-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'apihub-kimi-home-'))
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

// ---------- CATALOG / 路径 / 字段校验 ----------

describe('kimi 适配器目录与校验', () => {
  it('CATALOG 含可用的 kimi 条目（label/needsKey/字段定义含 select）', () => {
    const k = API_HUB_CATALOG.find((a) => a.id === 'kimi')
    expect(k).toBeDefined()
    expect(k?.available).toBe(true)
    expect(k?.label).toBe('Kimi Code CLI')
    expect(k?.needsKey).toBe(true)
    const keys = (k?.fieldDefs ?? []).map((d) => d.key)
    for (const want of ['providerId', 'modelId', 'baseUrl', 'type', 'modelDisplay', 'maxContext', 'capabilities', 'thinkingEnabled']) {
      expect(keys).toContain(want)
    }
    const typeDef = k?.fieldDefs.find((d) => d.key === 'type')
    expect(typeDef?.kind).toBe('select')
    expect(typeDef?.options).toEqual(['openai', 'anthropic'])
    const thDef = k?.fieldDefs.find((d) => d.key === 'thinkingEnabled')
    expect(thDef?.options).toEqual(['true', 'false'])
  })

  it('adapterPaths(kimi) 指向 <home>/.kimi-code/config.toml', () => {
    expect(adapterPaths('kimi', home)).toEqual([path.join(home, '.kimi-code', 'config.toml')])
  })

  it('validateHubFields：缺省 type/thinking 合法（走默认）；非法 providerId/maxContext/thinking 拒绝', () => {
    const minimal = { providerId: 'micuapi', modelId: 'kimi-k3', baseUrl: 'https://x/v1' }
    expect(validateHubFields('kimi', minimal, true)).toBeNull()
    expect(validateHubFields('kimi', { ...minimal, providerId: 'Bad_ID' }, true)).toContain('Provider ID')
    expect(validateHubFields('kimi', { ...minimal, maxContext: 'abc' }, true)).toContain('上下文窗口')
    expect(validateHubFields('kimi', { ...minimal, maxContext: '131072.5' }, true)).toContain('上下文窗口')
    expect(validateHubFields('kimi', { ...minimal, thinkingEnabled: 'yes' }, true)).toContain('Thinking')
    expect(validateHubFields('kimi', { ...minimal, type: 'grpc' }, true)).toContain('type')
    expect(validateHubFields('kimi', { ...minimal, baseUrl: 'ftp://x' }, true)).toContain('Base URL')
  })

  it('kimiFieldsOf：缺省映射（type=openai / maxContext=131072 / display 同模型 ID / thinking=true）', () => {
    const f = kimiFieldsOf({ providerId: 'p1', modelId: 'm1', baseUrl: 'https://x/v1' })
    expect(f.type).toBe('openai')
    expect(f.maxContext).toBe(131072)
    expect(f.modelDisplay).toBe('m1')
    expect(f.thinkingEnabled).toBe(true)
    expect(f.capabilities).toEqual([])
    const g = kimiFieldsOf({ providerId: 'p1', modelId: 'm1', baseUrl: 'https://x/v1', thinkingEnabled: 'false', maxContext: '4096', capabilities: 'a, b' })
    expect(g.thinkingEnabled).toBe(false)
    expect(g.maxContext).toBe(4096)
    expect(g.capabilities).toEqual(['a', 'b'])
  })
})

// ---------- 纯变换 kimiApplyConfig / kimiVerify ----------

describe('kimiApplyConfig / kimiVerify（纯文本变换）', () => {
  it('全新文本：建 providers/models/thinking 三块 + default_model；未知段 [server] 原样保留', () => {
    const base = ['[server]', tomlAssign('host', '127.0.0.1'), ''].join('\n')
    const next = kimiApplyConfig(base, kimiFieldsOf(KIMI_FIELDS), KEY_NEW)
    expect(next).toContain(tomlHeader('providers.micuapi'))
    expect(next).toContain(tomlAssign('api_key', KEY_NEW))
    expect(next).toContain(tomlAssign('base_url', 'https://www.micuapi.ai/v1'))
    expect(next).toContain(tomlHeader('models.' + tomlQuote('micuapi/kimi-k3')))
    expect(next).toContain(tomlAssignRaw('max_context_size', '131072'))
    expect(next).toContain('capabilities = [ "thinking", "always_thinking" ]')
    expect(next).toContain(tomlAssignRaw('enabled', 'true'))
    expect(next).toContain(tomlAssign('default_model', 'micuapi/kimi-k3'))
    expect(next).toContain('[server]')
    expect(next).toContain(tomlAssign('host', '127.0.0.1'))
    kimiVerify(next, kimiFieldsOf(KIMI_FIELDS), KEY_NEW)
  })

  it('既有配置上重写：块级替换（含 api_key 更新），旧段落保留', () => {
    const next = kimiApplyConfig(kimiConfig(KEY_CUR), kimiFieldsOf(KIMI_FIELDS), KEY_NEW)
    expect(next).not.toContain(KEY_CUR)
    expect(next).toContain(tomlAssign('api_key', KEY_NEW))
    expect(next).toContain(tomlHeader('providers.micuapi'))
    expect(next).toContain('[server]')
    kimiVerify(next, kimiFieldsOf(KIMI_FIELDS), KEY_NEW)
  })

  it('kimiVerify：default_model / thinking / api_key 任一不一致即抛错', () => {
    const text = kimiConfig(KEY_CUR)
    kimiVerify(text, kimiFieldsOf(KIMI_FIELDS), KEY_CUR)
    expect(() => kimiVerify(text, { ...kimiFieldsOf(KIMI_FIELDS), modelId: 'other' }, KEY_CUR)).toThrow('default_model')
    expect(() => kimiVerify(text, { ...kimiFieldsOf(KIMI_FIELDS), thinkingEnabled: false }, KEY_CUR)).toThrow('thinking')
    expect(() => kimiVerify(text, kimiFieldsOf(KIMI_FIELDS), KEY_NEW)).toThrow('api_key 尾 4 位不一致')
  })
})

// ---------- apihubSwitch kimi 骨架（临时目录演练） ----------

describe('apihubSwitch kimi（临时目录演练）', () => {
  it('写入正确 + 备份命名 bak_20260902_120000 + active 登记 + 无 tmp 残留 + 结果无全值 key', async () => {
    writeTmp(home, path.join('.kimi-code', 'config.toml'), kimiConfig(KEY_CUR))
    const p = upsertHubProfile(ud, { adapterId: 'kimi', name: 'Micu', fields: KIMI_FIELDS }, KEY_NEW, fakeSealer())
    const before = readTmp(home, path.join('.kimi-code', 'config.toml'))
    const r = (await apihubSwitch('kimi', p.id, deps())) as ApiHubSwitchResult
    expect(r.backupFiles).toHaveLength(1)
    expect(path.basename(r.backupFiles[0])).toBe('config.toml.bak_20260902_120000')
    expect(fs.readFileSync(r.backupFiles[0], 'utf8')).toBe(before)
    const after = readTmp(home, path.join('.kimi-code', 'config.toml'))
    expect(after).toContain(tomlAssign('api_key', KEY_NEW))
    expect(after).not.toContain(KEY_CUR)
    expect(after).toContain('[server]')
    expect(loadHubStore(ud).activeByAdapter['kimi']).toBe(p.id)
    expect(fs.readdirSync(path.join(home, '.kimi-code')).filter((f) => f.includes('.tmp-'))).toEqual([])
    expect(JSON.stringify(r)).not.toContain(KEY_NEW)
  })

  it('目标缺失：全新建目录写入，零备份', async () => {
    const p = upsertHubProfile(ud, { adapterId: 'kimi', name: 'Micu', fields: KIMI_FIELDS }, KEY_NEW, fakeSealer())
    const r = (await apihubSwitch('kimi', p.id, deps())) as ApiHubSwitchResult
    expect(r.backupFiles).toEqual([])
    const after = readTmp(home, path.join('.kimi-code', 'config.toml'))
    expect(after).toContain(tomlAssign('api_key', KEY_NEW))
    expect(after).toContain(tomlAssign('default_model', 'micuapi/kimi-k3'))
  })

  it('重读校验失败（Proxy fs 模拟坏内容）：逐字节回滚，备份在场', async () => {
    writeTmp(home, path.join('.kimi-code', 'config.toml'), kimiConfig(KEY_CUR))
    const p = upsertHubProfile(ud, { adapterId: 'kimi', name: 'Micu', fields: KIMI_FIELDS }, KEY_NEW, fakeSealer())
    const target = path.join(home, '.kimi-code', 'config.toml')
    const before = fs.readFileSync(target)
    let reads = 0
    const realReadFileSync = fs.readFileSync
    const flakyFs = new Proxy(fs, {
      get(t, prop, recv) {
        if (prop === 'readFileSync') {
          return (file: fs.PathOrFileDescriptor, ...rest: unknown[]): string | Buffer => {
            if (typeof file === 'string' && path.resolve(file) === path.resolve(target)) {
              reads++
              if (reads === 2) return '' // 第二次读 = 写盘后的重读校验
            }
            return (realReadFileSync as (...a: unknown[]) => string | Buffer)(file, ...rest)
          }
        }
        return Reflect.get(t, prop, recv)
      }
    }) as typeof fs
    await expect(apihubSwitch('kimi', p.id, deps({ fsMod: flakyFs }))).rejects.toThrow('重读校验失败')
    expect(fs.readFileSync(target)).toEqual(before)
    expect(fs.readdirSync(path.join(home, '.kimi-code')).some((f) => f.startsWith('config.toml.bak_'))).toBe(true)
  })
})

// ---------- readCurrent / importCurrent ----------

describe('kimi readCurrent / importCurrent', () => {
  it('readCurrent：baseUrl/tail/len + detail（defaultModel/thinking/maxContext）+ 命中档案 + 无全值', async () => {
    writeTmp(home, path.join('.kimi-code', 'config.toml'), kimiConfig(KEY_CUR))
    const p = upsertHubProfile(ud, { adapterId: 'kimi', name: 'Micu', fields: KIMI_FIELDS }, KEY_NEW, fakeSealer())
    const cur = await apihubReadCurrent('kimi', deps())
    expect(cur.available).toBe(true)
    expect(cur.configPaths).toEqual([path.join(home, '.kimi-code', 'config.toml')])
    expect(cur.baseUrl).toBe('https://www.micuapi.ai/v1')
    expect(cur.apiKeyTail).toBe(KEY_CUR.slice(-4))
    expect(cur.apiKeyLen).toBe(KEY_CUR.length)
    expect(cur.detail.defaultModel).toBe('micuapi/kimi-k3')
    expect(cur.detail.thinking).toBe('true')
    expect(cur.detail.maxContext).toBe('131072')
    expect(cur.matchedProfileId).toBe(p.id)
    const s = JSON.stringify(cur)
    expect(s).not.toContain(KEY_CUR)
    expect(s).not.toContain(KEY_NEW)
  })

  it('importCurrent：字段映射（maxContext 字符串 / capabilities 逗号串 / thinkingEnabled true|false），key 立即 seal', async () => {
    writeTmp(home, path.join('.kimi-code', 'config.toml'), kimiConfig(KEY_CUR))
    const imp = await apihubImportCurrent('kimi', deps())
    expect(imp.imported).toBe(true)
    expect(imp.profile?.name).toBe('www.micuapi.ai')
    expect(imp.profile?.fields).toMatchObject({
      providerId: 'micuapi',
      type: 'openai',
      baseUrl: 'https://www.micuapi.ai/v1',
      modelId: 'kimi-k3',
      modelDisplay: 'Kimi K3',
      maxContext: '131072',
      capabilities: 'thinking, always_thinking',
      thinkingEnabled: 'true'
    })
    expect(imp.profile?.apiKeySealed).not.toContain(KEY_CUR)
    expect(hubProfileView(imp.profile!, fakeSealer()).apiKeyTail).toBe(KEY_CUR.slice(-4))
    expect(JSON.stringify(hubProfileView(imp.profile!, fakeSealer()))).not.toContain(KEY_CUR)
    // 首个导入档案即登记生效；且切换可用（round-trip）
    expect(loadHubStore(ud).activeByAdapter['kimi']).toBe(imp.profile?.id)
  })

  it('importCurrent：文件缺失 / 结构不明（无 default_model）→ imported=false + reason', async () => {
    const miss = await apihubImportCurrent('kimi', deps())
    expect(miss.imported).toBe(false)
    expect(miss.reason ?? '').toContain('config.toml')
    writeTmp(home, path.join('.kimi-code', 'config.toml'), ['[server]', tomlAssign('host', '127.0.0.1'), ''].join('\n'))
    const broken = await apihubImportCurrent('kimi', deps())
    expect(broken.imported).toBe(false)
    expect(broken.reason ?? '').toContain('default_model')
  })
})

// ---------- 旧 kimi-profiles.json 自动迁移 ----------

describe('旧 Kimi 档案自动迁移（loadHubStore）', () => {
  it('旧文件存在 + kimi 节为空 → 自动迁移：fields 映射、key 密文原样、activeId 映射、旧文件保留', () => {
    writeTmp(ud, 'kimi-profiles.json', legacyStoreJson())
    const legacyBefore = fs.readFileSync(profilesFile(ud))
    const store = loadHubStore(ud)
    const kimi = store.byAdapter['kimi'] ?? []
    expect(kimi).toHaveLength(2)
    expect(kimi[0].id).toBe('kp-legacy-a')
    expect(kimi[0].adapterId).toBe('kimi')
    expect(kimi[0].fields).toEqual({
      providerId: 'micuapi',
      type: 'openai',
      baseUrl: 'https://www.micuapi.ai/v1',
      modelId: 'kimi-k3',
      modelDisplay: 'Kimi K3',
      maxContext: '262144',
      capabilities: 'thinking',
      thinkingEnabled: 'false'
    })
    // 密文/降级标记原样搬运（不重新 seal）
    expect(kimi[0].apiKeySealed).toBe(Buffer.from(KEY_LEGACY, 'utf8').toString('base64'))
    expect(kimi[0].plainStore).toBe(true)
    expect(store.activeByAdapter['kimi']).toBe('kp-legacy-a')
    // 旧文件逐字节保留（备份语义）
    expect(fs.readFileSync(profilesFile(ud))).toEqual(legacyBefore)
    // 迁移结果已落盘（api-hub-profiles.json 出现且含 kimi 节）
    expect(fs.existsSync(apiHubStoreFile(ud))).toBe(true)
    const reloaded = loadHubStore(ud)
    expect((reloaded.byAdapter['kimi'] ?? []).map((p) => p.id)).toEqual(['kp-legacy-a', 'kp-legacy-b'])
  })

  it('kimi 节已存在（即使被清空）→ 不再从旧文件复活', () => {
    writeTmp(ud, 'kimi-profiles.json', legacyStoreJson())
    saveHubStore(ud, { version: 1, byAdapter: { kimi: [] }, activeByAdapter: {} })
    const store = loadHubStore(ud)
    expect(store.byAdapter['kimi']).toEqual([])
    expect(store.activeByAdapter['kimi'] ?? null).toBeNull()
  })

  it('无旧文件 → 不迁移；旧文件损坏 → 不迁移且不崩；apihub 库损坏 + 旧文件在场 → 照常迁移', () => {
    expect(loadHubStore(ud).byAdapter['kimi']).toBeUndefined()
    writeTmp(ud, 'kimi-profiles.json', 'not-json')
    expect(loadHubStore(ud).byAdapter['kimi']).toBeUndefined()
    writeTmp(ud, 'kimi-profiles.json', legacyStoreJson())
    writeTmp(ud, 'api-hub-profiles.json', 'broken-json')
    const store = loadHubStore(ud)
    expect((store.byAdapter['kimi'] ?? []).length).toBe(2)
  })
})
