#!/usr/bin/env node
// ---------------------------------------------------------------------------
// source-manifest.mjs —— 生成「参赛提交 ↔ 源码内容」的对应清单
//
// WHY 需要它：技术文档封面原先印的是一个固定的 commit SHA，但仓库在提交那一刻还在变
//   ——文档写下的 SHA 与真正包含这份文档的提交永远差一步（自指悖论）。
//   解决办法是把「版本锚点」从文档正文里挪出来，放进一个可由脚本生成、可被独立复算的
//   清单文件：docs/source-manifest.json。文档只引用这个文件，评审者读它就知道
//   自己该 checkout 哪个提交、以及如何验证手上的源码与文档描述的是同一份。
//
// 清单里记录三样东西：
//   1) 提交锚点：包含本文档与全部源码的那一次提交（由 --commit 传入或自动取 HEAD）
//   2) src/ 内容指纹：SHA-256 over「相对路径 + 文件 SHA-256」的排序列表。
//      指纹与提交无关 —— 只要 src/ 的字节内容不变，指纹就不变，因此它可以独立校验
//      「我手上的源码是不是文档描述的那一份」。
//   3) 规模数字：直接引用 docs/stats.json（那个文件本身由 count-stats.mjs 生成）。
//
// 用法：
//   node scripts/source-manifest.mjs                  # 生成/更新清单（自动取 HEAD）
//   node scripts/source-manifest.mjs --commit <sha>   # 指定锚点提交
//   node scripts/source-manifest.mjs --check          # 只校验，不写文件
//   node scripts/source-manifest.mjs --print          # 只打印指纹与摘要，不写文件
//   node scripts/source-manifest.mjs --help
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const SRC_ROOT = path.join(REPO_ROOT, 'src')
const OUT = path.join(REPO_ROOT, 'docs', 'source-manifest.json')

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`source-manifest.mjs —— 生成「参赛提交 ↔ 源码内容」对应清单

用法：
  node scripts/source-manifest.mjs                生成/更新 docs/source-manifest.json（锚点取 HEAD）
  node scripts/source-manifest.mjs --commit <sha> 指定锚点提交
  node scripts/source-manifest.mjs --check        只校验，不写文件；不一致退出码 1
  node scripts/source-manifest.mjs --print        只打印摘要，不写文件
  node scripts/source-manifest.mjs --help         显示本帮助

清单内容：
  anchorCommit    包含本次参赛源码与文档的提交
  srcFingerprint  src/ 目录内容指纹（与提交无关，只随字节内容变化）
  stats           规模数字（引用 docs/stats.json）
  verify          评审者自行复核的命令`)
  process.exit(0)
}
const checkOnly = argv.includes('--check')
const printOnly = argv.includes('--print')
const commitIdx = argv.indexOf('--commit')
const anchorCommit = commitIdx >= 0 && argv[commitIdx + 1] ? argv[commitIdx + 1].trim() : null

/** 列出 src/ 下所有文件（相对路径，'/' 分隔，排序） */
function listSrcFiles() {
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push(path.relative(SRC_ROOT, p).split(path.sep).join('/'))
    }
  }
  walk(SRC_ROOT)
  return out.sort()
}

/** 单文件 SHA-256 */
function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

/**
 * src/ 内容指纹：把「相对路径\0文件 SHA-256」逐行拼起来再取 SHA-256。
 * WHY 这样定义：文件内容变 → 该行变 → 指纹变；文件增删 → 行数变 → 指纹变；
 * 而提交信息、作者、时间戳、分支名都不参与计算 —— 指纹只反映「源码字节内容」这一件事。
 */
function srcFingerprint() {
  const files = listSrcFiles()
  const h = crypto.createHash('sha256')
  for (const rel of files) {
    h.update(rel)
    h.update('\0')
    h.update(sha256File(path.join(SRC_ROOT, rel)))
    h.update('\n')
  }
  return { fingerprint: h.digest('hex'), fileCount: files.length }
}

/** 取一个 git 事实（失败返回 null） */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true
    }).trim()
  } catch {
    return null
  }
}

/** 当前 HEAD 提交 */
function headCommit() {
  return git(['rev-parse', 'HEAD'])
}

function buildManifest() {
  const { fingerprint, fileCount } = srcFingerprint()
  const commit = anchorCommit || headCommit()
  const statsPath = path.join(REPO_ROOT, 'docs', 'stats.json')
  let stats = null
  if (fs.existsSync(statsPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(statsPath, 'utf8'))
      stats = {
        sourceFiles: s.source?.files ?? null,
        sourcePhysicalLines: s.source?.physicalLines ?? null,
        sourceCodeLines: s.source?.codeLines ?? null,
        testFiles: s.tests?.testFiles ?? null,
        testPhysicalLines: s.tests?.physicalLines ?? null,
        assertionCountStatic: s.tests?.assertionCountStatic ?? null,
        testCasesAuthoritative: s.vitest?.testCases ?? null,
        testCasesPassed: s.vitest?.passed ?? null,
        testCasesFailed: s.vitest?.failed ?? null,
        generatedBy: s.generatedBy ?? null
      }
    } catch {
      stats = null
    }
  }
  return {
    schema: 'skillvault-source-manifest/1',
    purpose:
      '本清单是技术文档封面「源码版本」的实际指向：文档只引用本文件，不在正文里印固定 SHA，' +
      '避免文档与提交号互相指代的悖论。评审者按本文件的 anchorCommit checkout，即可得到文档描述的那一份源码与文档。',
    anchorCommit: commit,
    anchorCommitShort: commit ? commit.slice(0, 12) : null,
    anchorNote:
      'anchorCommit 指向**包含本次参赛全部源码与文档**的那次提交。若本清单是在该提交之后补写的，' +
      '补写它的那次提交只新增本文件一个条目，不改动任何源码或文档内容。',
    srcFingerprint: fingerprint,
    srcFileCount: fileCount,
    fingerprintMethod:
      'SHA-256 over「相对路径\\0文件 SHA-256」逐行拼接（src/ 下全部文件，按路径排序）',
    stats,
    verify: [
      'git checkout ' + (commit || '<anchorCommit>') + '   # 取到文档描述的那一份源码',
      'node scripts/source-manifest.mjs --check     # 校验 src/ 指纹与本清单一致（退出码 0 即一致）',
      'node scripts/count-stats.mjs --vitest        # 复算规模数字，与 docs/stats.json 比对',
      'node scripts/count-prompt-chains.mjs --check # 复算四条 Prompt 链的消息构成'
    ]
  }
}

function main() {
  const manifest = buildManifest()

  if (printOnly) {
    console.log(JSON.stringify(manifest, null, 2))
    return
  }

  if (checkOnly) {
    if (!fs.existsSync(OUT)) {
      console.error('CHECK FAILED: docs/source-manifest.json 不存在')
      process.exit(1)
    }
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'))
    const diffs = []
    if (prev.srcFingerprint !== manifest.srcFingerprint) {
      diffs.push(`srcFingerprint: 现有 ${prev.srcFingerprint} ≠ 重算 ${manifest.srcFingerprint}`)
    }
    if (prev.srcFileCount !== manifest.srcFileCount) {
      diffs.push(`srcFileCount: 现有 ${prev.srcFileCount} ≠ 重算 ${manifest.srcFileCount}`)
    }
    if (diffs.length) {
      console.error('CHECK FAILED:\n  ' + diffs.join('\n  '))
      process.exit(1)
    }
    console.log('CHECK OK: src/ 内容指纹与 docs/source-manifest.json 一致（提交锚点不参与校验）')
    return
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.error(
    `[source-manifest] 已写入 docs/source-manifest.json\n` +
      `  锚点提交   : ${manifest.anchorCommitShort || '(无 — 仓库尚未提交)'}\n` +
      `  src 指纹   : ${manifest.srcFingerprint}\n` +
      `  src 文件数 : ${manifest.srcFileCount}`
  )
}

main()
