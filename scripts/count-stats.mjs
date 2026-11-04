#!/usr/bin/env node
// ---------------------------------------------------------------------------
// count-stats.mjs —— 规模统计的可复算脚本
//
// 目的：技术文档里出现的每个数字（源码行数 / 测试文件数 / 用例数 / 断言数）
//       都能由评审者用一条命令独立复算，而不是只能相信文档。
//
// 用法：
//   node scripts/count-stats.mjs              # 静态统计 + 写出 docs/stats.json
//   node scripts/count-stats.mjs --vitest     # 额外跑一次 vitest（JSON reporter）拿权威用例数
//   node scripts/count-stats.mjs --check      # 只比对，不写文件（CI 用；不一致则退出码 1）
//   node scripts/count-stats.mjs --help
//
// 计数口径（口径本身就是证据的一部分，故在此显式写死）：
//   1. 统计范围只含 src/ 与 tests/ 两个目录；docs/、scripts/、build/ 一律不计入，
//      因为它们是「关于项目的材料」而不是「产品本体」。
//   2. 行数 = 物理行数（physical lines），即 wc -l 的结果，含空行与注释行。
//      同时另算「代码行」= 物理行 − 空行 − 纯注释行，供评审者按需引用。
//      注释识别规则：整行以 // 或 * 或 /* 或 */ 开头（可含前导空白）算注释行；
//      行内注释不扣除（保守，宁可高估不低估）。
//   3. 测试文件 = 匹配 vitest include 规则 tests/**/*.test.ts 的文件；
//      tests/helpers/ 下的公共替身单列为「测试支撑文件」，不计入「测试文件数」，
//      但其行数计入「测试代码行数」（它们是测试代码的一部分）。
//   4. 断言数 = 测试文件中 expect( 的出现次数（含 expect.soft / expect(...).rejects 等变体）。
//      这是静态计数，与运行时实际执行次数可能不同（一个 expect 可被多次调用）。
//      权威的「用例数」以 vitest 实际运行结果为准（--vitest）。
//   5. 用例数的静态估算 = it( 与 test( 的出现次数；它可能与实际不符
//      （例如在循环里生成用例），因此本脚本把它标为 estimate，
//      真实值以 --vitest 的运行结果为准。
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
const wantHelp = argv.includes('--help') || argv.includes('-h')
const wantVitest = argv.includes('--vitest')
const checkOnly = argv.includes('--check')

// ---- 统计口径常量（写进输出，便于机器核对） --------------------------------
const EXCLUSION_RULES = {
  includedRoots: ['src/', 'tests/'],
  excludedRoots: ['docs/', 'scripts/', 'build/', 'out/', 'dist/', 'node_modules/'],
  lineKind: 'physical-lines (wc -l 等价)；另计 codeLines = 物理行 − 空行 − 纯注释行',
  commentRule: '整行以 // * /* */ 开头（允许前导空白）视为纯注释行；行内注释不扣除',
  testFileRule: 'tests/**/*.test.ts（与 vitest.config.ts 的 include 一致）',
  helperRule: 'tests/helpers/** 为测试支撑文件，单独统计，行数计入测试代码行数',
  assertionRule: '测试文件中 expect( 的出现次数（含 expect.soft / .rejects / .resolves 等变体）',
  testCaseEstimateRule:
    'it( 与 test( 的出现次数，仅为静态估算且为【下界】：位于 for 循环体内的 it( 每轮只计 1 次，' +
    '实际展开的用例数更多。权威值以 vitest 运行结果为准（--vitest）或 docs/stats.json 的 vitest 字段',
}

function printHelp() {
  console.log(`count-stats.mjs —— 复算技术文档中的规模数字

用法：
  node scripts/count-stats.mjs              静态统计并写出 docs/stats.json
  node scripts/count-stats.mjs --vitest     额外运行 vitest（JSON reporter）取权威用例数
  node scripts/count-stats.mjs --check      只比对不写文件；与现有 docs/stats.json 不一致则退出码 1
  node scripts/count-stats.mjs --help       显示本帮助

输出：docs/stats.json（含口径常量，便于第三方核对）`)
}

// ---- 目录遍历 -------------------------------------------------------------
/** 递归列出目录下的所有文件（返回绝对路径数组） */
function walk(dir) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

/** 判断某行是否为「纯注释行」 */
function isCommentOnly(line) {
  const t = line.trim()
  if (t === '') return true
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')
}

/** 统计单个文件的行数与代码行数 */
function countFileLines(absPath) {
  const text = fs.readFileSync(absPath, 'utf8')
  // 按 \n 切分；末尾若为空串（文件以 \n 结尾）不计为一行，与 wc -l 语义一致
  const lines = text.length === 0 ? [] : text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  let codeLines = 0
  for (const l of lines) if (!isCommentOnly(l)) codeLines++
  return { physical: lines.length, code: codeLines }
}

// ---- 主统计 ---------------------------------------------------------------
function collectStats() {
  const srcRoot = path.join(REPO_ROOT, 'src')
  const testsRoot = path.join(REPO_ROOT, 'tests')

  const srcFiles = walk(srcRoot).filter((p) => CODE_EXT.has(path.extname(p)))
  const testAll = walk(testsRoot).filter((p) => CODE_EXT.has(path.extname(p)))
  // 测试文件：与 vitest include 规则一致 —— tests 下任意层级的 *.test.ts
  const testFiles = testAll.filter((p) => p.endsWith('.test.ts'))
  const helperFiles = testAll.filter((p) => !p.endsWith('.test.ts'))

  const sum = (files) => {
    let physical = 0
    let code = 0
    for (const f of files) {
      const c = countFileLines(f)
      physical += c.physical
      code += c.code
    }
    return { physical, code }
  }

  const srcSum = sum(srcFiles)
  const testSum = sum(testFiles)
  const helperSum = sum(helperFiles)

  // 断言数：测试文件中的 expect( 出现次数
  let assertions = 0
  for (const f of testFiles) {
    const text = fs.readFileSync(f, 'utf8')
    const m = text.match(/\bexpect(?:\.[A-Za-z]+)?\s*\(/g)
    if (m) assertions += m.length
  }

  // 用例数静态估算：it( / test( 出现次数
  // 注意：位于 for 循环体内的 it( 每轮只计 1 次，实际展开的用例数更多，
  // 因此这里是【下界】。权威值必须用 --vitest 实测。
  let caseEstimate = 0
  for (const f of testFiles) {
    const text = fs.readFileSync(f, 'utf8')
    const m = text.match(/\b(?:it|test)\s*\(/g)
    if (m) caseEstimate += m.length
  }

  // 逐文件明细（便于第三方核对任一行的来源）
  const perFile = (files) =>
    files
      .map((f) => {
        const c = countFileLines(f)
        return { file: path.relative(REPO_ROOT, f).split(path.sep).join('/'), ...c }
      })
      .sort((a, b) => b.physical - a.physical)

  return {
    generatedBy: 'scripts/count-stats.mjs',
    repoRoot: REPO_ROOT,
    platform: { os: os.platform(), release: os.release(), node: process.version },
    rules: EXCLUSION_RULES,
    source: {
      files: srcFiles.length,
      physicalLines: srcSum.physical,
      codeLines: srcSum.code,
      perFile: perFile(srcFiles),
    },
    tests: {
      testFiles: testFiles.length,
      helperFiles: helperFiles.length,
      physicalLines: testSum.physical + helperSum.physical,
      codeLines: testSum.code + helperSum.code,
      testOnlyPhysicalLines: testSum.physical,
      helperPhysicalLines: helperSum.physical,
      assertionCountStatic: assertions,
      testCaseCountStaticEstimate: caseEstimate,
      perFile: perFile(testAll),
    },
    ratio: {
      productionToTestPhysical: +(srcSum.physical / Math.max(1, testSum.physical + helperSum.physical)).toFixed(2),
    },
    vitest: null,
  }
}

/** 运行 vitest 取权威用例数（可选） */
function runVitest() {
  const tmp = path.join(os.tmpdir(), `skillvault-stats-${process.pid}.json`)
  // 直接调用 vitest 的 JS 入口（node_modules/vitest/vitest.mjs）——
  // 不走 .cmd 包装（Windows 上 spawn .cmd 会 EINVAL），也不走 npx（避免联网解析）。
  const vitestEntry = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs')
  if (!fs.existsSync(vitestEntry)) {
    return { ok: false, error: '未找到 node_modules/vitest/vitest.mjs，请先执行 pnpm install' }
  }
  try {
    execFileSync(process.execPath, [vitestEntry, 'run', '--reporter=json', `--outputFile=${tmp}`], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      timeout: 10 * 60 * 1000,
      shell: false,
    })
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 400) }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'))
    return {
      ok: true,
      testFiles: (raw.testResults ?? []).length,
      testCases: raw.numTotalTests,
      passed: raw.numPassedTests,
      failed: raw.numFailedTests,
      success: raw.success === true,
      durationMs: typeof raw.startTime === 'number' ? Date.now() - raw.startTime : null,
    }
  } catch (e) {
    return { ok: false, error: '解析 vitest 报告失败: ' + String(e?.message ?? e).slice(0, 400) }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 临时文件删除失败不影响结果 */
    }
  }
}

// ---- 输出 -----------------------------------------------------------------
function main() {
  if (wantHelp) {
    printHelp()
    return
  }

  const stats = collectStats()
  if (wantVitest) {
    const v = runVitest()
    stats.vitest = v
    if (v.ok && typeof v.testCases === 'number') stats.tests.testCasesAuthoritative = v.testCases
  } else {
    // 未显式要求跑 vitest 时，也尝试复用仓库中已有的最近一次实测结果（若存在）
    const prevPath = path.join(REPO_ROOT, 'docs', 'stats.json')
    if (fs.existsSync(prevPath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'))
        if (prev.vitest && prev.vitest.ok) {
          stats.vitest = { ...prev.vitest, reusedFromPreviousRun: true }
          if (typeof prev.tests?.testCasesAuthoritative === 'number') {
            stats.tests.testCasesAuthoritative = prev.tests.testCasesAuthoritative
          }
        }
      } catch {
        /* 既有文件损坏则忽略，重新统计 */
      }
    }
  }

  const outPath = path.join(REPO_ROOT, 'docs', 'stats.json')
  const serialized = JSON.stringify(stats, null, 2) + '\n'

  if (checkOnly) {
    if (!fs.existsSync(outPath)) {
      console.error('CHECK FAILED: docs/stats.json 不存在')
      process.exit(1)
    }
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    const cmp = (a, b) => {
      const keys = ['source', 'tests']
      for (const k of keys) {
        for (const f of Object.keys(a[k] ?? {})) {
          if (typeof a[k][f] === 'number' && a[k][f] !== b[k]?.[f]) {
            return `${k}.${f}: 现有 ${b[k]?.[f]} ≠ 重算 ${a[k][f]}`
          }
        }
      }
      return null
    }
    const diff = cmp(stats, prev)
    if (diff) {
      console.error('CHECK FAILED: ' + diff)
      process.exit(1)
    }
    console.log('CHECK OK: 文档中的规模数字与当前工作树一致')
    return
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, serialized, 'utf8')

  // stdout：机器可读；stderr：人可读摘要
  process.stdout.write(serialized)
  const v = stats.vitest
  console.error(
    [
      '—— 规模统计完成 ——',
      `源码：${stats.source.files} 文件 / ${stats.source.physicalLines} 物理行（代码行 ${stats.source.codeLines}）`,
      `测试：${stats.tests.testFiles} 测试文件 + ${stats.tests.helperFiles} 支撑文件 / ${stats.tests.physicalLines} 行`,
      `断言（静态）：${stats.tests.assertionCountStatic}`,
      `用例（静态估算）：${stats.tests.testCaseCountStaticEstimate}` +
        (v && v.ok ? `；vitest 实测：${v.testCases}（通过 ${v.passed} / 失败 ${v.failed}）` : ''),
      `已写入：docs/stats.json`,
    ].join('\n')
  )
}

main()
