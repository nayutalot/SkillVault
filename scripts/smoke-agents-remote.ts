// 无头冒烟（不开 GUI）：agentsDir 状态矩阵 / vault agent 文件清单 / probeRemote 无目标行为
/* eslint-disable no-console */
import fs from 'node:fs'
import path from 'node:path'
import { loadSettings } from '../src/main/settings'
import { parseRegistry } from '../src/shared/registry'
import { listVaultAgentFiles, scanWindowsAgents, vaultAgentsDir } from '../src/main/winLinks'
import { runCompanion } from '../src/main/wslBridge'
import { probeRemote } from '../src/main/remote'
import type { AgentScan, LinkState, RemoteTarget } from '../src/shared/types'

const SYM: Record<LinkState, string> = {
  linked: '✓',
  missing: '✗',
  'wrong-target': '~',
  'real-dir': '!',
  'vault-missing': '∅'
}

async function main(): Promise<void> {
  const s = loadSettings(null)
  console.log('=== 1. settings（默认，无 GUI） ===')
  console.log(`vault=${s.vaultPath}  remoteTargets=${JSON.stringify(s.remoteTargets)}`)

  console.log('\n=== 2. vault agents/ 文件清单 ===')
  const agentsDir = vaultAgentsDir(s.vaultPath)
  console.log(`agentsDir=${agentsDir} exists=${fs.existsSync(agentsDir)}`)
  const files = listVaultAgentFiles(s.vaultPath)
  for (const f of files) {
    const full = agentsDir + path.sep + f
    console.log(`  ${f}  ${fs.statSync(full).size} bytes  首行: ${fs.readFileSync(full, 'utf8').split(/\r?\n/)[0]}`)
  }

  console.log('\n=== 3. Windows 侧 agentsDir 状态矩阵 ===')
  const reg = parseRegistry(fs.readFileSync(path.join(s.vaultPath, 'registry.json'), 'utf8'))
  if (!reg.ok) throw new Error(reg.error)
  const winAgents = scanWindowsAgents(s.vaultPath, reg.registry)
  for (const a of winAgents) {
    if (!a.agentsDir) {
      console.log(`  ${a.name.padEnd(12)} （未配置 agentsDir）`)
      continue
    }
    console.log(
      `  ${a.name.padEnd(12)} ${SYM[a.agentsDirState ?? 'missing']} ${a.agentsDirState}  ${a.agentsDir}  files=[${(a.agentFiles ?? []).join(', ')}]`
    )
  }

  console.log('\n=== 4. WSL 侧 agentsDir 状态（companion scan，20s 超时） ===')
  const c = await runCompanion(s.wslDistro, ['scan'], 20000)
  const p = c.parsed as { ok?: boolean; agents?: AgentScan[] } | undefined
  if (c.ok && p?.ok) {
    for (const a of p.agents ?? []) {
      if (!a.agentsDir) {
        console.log(`  ${a.name.padEnd(12)} （未配置 agentsDir）`)
        continue
      }
      console.log(
        `  ${a.name.padEnd(12)} ${SYM[a.agentsDirState ?? 'missing']} ${a.agentsDirState}  ${a.agentsDir}  files=[${(a.agentFiles ?? []).join(', ')}]`
      )
    }
  } else {
    console.log(`  companion 不可达: ${(c.stderr || c.parseError || '').slice(0, 160)}`)
  }

  console.log('\n=== 5. probeRemote：无目标时的行为 ===')
  if (s.remoteTargets.length === 0) {
    console.log('  settings.remoteTargets = []：没有任何真实目标，不发起任何探测，也不显示任何「同步成功」。')
  }
  // 对一个「未配置字段」的假想目标演示如实失败（不产生网络请求）
  const unconfigured = { id: 'demo', kind: 'ssh' as const, label: 'demo', enabled: true }
  const r = await probeRemote(unconfigured, { timeoutMs: 100 })
  console.log(`  未配置 host 的 ssh 目标探测结果: ok=${r.ok} detail="${r.detail}"`)
  const disabled: RemoteTarget = {
    id: 'demo2',
    kind: 'docker',
    label: 'demo2',
    enabled: false,
    container: 'nonexistent-demo'
  }
  const r2 = await probeRemote(disabled, { timeoutMs: 100 })
  console.log(`  docker 假想目标探测（无 docker 环境则如实失败）: ok=${r2.ok} detail="${r2.detail.slice(0, 80)}"`)

  console.log('\nSMOKE DONE')
}

void main()
