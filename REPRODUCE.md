# REPRODUCE.md — SkillVault 10 分钟极速复现指南

本文件面向**第一次接触本仓库的评审者**，目标是：在 10 分钟内从零跑起应用，并独立验证核心功能可运行。

> 作品名称：基于分布式版本控制的智能体技能协同平台（SkillVault）
> 仓库地址：https://github.com/nayutalot/SkillVault
> 本指南对应的源码版本见 §6「版本锚点」。

---

## 0. 一句话了解这是什么

多台 AI Agent 工具（Claude Code、Codex、Kimi CLI、ZCode…）各自维护一份技能目录，同一个技能被复制成多份副本，改一处漏一处。本工具把这些技能收拢到**一个本地 Git 仓库**作为唯一真相源，各工具目录用链接引用它；Windows 与 WSL 两侧各自克隆同一仓库、各自提交同步，**全程不依赖任何云端远程仓库**。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10 / 11，x64 | 主开发与验证环境为 Windows 11 + WSL2 Ubuntu 24.04 |
| Node.js | **≥ 20**（验证用 24.21.0） | 仅开发/构建需要；运行成品 exe 不需要 |
| pnpm | **≥ 9**（验证用 11.24.0） | 依赖树由 `pnpm-lock.yaml` 锁定 |
| Git | ≥ 2.30（验证用 2.54.0） | 双端同步依赖 git |
| WSL2 | 可选 | 只有验证「跨端同步」时才需要 |
| Docker | 可选 | 只有验证 Docker 页面时才需要；引擎未运行时该页会显示降级提示而非报错 |

### 1.1 国内网络说明

`.npmrc` 已配置 Electron 与 electron-builder 的二进制下载源为国内镜像（npmmirror），`pnpm install` 无需额外代理即可完成。

---

## 2. 10 分钟复现路径

### 步骤 1｜获取源码与安装依赖（2 分钟）

```bash
git clone https://github.com/nayutalot/SkillVault.git
cd SkillVault
pnpm install
```

`pnpm install` 会安装 2 个运行时依赖（react、react-dom）与 12 个构建期依赖，并按 `pnpm-lock.yaml` 锁定版本。

### 步骤 2｜类型检查（1 分钟）

```bash
pnpm typecheck
```

预期：**零错误**。该命令依次检查主进程（`tsconfig.json`）与渲染进程（`tsconfig.web.json`）两套配置。

### 步骤 3｜运行全部自动化测试（1 分钟）

```bash
pnpm test
```

预期：**37 个测试文件、566 个用例全部通过**。

测试特性（保证在任意机器上稳定复现）：

- 文件系统、home 目录、时钟、加密器、子进程启动器**全部可注入**，测试在系统临时目录中演练，真实用户文件零改动
- 外部命令（`docker` / `wsl` / `git` / `npm`）经 `fakeSpawn` 模拟，因此**测试不依赖 Docker 引擎运行、不依赖 WSL 发行版启动、不依赖网络**

### 步骤 4｜启动应用（1 分钟）

```bash
pnpm dev
```

或者构建双格式安装包：

```bash
pnpm build            # 构建 + 类型检查
pnpm dist             # NSIS 安装包 + portable 便携版（各约 75 MB）
pnpm dist:portable    # 仅便携版（免安装单文件）
```

### 步骤 5｜打包 WSL 伴生 CLI（1 分钟）

```bash
pnpm build:companion
```

产出 `out/skm.mjs` —— 零依赖单文件 CLI，供 WSL 侧执行 Git、链接与检查操作。

### 步骤 6｜验证核心功能闭环（4 分钟）

**（a）导入与链接分发**

在「导入」页把任一 skill 目录导入 vault；随后在「仪表盘」页确认各 Agent 目录的链接状态。链接状态分五态：`linked` / `wrong-target` / `real-dir` / `missing` / `vault-missing`。

**（b）配置切换与失败恢复**

在「接口中心」建立命名档案（Base URL / 模型 / Key），选择目标 Harness 执行切换。切换过程为「备份 → 原子写 → 回读校验 → 失败回滚」，Key 以 `safeStorage` 加密存储，界面只显示尾 4 位。

**（c）跨端同步（需 WSL2）**

见下方 §3。

---

## 3. 双端同步的完整搭建（可选，用于验证跨端能力）

### 3.1 Windows 侧

```bash
# 1) 准备工作仓与裸仓
mkdir -p ~/SkillVault.git && git init --bare ~/SkillVault.git
mkdir -p ~/SkillVault && cd ~/SkillVault
git init && git remote add origin ~/SkillVault.git

# 2) 放入 skills/ 与 registry.json（可从本仓库复制，或用应用「导入」页生成）

# 3) 在应用「设置」页确认 vault 路径与裸仓路径
```

### 3.2 WSL 侧

```bash
# 1) 目标发行版内安装 git 与 node（≥18）
apt update && apt install -y git
# node 建议用 nvm 或发行版自带源安装

# 2) 克隆同一裸仓
git clone /mnt/c/Users/<你的用户名>/SkillVault.git /root/skill-vault
cd /root/skill-vault

# 3) 部署伴生 CLI（由步骤 5 产出）
mkdir -p bin && cp <你的路径>/out/skm.mjs bin/skm.mjs

# 4) 修正 Linux 侧执行权限
node bin/skm.mjs fix-permissions

# 5) 校验
node bin/skm.mjs selfcheck
```

### 3.3 同步顺序与预期

同步页按固定顺序执行三步：

```
Windows 提交推送  →  companion sync（拉取变基后推送）  →  Windows 拉取合并
```

- 冲突时：Windows 侧收冲突文件后 `merge --abort`，WSL 侧收冲突后 `rebase --abort`，**双方改动都保留，绝不 force**
- 最后一次 Windows 拉取显式使用 `--no-rebase --no-edit`，避免打开交互式编辑器

### 3.4 伴生 CLI 子命令

`node /root/skill-vault/bin/skm.mjs <子命令>`，所有子命令**始终输出单个 JSON 字符串且从不访问网络**：

| 子命令 | 作用 |
|---|---|
| `scan` | 扫描本侧 Agent 技能目录与链接状态 |
| `link` / `unlink` | 建立 / 移除目录链接 |
| `agents-link` / `agents-unlink` | 子智能体档案目录的整目录链接 |
| `sync` | 本侧提交 → 拉取变基 → 推送 |
| `fix-permissions` | 修正 Linux 侧执行权限 |
| `selfcheck` | 自检本侧权限与链接状态 |

---

## 4. 环境变量

项目**只有一个环境变量**，用于 WSL 伴生 CLI 定位 vault：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SKM_VAULT` | `/root/skill-vault` | WSL 侧 vault 路径。与 `src/shared/paths.ts` 的 `WSL_VAULT` 常量、`src/companion/skm.ts` 的 `VAULT` 保持一致 |

Windows 侧的 vault 与裸仓路径**不使用环境变量**，而是按 `os.homedir()` 派生（见 `src/main/settings.ts` 的 `defaultSettings()`），因此换电脑或换用户名不会失效。

模板文件见仓库根目录 [`.env.example`](./.env.example)。

---

## 5. 验证清单

复现完成后，可用下表逐项核对（每项都有可执行的客观判据）：

| 验证项 | 命令 / 入口 | 预期结果 | 自动化覆盖 |
|---|---|---|---|
| 类型正确 | `pnpm typecheck` | 零错误 | ✅ 双 tsconfig |
| 单元测试 | `pnpm test` | 37 文件 / 566 用例全绿 | ✅ |
| 伴生自检 | `node skm.mjs selfcheck` | 输出单个 JSON | ✅ |
| 构建 | `pnpm build` | 产物生成 + 类型检查通过 | ✅ |
| 分发 | `pnpm dist` | NSIS + portable 双产物 | ✅ |
| 链接五态 | 应用「仪表盘」 | 状态分类正确 | ✅ |
| 配置切换与回滚 | 应用「接口中心」 | 备份 → 原子写 → 校验 → 回滚 | ✅ |
| 跨端同步 | 应用「同步」页 | 三步顺序执行，冲突可复现 | ✅（fake transport 单测） |
| 版本检测 | 应用「版本中心」 | 8 个条目多通道检测 | ✅（fake spawn 单测） |

---

## 6. 版本锚点

本指南对应的源码版本（评审时可据此核对）：

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/nayutalot/SkillVault |
| 提交锚点 | 见 `git log -1 --format=%H` 的输出，或技术文档封面所标注的 commit |
| 依赖锁定 | `pnpm-lock.yaml`（154,452 字节） |
| 构建配置 | `electron-builder.yml`、`electron.vite.config.ts` |

---

## 7. 已知边界（明确声明，未夸大的部分）

复现者可能遇到的限制，如实列出：

1. **SSH / Docker 远程目标目前是框架状态** —— 已实现目标管理、探测与 git-bundle 传输抽象，并有基于 fake 的单元测试覆盖，但**未接入真实远程目标**，跨机远程同步的实际链路尚未经过真实验证。
2. **Docker 与 WSL 页面的容器生命周期操作** —— 降级路径（引擎未运行）已在开发环境验证；完整容器操作链路需在 Docker 引擎运行的环境中复验。
3. **旧版 WSL（低于 0.58）** —— 该版本忽略 `WSL_UTF8` 并输出 UTF-16，界面仍会出现乱码。当前实现未做代码层兜底，需升级目标机 WSL 版本解决。
4. **应用未做代码签名** —— Windows 可能显示 SmartScreen 提示。
5. **运行时依赖仅 2 个**（react、react-dom），其余全部为构建期依赖；成品 exe 自带运行时，目标机器无需安装 Node。

---

## 8. 目录结构速查

```
src/
├── main/          Electron 主进程（全部业务编排）
│   ├── apihub/    接口中心：index 编排 / transforms 纯函数 / store 档案库 / adapters 适配器
│   ├── versionCenter/  版本中心：catalog 通道目录 / github / npm / winget / native / arp / jobs
│   ├── kimi/      Kimi 档案（safeStorage 封存 + config.toml 编辑）
│   ├── docker/ wslmon/  Docker 与 WSL 监控与操作
│   └── sync.ts doctor.ts importer.ts wslBridge.ts winLinks.ts agentDiscover.ts …
├── preload/       contextBridge 暴露 IPC（统一 Result<T> 封装）
├── renderer/      React 9 页 UI（Dashboard / Import / Sync / Doctor / VersionCenter / ApiHub / Docker / WSL / Settings）
├── companion/     WSL 伴生 CLI：esbuild 打包为零依赖单文件 out/skm.mjs
└── shared/        三端共享：types.ts / registry.ts / agentSignatures.ts / frontmatter.ts / paths.ts / textDecode.ts
```

各设计对象与源码位置的完整对照表见技术文档《表 2-2 软件设计与源码索引》。
