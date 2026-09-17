// Docker / WSL 真机只读冒烟：全链路读取当前实机状态并打印原文。
// 红线：只读。绝不执行任何容器动作（start/stop/restart/remove/rmi）、绝不执行
// wsl terminate/boot/shutdown、绝不拉起 Docker Desktop。tsx scripts/smoke-docker-wsl.ts
/* eslint-disable no-console */
import { dockerContainers, dockerImages, dockerInfo } from '../src/main/docker'
import { hostVm, listDistros, distroStats, wslOverview } from '../src/main/wslmon'

async function main(): Promise<void> {
  console.log('=== Docker 只读探测 ===')
  const info = await dockerInfo()
  console.log('dockerInfo:', JSON.stringify(info, null, 2))
  console.log('engine-down 判定:', info.state === 'engine-down' ? '命中（引擎未运行）' : `state=${info.state}`)

  if (info.state === 'online') {
    const cs = await dockerContainers()
    console.log('dockerContainers:', JSON.stringify(cs, null, 2))
    const imgs = await dockerImages()
    console.log('dockerImages:', JSON.stringify(imgs, null, 2))
  } else {
    // 引擎未运行：docker ps / images 原样跑一遍，验证空列表优雅降级（不抛错、不报错刷屏）
    console.log('dockerContainers（引擎下线时）:', JSON.stringify(await dockerContainers()))
    console.log('dockerImages（引擎下线时）:', JSON.stringify(await dockerImages()))
  }

  console.log('\n=== WSL 只读探测 ===')
  const { distros, error } = await listDistros()
  console.log('listDistros:', JSON.stringify({ distros, error }))
  for (const d of distros) {
    if (d.state === 'Running' && d.name !== 'docker-desktop') {
      const r = await distroStats(d.name)
      console.log(`distroStats(${d.name}):`, JSON.stringify(r))
    } else {
      console.log(`distroStats(${d.name}): 跳过（state=${d.state}${d.name === 'docker-desktop' ? ' / 由 Docker Desktop 管理' : ''}，绝不为取数而启动）`)
    }
  }
  console.log('hostVm:', JSON.stringify(await hostVm()))
  const ov = await wslOverview()
  console.log('wslOverview（wsl:distros 全链路）:', JSON.stringify(ov, null, 2))
}

main().catch((e) => {
  console.error('冒烟失败:', e)
  process.exit(1)
})
