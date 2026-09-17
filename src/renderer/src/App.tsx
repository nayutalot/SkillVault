import { useCallback, useRef, useState } from 'react'
import Dashboard from './pages/Dashboard'
import ImportPage from './pages/Import'
import SyncPage from './pages/Sync'
import DoctorPage from './pages/Doctor'
import SettingsPage from './pages/Settings'
import VersionCenterPage from './pages/VersionCenter'
import ApiHubPage from './pages/ApiHub'
import DockerPage from './pages/DockerPage'
import WslPage from './pages/WslPage'

export type PageName = 'dashboard' | 'import' | 'sync' | 'doctor' | 'versions' | 'docker' | 'wsl' | 'apihub' | 'settings'
export type Notify = (kind: 'ok' | 'err', text: string) => void

const NAV: { key: PageName; label: string }[] = [
  { key: 'dashboard', label: '仪表盘' },
  { key: 'import', label: '导入' },
  { key: 'sync', label: '同步' },
  { key: 'doctor', label: '体检' },
  { key: 'versions', label: '版本中心' },
  { key: 'docker', label: 'Docker' },
  { key: 'wsl', label: 'WSL' },
  { key: 'apihub', label: '接口中心' },
  { key: 'settings', label: '设置' }
]

export default function App(): React.JSX.Element {
  const [page, setPage] = useState<PageName>('dashboard')
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const toastTimer = useRef<number | null>(null)

  const notify = useCallback<Notify>((kind, text) => {
    // 先清上一个 toast 的定时器：否则连续两次 notify 时，前一个 6s 计时器到点会把后一条提示提前清掉
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    setToast({ kind, text })
    toastTimer.current = window.setTimeout(() => setToast(null), 6000)
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">SkillVault</div>
        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`nav-btn${page === n.key ? ' active' : ''}`}
              onClick={() => setPage(n.key)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="subtitle">跨 Windows / WSL 的 Skill Vault 中央仓库</div>
      </header>
      <main className="content">
        {page === 'dashboard' && <Dashboard notify={notify} goTo={setPage} />}
        {page === 'import' && <ImportPage notify={notify} />}
        {page === 'sync' && <SyncPage notify={notify} />}
        {page === 'doctor' && <DoctorPage notify={notify} />}
        {page === 'versions' && <VersionCenterPage notify={notify} />}
        {page === 'docker' && <DockerPage notify={notify} />}
        {page === 'wsl' && <WslPage notify={notify} />}
        {page === 'apihub' && <ApiHubPage notify={notify} />}
        {page === 'settings' && <SettingsPage notify={notify} />}
      </main>
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
