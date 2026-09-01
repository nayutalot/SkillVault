// 跨端共享的路径常量（主进程 / 渲染进程 / companion 共用）。
// WSL 侧 vault 挂载点：与 wslBridge.runCompanion、companion skm.ts 的 VAULT 保持一致。
export const WSL_VAULT = '/root/skill-vault'

/** WSL vault 内某 skill 的目录（POSIX 路径，文本展示用） */
export function wslVaultSkillDir(skillName: string): string {
  return `${WSL_VAULT}/skills/${skillName}`
}

/** Windows 侧可打开的 WSL 路径（\\wsl.localhost\<distro>\root\skill-vault\skills\<name>） */
export function wslUncSkillDir(distro: string, skillName: string): string {
  return `\\\\wsl.localhost\\${distro}\\root\\skill-vault\\skills\\${skillName}`
}
