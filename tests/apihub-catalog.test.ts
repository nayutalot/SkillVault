// 接口中心动态目录测试：注册表（active 且 enabled）× 实现矩阵合成适配器目录、
// 未支持工具的说明卡文案与 id 规则、注册表读不到/没有签名时的静态兜底（绝不白屏），
// 以及「自定义供应商 → 适配器字段」预填映射（能填的填、填不了的进 missing）。
// 全部纯逻辑 + 临时目录真 fs，零真实配置接触。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApiHubCatalog, providerIdOf, providerPrefill, synthesizeApiHubCatalog } from '../src/main/apihub/adapters'
import { STATIC_API_HUB_CATALOG } from '../src/main/apihub/catalog'
import type { RegistryAgent } from '../src/shared/types'

const tmpDirs: string[] = []

function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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

/** 注册表条目（默认 discovered/active/enabled，测试按需覆盖） */
function agent(partial: Partial<RegistryAgent> & { name: string }): RegistryAgent {
  return {
    platform: 'windows',
    skillsDir: 'C:\\Users\\t\\.x\\skills',
    include: ['*'],
    source: 'discovered',
    enabled: true,
    status: 'active',
    ...partial
  }
}

describe('synthesizeApiHubCatalog（注册表驱动）', () => {
  it('检测到 claude → 出 Claude Code 卡 + Claude Desktop 说明卡；未检测到的工具一张卡都不出', () => {
    const r = synthesizeApiHubCatalog([agent({ name: 'claude-win', sigId: 'claude', label: 'Claude Code' })])
    expect(r.degraded).toBe(false)
    expect(r.adapters.map((a) => a.id)).toEqual(['claude-cli', 'claude-desktop'])
    expect(r.adapters[0].available).toBe(true)
    expect(r.adapters[0].sigId).toBe('claude')
    expect(r.adapters[1].available).toBe(false)
    expect(r.adapters[1].naReason).toContain('写入目标未能定位')
  })

  it('没有 claude 时 Claude Desktop 说明卡不出现（避免"漏了它"的误会）', () => {
    const r = synthesizeApiHubCatalog([agent({ name: 'kimi-win', sigId: 'kimi', label: 'Kimi Code' })])
    expect(r.adapters.map((a) => a.id)).toEqual(['kimi'])
  })

  it('未支持的工具 → 白话说明卡（na: 命名空间），dsh 复用既有 deepseek 卡位', () => {
    const r = synthesizeApiHubCatalog([
      agent({ name: 'gemini-win', sigId: 'gemini', label: 'Gemini CLI' }),
      agent({ name: 'dsh-win', sigId: 'dsh', label: 'DeepSeek Harness' })
    ])
    const ids = r.adapters.map((a) => a.id)
    expect(ids).toContain('na:gemini')
    expect(ids).toContain('deepseek')
    const gemini = r.adapters.find((a) => a.id === 'na:gemini')
    expect(gemini?.available).toBe(false)
    expect(gemini?.naReason).toBe('已检测到 Gemini CLI，但「接口一键切换」暂不支持它，不影响技能同步（技能照常扫描与建链）')
    expect(gemini?.fieldDefs).toEqual([])
    expect(gemini?.needsKey).toBe(false)
  })

  it('generic:<dir> 兜底签名也出说明卡，展示名用注册表 label', () => {
    const r = synthesizeApiHubCatalog([agent({ name: 'mystery-win', sigId: 'generic:mystery', label: 'mystery' })])
    expect(r.adapters.map((a) => a.id)).toEqual(['na:generic:mystery'])
    expect(r.adapters[0].label).toBe('mystery')
  })

  it('agents-shared（通用共享目录）不出说明卡：它不是某个具体工具', () => {
    const r = synthesizeApiHubCatalog([agent({ name: 'agents-win', sigId: 'agents-shared', label: '通用共享目录' })])
    expect(r.adapters).toEqual([])
  })

  it('停用（enabled:false）与 missing 的条目不进目录 —— 这就是"自动增减"', () => {
    const disabled = synthesizeApiHubCatalog([agent({ name: 'codex-win', sigId: 'codex', enabled: false })])
    expect(disabled.adapters).toEqual([])
    const missing = synthesizeApiHubCatalog([agent({ name: 'codex-win', sigId: 'codex', status: 'missing' })])
    expect(missing.adapters).toEqual([])
  })

  it('WSL（linux）条目不出接口卡：适配器写的是 Windows 主目录，够不着发行版内部', () => {
    const r = synthesizeApiHubCatalog([agent({ name: 'claude-wsl', sigId: 'claude', platform: 'linux', skillsDir: '/root/.claude/skills' })])
    expect(r.adapters).toEqual([])
  })

  it('同签名多条目去重（claude-win + claude-extra 只出一张卡）', () => {
    const r = synthesizeApiHubCatalog([
      agent({ name: 'claude-win', sigId: 'claude', label: 'Claude Code（Windows）' }),
      agent({ name: 'claude-extra', sigId: 'claude', label: 'Claude Code（副本）' })
    ])
    expect(r.adapters.map((a) => a.id)).toEqual(['claude-cli', 'claude-desktop'])
    expect(r.adapters[0].agentLabel).toBe('Claude Code（Windows）')
  })

  it('注册表里一个签名都没有（老注册表未跑过自动发现）→ 回落内置静态目录并标记 degraded', () => {
    const r = synthesizeApiHubCatalog([agent({ name: 'zcode-win', skillsDir: 'C:\\Users\\t\\.zcode\\skills' })])
    expect(r.degraded).toBe(true)
    expect(r.reason).toContain('自动发现')
    expect(r.adapters).toBe(STATIC_API_HUB_CATALOG)
  })
})

describe('buildApiHubCatalog（读盘 + 兜底）', () => {
  it('registry.json 不存在 → 静态目录 + degraded（绝不白屏，也绝不抛错）', () => {
    const vault = mkTmp('sv-apihub-noreg-')
    const r = buildApiHubCatalog({ vaultPath: vault })
    expect(r.degraded).toBe(true)
    expect(r.adapters.map((a) => a.id)).toEqual(STATIC_API_HUB_CATALOG.map((a) => a.id))
  })

  it('registry.json 损坏 → 静态目录 + degraded 原因', () => {
    const vault = mkTmp('sv-apihub-badreg-')
    fs.writeFileSync(path.join(vault, 'registry.json'), '{ 这不是 JSON', 'utf8')
    const r = buildApiHubCatalog({ vaultPath: vault })
    expect(r.degraded).toBe(true)
    expect(r.reason).toContain('解析失败')
  })

  it('真实 registry.json → 动态目录（只出检测到的工具）', () => {
    const vault = mkTmp('sv-apihub-okreg-')
    const reg = {
      version: 3,
      agents: [agent({ name: 'grok-win', sigId: 'grok', label: 'Grok CLI', skillsDir: path.join(vault, '.grok', 'skills') })]
    }
    fs.writeFileSync(path.join(vault, 'registry.json'), JSON.stringify(reg), 'utf8')
    const r = buildApiHubCatalog({ vaultPath: vault })
    expect(r.degraded).toBe(false)
    expect(r.adapters.map((a) => a.id)).toEqual(['grok'])
  })
})

describe('providerPrefill（自定义供应商 → 适配器字段）', () => {
  const provider = {
    label: 'MicuAPI 中转',
    baseUrl: 'https://api.micu.example/v1',
    protocol: 'openai' as const,
    defaultModel: 'claude-sonnet-4'
  }

  it('Provider ID 由供应商名派生（只留小写字母/数字/连字符）', () => {
    expect(providerIdOf('MicuAPI 中转')).toBe('micuapi')
    expect(providerIdOf('My_Gateway v2')).toBe('my-gateway-v2')
    expect(providerIdOf('中文名')).toBe('custom')
  })

  it('claude-cli：只填 Base URL（密钥走 apiKeyFromProviderId，不回显）', () => {
    const r = providerPrefill('claude-cli', provider)
    expect(r.fields).toEqual({ baseUrl: 'https://api.micu.example/v1' })
    expect(r.missing).toEqual([])
  })

  it('codex：填 providerId/baseUrl/wireApi，并提示接口格式按兼容性推测', () => {
    const r = providerPrefill('codex', provider)
    expect(r.fields).toEqual({ providerId: 'micuapi', baseUrl: 'https://api.micu.example/v1', wireApi: 'chat' })
    expect(r.notes.join()).toContain('OpenAI 兼容')
  })

  it('kimi：type 随接口格式映射；缺默认模型时进 missing 让用户补，绝不编造模型名', () => {
    const withModel = providerPrefill('kimi', { ...provider, protocol: 'anthropic' })
    expect(withModel.fields.type).toBe('anthropic')
    expect(withModel.fields.modelId).toBe('claude-sonnet-4')
    expect(withModel.missing).toEqual([])
    const noModel = providerPrefill('kimi', { ...provider, defaultModel: '' })
    expect(noModel.fields.modelId).toBeUndefined()
    expect(noModel.missing).toContain('模型 ID')
  })

  it('grok：上下文窗口先填 0（表示不指定）并给出说明', () => {
    const r = providerPrefill('grok', provider)
    expect(r.fields.contextWindow).toBe('0')
    expect(r.fields.apiBackend).toBe('chat')
    expect(r.notes.join()).toContain('上下文窗口')
  })

  it('zcode：填 providerId/providerName/baseURL/kind；非 anthropic 供应商给一句提醒', () => {
    const r = providerPrefill('zcode', provider)
    expect(r.fields).toEqual({
      providerId: 'micuapi',
      providerName: 'MicuAPI 中转',
      baseURL: 'https://api.micu.example/v1',
      kind: 'anthropic'
    })
    expect(r.notes.join()).toContain('anthropic')
  })

  it('只回适配器 fieldDefs 认识的键（不给表单塞它不认识的字段）', () => {
    const r = providerPrefill('claude-cli', provider)
    expect(Object.keys(r.fields)).toEqual(['baseUrl'])
  })
})
