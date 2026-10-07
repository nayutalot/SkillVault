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

const NAV: { key: PageName; label: string; title: string }[] = [
  { key: 'dashboard', label: '总览', title: '一屏看清技能库里有哪些技能、各个 Agent 那边有没有建好快捷方式' },
  { key: 'import', label: '导入', title: '把各 Agent 手里的技能收进技能库统一管理' },
  { key: 'sync', label: '同步', title: '在 Windows 和 WSL 之间互相同步技能库（不经过云端）' },
  { key: 'doctor', label: '体检', title: '检查技能库与各 Agent 有没有问题，能修的可以一键修复' },
  { key: 'versions', label: '版本更新', title: '查看已安装工具的版本并更新' },
  { key: 'docker', label: 'Docker', title: '查看和管理 Docker 容器与镜像' },
  { key: 'wsl', label: 'WSL', title: '查看 Linux 子系统的运行状态与资源占用' },
  { key: 'apihub', label: '接口中心', title: '统一管理各个 AI 工具的接口地址与密钥' },
  { key: 'settings', label: '设置', title: '路径、Agent 清单与远程电脑等设置' }
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
              title={n.title}
              onClick={() => setPage(n.key)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="subtitle">把 Windows 和 WSL 上的 AI 技能集中到一处管理</div>
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
