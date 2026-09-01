import { app, BrowserWindow, dialog } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { focusExistingWindow } from './singleInstance'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: 'SkillVault',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  win.on('ready-to-show', () => win.show())
  // 加载失败必须可见：窗口 show:false 创建，ready-to-show 永不触发时应用表现为「点了没反应」
  const onLoadError = (e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[SkillVault] 窗口加载失败:', msg)
    dialog.showErrorBox('SkillVault 启动失败', `界面加载失败：${msg}`)
    win.show()
  }
  // 不加载任何远程内容
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']).catch(onLoadError)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html')).catch(onLoadError)
  }
}

// 单实例锁：已有实例在跑时拿不到锁 → 立即退出，且不执行任何初始化（registerIpc / createWindow 都不放行）
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  // 第二实例启动请求到达：把已有主窗口弹到前台（最小化先还原）
  app.on('second-instance', () => {
    focusExistingWindow(BrowserWindow.getAllWindows())
  })

  app.whenReady().then(() => {
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[SkillVault] 启动失败:', msg)
    dialog.showErrorBox('SkillVault 启动失败', msg)
    app.quit()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
