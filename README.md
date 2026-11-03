# SkillVault

跨 Windows / WSL 的 **Skill 集中管理仓库**（零云远端）— Electron 桌面应用。

SkillVault 把散落在各个 agent harness（Claude Code、Codex、Kimi CLI、Grok CLI 等）目录里的 skills 与子智能体档案收拢到一个本地 Git 仓库（vault），Windows 与 WSL 两侧通过链接共享、各自向本地裸库提交同步。全程不依赖任何云远端，同时提供版本中心、接口中心、Docker / WSL 资源监控等日常运维面板。

## 核心设计原则

- **零云远端**：vault + 本地裸库（`SkillVault.git`）即完整闭环；SSH / Docker 远程目标仅为用户显式配置后启用的先行框架，默认关闭。
- **绝不伪造状态**：任何检测（WSL 扫描、Docker 引擎、版本检查）不可达时如实返回 `stale` / `unknown` / `engine-down`，取不到的数值为 `null`，绝不硬造。
- **密钥安全**：API key 经 Electron `safeStorage` 加密封存，明文只经 IPC 传递一次；所有展示均为脱敏视图（仅尾 4 位与长度），绝无全值落盘落日志。
- **写操作先备份**：配置写入统一走「时间戳备份 → 原子写 → 重读校验 → 失败回滚」。
- **优雅降级**：Docker 引擎未运行、WSL 发行版已停止都是常态，页面显示说明横幅而非报错崩溃；绝不为取数而启动已停止的发行版。

## 功能页面

| 页面 | 功能 |
| --- | --- |
| 仪表盘 | Windows / WSL 两侧 agent 的 skills 链接状态总览（`linked` / `missing` / `wrong-target` / `real-dir` / `vault-missing`）；agentsDir 整目录链接的硬链接感知与一键修复 |
| 导入 | 将任意 skill 目录导入 vault：先出计划预览（名称校验、SKILL.md 存在性、vault 重名冲突、文件数/字节数），确认后执行 |
| 同步 | Windows / WSL 双端 git 提交同步（双方各自扫描、推送拉取本地裸库），步骤级日志与冲突检测；SSH / Docker 远程目标管理框架 |
| 体检 Doctor | vault 与各 agent 目录健康检查，问题分级（error/warn/info），可修复项一键修复 |
| 版本中心 | 8 个内置 agent harness 条目的已装版本 vs 最新版本检测与一键更新，支持 5 种通道（见下） |
| 接口中心 API Hub | 把「档案切换」模式扩展到全部 agent harness：为每个工具维护多套 API 档案（Base URL / 模型 / key），一键切换并自动备份原配置 |
| Docker | Portainer 风格容器 / 镜像管理：状态徽章、CPU / 内存占用、日志查看、start / stop / restart / remove，可拉起 Docker Desktop |
| WSL | 任务管理器风格资源监控：发行版列表与运行状态、`/proc` 内存 / 负载 / 磁盘 / uptime 指标、宿主 vmmemWSL 进程内存、terminate / boot / 全部关机 |
| 设置 | vault 与裸库路径、WSL 发行版、DeepSeek Harness 目录、远程目标列表 |

### 版本中心通道

| 通道 | 说明 | 内置条目 |
| --- | --- | --- |
| `npm` | npm 全局包检查 + `npm update -g` | Claude Code |
| `winget` | winget 升级（含商店系 MSIX 子串匹配、Store 兜底提示） | Claude Code、Claude Desktop、Codex、zcode |
| `native` | 工具自带更新器 CLI | Kimi CLI、Grok CLI |
| `arp` | 注册表安装器检测（仅检测，不更新） | — |
| `github` | GitHub Releases 检测 + 源码重建 | DeepSeek Harness |

更新以 job 形式运行（IPC 轮询增量日志），检测超时 90s、更新超时 20min；目标进程仍在运行时先阻断并要求 UI 确认。

### 接口中心适配器

共 7 个适配器 ID：`claude-cli`、`claude-desktop`、`codex`、`grok`、`kimi`、`zcode`、`deepseek`。其中 5 个可用（Claude Code CLI、Codex、Grok、Kimi、zcode），不适用的渲染为 N/A 说明卡。切换流程：检测目标进程运行 → 备份原配置 → 原子写入 → 重读校验 → 失败自动回滚；支持从现有配置一键导入为档案。

## 架构

```
src/
├── main/               Electron 主进程（全部业务编排）
│   ├── apihub/         接口中心：index 编排 / transforms 纯函数 / store 档案库
│   ├── versionCenter/  版本中心：catalog 通道目录 / github / npm / winget / native / arp / jobs
│   ├── kimi/           Kimi 档案（safeStorage 封存 + config.toml 编辑）
│   ├── wslmon/ docker/ WSL / Docker 监控与操作
│   ├── sync.ts doctor.ts importer.ts wslBridge.ts wslScan.ts …
│   └── settings.ts singleInstance.ts …
├── preload/            contextBridge 暴露 IPC（统一 Result<T> 封装）
├── renderer/           React 9 页 UI（Dashboard / Import / Sync / Doctor / VersionCenter / ApiHub / Docker / WSL / Settings）
├── companion/
│   └── skm.ts          WSL 伴生 CLI：esbuild 打包为零依赖单文件 out/skm.mjs，
│                        子命令 scan / link / unlink / agents-link / agents-unlink / sync /
│                        fix-permissions / selfcheck，始终输出单个 JSON，绝不访问网络
└── shared/             三端共享：types.ts / registry.json 校验 / SKILL.md frontmatter / 路径常量
```

## Vault 布局

```
C:\Users\sakuya\SkillVault                 工作库：skills/ + agents/ + registry.json
C:\Users\sakuya\SkillVault.git             本地裸库（origin，零云）
\\wsl.localhost\<distro>\root\skill-vault  WSL 侧 vault（默认 /root/skill-vault）
```

`registry.json`（version 2）记录每个 agent 的平台、skillsDir、include 规则与可选 agentsDir；应用与 WSL 伴生 CLI 共用同一套解析逻辑（`src/shared`）。

## 快速开始

前置条件：Windows 10/11、WSL2（默认发行版 Ubuntu）、Node.js 20+、pnpm，两侧均装有 git。

```bash
pnpm install
pnpm build:companion   # 打包 WSL 伴生 CLI → out/skm.mjs
pnpm dev               # 启动开发模式
```

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | electron-vite 开发模式 |
| `pnpm typecheck` | 主进程 + 渲染进程双 tsconfig 类型检查 |
| `pnpm build` | 构建产物并通过类型检查 |
| `pnpm build:companion` | esbuild 打包 WSL 伴生 CLI → `out/skm.mjs` |
| `pnpm test` | vitest 全量测试 |
| `pnpm dist` | 构建 + electron-builder 打包 Windows 安装包与便携版 |
| `pnpm dist:portable` | 仅便携版（免安装单文件） |
| `pnpm migrate` | 旧版数据迁移脚本 |

## 测试

vitest，**25 个测试文件、404 个用例**（全部通过）。文件系统、home 目录、时钟、加密器、子进程均可注入，测试在临时目录演练，真实文件零改动；外部命令（docker / wsl / git / npm）经 fakeSpawn 演练。

## 打包与分发

- `pnpm dist` 产出两种目标（x64）：**NSIS** 安装包（一次性安装，启动快）与 **portable** 便携版（免安装单文件）。
- 未做代码签名；应用图标由 `build/icon.png` 经 Pillow 生成多尺寸 `.ico`。
- `.npmrc` 已配置 Electron / electron-builder 二进制的 npmmirror 镜像，适配国内网络。

## 安全模型

- API key 明文仅经 IPC 传递一次，主进程立即 `safeStorage` 封存；`safeStorage` 不可用时降级为带 `plainStore` 标记的存储并如实提示。
- 所有配置 / 档案展示接口均为脱敏视图：key 只出现尾 4 位与长度。
- 配置写入前生成时间戳备份，写后重读校验，失败自动回滚。
- 更新与接口切换前用 tasklist 检测目标 harness 进程，运行中则阻断并要求用户确认。

---

作者：sakuya · 私有项目
