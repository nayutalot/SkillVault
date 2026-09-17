import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { focusExistingWindow } from '../src/main/singleInstance'

/** fake 窗口：记录 restore/show/focus 调用顺序，可指定最小化状态 */
function fakeWindow(minimized: boolean): { win: BrowserWindow; calls: string[] } {
  const calls: string[] = []
  const win = {
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(() => calls.push('restore')),
    show: vi.fn(() => calls.push('show')),
    focus: vi.fn(() => calls.push('focus'))
  } as unknown as BrowserWindow
  return { win, calls }
}

describe('focusExistingWindow（second-instance 到达时聚焦已有主窗口）', () => {
  it('正常状态：直接 show + focus，不 restore', () => {
    const { win, calls } = fakeWindow(false)
    focusExistingWindow([win])
    expect(calls).toEqual(['show', 'focus'])
    expect(win.isMinimized).toHaveBeenCalledTimes(1)
  })

  it('最小化状态：先 restore 再 show + focus', () => {
    const { win, calls } = fakeWindow(true)
    focusExistingWindow([win])
    expect(calls).toEqual(['restore', 'show', 'focus'])
  })

  it('窗口列表为空：静默跳过，不抛错', () => {
    expect(() => focusExistingWindow([])).not.toThrow()
  })

  it('多个窗口时只取第一个（getAllWindows 顺序语义）', () => {
    const first = fakeWindow(false)
    const second = fakeWindow(false)
    focusExistingWindow([first.win, second.win])
    expect(first.calls).toEqual(['show', 'focus'])
    expect(second.calls).toEqual([])
  })
})
