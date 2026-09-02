import { describe, expect, it } from 'vitest'
import {
  compareSemver,
  compareVersions,
  extractVersionCore,
  parseSemver,
  semverFromTag
} from '../src/main/versionCenter/versionCompare'

describe('extractVersionCore（版本核心提取）', () => {
  it('裸版本号原样提取', () => {
    expect(extractVersionCore('2.1.150')).toBe('2.1.150')
  })

  it('剥离 CLI 前缀噪声：grok 1.0.5 (5115b46bc9) → 1.0.5', () => {
    expect(extractVersionCore('grok 1.0.5 (5115b46bc9)')).toBe('1.0.5')
  })

  it('剥离 v 前缀', () => {
    expect(extractVersionCore('v1.2.3')).toBe('1.2.3')
  })

  it('四段大数字版本（1.26832.0.0）完整提取', () => {
    expect(extractVersionCore('1.26832.0.0')).toBe('1.26832.0.0')
  })

  it('无数字 → null', () => {
    expect(extractVersionCore('最新')).toBeNull()
    expect(extractVersionCore('')).toBeNull()
  })
})

describe('compareVersions（semver 风格多段比较）', () => {
  it('相等 → 0', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('26.825.6671.0', '26.825.6671.0')).toBe(0)
  })

  it('小于 / 大于（逐段比较）', () => {
    expect(compareVersions('2.1.150', '2.1.257')).toBe(-1)
    expect(compareVersions('2.1.257', '2.1.150')).toBe(1)
    expect(compareVersions('0.36.0', '0.36.1')).toBe(-1)
  })

  it('四段版本：1.26832.0.0 < 1.30096.1（第二段主导，缺省段补 0）', () => {
    expect(compareVersions('1.26832.0.0', '1.30096.1')).toBe(-1)
    expect(compareVersions('1.30096.1', '1.26832.0.0')).toBe(1)
  })

  it('段数不同按 0 补齐：1.0 == 1.0.0', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('2.1', '2.1.0.0')).toBe(0)
  })

  it('带前缀噪声输入可比：grok 1.0.5 < 1.0.6', () => {
    expect(compareVersions('grok 1.0.5 (5115b46bc9)', '1.0.6')).toBe(-1)
    expect(compareVersions('grok 1.0.5 (5115b46bc9)', '1.0.5')).toBe(0)
  })

  it('段内多位数字按数值比较（非字典序）', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
    expect(compareVersions('02.07.01.62', '02.08.02.61')).toBe(-1)
  })

  it('任一侧不可提取版本 → null（UI 显示「未知」）', () => {
    expect(compareVersions('abc', '1.0.0')).toBeNull()
    expect(compareVersions('1.0.0', '')).toBeNull()
    expect(compareVersions('未知', 'latest')).toBeNull()
  })
})

describe('compareSemver（prerelease 扩展，GitHub Releases 通道）', () => {
  it('实测升级链：0.1.0-rc.5 < 0.1.1-rc.2 < 0.1.2-alpha.4', () => {
    expect(compareSemver('0.1.0-rc.5', '0.1.1-rc.2')).toBe(-1)
    expect(compareSemver('0.1.1-rc.2', '0.1.2-alpha.4')).toBe(-1)
    expect(compareSemver('0.1.0-rc.5', '0.1.2-alpha.4')).toBe(-1)
    expect(compareSemver('0.1.2-alpha.4', '0.1.0-rc.5')).toBe(1)
  })

  it('核心相同 → 无 prerelease 者更新：0.1.2-alpha.4 < 0.1.2', () => {
    expect(compareSemver('0.1.2-alpha.4', '0.1.2')).toBe(-1)
    expect(compareSemver('0.1.2', '0.1.2-alpha.4')).toBe(1)
    expect(compareSemver('0.1.2', '0.1.2')).toBe(0)
  })

  it('字母段字典序：alpha < beta < rc', () => {
    expect(compareSemver('0.1.0-alpha.1', '0.1.0-beta.1')).toBe(-1)
    expect(compareSemver('0.1.0-beta.1', '0.1.0-rc.1')).toBe(-1)
    expect(compareSemver('0.1.0-rc.1', '0.1.0-alpha.1')).toBe(1)
  })

  it('数字段按数值比较（非字典序）：rc.2 < rc.10', () => {
    expect(compareSemver('0.1.0-rc.2', '0.1.0-rc.10')).toBe(-1)
    expect(compareSemver('0.1.0-alpha.9', '0.1.0-alpha.23')).toBe(-1)
  })

  it('数字段 < 字母段（semver 规则）', () => {
    expect(compareSemver('0.1.0-1', '0.1.0-alpha')).toBe(-1)
    expect(compareSemver('0.1.0-alpha', '0.1.0-1')).toBe(1)
  })

  it('核心差异主导：prerelease 更深的核心升级仍然更大', () => {
    expect(compareSemver('0.1.0-rc.9', '0.2.0-alpha.1')).toBe(-1)
    expect(compareSemver('0.2.0-alpha.1', '0.1.0-rc.9')).toBe(1)
  })

  it('前缀噪声剥离：dsh-v0.1.2-alpha.4 与 0.1.2-alpha.4 相等', () => {
    expect(compareSemver('dsh-v0.1.2-alpha.4', '0.1.2-alpha.4')).toBe(0)
    expect(compareSemver('dsh-v0.1.2-alpha.4', 'dsh-v0.1.1-rc.2')).toBe(1)
  })

  it('段数不齐按 0 补齐；prerelease 段少者小', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0)
    expect(compareSemver('0.1.0-rc', '0.1.0-rc.1')).toBe(-1)
    expect(compareSemver('0.1.0-rc.1', '0.1.0-rc')).toBe(1)
  })

  it('任一侧解析失败 → null', () => {
    expect(compareSemver('abc', '1.0.0')).toBeNull()
    expect(compareSemver('1.0.0', '')).toBeNull()
    expect(compareSemver('', '')).toBeNull()
  })
})

describe('parseSemver / semverFromTag（结构解析）', () => {
  it('裸版本 / v 前缀 / tag 噪声 / 前缀文本', () => {
    expect(parseSemver('0.1.0-rc.5')).toEqual({ core: [0, 1, 0], pre: ['rc', '5'] })
    expect(parseSemver('v1.2.3')).toEqual({ core: [1, 2, 3], pre: [] })
    expect(parseSemver('dsh-v0.1.2-alpha.4')).toEqual({ core: [0, 1, 2], pre: ['alpha', '4'] })
    expect(parseSemver('grok 1.0.5 (5115b46bc9)')).toEqual({ core: [1, 0, 5], pre: [] })
  })

  it('无数字 → null；semverFromTag 规范化', () => {
    expect(parseSemver('最新')).toBeNull()
    expect(parseSemver('')).toBeNull()
    expect(semverFromTag('dsh-v0.1.2-alpha.4')).toBe('0.1.2-alpha.4')
    expect(semverFromTag('v1.2.3')).toBe('1.2.3')
    expect(semverFromTag('not-a-version!!')).toBe('not-a-version!!')
  })
})
