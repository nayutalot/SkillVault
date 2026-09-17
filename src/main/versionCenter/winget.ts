// winget 通道：winget list（已装检测）/ winget upgrade（全量升级清单，一次解析成 Map）/ winget upgrade --id（更新）。
// 解析注意（真机实测，Git Bash 管道重定向下）：
// - 表头按列宽多空格对齐，但数据行可能是「单空格」分隔（winget list --id X 重定向输出实测如此）；
//   因此不能只按多空格 split，也不能盲按单空格 split 取固定列 —— 采用「语义 token」定位：
//   ID = 含字母且含 '.'、且其后紧跟版本号 token 的最后一个（真 ID 永远紧邻其版本列）；
//   版本 token = 纯数字点分。两种对齐格式天然兼容，虚线分隔行与表尾统计行（"40 upgrades available."）自然跳过。
// - 未命中不等于命令失败：winget list 找不到包也可能非零退出 → 以「是否解析到匹配行」为准。
import { execAsync, type Spawner } from './exec'

export const WINGET_CHECK_TIMEOUT_MS = 90_000
export const WINGET_UPDATE_TIMEOUT_MS = 20 * 60_000

const VERSION_TOKEN = /^v?\d+(?:\.\d+)+$/ // 至少两段，避免把年份、构建号等孤立数字误判为版本

export type WingetRow = { id: string; installed: string; available?: string }
export type WingetUpgradeMap = Map<string, { installed: string; available?: string }>

function isVersionToken(t: string): boolean {
  return VERSION_TOKEN.test(t)
}

/** ID 候选：含 '.' 且含字母（排除纯数字版本号），如 Anthropic.Claude / OpenJS.NodeJS.LTS */
function isIdToken(t: string): boolean {
  return t.includes('.') && /[A-Za-z]/.test(t)
}

/**
 * 解析 winget 表格输出（list / upgrade 通用）。
 * 每行按空白切 token：从左到右找出所有「ID 候选且紧跟版本号」的位置，取最后一个作为该行 ID
 * （名称列中含 '.' 的 token 如 "Node.js" 会被更靠后的真 ID 覆盖），其后第一个版本号 = 已装版本，
 * 再往后还有一个版本号 = 可升级版本。
 */
export function parseWingetTable(out: string): WingetRow[] {
  const rows: WingetRow[] = []
  const lines = String(out ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || /^[-\s]+$/.test(line)) continue // 空行 / 虚线分隔行
    const tokens = line.split(/\s+/)
    let idIdx = -1
    for (let i = 0; i < tokens.length - 1; i++) {
      if (isIdToken(tokens[i]) && isVersionToken(tokens[i + 1])) idIdx = i
    }
    if (idIdx < 0) continue // 表头 / 统计行 / 说明文本
    const installed = tokens[idIdx + 1]
    const availableToken = tokens[idIdx + 2]
    rows.push({
      id: tokens[idIdx],
      installed,
      available: availableToken && isVersionToken(availableToken) ? availableToken : undefined
    })
  }
  return rows
}

/**
 * winget list --id <id> [-e]：解析该包已装版本；未安装返回 {}（不是错误），命令失败返回 { error }。
 * exact=false 时不加 -e、行 id 按子串匹配 —— 用于商店系 MSIX 应用（已装记录 id 是
 * MSIX\OpenAI.Codex_26.825..._x64__... 完整包名，精确匹配会漏检）。
 */
export async function wingetCheckInstalled(
  packageId: string,
  deps: { spawner?: Spawner; timeoutMs?: number; exact?: boolean } = {}
): Promise<{ version?: string; error?: string }> {
  const exact = deps.exact !== false
  const args = ['list', '--id', packageId]
  if (exact) args.push('-e')
  args.push('--disable-interactivity')
  const r = await execAsync('winget', args, {
    timeoutMs: deps.timeoutMs ?? WINGET_CHECK_TIMEOUT_MS,
    spawner: deps.spawner
  }).done
  const want = packageId.toLowerCase()
  const row = parseWingetTable(r.stdout).find((x) =>
    exact ? x.id.toLowerCase() === want : x.id.toLowerCase().includes(want)
  )
  if (row) return { version: row.installed }
  if (!r.ok && !r.stdout.trim()) {
    return { error: `winget list 失败: ${(r.stderr || '无输出').slice(0, 200)}` }
  }
  return {}
}

/** winget upgrade：一次解析全量升级清单 → Map<小写 id, { installed, available }> */
export async function wingetListUpgrades(
  deps: { spawner?: Spawner; timeoutMs?: number } = {}
): Promise<{ map: WingetUpgradeMap } | { error: string }> {
  const r = await execAsync('winget', ['upgrade', '--disable-interactivity'], {
    timeoutMs: deps.timeoutMs ?? WINGET_CHECK_TIMEOUT_MS,
    spawner: deps.spawner
  }).done
  const map: WingetUpgradeMap = new Map()
  for (const row of parseWingetTable(r.stdout)) {
    map.set(row.id.toLowerCase(), { installed: row.installed, available: row.available })
  }
  if (map.size === 0 && !r.ok) {
    return { error: `winget upgrade 失败: ${(r.stderr || r.stdout || '无输出').slice(0, 200)}` }
  }
  return { map }
}

/** 更新参数：winget upgrade --id <id> -e --silent --accept-package-agreements --accept-source-agreements */
export function wingetUpgradeArgs(packageId: string): string[] {
  return [
    'upgrade',
    '--id',
    packageId,
    '-e',
    '--silent',
    '--accept-package-agreements',
    '--accept-source-agreements'
  ]
}
