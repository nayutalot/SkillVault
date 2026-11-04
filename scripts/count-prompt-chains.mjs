#!/usr/bin/env node
// ---------------------------------------------------------------------------
// count-prompt-chains.mjs —— 会话导出快照（Prompt 链）的可复算计数脚本
//
// 目的：技术文档引用了四条 AI 协同会话导出（docs/prompt-chains/*.md）中
//       「人的输入 / 系统消息 / AI 回复 / 工具调用」四个数字。盲评要求这些数字
//       必须能被第三方用一条命令独立复算，而不是只能相信文档里的断言。
//       本脚本从 Markdown 导出体的**实际结构**重新推导这些数字，并与导出体
//       末尾「## 消息来源统计」表里项目自述的数字逐项比对，差异写进输出。
//
// 用法：
//   node scripts/count-prompt-chains.mjs            # 复算并写出 docs/prompt-chain-stats.json
//   node scripts/count-prompt-chains.mjs --check    # 只比对：与现有 JSON 不一致则退出码 1
//   node scripts/count-prompt-chains.mjs --no-db    # 跳过会话库旁证（纯 Markdown 复算）
//   node scripts/count-prompt-chains.mjs --db <路径> # 指定会话库做旁证（默认 ~/.zcode/cli/db/db.sqlite）
//   node scripts/count-prompt-chains.mjs --help
//
// ---------------------------------------------------------------------------
// 计数口径（口径本身即证据，故在此写死）
// ---------------------------------------------------------------------------
// 1) 人的输入（humanInputsRaw）
//    = 导出体中形如 `### 提问 N（人的输入）` 的头部行数量。
//    头部识别不依赖围栏状态：导出体里出现的每一行 `### 提问 N（人的输入）`
//    都是一次真实提问（已与源会话库逐条比对，见 corroboration 段）。
//
// 2) 人的输入（humanInputsDistinct）
//    = 把每个提问块的 ```text 围栏内容按「去除首尾空白后的完整文本」做精确去重后的个数。
//    口径说明：同一条人工输入在会话库中可能重复落库（导出体头部注释明确写了
//    「同一条人工输入在会话库中可能重复落库，已按内容去重后计数」）。
//    本脚本同时输出 raw 与 distinct 两个数字，并指出哪一个与导出体自述数字相符。
//    注意：去重是**精确文本去重**，不做前缀/包含去重——例如链一的「提问 1」与
//    「提问 2」是「同一段话」与「同一段话 + 追加一句」，文本不同，各自计一次。
//
// 3) AI 回复（aiReplies）
//    = 导出体中形如 `### 回应 N（AI 回复）` 的头部行数量。
//    每个头部即一条回复；**正文为空的回复（只有头部、没有文本围栏）同样计入**，
//    因为导出体保留的就是「一次回复 = 一个头部」这一层事实（这类回复在源库中
//    是纯工具调用轮次，正文为空但确实发生过）。
//
// 4) 工具调用总次数（toolCallsSummed）
//    = 所有回复头部中 `工具调用 K 次` 的 K 之和。
//    头部形如：`### 回应 N（AI 回复）  ·  模型 `X` · <时间戳> · 工具调用 K 次（Tool1、Tool2）`
//    部分回复头部没有「工具调用」段（该轮没有工具调用），按 0 计。
//
// 5) 工具名清单条目数（toolNamesListed）
//    = 所有回复头部括号里列出的工具**名目个数**之和（`（Bash、Read）` = 2）。
//    它与 K 之和一般不相等，原因是：括号里列的是**去重后的工具种类**，
//    而 K 是该轮工具的**实际调用次数**。例：`工具调用 4 次（Agent、Bash）`
//    表示本轮调用了 4 次工具，工具种类有 2 种（Bash 被调用了 3 次）。
//    两个数字都输出，并给出差值与成因。
//
// 6) 系统消息（systemMessages）
//    **Markdown 导出体无法复算**，脚本如实标注 derivable=false，不猜数。
//    原因：导出体只保留了两类带角色标注的头部（「提问」「回应」），
//    会话框架注入的消息（todo_reminder / goal-continuation / background_task
//    一类）在导出时已被剔除，正文里没有留下任何可数的标记
//    （全文不含 <system-reminder>、「系统消息」标签或 role 字段）。
//    若评审者本机存在源会话库（~/.zcode/cli/db/db.sqlite），脚本会做一次**旁证**：
//    按「role=user 且 (synthetic=true 或 metadata.visibility='model-only')」
//    统计框架注入消息条数，与导出体自述的系统消息数比对；旁证结果记在
//    systemMessages.corroboration 下，旁证不可用时如实记 available=false。
//
// 7) 本脚本只读，不修改 docs/prompt-chains/*.md 与任何其他仓库文件。
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const CHAIN_DIR = path.join(REPO_ROOT, 'docs', 'prompt-chains')
const OUT_FILE = path.join(REPO_ROOT, 'docs', 'prompt-chain-stats.json')
const DEFAULT_DB = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite')

// ---- 参数 ----------------------------------------------------------------
const argv = process.argv.slice(2)
const wantHelp = argv.includes('--help') || argv.includes('-h')
const checkOnly = argv.includes('--check')
const noDb = argv.includes('--no-db')
const dbFlagIndex = argv.indexOf('--db')
const dbPath = dbFlagIndex >= 0 && argv[dbFlagIndex + 1] ? path.resolve(argv[dbFlagIndex + 1]) : DEFAULT_DB

const METHOD = {
  humanInputsRaw:
    '人的输入（原始）：导出体中匹配 `### 提问 N（人的输入）` 的头部行数。头部识别不依赖代码围栏状态。',
  humanInputsDistinct:
    "人的输入（去重）：对每个提问块的 ```text 围栏内容做「去首尾空白后的精确文本去重」后的个数；导出体自述口径为「同一条人工输入在会话库中可能重复落库，已按内容去重后计数」。不做前缀或包含去重。",
  aiReplies:
    'AI 回复：匹配 `### 回应 N（AI 回复）` 的头部行数。正文为空的回复（无文本围栏）同样计入，因导出体中「一次回复 = 一个头部」。',
  toolCallsSummed:
    '工具调用总次数：所有回复头部中 `工具调用 K 次` 的 K 之和；头部无该段者按 0 计。',
  toolNamesListed:
    '工具名清单条目数：所有回复头部括号内列出的工具名个数之和（`（Bash、Read）` 计 2）。括号内是去重后的工具种类，K 是实际调用次数，故两者一般不等。',
  systemMessages:
    '系统消息：**Markdown 导出体不可复算**（derivable=false）。导出体只保留「提问」「回应」两类带角色标注的头部，框架注入消息在导出时已被剔除且未留下可数标记。脚本不猜数；若源会话库可用则给出旁证。',
  comparison:
    '比对口径：复算值与导出体「## 消息来源统计」表逐项比对；差异写入 mismatches 数组，不修改任何 Markdown。',
  scope:
    '只读脚本：不修改 docs/prompt-chains/*.md，不修改仓库其他文件；仅在默认模式下写出 docs/prompt-chain-stats.json。',
}

function printHelp() {
  console.log(`count-prompt-chains.mjs —— 复算四条 AI 协同会话导出（docs/prompt-chains/*.md）里的消息计数

用法：
  node scripts/count-prompt-chains.mjs              复算并写出 docs/prompt-chain-stats.json
  node scripts/count-prompt-chains.mjs --check      只比对：与现有 JSON 不一致（或存在与自述数字的差异）则退出码 1
  node scripts/count-prompt-chains.mjs --no-db      跳过会话库旁证，只做纯 Markdown 复算
  node scripts/count-prompt-chains.mjs --db <路径>  指定会话库做旁证（默认 ${DEFAULT_DB}）
  node scripts/count-prompt-chains.mjs --help       显示本帮助

输出：docs/prompt-chain-stats.json（含 method 口径常量，便于第三方核对）
退出码：0 = 一致；1 = --check 发现差异`)
}

if (wantHelp) {
  printHelp()
  process.exit(0)
}

// ---- Markdown 解析 --------------------------------------------------------
const HEADER_RE = /^###\s+(提问|回应)\s*(\d+)（(人的输入|AI 回复)）\s*(.*)$/
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/
const TOOL_RE = /工具调用\s*(\d+)\s*次(?:（([^）]*)）)?/
const SESSION_RE = /^##\s+会话\s+`([^`]+)`/
const STATED_ROWS = {
  '人的输入（去重后）': 'humanInputs',
  '人的输入': 'humanInputs',
  '系统/工具消息': 'systemMessages',
  '系统消息': 'systemMessages',
  'AI 回复（含工具调用）': 'aiReplies',
  'AI 回复': 'aiReplies',
  '工具调用总次数': 'toolCalls',
}

/** 把导出体按「头部 → 下一个头部」切成块 */
function splitBlocks(lines) {
  const headers = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADER_RE)
    if (m) headers.push({ index: i, kind: m[1], number: Number(m[2]), label: m[3], tail: m[4] ?? '' })
  }
  return headers.map((h, k) => ({
    ...h,
    segment: lines.slice(h.index + 1, k + 1 < headers.length ? headers[k + 1].index : lines.length),
  }))
}

/** 取块内第一个围栏的内容（提问块恒为 ```text ... ```） */
function firstFencedContent(segment) {
  const openIdx = segment.findIndex((l) => FENCE_RE.test(l))
  if (openIdx < 0) return { present: false, content: '', info: null }
  const info = (segment[openIdx].match(FENCE_RE)[2] ?? '').trim()
  // 关闭围栏：裸 ```（无 info string）
  let closeIdx = -1
  for (let i = openIdx + 1; i < segment.length; i++) {
    const m = segment[i].match(FENCE_RE)
    if (m && (m[2] ?? '').trim() === '') {
      closeIdx = i
      break
    }
  }
  const content = segment.slice(openIdx + 1, closeIdx < 0 ? segment.length : closeIdx).join('\n')
  return { present: true, content, info }
}

/** 解析导出体「## 消息来源统计」表 */
function parseStatedTable(lines) {
  const start = lines.findIndex((l) => l.trim() === '## 消息来源统计')
  const stated = {}
  if (start < 0) return stated
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s/.test(line)) break
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|/)
    if (!m) continue
    const key = STATED_ROWS[m[1].trim()]
    if (key && stated[key] === undefined) stated[key] = Number(m[2])
  }
  return stated
}

function analyzeChain(fileName) {
  const abs = path.join(CHAIN_DIR, fileName)
  const text = fs.readFileSync(abs, 'utf8')
  const lines = text.split(/\r?\n/)
  const blocks = splitBlocks(lines)

  const questions = blocks.filter((b) => b.kind === '提问')
  const replies = blocks.filter((b) => b.kind === '回应')

  const questionTexts = questions.map((q) => firstFencedContent(q.segment).content.trim())
  const distinctQuestions = new Set(questionTexts)

  let toolCallsSummed = 0
  let toolNamesListed = 0
  let repliesWithToolHeader = 0
  let repliesWithEmptyBody = 0
  const toolNameSet = new Set()
  const toolKindMismatches = []
  for (const r of replies) {
    const tm = r.tail.match(TOOL_RE)
    const hasTextFence = firstFencedContent(r.segment).present
    if (!hasTextFence) repliesWithEmptyBody += 1
    if (!tm) continue
    repliesWithToolHeader += 1
    const k = Number(tm[1])
    const names = tm[2] ? tm[2].split('、').map((s) => s.trim()).filter(Boolean) : []
    toolCallsSummed += k
    toolNamesListed += names.length
    for (const n of names) toolNameSet.add(n)
    if (k !== names.length) {
      toolKindMismatches.push({
        replyNumber: r.number,
        toolCalls: k,
        listedKinds: names.length,
        kinds: names.join('、'),
      })
    }
  }

  const sessionLine = lines.find((l) => SESSION_RE.test(l))
  const sessionId = sessionLine ? sessionLine.match(SESSION_RE)[1] : null
  const title = (lines.find((l) => l.startsWith('# ')) ?? '').replace(/^#\s+/, '').trim()
  const stated = parseStatedTable(lines)

  return {
    file: `docs/prompt-chains/${fileName}`,
    title,
    sessionId,
    humanInputsRaw: questions.length,
    humanInputsDistinct: distinctQuestions.size,
    aiReplies: replies.length,
    toolCallsSummed,
    toolNamesListed,
    repliesWithToolHeader,
    repliesWithoutToolHeader: replies.length - repliesWithToolHeader,
    repliesWithEmptyBody,
    distinctToolKinds: [...toolNameSet].sort(),
    toolKindMismatches,
    statedInFile: {
      humanInputs: stated.humanInputs ?? null,
      systemMessages: stated.systemMessages ?? null,
      aiReplies: stated.aiReplies ?? null,
      toolCalls: stated.toolCalls ?? null,
    },
  }
}

// ---- 会话库旁证（可选） ----------------------------------------------------
async function crossCheckWithDb(chain) {
  if (noDb) return { available: false, reason: '按 --no-db 跳过会话库旁证。' }
  if (!chain.sessionId) return { available: false, reason: '导出体中未找到会话 ID，无法定位会话库记录。' }
  if (!fs.existsSync(dbPath)) {
    return { available: false, reason: `会话库不存在：${dbPath}（该文件为本机私有数据，不随仓库分发）。` }
  }
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch (err) {
    return { available: false, reason: `当前 Node 不提供 node:sqlite（${err.message}）。` }
  }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (err) {
    return { available: false, reason: `无法以只读方式打开会话库：${err.message}` }
  }
  try {
    const rows = db
      .prepare(
        `SELECT m.id AS mid, m.data AS mdata, p.data AS pdata
           FROM message m LEFT JOIN part p ON p.message_id = m.id
          WHERE m.session_id = ? ORDER BY m.sequence, p.sequence`,
      )
      .all(chain.sessionId)

    const messages = new Map()
    for (const row of rows) {
      if (!messages.has(row.mid)) messages.set(row.mid, { meta: JSON.parse(row.mdata), parts: [] })
      if (row.pdata) messages.get(row.mid).parts.push(JSON.parse(row.pdata))
    }

    let plainUser = 0
    let injectedUser = 0
    let assistant = 0
    let assistantWithTool = 0
    let assistantTextOnly = 0
    let assistantNoTextNoTool = 0
    let assistantWithText = 0
    let assistantEmptyText = 0
    let toolParts = 0
    let distinctToolKindSum = 0
    const humanTexts = []

    for (const { meta, parts } of messages.values()) {
      if (meta.role === 'user') {
        const md = meta.metadata ?? {}
        const injected = meta.synthetic === true || md.visibility === 'model-only'
        if (injected) {
          injectedUser += 1
          continue
        }
        plainUser += 1
        humanTexts.push(parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n'))
        continue
      }
      if (meta.role !== 'assistant') continue
      assistant += 1
      const tools = parts.filter((p) => p.type === 'tool')
      const texts = parts.filter((p) => p.type === 'text')
      const hasText = texts.some((p) => (p.text ?? '').trim() !== '')
      if (tools.length) {
        assistantWithTool += 1
        toolParts += tools.length
        distinctToolKindSum += new Set(tools.map((t) => t.tool)).size
      } else if (hasText) {
        assistantTextOnly += 1
      } else {
        assistantNoTextNoTool += 1
      }
      if (hasText) assistantWithText += 1
      else assistantEmptyText += 1
    }

    const distinctHuman = new Set(humanTexts.map((t) => t.trim())).size
    const injectedSources = new Map()
    for (const { meta } of messages.values()) {
      if (meta.role !== 'user') continue
      const md = meta.metadata ?? {}
      if (!(meta.synthetic === true || md.visibility === 'model-only')) continue
      const key = `${md.source ?? '(无 source 字段)'} / visibility=${md.visibility ?? '(无)'}`
      injectedSources.set(key, (injectedSources.get(key) ?? 0) + 1)
    }

    return {
      available: true,
      sessionId: chain.sessionId,
      dbPath,
      method:
        '源会话库 message/part 表：role=user 且 (synthetic=true 或 metadata.visibility=model-only) 的消息计为框架注入的系统消息；其余 role=user 为人工输入（按完整文本精确去重）；role=assistant 且含 tool part 的计为带工具调用的回复。',
      injectedUserMessages: injectedUser,
      injectedUserSources: Object.fromEntries(injectedSources),
      plainUserMessages: plainUser,
      distinctHumanTexts: distinctHuman,
      assistantMessages: assistant,
      assistantWithTool,
      assistantTextOnly,
      assistantNoTextNoTool,
      assistantWithText,
      assistantEmptyText,
      toolParts,
      distinctToolKindSum,
      comparesWithMarkdown: {
        humanInputsDistinct: distinctHuman === chain.humanInputsDistinct,
        aiReplies: assistantWithTool + assistantTextOnly === chain.aiReplies,
        toolCalls: toolParts === chain.toolCallsSummed,
        toolNamesListed: distinctToolKindSum === chain.toolNamesListed,
        repliesWithEmptyBody:
          assistantEmptyText - assistantNoTextNoTool === chain.repliesWithEmptyBody,
      },
      note:
        '导出体省略了既无文本也无工具的助手消息（模型切换分隔线、被取消的模型请求），故源库 assistant 条数比导出体「回应」头部数略多；这不影响任何一项计数口径。',
    }
  } catch (err) {
    return { available: false, reason: `会话库查询失败：${err.message}` }
  } finally {
    try {
      db.close()
    } catch {
      /* 忽略关闭异常 */
    }
  }
}

// ---- 主流程 ---------------------------------------------------------------
async function main() {
  if (!fs.existsSync(CHAIN_DIR)) {
    console.error(`[count-prompt-chains] 目录不存在：${CHAIN_DIR}`)
    process.exit(2)
  }
  const files = fs.readdirSync(CHAIN_DIR).filter((f) => f.endsWith('.md')).sort()
  if (files.length === 0) {
    console.error(`[count-prompt-chains] ${CHAIN_DIR} 下没有 .md 文件`)
    process.exit(2)
  }

  const chains = []
  for (const fileName of files) {
    const chain = analyzeChain(fileName)
    const cross = await crossCheckWithDb(chain)
    const stated = chain.statedInFile

    chain.systemMessages = {
      derivable: false,
      value: null,
      reason:
        'Markdown 导出体不可复算：导出体只保留「提问」「回应」两类带角色标注的头部，会话框架注入的消息在导出时已被剔除，正文中没有留下 <system-reminder>、「系统消息」标签或 role 字段等任何可计数的标记。因此脚本不猜测该数字，只在会话库可用时给出旁证。',
      statedInFile: stated.systemMessages,
      corroboration: cross,
    }

    chain.matchesStated = {
      humanInputs: stated.humanInputs === null ? null : chain.humanInputsDistinct === stated.humanInputs,
      humanInputsRaw: stated.humanInputs === null ? null : chain.humanInputsRaw === stated.humanInputs,
      aiReplies: stated.aiReplies === null ? null : chain.aiReplies === stated.aiReplies,
      toolCalls: stated.toolCalls === null ? null : chain.toolCallsSummed === stated.toolCalls,
      systemMessages: null,
    }
    chain.humanInputsCountBasis = chain.humanInputsRaw === chain.humanInputsDistinct
      ? '导出体已按内容去重，raw 与 distinct 相同，且与自述数字一致。'
      : `自述数字对应${chain.matchesStated.humanInputs ? '去重后' : '原始'}口径。`
    chains.push(chain)
  }

  const totals = {
    humanInputsRaw: sum(chains.map((c) => c.humanInputsRaw)),
    humanInputsDistinct: sum(chains.map((c) => c.humanInputsDistinct)),
    aiReplies: sum(chains.map((c) => c.aiReplies)),
    toolCallsSummed: sum(chains.map((c) => c.toolCallsSummed)),
    toolNamesListed: sum(chains.map((c) => c.toolNamesListed)),
    repliesWithToolHeader: sum(chains.map((c) => c.repliesWithToolHeader)),
    repliesWithEmptyBody: sum(chains.map((c) => c.repliesWithEmptyBody)),
    statedInFile: {
      humanInputs: sum(chains.map((c) => c.statedInFile.humanInputs ?? 0)),
      systemMessages: sum(chains.map((c) => c.statedInFile.systemMessages ?? 0)),
      aiReplies: sum(chains.map((c) => c.statedInFile.aiReplies ?? 0)),
      toolCalls: sum(chains.map((c) => c.statedInFile.toolCalls ?? 0)),
    },
    matchesStated: {
      humanInputs: chains.every((c) => c.matchesStated.humanInputs !== false),
      aiReplies: chains.every((c) => c.matchesStated.aiReplies !== false),
      toolCalls: chains.every((c) => c.matchesStated.toolCalls !== false),
      systemMessages: null,
    },
  }

  const mismatches = []
  for (const c of chains) {
    pushMismatch(mismatches, c, 'humanInputs', c.humanInputsDistinct, c.statedInFile.humanInputs)
    pushMismatch(mismatches, c, 'aiReplies', c.aiReplies, c.statedInFile.aiReplies)
    pushMismatch(mismatches, c, 'toolCalls', c.toolCallsSummed, c.statedInFile.toolCalls)
  }

  const undetermined = [
    {
      metric: 'systemMessages',
      scope: `全部 ${chains.length} 条会话导出`,
      reason:
        '导出体不承载系统消息的可数标记，无法从 Markdown 复算；脚本标注 derivable=false，不猜数。',
      statedInFile: totals.statedInFile.systemMessages,
      corroborationAvailable: chains.some((c) => c.systemMessages.corroboration?.available),
      corroborationMatches:
        chains.every(
          (c) =>
            !c.systemMessages.corroboration?.available ||
            c.systemMessages.corroboration.injectedUserMessages === c.statedInFile.systemMessages,
        ),
    },
  ]

  const result = {
    generatedBy: 'scripts/count-prompt-chains.mjs',
    schemaVersion: 1,
    method: METHOD,
    chains: chains.map((c) => ({
      file: c.file,
      title: c.title,
      sessionId: c.sessionId,
      humanInputsRaw: c.humanInputsRaw,
      humanInputsDistinct: c.humanInputsDistinct,
      aiReplies: c.aiReplies,
      toolCallsSummed: c.toolCallsSummed,
      toolNamesListed: c.toolNamesListed,
      repliesWithToolHeader: c.repliesWithToolHeader,
      repliesWithoutToolHeader: c.repliesWithoutToolHeader,
      repliesWithEmptyBody: c.repliesWithEmptyBody,
      distinctToolKinds: c.distinctToolKinds,
      toolKindMismatches: c.toolKindMismatches,
      humanInputsCountBasis: c.humanInputsCountBasis,
      systemMessages: c.systemMessages,
      statedInFile: c.statedInFile,
      matchesStated: c.matchesStated,
    })),
    totals,
    mismatches,
    undetermined,
  }

  const projection = projectForComparison(result)

  if (checkOnly) {
    if (!fs.existsSync(OUT_FILE)) {
      console.error(`[count-prompt-chains] --check：${OUT_FILE} 不存在，无法比对`)
      process.exit(1)
    }
    const existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'))
    const a = stable(projection)
    const b = stable(projectForComparison(existing))
    const same = a === b
    console.log(`[count-prompt-chains] --check：与 ${path.relative(REPO_ROOT, OUT_FILE)} 比对 —— ${same ? '一致' : '不一致'}`)
    if (!same) {
      console.error('[count-prompt-chains] 差异明细（左=本次复算，右=文件内容）：')
      console.error(diffLines(a, b).join('\n'))
      process.exit(1)
    }
    if (mismatches.length > 0) {
      console.error('[count-prompt-chains] 复算值与导出体自述数字存在差异：')
      for (const m of mismatches) console.error(`  ${m.file} · ${m.metric}：复算 ${m.recomputed} vs 自述 ${m.stated}`)
      process.exit(1)
    }
    process.exit(0)
  }

  fs.writeFileSync(OUT_FILE, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`[count-prompt-chains] 已写出 ${path.relative(REPO_ROOT, OUT_FILE)}`)
  for (const c of result.chains) {
    console.log(
      `  ${c.file}\n` +
        `    人的输入 raw=${c.humanInputsRaw} distinct=${c.humanInputsDistinct}（自述 ${c.statedInFile.humanInputs}）\n` +
        `    AI 回复=${c.aiReplies}（自述 ${c.statedInFile.aiReplies}）  空正文回复=${c.repliesWithEmptyBody}\n` +
        `    工具调用 K 和=${c.toolCallsSummed}（自述 ${c.statedInFile.toolCalls}）  工具名条目和=${c.toolNamesListed}\n` +
        `    系统消息：导出体不可复算（自述 ${c.statedInFile.systemMessages}）` +
        (c.systemMessages.corroboration?.available
          ? `，会话库旁证=${c.systemMessages.corroboration.injectedUserMessages}`
          : '，无旁证') +
        '（不猜数）',
    )
  }
  if (mismatches.length > 0) {
    console.warn('[count-prompt-chains] 注意：复算值与导出体自述数字存在差异（见 mismatches 数组）')
  }
  process.exit(0)
}

function sum(nums) {
  return nums.reduce((a, b) => a + b, 0)
}

function pushMismatch(list, chain, metric, recomputed, stated) {
  if (stated === null || stated === undefined) return
  if (recomputed === stated) return
  list.push({
    file: chain.file,
    metric,
    recomputed,
    stated,
    note:
      metric === 'toolCalls'
        ? '导出体自述的「工具调用总次数」应为各回复头部 K 之和。'
        : '导出体自述数字与按本脚本口径复算的结果不一致；脚本不修改 Markdown，差异如实记录。',
  })
}

/** 供 --check 比对的投影：剔除会话库旁证等环境相关字段，保证跨机器可比 */
function projectForComparison(stats) {
  return {
    schemaVersion: stats.schemaVersion,
    method: stats.method,
    chains: stats.chains.map((c) => ({
      file: c.file,
      title: c.title,
      humanInputsRaw: c.humanInputsRaw,
      humanInputsDistinct: c.humanInputsDistinct,
      aiReplies: c.aiReplies,
      toolCallsSummed: c.toolCallsSummed,
      toolNamesListed: c.toolNamesListed,
      repliesWithToolHeader: c.repliesWithToolHeader,
      repliesWithoutToolHeader: c.repliesWithoutToolHeader,
      repliesWithEmptyBody: c.repliesWithEmptyBody,
      distinctToolKinds: c.distinctToolKinds,
      toolKindMismatches: c.toolKindMismatches,
      humanInputsCountBasis: c.humanInputsCountBasis,
      systemMessages: {
        derivable: c.systemMessages.derivable,
        value: c.systemMessages.value,
        statedInFile: c.systemMessages.statedInFile,
      },
      statedInFile: c.statedInFile,
      matchesStated: c.matchesStated,
    })),
    totals: stats.totals,
    mismatches: stats.mismatches,
    undetermined: stats.undetermined.map((u) => ({
      metric: u.metric,
      scope: u.scope,
      reason: u.reason,
      statedInFile: u.statedInFile,
    })),
  }
}

function stable(value) {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k])
    return out
  }
  return value
}

function diffLines(a, b) {
  const al = JSON.stringify(sortKeys(JSON.parse(a)), null, 2).split('\n')
  const bl = JSON.stringify(sortKeys(JSON.parse(b)), null, 2).split('\n')
  const lines = []
  const max = Math.max(al.length, bl.length)
  for (let i = 0; i < max; i++) {
    if (al[i] !== bl[i]) lines.push(`  行 ${i + 1}\n    本次：${al[i] ?? '(缺)'}\n    文件：${bl[i] ?? '(缺)'}`)
  }
  return lines.slice(0, 60)
}

main().catch((err) => {
  console.error(`[count-prompt-chains] 运行失败：${err?.stack ?? err}`)
  process.exit(2)
})
