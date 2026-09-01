// 单实例锁支撑逻辑（可测试部分）。
// - 锁的申请（app.requestSingleInstanceLock）依赖 Electron 运行时，留在 main/index.ts；
//   这里只放纯逻辑：second-instance 事件到达时把已有主窗口弹到前台。
// - focusExistingWindow 接收窗口数组（main 里传 BrowserWindow.getAllWindows()），
//   vitest 用 fake window 覆盖：正常聚焦 / 最小化先 restore / 空数组静默跳过。
import type { BrowserWindow } from 'electron'

/**
 * 聚焦已有窗口：最小化则先 restore，再 show + focus。
 * 窗口列表为空时静默跳过（不影响 darwin 的 activate 重建逻辑）。
 */
export function focusExistingWindow(windows: BrowserWindow[]): void {
  const win = windows[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
