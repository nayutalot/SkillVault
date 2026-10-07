// 一次性迁移辅助：agentsDir 的 Windows junction 替换（校验已在命令行完成）
/* eslint-disable no-console */
import fs from 'node:fs'
import { createJunction, getLinkState } from '../src/main/winLinks'

const link = 'C:\\Users\\sakuya\\.zcode\\agents'
const target = 'C:\\Users\\sakuya\\SkillVault\\agents'

const before = getLinkState(link, target)
console.log('before:', before)
if (before === 'linked') {
  console.log('already linked, skip')
} else {
  if (before === 'real-dir') throw new Error('refuse: real dir still present')
  if (before !== 'missing') throw new Error(`unexpected state: ${before}`)
  createJunction(target, link)
  console.log('junction created:', fs.readlinkSync(link))
}
console.log('after:', getLinkState(link, target))
for (const f of ['omni-agent.md', 'omni-agent-pro.md']) {
  const line = fs.readFileSync(`${link}\\${f}`, 'utf8').split(/\r?\n/)[0]
  console.log(`透过 junction 读 ${f} 首行: ${line}`)
}
