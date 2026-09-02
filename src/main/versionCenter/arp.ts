// arp 通道（DeepSeek Harness）：注册表 Uninstall 键（Add/Remove Programs）只读检测，无升级通道（UI 恒为「仅检测」）。
// 用 reg query <root> /s 全量枚举三处 Uninstall 键（HKLM 64位 / HKLM WOW6432Node / HKCU），按 HKEY_ 行分块解析
// DisplayName / DisplayVersion（值可含空格 → 取行尾整段；实测 DeepSeek Harness 为 Chrome PWA 条目，位于 HKCU，DisplayVersion 1.0）。
// reg.exe 经 cmd chcp 65001 通道执行：重定向输出默认用 OEM 代码页（中文系统 GBK），非 ASCII DisplayName 会乱码导致匹配失败。
import { execCmdArgs, type Spawner } from './exec'

export const ARP_CHECK_TIMEOUT_MS = 90_000

export const ARP_QUERY_TARGETS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
] as const

export type ArpBlock = { key: string; displayName?: string; displayVersion?: string }

/** 解析 reg query /s 输出：HKEY_ 开头行开新块，块内抓 DisplayName / DisplayVersion（大小写不敏感，值取行尾整段） */
export function parseArpBlocks(out: string): ArpBlock[] {
  const blocks: ArpBlock[] = []
  let cur: ArpBlock | null = null
  for (const raw of String(out ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (/^HKEY_/i.test(line)) {
      if (cur) blocks.push(cur)
      cur = { key: line }
      continue
    }
    if (!cur) continue
    const nameM = line.match(/^\s*DisplayName\s+REG_[A-Z_]+\s+(.*)$/i)
    if (nameM) {
      cur.displayName = nameM[1].trim()
      continue
    }
    const verM = line.match(/^\s*DisplayVersion\s+REG_[A-Z_]+\s+(.*)$/i)
    if (verM) cur.displayVersion = verM[1].trim()
  }
  if (cur) blocks.push(cur)
  return blocks
}

/** 在枚举输出中找 displayName 子串匹配（大小写不敏感）条目的 DisplayVersion；找不到/无版本 → null */
export function findArpVersion(out: string, displayName: string): string | null {
  for (const b of parseArpBlocks(out)) {
    if (b.displayName && b.displayName.toLowerCase().includes(displayName.toLowerCase())) {
      return b.displayVersion ?? null
    }
  }
  return null
}

/** 三处根键并行枚举，返回首个命中条目；version 缺省 = 找到条目但无 DisplayVersion 或未找到；
 *  error 仅在三处根键全部查询失败时报（部分失败时其余根键的结果仍有效，按未命中处理） */
export async function arpInstalledVersion(
  displayName: string,
  deps: { spawner?: Spawner; timeoutMs?: number } = {}
): Promise<{ version?: string; error?: string }> {
  const results = await Promise.all(
    ARP_QUERY_TARGETS.map(async (key) => {
      const r = await execCmdArgs(['reg', 'query', key, '/s'], {
        timeoutMs: deps.timeoutMs ?? ARP_CHECK_TIMEOUT_MS,
        spawner: deps.spawner
      }).done
      return r
    })
  )
  let failedRoots = 0
  for (const r of results) {
    if (!r.ok && !r.stdout.trim()) failedRoots++
    if (!r.stdout.trim()) continue
    const hit = parseArpBlocks(r.stdout).find(
      (b) => b.displayName && b.displayName.toLowerCase().includes(displayName.toLowerCase())
    )
    if (hit) return hit.displayVersion ? { version: hit.displayVersion } : {}
  }
  if (failedRoots === ARP_QUERY_TARGETS.length) {
    return { error: `reg query 全部 ${ARP_QUERY_TARGETS.length} 处根键查询失败，无法读取 ARP 注册表` }
  }
  return {}
}
