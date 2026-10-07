// 注册表只读入口（接口中心目录合成 + 版本中心可见性共用）：
// 只读 registry.json，缺失/损坏/读取失败一律回 agents:null + reason，由调用方各自保守降级
// （接口中心回落内置静态目录、版本中心显示全部条目）——绝不在这里抛错，也绝不写盘。
import fs from 'node:fs'
import path from 'node:path'
import { parseRegistry } from '../../shared/registry'
import type { RegistryAgent } from '../../shared/types'

export type RegistryAgentsRead = { agents: RegistryAgent[] | null; file: string; reason?: string }

/** registry.json 路径（与 agentDiscover.registryFilePath / ipc.ts readRegistry 同源：vaultPath/registry.json） */
export function registryFileIn(vaultPath: string): string {
  return path.join(vaultPath, 'registry.json')
}

export function readRegistryAgents(vaultPath: string, fsMod: typeof fs = fs): RegistryAgentsRead {
  const file = registryFileIn(vaultPath)
  try {
    if (!fsMod.existsSync(file)) {
      return { agents: null, file, reason: '还没有 registry.json（可在仪表盘点一次「自动发现」）' }
    }
    const r = parseRegistry(fsMod.readFileSync(file, 'utf8'))
    if (!r.ok) return { agents: null, file, reason: 'registry.json 解析失败：' + r.error }
    return { agents: r.registry.agents, file }
  } catch (e) {
    return { agents: null, file, reason: 'registry.json 读取失败：' + String(e instanceof Error ? e.message : e) }
  }
}
