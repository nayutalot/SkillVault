// 真机只读冒烟：agentsDir 硬链接共享识别 + npm.cmd 解析器。
// 红线：零写入（不建链、不修复、不执行 npm 实际命令、不写缓存）。tsx scripts/smoke-agentsdir-npm.ts
/* eslint-disable no-console */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveNpmCmdPath } from '../src/main/versionCenter/npm'
import { agentsDirStateOf, vaultAgentsDir } from '../src/main/winLinks'
import { loadSettings } from '../src/main/settings'
import { parseRegistry, defaultRegistry } from '../src/shared/registry'

async function main(): Promise<void> {
  console.log('=== agentsDir 状态（只读） ===')
  const s = loadSettings(null)
  const vaultPath = s.vaultPath
  console.log('vaultPath:', vaultPath, 'exists:', fs.existsSync(vaultPath))
  let registry = defaultRegistry()
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(vaultPath, 'registry.json'), 'utf8'))
    const parsed = parseRegistry(JSON.stringify(raw))
    if (parsed.ok) registry = parsed.registry
  } catch {
    console.log('registry.json 不可读，使用 defaultRegistry()')
  }
  const vaultFiles = fs.existsSync(vaultAgentsDir(vaultPath)) ? fs.readdirSync(vaultAgentsDir(vaultPath)) : []
  console.log('vault agents/:', JSON.stringify(vaultFiles))
  for (const a of registry.agents.filter((x) => x.platform === 'windows' && x.agentsDir)) {
    const st = agentsDirStateOf(vaultPath, a.agentsDir!)
    console.log(`[${a.name}] ${a.agentsDir} → state=${st.state}${st.note ? ` note=${st.note}` : ''}`)
  }

  console.log('')
  console.log('=== npm.cmd 解析器（只解析路径，不执行 npm 命令） ===')
  const npm = await resolveNpmCmdPath()
  console.log('npm.cmd 绝对路径:', npm ?? '(null)')
  if (!npm) process.exit(1)
}

main().catch((e) => {
  console.error('冒烟失败:', e)
  process.exit(1)
})
