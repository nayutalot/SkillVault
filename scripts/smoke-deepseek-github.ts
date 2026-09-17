// DeepSeek Harness GitHub Releases 通道真机冒烟（只读，绝不下载/解包/换目录）：
// tsx scripts/smoke-deepseek-github.ts
// 实跑 fetchLatestRelease（curl.exe 子进程，唯一网络动作）+ 本地 package.json 读取 + compareSemver 判定。
import {
  DEEPSEEK_DEFAULT_ROOT,
  fetchLatestRelease,
  readLocalPackageVersion
} from '../src/main/versionCenter/github'
import { compareSemver } from '../src/main/versionCenter/versionCompare'

async function main(): Promise<void> {
  console.log('[smoke] repo = deepseek-ai/deepseek-harness（只读冒烟：仅查询 Releases API）')
  const latest = await fetchLatestRelease({})
  if (!latest.ok) {
    console.log('[smoke] fetchLatestRelease → error: ' + latest.error)
    return
  }
  console.log('[smoke] latest tag         = ' + latest.tag)
  console.log('[smoke] latest version     = ' + latest.version)
  console.log('[smoke] latest publishedAt = ' + latest.publishedAt)

  const local = readLocalPackageVersion(DEEPSEEK_DEFAULT_ROOT)
  if ('version' in local) {
    console.log('[smoke] local  version     = ' + local.version + '  (from ' + DEEPSEEK_DEFAULT_ROOT + '\\package.json)')
    const c = compareSemver(local.version, latest.version)
    const verdict = c === null ? '未知（不可比较）' : c < 0 ? 'upgradable' : c === 0 ? 'up-to-date' : 'local newer'
    console.log('[smoke] compareSemver(local, latest) = ' + c + ' → ' + verdict)
  } else if ('missing' in local) {
    console.log('[smoke] local install      = 未找到（' + DEEPSEEK_DEFAULT_ROOT + '）')
  } else {
    console.log('[smoke] local read error   = ' + local.error)
  }
  console.log('[smoke] 完成（未执行任何下载/更新动作）')
}

void main()
