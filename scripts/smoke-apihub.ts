// 接口中心 真机只读冒烟 + 临时副本切换演练。
// 红线：真实配置文件只读不写；演练写入全部走 writeDrill 受控守卫（resolve 后必须仍位于临时演练家目录内）；
//       key 全值绝不打印（只报尾 4 位/长度）；真实文件 sha256 前后对比必须一致。
// 用法：tsx scripts/smoke-apihub.ts
/* eslint-disable no-console */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adapterPaths, apihubImportCurrent, apihubReadCurrent, apihubSwitch, type ApiHubDeps } from '../src/main/apihub'
import { hubProfileView, loadHubStore } from '../src/main/apihub/store'
import type { KimiSealer } from '../src/main/kimi/profiles'
import type { ApiHubAdapterId, ApiHubSwitchResult } from '../src/shared/types'

// 演练 sealer：plainStore 降级（无 electron/safeStorage 的 tsx 环境走同一条降级代码路径）
const sealer: KimiSealer = {
  isEncryptionAvailable: () => false,
  encrypt: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
  decrypt: (b64) => Buffer.from(b64, 'base64').toString('utf8')
}

const realHome = os.homedir()
const ADAPTERS: ApiHubAdapterId[] = ['claude-cli', 'codex', 'grok', 'kimi', 'zcode']
const FIXED = new Date(2026, 8, 2, 12, 0, 0) // 固定时钟：备份名稳定为 bak_20260902_120000

function sha256(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

/** 受控副本写入：path.resolve 后必须仍位于 drillHome 内（防路径逃逸，红线双保险） */
function writeDrill(drillHome: string, rel: string, content: string): string {
  const target = path.resolve(drillHome, rel)
  const root = path.resolve(drillHome) + path.sep
  if (!target.startsWith(root)) throw new Error('演练写入越界: ' + target)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  return target
}

async function main(): Promise<void> {
  console.log('=== 接口中心 冒烟（真实文件只读） ===')
  const udSmoke = fs.mkdtempSync(path.join(os.tmpdir(), 'apihub-smoke-ud-'))
  for (const id of ADAPTERS) {
    const cur = await apihubReadCurrent(id, { homeDir: realHome, userDataDir: udSmoke, sealer })
    console.log('[' + id + '] current:', JSON.stringify(cur))
  }

  // 真实文件 sha256 快照（只含实际存在的文件）
  const realFiles: string[] = []
  for (const id of ADAPTERS) {
    for (const p of adapterPaths(id, realHome)) {
      if (fs.existsSync(p) && !realFiles.includes(p)) realFiles.push(p)
    }
  }
  const shaBefore = new Map<string, string>(realFiles.map((p) => [p, sha256(p)]))
  console.log('参与对比的真实文件数:', realFiles.length)

  console.log('')
  console.log('=== 接口中心 演练（临时目录副本，绝不写真实路径） ===')
  const drillHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apihub-drill-home-'))
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'apihub-drill-ud-'))
  console.log('演练家目录:', drillHome)

  for (const id of ADAPTERS) {
    console.log('')
    console.log('--- [' + id + '] ---')
    // 1) 真实配置拷入临时副本（保持相对 home 的相对路径），记录副本原文用于备份比对
    const beforeText = new Map<string, string>()
    for (const real of adapterPaths(id, realHome)) {
      if (!fs.existsSync(real)) continue
      const rel = path.relative(realHome, real)
      const text = fs.readFileSync(real, 'utf8')
      writeDrill(drillHome, rel, text)
      beforeText.set(path.join(drillHome, rel), text)
    }
    // 2) 从副本导入当前配置为档案（key 全值只在内存一瞬间，立即 seal 入临时档案库）
    const drillDeps: ApiHubDeps = { homeDir: drillHome, userDataDir: ud, sealer, clock: () => FIXED }
    const imp = await apihubImportCurrent(id, drillDeps)
    if (!imp.imported || !imp.profile) {
      console.log('[' + id + '] 导入跳过:', imp.reason ?? '未知原因')
      continue
    }
    const view = hubProfileView(imp.profile, sealer)
    console.log(
      '[' + id + '] 导入档案:',
      JSON.stringify({ id: view.id, name: view.name, fields: view.fields, tail: view.apiKeyTail, len: view.apiKeyLen, plainStore: view.plainStore })
    )
    // 3) 对副本完整切换（confirmed: true 跳过 zcode 进程预检；本机 ZCode 正在运行也绝不触碰真实文件）
    const r = (await apihubSwitch(id, imp.profile.id, drillDeps, { confirmed: true })) as ApiHubSwitchResult
    console.log('[' + id + '] 备份文件:', r.backupFiles.map((f) => path.basename(f)).join(', '), r.warning ? '| ' + r.warning : '')
    for (const [drillFile, text] of beforeText) {
      const backup = drillFile + '.bak_20260902_120000'
      const ok = fs.existsSync(backup) && fs.readFileSync(backup, 'utf8') === text
      console.log('[' + id + '] 备份与写前逐字节一致:', path.basename(drillFile), '→', ok)
    }
    // 4) 副本写后结构（脱敏读取打印）+ 生效登记
    const after = await apihubReadCurrent(id, { homeDir: drillHome, userDataDir: ud, sealer })
    console.log('[' + id + '] 副本写后 current:', JSON.stringify(after))
    console.log('[' + id + '] 命中导入档案:', after.matchedProfileId === imp.profile.id)
    console.log('[' + id + '] activeId 已登记:', loadHubStore(ud).activeByAdapter[id] === imp.profile.id)
  }

  // 5) 真机零改动证据
  console.log('')
  console.log('=== 真实文件 sha256 前后对比 ===')
  let unchanged = true
  for (const p of realFiles) {
    const before = shaBefore.get(p) ?? ''
    const after = sha256(p)
    const same = before === after
    if (!same) unchanged = false
    console.log((same ? 'OK   ' : 'DIFF ') + p)
    console.log('     sha256=' + after)
  }
  console.log('真实文件全部未变:', unchanged)

  fs.rmSync(udSmoke, { recursive: true, force: true })
  fs.rmSync(ud, { recursive: true, force: true })
  fs.rmSync(drillHome, { recursive: true, force: true })
  console.log('临时目录已清理')
  if (!unchanged) process.exit(1)
}

main().catch((e) => {
  console.error('冒烟失败:', e)
  process.exit(1)
})
