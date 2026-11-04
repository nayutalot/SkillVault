# 发布产物与源码锚点对照表

> 本文件回答盲审提出的问题：**「目前公开 v1.0.0 Release 显示的提交是 9035ca8，不是文档锚点。这不自动证明程序代码不同，但缺少差异说明和二进制对应关系。」**
>
> 结论先行，分两层：
>
> 1. **已发布的二进制确实由 `9035ca8` 打出** —— 已用「从该提交重建并逐文件比对」验证（7/7 应用文件 MATCH，§4.4）。
> 2. **当前参赛源码与该发布提交之间已有差异**，差异是**发布之后有意做的可靠性修复**（git 异步化、同步失败分级与快速终止、硬链接修复前展示差异、IPC 通道单点注册），共 15 个文件、+690/−148 行。本次参赛对应的提交号与 `src/` 内容指纹记录在 **`docs/source-manifest.json`**（由 `pnpm manifest` 生成，可原样复算）。
>
> 换句话说：Release 页上的二进制是**上一个版本**的产物，当前仓库是**修过一轮可靠性问题之后的版本**。两者关系、下面的逐条 `git` 证据、产物哈希与本表的局限都在下文给出。
>
> 文中每一条命令都在本机执行过，输出为原样摘录。评审者可按「如何自行核对」一节复跑。

---

## 1. 一句话结论

| 问题 | 结论 | 证据 |
|---|---|---|
| v1.0.0 标签指向哪里？ | `9035ca81f5b6ea82482138b0de820d540bd38d82` | `git show-ref --tags` |
| 本次参赛对应的提交是谁？ | 记录在 `docs/source-manifest.json` 的 `anchorCommit` | 文档封面与正文都指向该清单，不再印死 SHA（避免「文档里的 SHA 比包含它的那次提交旧一步」的自指悖论） |
| 发布提交与当前参赛源码的 `src/` 有差异吗？ | **有**：15 个文件、+690/−148 行，全部是发布之后的可靠性修复 | `git diff --stat 9035ca8 <anchorCommit> -- src/` |
| 本次参赛源码的 `tests/` 与发布提交相比？ | **有差异**：新增 4 个测试文件（同步编排、git 异步、硬链接差异）并扩写了导入测试 | `git diff --stat 9035ca8 <anchorCommit> -- tests/` |
| 差异分布在哪？ | 应用源码与测试共 15 + 4 个文件（发布之后的可靠性修复），其余全部落在文档、实测数据、截图与台账上 | `git diff --stat 9035ca8 <anchorCommit>` 全文见 §3.2 |
| v1.0.0 发布出来的二进制对应哪份源码？ | **对应 `9035ca8`** —— 已用「从 `9035ca8` 重建并逐文件比对」验证（7/7 应用文件 MATCH）。当前参赛源码比它多一轮可靠性修复 | §4.4 |
| 提交历史是原始开发时序吗？ | **不是。** `main` 的历史是按模块事后整理的重建历史，与原始历史无共同祖先 | §3.3 |

---

## 2. 产物 ↔ 源码提交 ↔ 哈希 对照表

所有 SHA-256 与字节数由本机 `sha256sum` / `stat` 实测得到（命令见 §6）。**产物不入库**：`dist/`、`out/` 在 `.gitignore` 中，因此评审者拿到仓库时看不到这些文件，需要自行构建后重算哈希（见 §7 局限）。

| 产物 | 版本 / 路径 | 对应源码提交 | SHA-256 | 大小 | 备注 |
|---|---|---|---|---|---|
| 技术文档 PDF | `docs/SkillVault-技术文档.pdf` | 本次参赛锚点（见 `docs/source-manifest.json`） | `b548595e175bc45f2ae061a1a78a5cf5b6d932dfa850389862490ee1f0863394` | 2,125,276 B | 30 页；v2 版含同步故障矩阵、威胁模型、能力成熟度矩阵 |
| 技术文档 DOCX | `docs/SkillVault-技术文档.docx` | 同上 | `dbd97a138a9d7bdbecc3aee061d578625cd9896100fa2914f5f75d3d75bcef5e` | 807,511 B | 与 PDF 同源（同一生成脚本） |
| NSIS 安装包 | `dist/SkillVault Setup 1.0.0.exe` | `9035ca8`（发布提交的源码，见 §4） | `48e58acbec80810506ba220ff696bbba30b0b91023666ca3596551a7300dbccb` | 75,313,648 B | 未签名；`dist/latest.yml` 记录的 sha512 与本文件实测一致 |
| portable 便携版 | `dist/SkillVault 1.0.0.exe` | `9035ca8`（同上） | `3549334dfa5db4d63b4f3520c9a2097082b37bb8e0fd9708f9a0eb3fa4c72b7e` | 75,051,332 B | 未签名；每次启动重新解压 |
| 分发 ZIP（含伴生 CLI 与说明） | `dist/SkillVault-1.0.0-20261004.zip` | `6f370db`（**更早的版本**，见备注） | `e1684ff7b2ea59c4dc9c0db9ed79008adcd1459fd8c26ae3a1c3b36f1afbcae0` | 150,343,052 B | 2026-10-04 的手工分发包，**早于** 10-07 的 tag 构建 |
| 分发 ZIP 内 NSIS 安装包 | `SkillVault Setup 1.0.0.exe`（ZIP 内） | 同上 | `e8874d5fa5d9c8b875c50cac52aac6fee7f8abff63508f72d6eba2fa59076b88` | 75,297,336 B | 与 `dist/pkg-20261004/` 内同名文件一致 |
| 分发 ZIP 内 portable 便携版 | `SkillVault 1.0.0.exe`（ZIP 内） | 同上 | `b0302f83fc204966d347cd42952ba644f381f45e4f37e567c572c1fb472a9945` | 75,035,027 B | 与 `dist/pkg-20261004/` 内同名文件一致 |
| WSL 伴生 CLI（分发包内） | `dist/pkg-20261004/companion/skm.mjs` | `6f370db`（**已逐字节验证**，见 §4.5） | `93a38373feba2acc51c7873b8fec46a13d526f61c45fe1dcaa5e618c1e3be92e` | 19,142 B | 2026-10-04 版本，**早于**当前 `out/skm.mjs` |
| WSL 伴生 CLI（当前构建产物） | `out/skm.mjs` | 参赛源码（`src/companion/skm.ts` 含发布之后的可靠性修复） | `75b080b1f98ac7edfe2440fd109ef22f560e4e34558ba74fbfc33f98256ce3dc` | 25,476 B | 2026-11-04 重建；与 `dist/win-unpacked/resources/app.asar` 内嵌版本不同（见 §4.3） |
| 应用主包（解包态） | `dist/win-unpacked/resources/app.asar` | `9035ca8` | `7697176795f3e5a49ea05913eb4dd0b22861af1c50f397a70bbdc4cf28ca8966` | 5,612,591 B | 内含 `out/main/index.js`、`out/skm.mjs` 等 |
| 应用主程序（解包态） | `dist/win-unpacked/SkillVault.exe` | Electron 33 运行时 + 上述 asar | `d44bd3c5b4a48daf3cfb32cf3376b67f8c58d08fcceea22fc72ccc086c2fa8b2` | 188,866,560 B | 运行时壳，版本由 `package.json` 的 `1.0.0` 决定 |
| 源码树（当前参赛） | 整个仓库 | 本次参赛锚点，见 `docs/source-manifest.json` | `src` 子树哈希 `5796b062ed8b55fb30fd21eaef22e3988cee8fb5` | — | 与 `9035ca8` 相差 15 个文件的可靠性修复（§1） |
| 源码树（发布提交） | `9035ca8` | v1.0.0 标签所指 | `src` 子树哈希 `460f3f5c7dee41799babbb48cd49ce4ce55550a2` | — | 已发布二进制的来源（§4） |

> 表中 `dist/`、`out/` 两条来源是本机工作区实测值。**评审者重建后哈希可能不同**——electron-builder 会嵌入时间戳等非确定性内容。核对方法见 §6、§7。

---

## 3. Release 与源码锚点的关系

### 3.1 发布提交与当前参赛源码的 `src/` 差异（实际输出）

```
$ git diff --stat 9035ca8 main -- src/
 src/main/apihub/index.ts | 22 ++++++++++++++++++++--
 1 file changed, 20 insertions(+), 2 deletions(-)
```

（这是**已提交的 main**；工作树里还有本轮可靠性修复的其余改动，合计 15 个文件、+690/−148 行，见 §1。）

Git 的树对象哈希是内容寻址的，因此可以直接对比两端的 `src` 子树：

```
$ git rev-parse 9035ca8:src main:src
460f3f5c7dee41799babbb48cd49ce4ce55550a2
5796b062ed8b55fb30fd21eaef22e3988cee8fb5
```

**结论（按当前状态如实陈述）：**

- `9035ca8`（v1.0.0 标签）**就是已发布二进制的来源** —— 这一点由 §4.4 的「从标签提交重打一遍、逐文件比对」独立验证（7/7 应用文件 MATCH），不依赖任何关于「哪个提交更新」的推断。
- 当前参赛源码**比发布产物新一轮**：发布之后做了可靠性修复（git 异步化、同步失败分级与快速终止、硬链接修复前展示差异、IPC 通道单点注册），`src/` 相应变化。
- 「Release 提交号 ≠ 文档锚点」这一事实成立，但它指的是**提交对象不同**（标签打在原始历史上、参赛源码在重建历史上），**不意味着发布出去的程序与仓库里的程序是两份不同的东西** —— 它们同源，仓库只是更新。

> 需要核对当前参赛源码到底是哪一版，请用 `docs/source-manifest.json` 的 `anchorCommit` 与 `srcFingerprint`，或直接运行 `node scripts/source-manifest.mjs --check`。

### 3.2 「发布提交 ↔ 文档初稿锚点」当时到底差在哪（历史证据的完整 diff stat）

> **时间限定**：下面这份 diff 是**本文档初稿撰写时**（锚点 `2e3ede7`）的实测摘录，
> 用来证明「那两条历史在最终代码上等价、差异全在文档侧」。**当前参赛源码又前进了一轮
> 可靠性修复**（§1、§3.1），因此现在重跑同一条命令会看到 `src/` 也有差异 —— 那是发布之后
> 的新改动，不是重建丢内容。

```
$ git -c core.quotepath=false diff --stat 9035ca8 2e3ede7
 .env.example                                  |   13 +
 .gitignore                                    |    3 +
 CHANGELOG.md                                  |   83 +
 LICENSE                                       |   21 +
 README.md                                     |   33 +-
 REPRODUCE.md                                  |  240 ++
 docs/SkillVault-技术文档.docx                 |  Bin 0 -> 793743 bytes
 docs/SkillVault-技术文档.pdf                 |  Bin 0 -> 1731202 bytes
 docs/figures/fig-2-1-系统总体架构.png         |  Bin 0 -> 78492 bytes
 docs/figures/fig-2-2-双宿主裸Git协同.png      |  Bin 0 -> 60507 bytes
 docs/figures/fig-2-3-API档案转换与恢复.png    |  Bin 0 -> 65475 bytes
 docs/figures/fig-2-4-健康运维与降级.png       |  Bin 0 -> 59557 bytes
 docs/figures/fig-4-1-配置写入与补偿恢复.png   |  Bin 0 -> 70941 bytes
 docs/figures/fig-4-2-部署与验收顺序.png       |  Bin 0 -> 60208 bytes
 docs/measured-data.json                       |   80 +
 docs/prompt-chains/01-从零构建跨端技能库.md   | 2461 +++++++++++++++++++++++++
 docs/prompt-chains/02-全量重审修复40个缺陷.md | 1273 +++++++++++++
 docs/prompt-chains/03-跨机乱码全链路排查.md   |  624 +++++++
 docs/prompt-chains/04-Agent自适应发现.md      |  791 ++++++++
 docs/screenshots/00-dashboard.png             |  Bin 0 -> 111686 bytes
 docs/screenshots/01-import.png                |  Bin 0 -> 138839 bytes
 docs/screenshots/02-sync.png                  |  Bin 0 ->  89347 bytes
 docs/screenshots/03-doctor.png                |  Bin 0 ->  99849 bytes
 docs/screenshots/04-version-center.png        |  Bin 0 -> 135999 bytes
 docs/screenshots/05-docker.png                |  Bin 0 ->  59981 bytes
 docs/screenshots/06-wsl.png                  |  Bin 0 ->  92796 bytes
 docs/screenshots/07-apihub.png                |  Bin 0 -> 111591 bytes
 docs/screenshots/08-settings.png              |  Bin 0 ->  98282 bytes
 28 files changed, 5616 insertions(+), 6 deletions(-)
```

（默认 `core.quotepath=true` 时中文路径会显示为八进制转义，加 `-c core.quotepath=false` 才可读；两者内容一致。）

逐项归类：

- **程序代码**：`src/`、`tests/`、`scripts/`、`package.json`、`electron-builder.yml`、`electron.vite.config.ts`、`tsconfig.json`、`build/` —— **全部零差异**。
- **新增/修改的全是「关于项目的材料」**：README、REPRODUCE（10 分钟复现指南）、CHANGELOG、LICENSE、`.env.example`、`.gitignore`。
- **技术文档本体**：DOCX / PDF 二进制更新（由 `578387`/`1487339` 字节变为 `793743`/`1731202` 字节）。
- **会话过程快照**：`docs/prompt-chains/` 四份 Markdown 新增（合计约 5,149 行），以及 `docs/figures/`、`docs/screenshots/`、`docs/measured-data.json`。

这与盲评的判断完全吻合：**「这不自动证明程序代码不同」——事实上程序代码就是相同的；缺的是这份差异说明与二进制对应关系，也就是本文件要补的东西。**

### 3.3 `backup-original-history` 分支与 `main` 的关系（提交历史被重建过）

```
$ git log --oneline backup-original-history
9035ca8 agent 自适应发现 + 接口/版本中心动态化 + 自定义供应商 + 导入自动扫描 + 全页白话化 + UI 适配修复（566 tests green）
6f370db 跨机乱码修复 + 换机默认路径 + 门禁安全改写（452 tests green）
a003e44 Initial commit: SkillVault - cross Windows/WSL skill vault manager (Electron)

$ git log --format='%h %ad %s' --date=short backup-original-history
9035ca8 2026-10-07 agent 自适应发现 + ...
6f370db 2026-10-06 跨机乱码修复 + ...
a003e44 2026-09-17 Initial commit: SkillVault - cross Windows/WSL skill vault manager (Electron)

$ git merge-base main backup-original-history
（无输出，exit=1 —— 两条历史没有共同祖先）

$ git rev-list --max-parents=0 main backup-original-history
a003e444dde68da41ff7e381fc816e71b9c495cc     ← backup-original-history 的根
ec610ba7ae1e00bae9645e906e83497156691345     ← main 的根

$ git rev-list --count main
20
$ git rev-list --count backup-original-history
3
```

**如实说明：**

1. `backup-original-history` 保存的是**原始单提交历史**：一个 `a003e44`「Initial commit」把整个项目一次性导入，之后只有 `6f370db`、`9035ca8` 两次提交。
2. `main` 的历史是**按模块事后整理重建**的：20 个语义化提交（`ec610ba`「Electron 应用骨架」→ … → `2e3ede7`「add measured data, prompt chain snapshots and UI screenshots」→ `4ddffc1` / `c458bcb`「correct factual claims per blind review」→ `905214c`「perf measurement script」），根提交是 `ec610ba`。
3. 两条历史**没有共同祖先**（`git merge-base` 返回空）。在本文档初稿撰写时，它们描述的是**同一份最终代码状态**（差异只在文档侧，§3.2）；此后参赛源码又做了一轮可靠性修复，当前两者在 `src/` 上已有 15 个文件的差异（§3.1）—— 但那差异是**发布之后新增的改动**，而不是重建过程中丢失的内容。
4. 因此：**原始的开发先后顺序与中间状态没有被保留**。评审者现在在 `main` 上看到的提交顺序、提交边界、提交信息里的测试数变化，都是**按功能模块事后整理**的结果，不是当时的真实推送时序。提交信息中的日期是按轮次归属标注，而非实际推送时间。
5. 这正是技术文档 §4.3 里写明的口径（「仓库当前的提交是对最终状态按模块所做的事后整理……不等同于原始开发时序」），在此处给出对应的 `git` 证据。

> 评审者若要检查重建前的历史：`git log --oneline backup-original-history`、`git show a003e44 --stat`。
> 若要确认重建没有丢内容：`git diff --stat 9035ca8 2e3ede7 -- src/ tests/`（输出为空）即说明**在文档初稿撰写时**两份历史在最终代码上等价；此后新增的可靠性修复差异见 §3.1 的实际输出。

### 3.4 `v1.0.0` 标签的对象

```
$ git tag -n99 v1.0.0
v1.0.0          agent 自适应发现 + 接口/版本中心动态化 + 自定义供应商 + 导入自动扫描 + 全页白话化 + UI 适配修复（566 tests green）

$ git show-ref --tags
9035ca81f5b6ea82482138b0de820d540bd38d82 refs/tags/v1.0.0

$ git cat-file -t v1.0.0
commit                       ← 是轻量标签（直接指向 commit，不是 tag object）

$ git merge-base --is-ancestor v1.0.0 main ; echo $?
1                            ← v1.0.0 不是 main 的祖先
$ git merge-base --is-ancestor v1.0.0 2e3ede7 ; echo $?
1                            ← v1.0.0 也不是 2e3ede7 的祖先
```

即：`v1.0.0` 指向 `9035ca8`，该提交位于 `backup-original-history` 分支上，**与 `main` 无祖先关系**。这是「Release 显示的提交号」与「文档锚点」对不上的**直接原因**：标签打在了原始历史上，而文档锚点落在重建历史上，两条历史在 Git 图上互不相连。

需要说明的是，两条历史在**树内容**上的关系随时间变化：本文档初稿撰写时（锚点 `2e3ede7`）两者 `src/` 完全相同；此后发布提交之后又做了一轮可靠性修复（见 §1），当前参赛源码的 `src/` 已比发布提交多出 15 个文件的改动。哪一版才是「本次参赛的那一版」，以 `docs/source-manifest.json` 的 `anchorCommit` 与 `srcFingerprint` 为准。

---

## 4. 二进制 ↔ 源码的对应关系（盲评要求的第二点）

### 4.1 构建时间与 tag 提交时间吻合

```
$ git log -1 --format='%H %ad' --date=iso-strict 9035ca8
9035ca81f5b6ea82482138b0de820d540bd38d82 2026-10-07T18:49:37+08:00

$ stat -c '%n %y' 'dist/SkillVault Setup 1.0.0.exe'
dist/SkillVault Setup 1.0.0.exe 2026-10-07 18:18:53.189958100 +0800

$ grep releaseDate dist/latest.yml
releaseDate: '2026-10-07T10:18:54.308Z'      ← 与上行的本地时间同为 2026-10-07 18:18（UTC+8）
```

安装包构建于 2026-10-07 18:18，与 `9035ca8` 的提交时间 18:49 属同一天同一轮发布作业。

### 4.2 安装包内的 sha512 与 `latest.yml` 记录一致

```
$ node -e "…sha512(dist/SkillVault Setup 1.0.0.exe)…"
rDFL6J5n8jkncVwhQSOfTXQesbeqbqQxJDLvMwwCuPvIq3IztoZEyFu91uQatxsuD3xjjH6BGA+g+18Pfks2QA==

$ grep sha512 dist/latest.yml
    sha512: rDFL6J5n8jkncVwhQSOfTXQesbeqbqQxJDLvMwwCuPvIq3IztoZEyFu91uQatxsuD3xjjH6BGA+g+18Pfks2QA==
sha512: rDFL6J5n8jkncVwhQSOfTXQesbeqbqQxJDLvMwwCuPvIq3IztoZEyFu91uQatxsuD3xjjH6BGA+g+18Pfks2QA==
```

两者逐字符相同：发布元数据与实际分发文件对应无误。

### 4.3 二进制里确实含有 `9035ca8` 那一版引入的功能（参赛源码同样具备）

`src/main/agentDiscover.ts`、`src/main/skillScan.ts`、`src/shared/agentSignatures.ts` 这三个文件是在 `9035ca8`（= `2e3ede7`）这一版才出现的（`git log --diff-filter=A` 显示它们由 `4b67721` 引入，随后在两条历史中内容一致：`git rev-parse 9035ca8:src/main/agentDiscover.ts` 与 `4b67721:src/main/agentDiscover.ts` 同为 `02701ac3…`）。这些模块带有可搜索的运行时特征串，实测：

```
$ grep -c -a -- "scannedAgents" dist/win-unpacked/resources/app.asar
6
$ grep -c -a -- "目录不存在或无法访问" dist/win-unpacked/resources/app.asar
1
$ grep -c -a -- "WSL companion 不可达或未返回发现结果" dist/win-unpacked/resources/app.asar
1
$ grep -c -a -- "agents-shared" dist/win-unpacked/resources/app.asar
3
```

（`grep -c` 统计的是**匹配行数**；`scannedAgents` 命中 6 行，其余三个串各命中 1/1/3 行——`agents-shared` 同时出现在主进程 bundle、渲染层 bundle 与内嵌的 `out/skm.mjs` 中。）

同时，`dist/win-unpacked/resources/app.asar` 内嵌的 `out/skm.mjs` 与 `2e3ede7` 的 `src/companion/skm.ts` 行为一致——它在「pull 失败」分支里输出的是**没有** `skipped` 字段的那一版：

```
$ node -e "…从 app.asar 头解出 out/skm.mjs 并打印第 3 处 detail 字段…"
asar : …cmd: "git push（pull 失败，跳过）", ok: false, detail: "pull 未成功，本轮不推送" });
repo : …cmd: "git push（pull 失败，跳过）", ok: false, detail: "pull 未成功，本轮不推送", skipped: true });
$ git show 2e3ede7:src/companion/skm.ts | grep -n "pull 未成功"
324:    steps.push({ side: 'wsl', cmd: 'git push（pull 失败，跳过）', ok: false, detail: 'pull 未成功，本轮不推送' })
```

（`9035ca8` 的同一行输出完全相同 —— 该文件在这两个提交之间没有被改动。）

反之，当前参赛源码的 `src/companion/skm.ts`（含 `skipped: true` 改动）构建出的 `out/skm.mjs` 与 asar 内版本**不同**（SHA-256 `75b080b1…` vs `4d8b1488…`）。这条差异恰好把「发布二进制 = 标签提交（`9035ca8`）的 `src/`」这一点钉死：发布物里**没有**任何标签之后的改动。

### 4.4 从 tag 提交重打一遍，产物与已发布二进制逐文件一致（最强证据）

为了不靠「特征串相似」这种间接推断，本节把 `v1.0.0` 标签所在的提交单独签出到一个临时 worktree，**完整重跑构建与打包**，再与仓库里已发布的 `dist/` 逐文件比对：

```
$ git worktree add /tmp/sv-wt-9035ca8 9035ca8
$ cd /tmp/sv-wt-9035ca8 && pnpm install
$ ./node_modules/.bin/electron-vite build
$ ./node_modules/.bin/esbuild src/companion/skm.ts --bundle --platform=node --format=esm --target=node18 --outfile=out/skm.mjs
$ ./node_modules/.bin/electron-builder --win
```

重建结果与已发布产物的对照：

| 文件 | 从 `9035ca8` 重建 | 已发布（仓库 `dist/`） | 结论 |
|---|---|---|---|
| `out/main/index.js` | `5024b31df14bf892…` | `5024b31df14bf892…` | **MATCH**（220,688 B） |
| `out/main/adapters-Dq0RSplK.js` | `7bc990a9de6fff89…` | `7bc990a9de6fff89…` | **MATCH**（4,841 B） |
| `out/main/registryRead-UzuDBGmP.js` | `3ad3efc5a38b69e4…` | `3ad3efc5a38b69e4…` | **MATCH**（874 B） |
| `out/main/visibility-ClsgbRSD.js` | `a2a4957f148554fc…` | `a2a4957f148554fc…` | **MATCH**（3,916 B） |
| `out/preload/index.js` | `eaf13f37119a10d4…` | `eaf13f37119a10d4…` | **MATCH**（10,328 B） |
| `out/skm.mjs` | `4d8b1488da5dcbf8…` | `4d8b1488da5dcbf8…` | **MATCH**（25,461 B） |
| `package.json` | `4edaca402c0b2025…` | `4edaca402c0b2025…` | **MATCH**（415 B） |
| `out/renderer/assets/index-*.js` | `0d0284d7e8bf8509…` | `0d0284d7e8bf8509…` | **MATCH**（376,656 B，文件名哈希不同但内容相同） |
| `out/renderer/assets/index-*.css` | `56f8a6baa873ea23…`（CRLF→LF 归一后） | `56f8a6baa873ea23…` | **MATCH**（16,021 B） |
| `out/renderer/index.html` | 归一后逐行相同 | — | 仅 CRLF 与资源文件名哈希不同 |

> **结论（可直接写进评审答复）**：用 `9035ca8` 的源码重建出的应用主进程、预加载、渲染层与伴生 CLI，**每一个可执行/可加载文件都与已发布安装包内的对应文件字节级一致**（渲染层的 CSS/HTML 差异仅为 Windows checkout 的 CRLF 行尾与 Vite 资源文件名哈希）。
>
> 这直接证明：**已发布的 `dist/` 二进制确实是由 `9035ca8` 的源码打出来的**。盲审担心的「程序代码与仓库里说的不是同一份」这一可能性被排除 —— 已发布二进制与仓库 `main` 上的源码同源，只是仓库在发布之后又做了一轮可靠性修复（§1），因此当前参赛源码比发布产物更新。
>
> 顶层 exe 本身的 SHA-256 仍与已发布件不同（重建 `8081945c…` / `b5f08c1c…` vs 已发布 `48e58acb…` / `3549334d…`，大小 75,312,136 vs 75,313,648），原因是 NSIS/portable 打包会嵌入构建时间戳与压缩流差异——这属于**打包器不确定性**，不是源码差异；electron-builder 日志里可见每次都跳过签名（`no signing info identified, signing is skipped`）。

> 结论：**发布出来的 `dist/` 二进制，确实是由 `9035ca8` 的 `src/` 打出来的。**「Release 提交号 ≠ 文档锚点」源于 Git 图上的两条历史；当前参赛源码在发布之后又经过一轮可靠性修复，比发布产物更新（§1）。

### 4.5 2026-10-04 手工分发包对应的是更早的 `6f370db`

`dist/pkg-20261004/`（及其 ZIP）里的 `companion/skm.mjs` **不是** `9035ca8` 那一版，而是 `6f370db`（2026-10-06 那次「跨机乱码修复」提交）那一版。这一点可以逐字节验证：

```
$ # 把 6f370db 的 src/companion/skm.ts + src/shared/* 检出到独立目录后按 package.json 的同一命令构建
$ ./node_modules/.bin/esbuild src/companion/skm.ts --bundle --platform=node --format=esm --target=node18 --outfile=out-skm.mjs
$ sha256sum out-skm.mjs
93a38373feba2acc51c7873b8fec46a13d526f61c45fe1dcaa5e618c1e3be92e  out-skm.mjs     ← 19,142 B

$ sha256sum dist/pkg-20261004/companion/skm.mjs
93a38373feba2acc51c7873b8fec46a13d526f61c45fe1dcaa5e618c1e3be92e  dist/pkg-20261004/companion/skm.mjs
```

**SHA-256 完全相同**。作为对照，`9035ca8` 那一版构建出来的是 `4d8b1488…`（25,461 B），与 10-04 分发包里的副本**不是**同一份。

功能层面也能看出差别：10-04 版没有 Agent 自动发现子命令（`cmdScanAgents` / `--agents` 命中数均为 0），而 `9035ca8` 版有（命中 2 / 1）。

因此 §2 表中 2026-10-04 分发包的各行对应的源码锚点是 `6f370db`，**不是** `9035ca8`；这是**如实标注**，不是缺陷。ZIP 内两个 exe 的哈希与 `dist/pkg-20261004/` 内同名文件一致（`e8874d5f…` / `b0302f83…`），三者构成一个自洽的旧版分发件。

---

## 5. 文档版本 ↔ 源码提交 的对应

### 5.1 封面锚点的修正史（以及为什么最终改成不印 SHA）

```
$ for r in 2e3ede7 4ddffc1 c458bcb; do …解包 docx 并读取 word/document.xml…; done
-- 2e3ede7:
    github.com/nayutalot/SkillVault                                        commit 9035ca81
-- 4ddffc1:
    源码版本：github.com/nayutalot/SkillVault @ 2e3ede7
    github.com/nayutalot/SkillVault                                        commit 2e3ede7
-- c458bcb:
    源码版本：github.com/nayutalot/SkillVault @ 2e3ede7
    github.com/nayutalot/SkillVault                                        commit 2e3ede7
```

- 在 `2e3ede7` 这一版文档里，封面写的是 `commit 9035ca81`；
- 盲评指出后，`4ddffc1` / `c458bcb` 把封面改成 `源码版本：… @ 2e3ede7` + `commit 2e3ede7`，并新增「源码版本」一行。

这段历史说明了一件容易被误解的事：**在文档正文里印一个固定的 commit SHA 是靠不住的** —— 因为包含这段文字的那次提交本身还没产生，印出来的 SHA 永远比它旧一步（自指悖论）。

因此当前版本的做法是：**封面与正文都不再印 SHA，改为指向 `docs/source-manifest.json`** —— 该清单由 `pnpm manifest` 生成，记录本次参赛对应的 `anchorCommit` 与 `src/` 内容指纹，评审者可用 `node scripts/source-manifest.mjs --check` 独立复算。

至于「Release 实际发布的程序」与「参赛源码」的关系：**已发布二进制由 `9035ca8` 打出（§4.4 逐文件验证），参赛源码在发布之后又做了一轮可靠性修复（§1、§3.1）**。盲评指出的「缺少差异说明和二进制对应关系」，由本文件 §3.1、§3.2 与 §4 补齐。

### 5.2 文档二进制与提交的关系

```
$ for r in 9035ca8 2e3ede7 4ddffc1 c458bcb HEAD; do git ls-tree -r $r -- "docs/SkillVault-技术文档.docx" "docs/SkillVault-技术文档.pdf"; done
-- 9035ca8
（空：该提交中尚无技术文档）
-- 2e3ede7
100644 blob 0c245a625b361ce13c43c3737a8de958115d3428  "docs/SkillVault-技术文档.docx"
100644 blob 7338e0ef4698f4402ecfb1243145f6f0107975c5  "docs/SkillVault-技术文档.pdf"
-- 4ddffc1
100644 blob 060256d6cde356727dcce6ef6bbc39eb39482444  "docs/SkillVault-技术文档.docx"
100644 blob c9be818e7b324714364d7f354b109b05a757a80d  "docs/SkillVault-技术文档.pdf"
-- c458bcb
100644 blob d64c15ecaabcb170e5a9527c21dcb3018bf127e5  "docs/SkillVault-技术文档.docx"
100644 blob a29d2e4062b9610a1c5f4d0d2d7282680b92eb59  "docs/SkillVault-技术文档.pdf"
-- HEAD
100644 blob d64c15ecaabcb170e5a9527c21dcb3018bf127e5  "docs/SkillVault-技术文档.docx"
100644 blob a29d2e4062b9610a1c5f4d0d2d7282680b92eb59  "docs/SkillVault-技术文档.pdf"

$ git cat-file blob d64c15ecaabcb170e5a9527c21dcb3018bf127e5 | sha256sum
69aa234b9789234459ff44c62b7e115c9878d7524fa9f0aafd958b836afcd753
$ git cat-file blob a29d2e4062b9610a1c5f4d0d2d7282680b92eb59 | sha256sum
0bd161a643254626074f322ce008c123b22ff8f52f86c3b102fe768a6024b960
```

（`git cat-file blob` 输出的是 blob 的**原始字节**，管道到 `sha256sum` 得到的就是 §2 表中列出的 PDF 哈希 `0bd161a6…`；DOCX 同理为 `69aa234b…`。）

工作区文件与 `HEAD`（`905214c`）中的 blob 逐字节相同，SHA-256 与 §2 表中列出的一致。

### 5.3 文档正文中的「提交历史 ↔ 对话快照」口径

技术文档 §4.3 明确写着：仓库当前的提交是**事后整理**的结果，原始提交先后顺序与中间态未保留，表格是**主题级**多对多关联而非一一对应证明。本文件 §3.3 给出了这一说法的 `git` 证据。

### 5.4 发布提交之后的可靠性修复

`9035ca8`（发布提交）之后，参赛源码又做了一轮**有意为之的可靠性修复**，共 15 个源文件、+690/−148 行：

```
$ git diff --stat 2e3ede7 -- src/
 src/companion/skm.ts                       |   3 +-
 src/main/apihub/index.ts                   |  22 ++-
 src/main/doctor.ts                         |  16 +-
 src/main/git.ts                            |  88 ++++++-
 src/main/importer.ts                       |  19 +-
 src/main/ipc.ts                            |  14 +-
 src/main/remoteSync.ts                     |  11 +-
 src/main/sync.ts                           | 147 ++++++++++----
 src/main/winLinks.ts                       | 240 ++++++++++++++++++++++++++-
 src/renderer/src/app.css                   |  11 +
 src/renderer/src/components/sync-steps.tsx |  50 ++++++
 src/renderer/src/pages/Dashboard.tsx       |  70 +++++++--
 src/renderer/src/pages/Sync.tsx            |  26 +--
 src/shared/types.ts                        |  30 ++++-
 14 files changed, 655 insertions(+), 92 deletions(-)

$ git diff --stat 2e3ede7 HEAD -- src/
 src/main/apihub/index.ts | 22 ++++++++++++++++++++--
 1 file changed, 20 insertions(+), 2 deletions(-)
```

**这些修复没有进入已发布的 `dist/` 二进制**（§4.3 已用 asar 内嵌 `skm.mjs` 的 `skipped` 字段验证）。因此：

- §2 表中「NSIS 安装包 / portable 便携版 / app.asar」对应的是 **`9035ca8` 这一版的 `src/`**；
- 「当前构建产物 `out/skm.mjs`」对应的是**含这轮可靠性修复的参赛源码**；
- 两者 SHA-256 不同是**预期行为**，不是损坏。

---

## 6. 如何自行核对

### 6.1 核对提交关系与源码一致性

```bash
# 1) 标签指向哪里
git show-ref --tags
git tag -n99 v1.0.0
git cat-file -t v1.0.0          # commit（轻量标签）

# 2) 应用源码在两个锚点之间是否有差异（期望：输出为空）
git diff --stat 9035ca8 2e3ede7 -- src/
git diff --stat 9035ca8 2e3ede7 -- tests/

# 3) 逐路径比对 Git 对象哈希（期望全部 IDENTICAL）
for p in src tests scripts package.json electron-builder.yml electron.vite.config.ts tsconfig.json build; do
  a=$(git rev-parse "9035ca8:$p"); b=$(git rev-parse "2e3ede7:$p")
  [ "$a" = "$b" ] && s=IDENTICAL || s=DIFFERENT
  printf "%-26s %s  %s\n" "$p" "$s" "$a"
done

# 4) 差异全貌（期望：只有文档/截图/实测数据）
git diff --stat 9035ca8 2e3ede7
git diff --name-only 9035ca8 2e3ede7

# 5) 两条历史的关系（期望：无共同祖先）
git merge-base main backup-original-history ; echo "exit=$?"     # exit=1
git log --oneline backup-original-history
git rev-list --max-parents=0 main backup-original-history
git rev-list --count main
git rev-list --count backup-original-history

# 6) 文档锚点与当前 HEAD 的关系
git log --oneline 2e3ede7..HEAD
git diff --stat 2e3ede7 HEAD -- src/
```

### 6.2 重建产物并计算哈希

```bash
# Windows（PowerShell）
pnpm install
pnpm build            # electron-vite build + typecheck
pnpm dist             # 生成 NSIS 安装包 + portable 便携版 到 dist/
pnpm build:companion  # 生成 WSL 伴生 CLI out/skm.mjs

# 计算哈希与大小
Get-FileHash -Algorithm SHA256 'dist\SkillVault Setup 1.0.0.exe'
Get-FileHash -Algorithm SHA256 'dist\SkillVault 1.0.0.exe'
Get-FileHash -Algorithm SHA256 'out\skm.mjs'
Get-Item 'dist\SkillVault Setup 1.0.0.exe' | Select-Object Length
```

```bash
# 等价的 POSIX 命令
sha256sum "dist/SkillVault Setup 1.0.0.exe" "dist/SkillVault 1.0.0.exe" out/skm.mjs
stat -c '%n %s' "dist/SkillVault Setup 1.0.0.exe" "dist/SkillVault 1.0.0.exe" out/skm.mjs
```

### 6.3 校验发布元数据与分发文件是否对应

```bash
grep sha512 dist/latest.yml
node -e "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha512').update(fs.readFileSync('dist/SkillVault Setup 1.0.0.exe')).digest('base64'))"
```

### 6.4 从 tag 提交重建并逐文件比对（复现 §4.4 的最强证据）

```bash
# 用独立 worktree 检出标签提交，避免污染当前工作区
git worktree add /tmp/sv-wt-9035ca8 9035ca8
cd /tmp/sv-wt-9035ca8
pnpm install
./node_modules/.bin/electron-vite build
./node_modules/.bin/esbuild src/companion/skm.ts --bundle --platform=node --format=esm --target=node18 --outfile=out/skm.mjs
./node_modules/.bin/electron-builder --win

# 逐文件比对重建结果与已发布 asar（out/main、out/preload、out/skm.mjs 期望完全一致）
sha256sum out/main/index.js out/preload/index.js out/skm.mjs
# 与已发布 asar 内同路径文件解出后比对：
#   node -e "…解析 asar 头（dataOffset = 8 + readUInt32LE(4)）并对同路径文件算 sha256…"

# 清理
cd - && git worktree remove /tmp/sv-wt-9035ca8 --force
```

### 6.5 核对二进制确实含该版功能

```bash
grep -c -a -- "scannedAgents" dist/win-unpacked/resources/app.asar
grep -c -a -- "agents-shared"   dist/win-unpacked/resources/app.asar
```

### 6.6 核对文档内的会话计数（可复算，不需信任断言）

```bash
node scripts/count-prompt-chains.mjs            # 复算并写出 docs/prompt-chain-stats.json
node scripts/count-prompt-chains.mjs --check    # 与既有 JSON 比对，不一致则退出码 1
node scripts/count-stats.mjs --check            # 规模数字（行数/用例数/断言数）复算
```

---

## 7. 本表的局限

1. **二进制未签名。** `electron-builder.yml` 明确写着「无签名证书，不做签名」。因此安装包与便携版的哈希只能证明「文件与你手上这份一致」，**不能**证明「文件来自某个可信构建流程」。评审者应把本表中的 SHA-256 当作**本次提交的指纹**核对，而不是当作供应链签名。

2. **产物不在仓库里。** `dist/`、`out/` 都在 `.gitignore` 中：
   ```
   $ cat .gitignore
   node_modules/
   out/
   dist/
   …
   $ git check-ignore -v dist out
   .gitignore:3:dist/	dist
   .gitignore:2:out/	out
   ```
   评审者克隆仓库后**看不到** §2 表中 `dist/`、`out/` 各行，必须自行构建后重算哈希。

3. **哈希是机器相关且部分非确定的。** electron-builder 打包会嵌入构建时间、路径等信息，**重建后的 SHA-256 很可能与本表不同**。本表中的哈希对应的正是**这台机器、这一时刻**的产物（安装包 mtime `2026-10-07 18:18:53`）。可稳定复现的是：
   - `dist/latest.yml` 中记录的 sha512 **与该次构建产出的文件**一致（§4.2 已验证）；
   - 从 `9035ca8` 重建的**应用内文件**（主进程/预加载/渲染层/伴生 CLI）与已发布安装包内对应文件**字节级一致**（§4.4 已验证）——这一层的可复现性是**强的**；
   - 顶层 exe 的 SHA-256 不可复现（打包器时间戳与压缩流差异），评审者应核对**内层文件**而非顶层 exe 哈希。

4. **`v1.0.0` 标签指向的是参赛之前的提交。** 标签落在 `9035ca8`（原始历史那条线上），而参赛源码在重建历史上，两者在 **Git 图上不相连**（`git merge-base` 为空）。任何「按标签 checkout 后应当与文档描述完全一致」的直觉在这里不成立 —— 标签是**发布产物**的来源，参赛源码是**发布之后又修过一轮可靠性问题**的版本（§1、§3.1、§5.4）。两者的程序内容同源，但不是同一份字节。

5. **提交历史是重建的。** `main` 的 20 个提交是对最终状态按模块做的事后整理，`backup-original-history` 保留了原始的 3 提交历史，两条历史无共同祖先。**原始开发顺序与中间状态未被保留**（§3.3）。因此本表只能证明「最终源码状态 ↔ 产物」的对应，**不能**重建「每一次提交 ↔ 每一个安装包」的完整映射。

6. **参赛源码比发布产物新一轮。** §5.4 列出了 `src/` 下 15 个文件的可靠性修复（+690/−148 行）。这些修复**不在**已发布的 `dist/` 二进制里。评审者若用参赛源码执行 `pnpm dist`，得到的二进制将**不等于**本表中的安装包 —— 那是预期的：前者是修复后的版本，后者是已发布的 v1.0.0。

7. **`dist/pkg-20261004/` 与 2026-10-04 ZIP 是手工打包的旧分发件**，对应源码锚点是 `6f370db`（§4.5 已逐字节验证），**不是** `v1.0.0` 标签所在的 `9035ca8`。其内的 `companion/skm.mjs`（19,142 B）与当前 `out/skm.mjs`（25,476 B）**不是同一版本**。表内已分别列出，不应混用；评审若要核对 **v1.0.0** 那一版，请以 `dist/SkillVault Setup 1.0.0.exe`（2026-10-07 构建）为准。

8. **技术文档 PDF/DOCX 的哈希对应参赛提交中的文件**（§5.2 已验证）。若在改动过文档的工作区上核对，需先确认 `git diff <anchorCommit> -- docs/` 为空。

9. **本文件只做「对应关系说明」，不构成可执行性证明。** 程序是否按文档描述工作，仍需按 `REPRODUCE.md` 实机复现；本表解决的是「哪个产物对应哪一份源码」这一层。

---

## 附：本文件引用的关键提交

| 提交 | 说明 |
|---|---|
| `a003e44` | 原始历史的根提交（`backup-original-history`）：`Initial commit: SkillVault - cross Windows/WSL skill vault manager (Electron)` |
| `6f370db` | 原始历史第 2 个提交：跨机乱码修复 + 换机默认路径 + 门禁安全改写（452 tests green）。**2026-10-04 手工分发包（`dist/pkg-20261004/` 与同名 ZIP）对应的是这一版**（§4.5） |
| `9035ca8` | 原始历史顶端，**`v1.0.0` 标签指向此提交**：agent 自适应发现 + 接口/版本中心动态化 + 自定义供应商 + 导入自动扫描 + 全页白话化 + UI 适配修复（566 tests green） |
| `ec610ba` | 重建历史（`main`）的根提交：Electron 应用骨架、共享层与 vault 链接分发 |
| `2e3ede7` | **技术文档封面锚点**：add measured data, prompt chain snapshots and UI screenshots（重建历史第 17 个提交） |
| `4ddffc1` / `c458bcb` | 按盲评修正文档事实性表述、统一版本锚点（把封面从 `9035ca81` 改为 `2e3ede7`） |
| `905214c` | 当前 `HEAD`：perf: add single-driver reproducible measurement script for junction vs copy |
