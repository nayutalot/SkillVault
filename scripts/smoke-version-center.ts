// 版本中心真机冒烟（只读，绝不触发任何更新命令）：
// tsx scripts/smoke-version-center.ts
// 真机跑 checkAll()，逐条打印 8 个内置条目的状态原文，用于与母智能体侦察数据比对。
import { runVersionCheckAll } from '../src/main/versionCenter/jobs'

async function main(): Promise<void> {
  // 冒烟不写缓存（cacheFile 缺省禁用读写），只做一次性实时检测
  const r = await runVersionCheckAll({})
  for (const s of r.statuses) {
    const parts = [
      `state=${s.state}`,
      `installed=${s.installed ?? '-'}`,
      `latest=${s.latest ?? '-'}`
    ]
    if (s.note) parts.push(`note=${s.note}`)
    console.log(`[${s.channelKind}] ${s.name} (${s.channel}) → ${parts.join(' ')}`)
  }
  console.log(`-- stale=${r.stale} ts=${new Date(r.ts).toISOString()} total=${r.statuses.length}`)
}

void main()
