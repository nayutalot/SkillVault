#!/usr/bin/env node
// ---------------------------------------------------------------------------
// extract-alerts.mjs —— 从安全扫描归档中抽取「告警裁定台账」
//
// 背景：项目在开发过程中接入了一个静态安全扫描器（Mimosa）。它会给出「路径穿越」
//       「命令注入」「硬编码凭据」「弱随机数」等告警。开发过程中这些告警被逐条核对：
//       有的确实是真问题（改写后通过），有的是误报（记录裁定理由，避免后续会话
//       反复尝试改写已验证正确的实现）。但这些裁定原本只散落在会话记录与本地
//       扫描归档里，评审者看不到。
//
// 本脚本把扫描归档（.mimosa/reports/*.json）里的告警抽取成一张可复核的清单：
//       finding ID · 文件:行 · 类别 · 严重级 · 首次出现 · 复核状态
//
// 用法：
//   node scripts/extract-alerts.mjs                 # 读 .mimosa/reports/，写 docs/security-alerts.raw.json
//   node scripts/extract-alerts.mjs --out <path>    # 指定输出路径
//   node scripts/extract-alerts.mjs --help
//
// 说明：
//   - .mimosa/ 在 .gitignore 中（扫描归档体积大、且含本机绝对路径），不入库。
//     因此本脚本在**没有扫描归档的机器上**会输出 0 条并给出明确提示；
//     已抽取的结果以 docs/security-alerts.raw.json 的形式入库，供评审者直接查看。
//   - 本脚本只读不写（除目标 JSON），不修改任何源码。
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const REPORT_DIR = path.join(REPO_ROOT, '.mimosa', 'reports')

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`extract-alerts.mjs —— 从安全扫描归档抽取告警裁定台账

用法：
  node scripts/extract-alerts.mjs               读 .mimosa/reports/，写 docs/security-alerts.raw.json
  node scripts/extract-alerts.mjs --out <path>  指定输出路径
  node scripts/extract-alerts.mjs --help        显示本帮助

注意：.mimosa/ 不入库，因此本脚本只在本机（保留了扫描归档的开发机）上跑得出全量结果；
入库的是抽取产物 docs/security-alerts.raw.json。`)
  process.exit(0)
}
const outIdx = argv.indexOf('--out')
const OUT = outIdx >= 0 && argv[outIdx + 1]
  ? path.resolve(argv[outIdx + 1])
  : path.join(REPO_ROOT, 'docs', 'security-alerts.raw.json')

/**
 * 告警的稳定键：文件 + 类别 + 行号。
 * 为什么用这三者而不是 finding_id：同一处代码在不同会话里会被反复扫描，
 * finding_id 每次都变；「文件+类别+行」才能把同一条告警的多次出现聚成一条，
 * 让「出现过几次、跨几个会话」成为可核对的客观事实。
 */
function keyOf(finding) {
  return [finding.file, finding.category, finding.line].join('|')
}

/**
 * 把扫描报告里的路径压成仓库相对路径。
 * 扫描器记录的路径有两种形态：
 *   - 仓库内文件：已经是相对路径（如 `src/main/vscode.ts`）
 *   - 仓库外文件：绝对路径（如临时目录里的辅助脚本）—— 这类一律单独标记，
 *     不与仓库内路径混为一谈（它们不属于被评审的代码）。
 */
function relativize(rawPath) {
  const p = String(rawPath || '').split('\\').join('/')
  const marker = 'Skill-Manager/'
  const i = p.indexOf(marker)
  if (i >= 0) return { path: p.slice(i + marker.length), inRepo: true }
  // 绝对路径 = 仓库外；已是相对路径 = 仓库内
  const isAbsolute = /^[A-Za-z]:\//.test(p) || p.startsWith('/')
  return { path: p, inRepo: !isAbsolute }
}

function main() {
  if (!fs.existsSync(REPORT_DIR)) {
    console.error(
      `[extract-alerts] 未找到扫描归档目录：${REPORT_DIR}\n` +
        '  .mimosa/ 不入库（体积大且含本机绝对路径），因此只有保留了归档的开发机上才有全量数据。\n' +
        '  入库的是抽取产物 docs/security-alerts.raw.json，可直接查阅。'
    )
    // 不写空文件覆盖已有产物
    process.exit(0)
  }

  const files = fs.readdirSync(REPORT_DIR).filter((f) => f.endsWith('.json'))
  const byKey = new Map()
  let rawRecords = 0

  for (const f of files) {
    let report
    try {
      report = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, f), 'utf8'))
    } catch {
      continue
    }
    const session = String(report.session_id || '').replace('sess_', '').slice(0, 8)
    const generatedAt = String(report.generated_at || '').slice(0, 10)
    for (const finding of report.findings || []) {
      rawRecords++
      const rel = relativize(finding.file)
      const key = keyOf({ file: rel.path, category: finding.category, line: finding.line })
      if (!byKey.has(key)) {
        byKey.set(key, {
          findingId: finding.finding_id || '',
          file: rel.path,
          inRepo: rel.inRepo,
          line: finding.line ?? null,
          category: finding.category || '',
          severity: finding.severity || '',
          kind: finding.kind || '',
          advisory: finding.advisory === true,
          occurrences: 0,
          sessions: new Set(),
          statuses: new Set(),
          firstSeen: generatedAt,
          lastSeen: generatedAt,
        })
      }
      const e = byKey.get(key)
      e.occurrences++
      if (session) e.sessions.add(session)
      if (finding.status) e.statuses.add(finding.status)
      if (generatedAt && generatedAt < e.firstSeen) e.firstSeen = generatedAt
      if (generatedAt && generatedAt > e.lastSeen) e.lastSeen = generatedAt
    }
  }

  const alerts = [...byKey.values()]
    .map((e) => ({
      findingId: e.findingId,
      file: e.file,
      inRepo: e.inRepo,
      line: e.line,
      category: e.category,
      severity: e.severity,
      kind: e.kind,
      advisory: e.advisory,
      occurrences: e.occurrences,
      sessions: [...e.sessions].sort(),
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
      statuses: [...e.statuses].sort(),
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.file.localeCompare(b.file))

  const byCategory = {}
  const bySeverity = {}
  for (const a of alerts) {
    byCategory[a.category] = (byCategory[a.category] || 0) + 1
    bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1
  }

  const out = {
    source: '.mimosa/reports/*.json',
    extractedBy: 'scripts/extract-alerts.mjs',
    reportFiles: files.length,
    rawFindingRecords: rawRecords,
    uniqueAlerts: alerts.length,
    byCategory,
    bySeverity,
    alerts,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8')

  console.error(
    `[extract-alerts] 报告 ${files.length} 份 / 原始记录 ${rawRecords} 条 / 去重后 ${alerts.length} 条告警\n` +
      `  分类：${JSON.stringify(byCategory)}\n` +
      `  严重级：${JSON.stringify(bySeverity)}\n` +
      `  已写入：${OUT}`
  )
}

main()
