# REPRODUCE.md — SkillVault 10 分钟极速复现指南

本文件面向**第一次接触本仓库的评审者**，目标是：在 10 分钟内从零跑起应用，并独立验证核心功能可运行。

> 作品名称：基于分布式版本控制的智能体技能协同平台（SkillVault）
> 仓库地址：https://github.com/nayutalot/SkillVault

---

## 0. 一句话了解这是什么

多台 AI Agent 工具（Claude Code、Codex、Kimi CLI、ZCode…）各自维护一份技能目录，同一个技能被复制成多份副本，改一处漏一处。本工具把这些技能收拢到**一个本地 Git 仓库**作为唯一真相源，各工具目录用链接引用它；Windows 与 WSL 两侧各自克隆同一仓库、各自提交同步，**核心同步链路不依赖任何云端远程仓库**。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10 / 11，x64 | 主开发与验证环境为 Windows 11 + WSL2 Ubuntu 24.04 |
| Node.js | **≥ 20**（验证用 24.21.0） | 仅开发/构建需要；运行成品 exe 不需要 |
| pnpm | **≥ 9**（验证用 11.24.0） | 依赖树由 `pnpm-lock.yaml` 锁定；`package.json` 的 `packageManager` 字段声明了验证用的版本 |
| Git | ≥ 2.30（验证用 2.54.0） | 双端同步依赖 git |
| WSL2 | 可选 | 只有验证「跨端同步」时才需要 |
| Docker | 可选 | 只有验证 Docker 页面时才需要；引擎未运行时该页会显示降级提示而非报错 |

### 1.1 国内网络说明

`.npmrc` 已配置 Electron 与 electron-builder 的二进制下载源为国内镜像（npmmirror），`pnpm install` 无需额外代理即可完成。

### 1.2 先跑预检（推荐第一步）

```bash
node scripts/preflight.mjs
```

它会逐项检查 Node / pnpm / Git 版本、依赖是否已安装、锁文件是否存在，并顺带探测 WSL 与 Docker 的可用状态。**必需项全部满足时退出码为 0**，否则打印缺什么、怎么补。加 `--json` 可得到机器可读结果。

---

## 2. 10 分钟复现路径

### 步骤 1｜获取源码并固定提交（1 分钟）

```bash
git clone https://github.com/nayutalot/SkillVault.git
cd SkillVault
```

> **为什么要固定提交**：`main` 分支会继续演进，评审者若直接看默认分支，看到的就不是文档描述的那个版本。
>
> 本次参赛对应的提交号写在 **`docs/source-manifest.json`** 的 `anchorCommit` 字段（由 `pnpm manifest` 生成，封面与正文都指向它而不再印死 SHA —— 印死会陷入「文档里的 SHA 比包含它的那次提交旧一步」的自指悖论）。核对方式：
>
> ```bash
> cat docs/source-manifest.json | head -20        # 看 anchorCommit 与 srcFingerprint
> git checkout <anchorCommit>                      # 切到被评审的版本
> node scripts/source-manifest.mjs --check         # 校验 src/ 指纹与清单一致（退出码 0 即一致）
> ```
>
> `srcFingerprint` 是 `src/` 目录全部文件内容的 SHA-256（按「相对路径 + 文件哈希」排序后取哈希）。它**只反映源码字节内容**，不含提交号、作者或时间戳 —— 因此它能独立回答「我手上的源码是不是文档描述的那一份」，而不依赖任何需要人工对照的信息。

### 步骤 2｜安装依赖（2 分钟）

```bash
pnpm install --frozen-lockfile
```

`pnpm install` 会安装 2 个运行时依赖（react、react-dom）与 12 个构建期依赖，并按 `pnpm-lock.yaml` 锁定版本。`--frozen-lockfile` 保证依赖树与仓库记录完全一致——**复现时不要去掉这个参数**，否则装到的版本可能与被评审的版本不同。

### 步骤 3｜类型检查（1 分钟）

```bash
pnpm typecheck
```

预期：**零错误**。该命令依次检查主进程（`tsconfig.json`）与渲染进程（`tsconfig.web.json`）两套配置。

### 步骤 4｜运行全部自动化测试（1 分钟）

```bash
pnpm test
```

预期：**全部通过**，用例数以 `pnpm stats` 的实测输出为准（复算命令见步骤 5）。

测试特性（保证在任意机器上稳定复现）：

- 文件系统、home 目录、时钟、加密器、子进程启动器**全部可注入**，测试在系统临时目录中演练，真实用户文件零改动
- 外部命令（`docker` / `wsl` / `git` / `npm`）经 `fakeSpawn` 模拟，因此**测试不依赖 Docker 引擎运行、不依赖 WSL 发行版启动、不依赖网络**

### 步骤 5｜独立复算规模数字（30 秒）

技术文档里出现的源码行数、测试文件数、用例数、断言数不是写死的文案，而是可复算的：

```bash
pnpm stats          # 复算并写出 docs/stats.json
pnpm stats:check    # 只比对不写文件；与仓库内记录不一致则退出码 1
```

`docs/stats.json` 同时记录了**统计口径**（哪些目录计入、行数如何定义、断言如何计数），第三方可据此判断数字是否算得合理，而不只是接受一个结果。

### 步骤 6｜启动应用（1 分钟）

```bash
pnpm dev
```

或者构建双格式安装包：

```bash
pnpm build            # 构建 + 类型检查
pnpm dist             # NSIS 安装包 + portable 便携版（各约 75 MB）
pnpm dist:portable    # 仅便携版（免安装单文件）
```

### 步骤 7｜打包 WSL 伴生 CLI（1 分钟）

```bash
pnpm build:companion
```

产出 `out/skm.mjs` —— 零依赖单文件 CLI，供 WSL 侧执行 Git、链接与检查操作。

### 步骤 8｜验证核心功能闭环（2 分钟）

**（a）导入与链接分发**

在「导入」页把任一 skill 目录导入 vault；随后在「仪表盘」页确认各 Agent 目录的链接状态。链接状态分五态：`linked` / `wrong-target` / `real-dir` / `missing` / `vault-missing`。

**（b）配置切换与失败恢复**

在「接口中心」建立命名档案（Base URL / 模型 / Key），选择目标 Harness 执行切换。切换过程为「备份 → 原子写 → 回读校验 → 失败回滚」，Key 以 `safeStorage` 加密存储，界面只显示尾 4 位。

**（c）跨端同步（需 WSL2）**

见下方 §3。

---

## 3. 隔离验收：一条命令跑完双端同步与冲突演练

评审者**不应该**为了验证而改动自己真实的 Harness 配置。为此仓库提供了一对脚本，在系统临时目录里造一套完全隔离的沙盘：

```bash
pnpm fixture                              # 生成夹具（默认在系统临时目录）
pnpm verify:roundtrip                     # 跑同步 + 冲突演练，产出验收报告
```

它做的事：

1. `pnpm fixture` 在临时目录创建：裸仓 `bare/`、Windows 侧工作仓 `vault/`（**分支显式初始化为 `main`**）、模拟 WSL 侧的第二份克隆 `wsl-side/`、两个假 harness 目录 `harness-a/` `harness-b/`，并写入一个样例技能与合法的 `registry.json`。git 身份只写**仓库本地配置**，不碰用户的全局 gitconfig。产物清单写在 `fixture.json`。
2. `pnpm verify:roundtrip` 按**产品真实使用的 git 命令序列**（`add -A` → `commit` → `push origin main` → 对端 `pull --rebase` → `push` → 本端 `pull --no-rebase --no-edit`）跑一遍双向同步，然后制造一个**同文件不同内容**的冲突，检测 `MERGE_HEAD`、收集未合并文件、执行 `merge --abort`，并核对**双方改动都还在**、无残留合并状态。

报告写在 `acceptance-report.json`，含每一步的命令、退出码、输出尾部、相关文件的 SHA-256、链接类型与最终 `git status`。脚本退出码非 0 即表示有环节未通过。

> **为什么分支名要显式指定 `main`**：Git 的初始分支名受 `init.defaultBranch` 配置影响，不同机器可能默认成 `master`。而同步实现固定操作 `main`，若不显式指定，克隆出来的工作仓与裸仓 HEAD 会指向不同分支，第一轮同步就会失败。夹具脚本用 `git init -b main` 显式固定，并把裸仓 HEAD 指向 `refs/heads/main`。

---

## 4. 双端同步的完整搭建（可选，用于验证跨机能力）

### 4.1 Windows 侧

```bash
# 1) 准备工作仓与裸仓（分支显式指定为 main）
mkdir -p ~/SkillVault.git && git init --bare ~/SkillVault.git
mkdir -p ~/SkillVault && cd ~/SkillVault
git init -b main && git remote add origin ~/SkillVault.git

# 2) 仓库内身份（只写本地配置，不改全局 gitconfig）
git config user.name "你的名字" && git config user.email "you@example.com"

# 3) 放入 skills/ 与 registry.json（可从本仓库复制，或用应用「导入」页生成）

# 4) 首次提交并推送，把裸仓 HEAD 指向 main
git add -A && git commit -m "init"
git push -u origin main
git -C ~/SkillVault.git symbolic-ref HEAD refs/heads/main

# 5) 在应用「设置」页确认 vault 路径与裸仓路径
```

### 4.2 WSL 侧

```bash
# 1) 目标发行版内安装 git 与 node（≥18）
apt update && apt install -y git
# node 建议用 nvm 或发行版自带源安装

# 2) 克隆同一裸仓
git clone /mnt/c/Users/<你的用户名>/SkillVault.git /root/skill-vault
cd /root/skill-vault

# 3) 部署伴生 CLI（由步骤 7 产出）
mkdir -p bin && cp <你的路径>/out/skm.mjs bin/skm.mjs

# 4) 修正 Linux 侧执行权限
node bin/skm.mjs fix-permissions

# 5) 校验
node bin/skm.mjs selfcheck
```

### 4.3 同步顺序与预期

同步页按固定顺序执行三步：

```
Windows 提交推送  →  companion sync（拉取变基后推送）  →  Windows 拉取合并
```

- 冲突时：Windows 侧收冲突文件后 `merge --abort`，WSL 侧收冲突后 `rebase --abort`，**双方改动都保留，绝不 force**
- 最后一次 Windows 拉取显式使用 `--no-rebase --no-edit`，避免打开交互式编辑器
- 任一阶段失败会**中止本轮后续阶段**并在同步日志里把未执行的步骤标为「已跳过」；原因写在界面上，不会静默继续

### 4.4 伴生 CLI 子命令

`node /root/skill-vault/bin/skm.mjs <子命令>`，所有子命令**始终输出单个 JSON 字符串**：

| 子命令 | 作用 |
|---|---|
| `scan` | 扫描本侧 Agent 技能目录与链接状态 |
| `link` / `unlink` | 建立 / 移除目录链接 |
| `agents-link` / `agents-unlink` | 子智能体档案目录的整目录链接 |
| `sync` | 本侧提交 → 拉取变基 → 推送 |
| `fix-permissions` | 修正 Linux 侧执行权限 |
| `selfcheck` | 自检本侧权限与链接状态 |

> 关于「不访问网络」的准确表述：伴生 CLI **自身不含任何网络代码**，但 `sync` 子命令会调用 git 执行 `pull` / `push`。默认配置下 `origin` 指向本地裸仓，因此不需要网络；**若把 `origin` 改为远程地址，它会照常发起网络请求**。

---

## 5. 环境变量

用户需要配置的业务环境变量只有一个：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SKM_VAULT` | `/root/skill-vault` | WSL 侧 vault 路径。与 `src/shared/paths.ts` 的 `WSL_VAULT` 常量、`src/companion/skm.ts` 的 `VAULT` 保持一致 |

模板文件见仓库根目录 [`.env.example`](./.env.example)。

Windows 侧的 vault 与裸仓路径**不使用环境变量**，而是按 `os.homedir()` 派生（见 `src/main/settings.ts` 的 `defaultSettings()`），因此换电脑或换用户名不会失效。

> **一个需要如实说明的边界**：`SKM_VAULT` 只被 WSL 伴生 CLI 读取；桌面应用调用伴生程序时走的是 `src/main/wslBridge.ts` 里的共享常量 `/root/skill-vault/bin/skm.mjs`。也就是说，**改这个环境变量能改变 CLI 自己的 vault 位置，但不能改变桌面端调用它的路径**——两处部署路径需要一致，若不一致请以 `src/shared/paths.ts` 为准同步修改。

工具内部另有一组环境变量，不属于用户配置范围：`ELECTRON_RENDERER_URL` 仅在开发模式用于指向渲染层调试服务器；`WSL_UTF8=1` 由程序在调用 `wsl.exe` 时自行注入以保证输出编码。

---

## 6. 验证清单

复现完成后，可用下表逐项核对（每项都有可执行的客观判据）：

| 验证项 | 命令 / 入口 | 预期结果 | 自动化覆盖 |
|---|---|---|---|
| 环境就绪 | `node scripts/preflight.mjs` | 必需项全绿，退出码 0 | ✅ 脚本 |
| 源码指纹一致 | `pnpm manifest:check` | 退出码 0（`src/` 与清单记录的参赛源码字节一致） | ✅ 脚本 |
| 类型正确 | `pnpm typecheck` | 零错误 | ✅ 双 tsconfig |
| 单元测试 | `pnpm test` | 全部通过 | ✅ |
| 规模数字可复算 | `pnpm stats:check` | 退出码 0 | ✅ |
| Prompt 链统计可复算 | `pnpm chains:check` | 退出码 0 | ✅ |
| 隔离夹具可用 | `pnpm fixture` | 打印夹具路径与首个 commit SHA | ✅ 脚本 |
| 双端同步与冲突 | `pnpm verify:roundtrip` | 退出码 0，报告全项通过 | ✅ 脚本 |
| 伴生自检 | `node skm.mjs selfcheck` | 输出单个 JSON | ✅ |
| 构建 | `pnpm build` | 产物生成 + 类型检查通过 | ✅ |
| 分发 | `pnpm dist` | NSIS + portable 双产物 | ✅ |
| 链接五态 | 应用「仪表盘」 | 状态分类正确 | ✅ |
| 配置切换与回滚 | 应用「接口中心」 | 备份 → 原子写 → 校验 → 回滚 | ✅ |
| 跨端同步 | 应用「同步」页 | 三步顺序执行，冲突可复现 | ✅（fake transport 单测 + 隔离夹具演练） |
| 版本检测 | 应用「版本中心」 | 8 个条目多通道检测 | ✅（fake spawn 单测） |

---

## 7. 已知边界（明确声明，未夸大的部分）

复现者可能遇到的限制，如实列出：

1. **SSH / Docker 远程目标目前是框架状态** —— 已实现目标管理、探测与 git-bundle 传输抽象，并有基于 fake 的单元测试覆盖，但**未接入真实远程目标**，跨机远程同步的实际链路尚未经过真实验证。
2. **Docker 与 WSL 页面的容器生命周期操作** —— 降级路径（引擎未运行）已在开发环境验证；完整容器操作链路需在 Docker 引擎运行的环境中复验。
3. **部分旧版 WSL 的字符编码** —— `WSL_UTF8` 是微软在 WSL **0.64.0** 发布说明中才列为新增能力的变量，更早的版本会忽略它并输出 UTF-16，界面仍会出现乱码。本项目实测环境为 WSL 2（Ubuntu 24.04，WSL 版本 2.x），未逐一验证所有历史版本；当前实现未做代码层兜底，需升级目标机 WSL 版本解决。0.64.0 是**该能力被引入的版本**，不等于本项目逐一验证过的兼容下限。
4. **伴生 CLI 的 `originOk` 判定较宽松** —— 该字段仅检查 `git remote get-url origin` 执行成功且返回非空，并不验证地址是否指向预期的本地裸仓。复现时请自行核对 `git remote -v` 的实际输出。
5. **`SKM_VAULT` 与桌面端调用路径是两处** —— 见 §5 的说明。
6. **应用未做代码签名** —— Windows 可能显示 SmartScreen 提示。
7. **运行时依赖仅 2 个**（react、react-dom），其余全部为构建期依赖；成品 exe 自带运行时，目标机器无需安装 Node。

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

scripts/           复现与取证脚本（纯 Node 内置模块，零 npm 依赖）
├── preflight.mjs       前置环境预检
├── count-stats.mjs     规模数字复算
├── measure-perf.mjs    单一驱动复测 junction vs 复制
├── init-fixture.mjs    隔离测试夹具生成
├── verify-roundtrip.mjs 双端同步与冲突演练验收报告
├── count-prompt-chains.mjs 四条 Prompt 链的消息构成复算
├── extract-alerts.mjs  安全扫描告警去重抽取
├── source-manifest.mjs 参赛提交号 + src/ 内容指纹清单
└── update-release.mjs  GitHub Release 描述口径同步（凭据只从环境变量读）

docs/              参赛材料（技术文档、Prompt 链快照、缺陷台账、告警裁定台账、产物对应表、
                    源码版本清单、实测数据、截图与架构图）
```

各设计对象与源码位置的完整对照表见技术文档《表 2-2 软件设计与源码索引》。
