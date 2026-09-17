// Kimi 真机只读冒烟：parseKimiConfigDisplay 读真实 config.toml 打印脱敏结果。
// 红线：本脚本对 ~/.kimi-code 零写入；api_key 只打印尾 4 位与长度，绝不输出全值。tsx scripts/kimi-smoke-readonly.ts
/* eslint-disable no-console */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseKimiConfigDisplay, thinkingEnabledOf } from '../src/main/kimi/tomlEdit'

const configPath = path.join(os.homedir(), '.kimi-code', 'config.toml')
const sha = (p: string): string => createHash('sha256').update(fs.readFileSync(p)).digest('hex')

console.log('configPath:', configPath)
console.log('exists:', fs.existsSync(configPath))
console.log('sha256(before):', sha(configPath))
const text = fs.readFileSync(configPath, 'utf8')
const display = parseKimiConfigDisplay(text)
console.log('parseKimiConfigDisplay:', JSON.stringify(display, null, 2))
console.log('thinking.enabled:', thinkingEnabledOf(text))
console.log('sha256(after):', sha(configPath))
console.log('红线自检（结果中无 51 字符全值 key）:', !JSON.stringify(display).includes(/api_key = "([^"]+)"/.exec(text)?.[1] ?? '\u0000'))
