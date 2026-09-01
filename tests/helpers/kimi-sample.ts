// Kimi 测试共用样本：与真机 config.toml 同构的假密钥样本（LF）。
// 假 key 一律运行时拼接生成（门禁安全惯例：源码里不出现凭据形字面量，虽然只是测试假数据）。
import { upsertBlock } from '../../src/main/kimi/tomlEdit'

/** 运行时拼出 test-key-<tag> 形态的假密钥（绝不写真字面量） */
export function fakeKey(tag: string): string {
  return ['test', 'key', tag].join('-')
}

export const KIMI_KEY = fakeKey('0123456789abcdef')

export const SAMPLE = [
  'default_model = "micuapi/kimi-k3"',
  '',
  '[providers.micuapi]',
  'type = "openai"',
  'base_url = "https://www.micuapi.ai/v1"',
  'api_key = "' + KIMI_KEY + '"',
  '',
  '[models."micuapi/kimi-k3"]',
  'provider = "micuapi"',
  'model = "kimi-k3"',
  'max_context_size = 1048576',
  'capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]',
  'display_name = "Kimi K3 (MicuAPI)"',
  '',
  '[thinking]',
  'enabled = true',
  ''
].join('\n')

/** 在 SAMPLE 基础上追加第二家 provider（切走再切回的场景用） */
export function sampleWithSecondProvider(): string {
  return upsertBlock(SAMPLE, '[providers.other]', [
    '[providers.other]',
    'type = "openai"',
    'base_url = "https://api.other.com/v1"',
    'api_key = "' + fakeKey('other-0000000000') + '"'
  ])
}
