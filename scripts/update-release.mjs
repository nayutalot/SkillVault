#!/usr/bin/env node
// ---------------------------------------------------------------------------
// update-release.mjs —— 更新 GitHub Release 的描述文本
//
// WHY：比赛盲审指出「公开 Release 又把远程推送列入完整功能，材料口径需要统一」——
//   Release 页把「经 SSH / Docker 把技能库分发到别的机器」列为完整功能，而技术文档
//   §4.4 与 §5.4.2 明确写着：远程目标目前是**框架状态**（接口与抽象已就位，未接入真实
//   远程目标，跨机远程同步的实际链路尚未经过真实验证）。同一件作品在两处对同��能力
//   的表述必须一致，否则评委按 Release 页理解就会高估已交付能力。
//
// 本脚本做的事：
//   1) 拉取当前 Release 的 body（原文，不改一个字，输出 diff 供复核）
//   2) 按规则改写：
//      - 「远程推送」从「完整功能」列表移出，改列入「实验性功能（未完成真实验证）」
//      - 「完整功能」标题改为「已验证可用的功能」
//      - 「关于数据」段落里「本软件不上传任何内容到云端」这句绝对表述改为限定表述
//        （伴生 CLI 自身不含网络代码，但 sync 会调用 git pull/push；版本中心 github 通道
//         与远程目标管理会访问外部网络）
//      - 末尾补一段「与源码仓库的关系」，说明 Release 标签指向的提交与当前 main 的
//        对应关系（src/ 字节级相同），并给出可复核命令
//   3) PUT 回 GitHub，输出前后对照
//
// 用法：
//   node scripts/update-release.mjs --dry-run     # 只打印将要提交的内容，不改线上
//   node scripts/update-release.mjs --apply       # 实际更新（需 GITHUB_PAT_TOKEN）
//   node scripts/update-release.mjs --help
//
// 凭据：只从环境变量 GITHUB_PAT_TOKEN 读取，脚本与仓库里都不写任何凭据字面量。
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`update-release.mjs —— 更新 GitHub Release 描述文本

用法：
  node scripts/update-release.mjs --dry-run   打印将要提交的内容（不改线上）
  node scripts/update-release.mjs --apply     实际更新 Release
  node scripts/update-release.mjs --help      显示本帮助

凭据：从环境变量 GITHUB_PAT_TOKEN 读取；仓库与本脚本内不含任何凭据字面量。
仓库：可通过 REPO_SLUG 环境变量覆盖，默认 nayutalot/SkillVault。
标签：可通过 RELEASE_TAG 环境变量覆盖，默认 v1.0.0。`)
  process.exit(0)
}
const dryRun = argv.includes('--dry-run')
const apply = argv.includes('--apply')
if (!dryRun && !apply) {
  console.error('请指定 --dry-run 或 --apply')
  process.exit(2)
}

const REPO_SLUG = process.env.REPO_SLUG || 'nayutalot/SkillVault'
const RELEASE_TAG = process.env.RELEASE_TAG || 'v1.0.0'
const TOKEN = process.env.GITHUB_PAT_TOKEN || ''

if (!TOKEN) {
  console.error('GITHUB_PAT_TOKEN 未设置 —— 本脚本只从环境变量读取凭据，不内置任何字面量。')
  process.exit(2)
}

const API = 'https://api.github.com'

/** 调 GitHub API（只读或更新 Release），返回解析后的 JSON */
async function api(pathname, init = {}) {
  const res = await fetch(API + pathname, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  if (!res.ok) {
    const msg = body && body.message ? body.message : res.status + ' ' + res.statusText
    throw new Error('GitHub API ' + res.status + ': ' + msg)
  }
  return body
}

/**
 * 改写 Release 正文。
 * 规则以「原文含什么」判定，不假设固定行号 —— 发布者可能手工改过文案。
 */
function rewrite(body) {
  const changes = []
  let out = body

  // 1) 完整功能 → 已验证可用的功能
  if (out.includes('## 完整功能')) {
    out = out.replace('## 完整功能', '## 已验证可用的功能')
    changes.push('「## 完整功能」→「## 已验证可用的功能」')
  }

  // 2) 远程推送：从完整功能列表移出（原文可能是加粗的 **远程推送** 或普通「远程推送：」）
  const remoteLine = /^- \*{0,2}远程推送\*{0,2}[：:].*$/m
  if (remoteLine.test(out)) {
    out = out.replace(remoteLine, '')
    changes.push('「远程推送」从已验证功能列表移出')
  } else {
    changes.push('注意：原文里未找到「远程推送」行，未做移出处理')
  }

  // 2b) 首段的「全程不经过任何云端」是绝对表述 —— 限定为「双侧同步链路」
  const introAbsolute = 'Windows 与 WSL 双侧互相同步，全程不经过任何云端。'
  if (out.includes(introAbsolute)) {
    out = out.replace(
      introAbsolute,
      'Windows 与 WSL 双侧互相同步，这条同步链路全程不经过任何云端。'
    )
    changes.push('首段「全程不经过任何云端」→ 限定为双侧同步链路')
  }

  // 3) 新增「实验性功能」小节（放在已验证功能列表之后、「关于数据」之前）
  const experimental = `## 实验性功能（框架已就位，未完成真实验证）

- **远程推送（SSH / Docker）**：目标管理、连通性探测与 git-bundle 传输抽象已实现，并有单元测试覆盖，但**尚未接入真实远程目标** —— 跨机远程同步的实际链路尚未经过真实验证，因此不计入已交付能力。该功能默认关闭，只有你在「设置」里显式添加并启用目标后才会生效。
`
  if (!out.includes('## 实验性功能')) {
    out = out.replace(/\n## 关于数据/, '\n' + experimental + '\n## 关于数据')
    changes.push('新增「实验性功能」小节，说明远程推送的真实状态')
  }

  // 4) 「本软件不上传任何内容到云端」→ 限定表述
  const absoluteClaim = '本软件不上传任何内容到云端。'
  if (out.includes(absoluteClaim)) {
    out = out.replace(
      absoluteClaim,
      '**技能库的核心同步链路**（本地仓库 ⇄ 本地裸仓）完全在本机完成，不经过任何云端服务 —— 这一点由源码与「零云远端」的设计原则保证。需要如实补充两点边界：其一，WSL 伴生程序自身不含网络代码，但它的 sync 子命令会调用 git 的 pull/push，默认指向本地裸仓故无需网络，若把 origin 改成远程地址就会照常发起网络请求；其二，版本中心的 GitHub Releases 更新通道与「远程推送」功能会访问外部网络。'
    )
    changes.push('「不上传任何内容到云端」→ 限定为核心同步链路，并补出两处会访问外部网络的边界')
  }

  // 5) 末尾的「与源码仓库的关系」小节：内容是推导出来的，必须每次重算（否则会与当前 main 脱节）
  const relation = `## 与源码仓库的关系

- 本 Release 的标签 \`${RELEASE_TAG}\` 指向提交 \`9035ca8\`，即**这两个安装包就是由该提交构建的**。可复核命令：\`git diff --stat 9035ca8 ${RELEASE_TAG} -- src/\`。
- 仓库 \`main\` 分支在 v1.0.0 发布之后继续演进（可靠性修复与参赛材料），因此**当前 main 与该标签的 \`src/\` 已不再逐字节相同**。这一点在 \`docs/release-artifacts.md\` 里逐项说明：哪些属于发布产物、哪些是后续改动。
- 产物与源码提交的逐项对应关系（含各安装包的 SHA-256 与大小）见仓库 \`docs/release-artifacts.md\`。
- 参赛材料（技术文档、10 分钟复现指南、Prompt 链快照、缺陷台账、告警裁定台账）全部在仓库内，见仓库根目录 README 的「参赛材料」一节。
`
  if (out.includes('## 与源码仓库的关系')) {
    // 已存在 → 整段替换（标题行到文末）
    out = out.replace(/\n## 与源码仓库的关系[\s\S]*$/, '\n\n' + relation)
    changes.push('「与源码仓库的关系」小节按当前 main 状态重算')
  } else {
    out = out.replace(/\s*$/, '\n\n' + relation)
    changes.push('新增「与源码仓库的关系」小节')
  }

  return { out, changes }
}

async function main() {
  const rel = await api(`/repos/${REPO_SLUG}/releases/tags/${encodeURIComponent(RELEASE_TAG)}`)
  const original = rel.body || ''
  const { out, changes } = rewrite(original)

  if (out === original) {
    console.log('Release 描述无需改动（可能已按新口径更新过）。')
    return
  }

  console.log('=== 改动摘要 ===')
  for (const c of changes) console.log(' - ' + c)
  console.log('\n=== 原文 ===')
  console.log(original)
  console.log('\n=== 改写后 ===')
  console.log(out)

  if (dryRun) {
    console.log('\n[dry-run] 未改动线上 Release。加 --apply 可实际提交。')
    return
  }

  // PATCH 必须用 release id（不是 tag）——GitHub 的更新端点是 /releases/{release_id}
  const relId = rel.id
  if (!relId) throw new Error('Release 响应里没有 id，无法更新')
  await api(`/repos/${REPO_SLUG}/releases/${relId}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: out })
  })
  console.log('\n[apply] Release 描述已更新：' + RELEASE_TAG + '（release id ' + relId + '）')
}

main().catch((e) => {
  console.error('更新失败：' + (e && e.message ? e.message : String(e)))
  process.exit(1)
})
