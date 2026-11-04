# CHANGELOG

本文件记录 SkillVault 的能力演进。每一节对应仓库中的一个语义提交，
提交历史按功能模块切分，可据此查看某一模块是在哪一轮引入的。

> **关于版本号**：以下 `M1`–`M4` 是**开发轮次**标记，不是产品发布版本。
> 产品版本自始至终为 `1.0.0`（见 `package.json`），尚未发布正式版本号。
> 各轮次对应的时间取自该轮次落地时的提交日期。

---

## M1 · 2026-09-01 — 初始实现

**跨 Windows / WSL 的 Skill 集中管理仓库。**

- 架构定型：Electron 主进程 + React 渲染进程，全部业务编排集中在主进程
- Vault 布局：`skills/` + `agents/` + `registry.json`，本地裸仓 `SkillVault.git` 作为唯一远端
- 九个功能页面：仪表盘 / 导入 / 同步 / 体检 / 版本中心 / 接口中心 / Docker / WSL / 设置
- WSL 伴生 CLI（`out/skm.mjs`）：零依赖单文件，8 个子命令，始终输出单个 JSON
- 目录联接（junction）与相对符号链接两种分发方式
- 零云远端设计：SSH / Docker 远程目标仅作框架，未接入真实目标

---

## M2 · 2026-09-02 — 版本中心 / 接口中心 / 资源运维

**版本中心（Version Center）** — 多 Harness 版本检测与一键更新。

- 8 个 Harness 条目：Claude Code CLI（npm + winget 双通道）、Claude Desktop、
  Codex Desktop、Kimi Code CLI、Grok CLI、DeepSeek Harness、ZCode
- 5 种更新通道：`npm` / `winget` / `native`（CLI 自带更新器）/ `arp`（注册表检测）/
  `github`（Releases 拉取 + 源码重建）
- 异步 job 模型：增量日志、取消、更新后自动复检
- 运行中进程阻断：更新前用 `tasklist` 检测目标 harness 进程

**接口中心（API Hub）** — 多 Harness 的 API 档案切换。

- 适配器矩阵：Claude Code CLI / Claude Desktop / Codex / Grok / Kimi / ZCode / DeepSeek
- 切换流程：备份 → 原子写 → 回读校验 → 失败回滚
- API Key 经 Electron `safeStorage`（Windows DPAPI）加密，界面只显示尾 4 位与长度

**Docker 页 / WSL 页** — 资源运维面板。

- Docker：Portainer 风格容器/镜像管理，全部走 `--format {{json .}}` JSON-lines 解析
- WSL：任务管理器风格资源监控，已停止的发行版绝不被自动启动
- 引擎不可用时显示说明横幅而非报错

---

## M3 · 2026-10-04 — 跨机乱码修复

**从「别的电脑安装完之后有乱码」倒查全链路，修复 5 处根因。**

- doctor 的 CRLF 修复改为纯字节级转换（原实现先做 UTF-8 解码，会把 GBK / UTF-16 文件永久写坏）
- git 调用统一注入 `-c core.quotepath=false -c i18n.logOutputEncoding=UTF-8`
- 默认路径改为 `os.homedir()` 派生，删除硬编码的机器专属用户名
- 新增 `src/shared/textDecode.ts`：BOM → UTF-8 → GBK 顺序探测，零新依赖，只用于展示绝不写回
- `vscode.ts` 的 `where.exe` 改走 `cmd chcp 65001` 通道

测试数 426 → 452。

---

## M4 · 2026-10-07 — Agent 自适应发现

**从固定适配列表转向签名驱动的自动发现。**

- `src/shared/agentSignatures.ts`：16 条目录签名（claude / codex / zcode / kimi / dsh / grok /
  gemini / qwen / opencode / kilo / pi / crush / goose / copilot / cursor / agents-shared）
  + `genericSweep` 兜底扫描任意 `.<name>/skills` 目录
- `registry.json` 升到 version 3，新增 `label` / `source` / `enabled` / `sigId` / `status` 字段，
  读取端对 v1、v2 保持兼容
- 接口中心与版本中心改为注册表驱动动态增减；无实现的 Harness 渲染为说明卡而非空白页
- 自定义供应商：密钥 `safeStorage` 加密，可从任意适配器一键填入
- 导入页自动扫描本机 skillsDir，支持批量勾选导入
- 全页面文案白话化，清除「裸仓」「rebase」等黑话
- 并发写入采用区域所有权标记（`REGION-*`），两个并行 Agent 零冲突合流

测试数 452 → **566**。

---

## M5 · 2026-11-04 — 参赛材料与提交历史整理

- 提交历史重构为 17 个语义化提交，每个对应一个功能模块（见仓库历史）
- 新增 `REPRODUCE.md`（10 分钟复现指南）、`LICENSE`、`.env.example`
- 新增 `docs/`：技术文档（PDF/DOCX）、架构图、界面截图、Prompt 链快照、实测数据
- 提交历史为**按模块整理后的结果**，原始开发时序与中间态未保留；演进过程的可追溯性
  由 `docs/prompt-chains/` 下的会话导出承担

---

## 尚未完成

详见技术文档《第 4.4 节 可验证的边界》中列出的当前未覆盖范围：
SSH / Docker 远程目标的真实链路验证、Docker 容器生命周期操作的完整链路验证、
部分旧版 WSL 的字符编码兜底。
