<!-- 本文件与 docs/defect-ledger.json 同源：两者内容一致，改动请同步两边。 -->

# SkillVault 缺陷台账（Defect Ledger）

> 生成日期：2026-11-04　·　对应提交：HEAD = `905214c`　·　机器可读版本：[docs/defect-ledger.json](./defect-ledger.json)

## 一、本台账的口径与局限

**本台账是什么。** 一份「缺陷 → 证据 → 修复 → 回归用例」四段齐备的可追溯清单。每一条给出：缺陷 ID、类别、现象、根因、首次发现轮次、修复提交（真实 SHA）、修复位置（`path:line` 或 `path` + 函数名）、回归用例（`tests/*.test.ts` 的**精确标题字符串**，逐字复制），以及是否发生过复发/二次修复。

**本台账不是什么。** 它**不是** 2026-09-07「重审项目，解决所有 bug」那一轮的完整枚举。那一轮的原始记录是：6 个并行审查代理报出约 45 个疑点，主代理逐条核实后**确认并修复约 40 个真实缺陷**（见 `docs/prompt-chains/02-全量重审修复40个缺陷.md` 的收尾总结）。**「约 40 个」是那一轮的汇总口径，不是一份可逐条对账的清单**：

- 那一轮的发现顺序、中间状态、代理间的疑点归属**没有被保存**——会话导出只保留了 AI 回复文本与工具调用计数，没有保留每次 Edit 的完整参数与返回值（见该文件末尾「说明」段）；
- 该轮修复随后被后续多轮提交重构、拆分、并入其它功能模块，原来的「一个 bug ↔ 一个 diff」对应关系已经不可复原；
- 部分当时发现的疑点在核实阶段即被判定为误报或已被既有代码覆盖，本就不该进入清单。

因此本台账的**唯一收录标准**是：**在当前仓库树里仍能同时指出三样东西**——(1) 修复代码的确切位置，(2) 一条针对该缺陷的回归用例（其标题可在测试文件里逐字搜到），(3) 引入该修复的提交 SHA。三者缺一者，或只能凭代码注释推测的，一律**不写入主表**。

**代价与收益。** 代价是清单必然短于原始的「约 40 个」：那些已被后续重构吸收、或当时就没有独立用例的缺陷无法对账。收益是**表里每一行都能被第三方独立复核**——给出行号与用例标题，任何人都能打开对应文件核对，不会出现「编号对不上」「用例名是编的」这类无法验伪的条目。

**当前台账的实际规模：**

| 分区 | 条数 | 说明 |
|---|---:|---|
| §七 主表 | **34** | 有独立回归用例（代码 + 用例 + 提交三者齐全） |
| §八 已修复但暂无独立回归用例 | **18** | 只列 ID / 类别 / 现象 / 根因 / 修复位置 / 修复提交，**没有测试列** |
| §九 已知限制（未修复） | **1** | 代码侧无法可靠兜底，**不计入缺陷修复数**，也没有修复提交 |
| **缺陷合计** | **53** | 含 2026-11-04 轮次新发现并修复的 1 条（伴生 CLI 参数路径穿越） |

**关于「约 40 个」这一数字的诚实表述。** 本台账在 2026-09-07 轮次上收录了 **43 条**（其中 25 条有独立回归用例，18 条无）；2026-11-04 轮次另收录 **2 条**（本轮新发现并修复的伴生 CLI 参数路径穿越，以及接口中心回滚失败不可观测）。这个数字**不等于**、也不声称覆盖原始汇总的「约 40 个」，差额来自三类：(a) 已被后续轮次重构吸收、无法再指向单一修复点的缺陷；(b) 当时在核实阶段被判定为误报或已被既有代码覆盖的疑点；(c) 至今没有独立回归用例、给不出测试标题的修复——后者**已全部放进 §八，不被丢弃，只是没有测试列**。

**关于仓库的两条历史线（复核时会遇到）。** 本仓库有两条历史线：`main`（当前 HEAD = `905214c`，按功能模块切分的语义历史）与 `backup-original-history`（squash 快照线，止于 `9035ca8`，把多轮改动压成 `a003e44` / `6f370db` / `9035ca8` 三个提交）。同一份修复在两条线上由不同 SHA 引入，因此**「修复提交」列的规则**是：记**引入该修复代码的提交**（`git log -S'<源码片段>' -- <文件>` 可核验）；2026-10-04 编码轮多数行在 `main` 线上已被拆进重建后的语义切片提交，故改记该轮专门的 squash 提交 `6f370db`，`main` 线的等价 SHA 逐条列在 §十，机器可读版本的 `fixCommitAlias` 字段是同一份信息。

**每行如何复核。** 对主表任意一行：

```bash
# 1) 修复提交真实存在且是 commit
git cat-file -t <修复提交>

# 2) 修复位置：打开文件跳到该行，确认注释/代码说明的正是这一缺陷
#    （本台账所有行号对应 HEAD=905214c）
sed -n '<行号>p' <修复位置里的文件路径>

# 3) 回归用例标题逐字存在
grep -F '<用例标题>' tests/<用例文件>

# 4) 该修复确实由该提交引入（git log -S 会命中该提交）
git log --format='%h %s' -S'<修复代码片段>' -- <修复位置里的文件路径>
```

机器可读版本 `docs/defect-ledger.json` 的每一行都带一个 `fixLocationNeedle` 字段（该修复点在源码里的原文片段），可直接用于自动化复核。本台账的全部条目已按上述四项逐一核对通过。

## 二、缺陷 ID 方案

| 格式 | 含义 | 示例 |
|---|---|---|
| `D-<发现轮次>-<两位序号>` | 该缺陷**有**独立回归用例，列入 §七 主表 | `D-2026-09-07-01` |
| `D-<发现轮次>-X<两位序号>` | 该缺陷**已修复但暂无**独立回归用例，列入 §八 | `D-2026-09-07-X01` |
| `D-<发现轮次>-K<两位序号>` | **已知限制**，代码侧未修复，列入 §九 | `D-2026-10-04-K01` |

- 发现轮次按会话记录日期：`2026-09-07`（重审修复轮）、`2026-10-04`（跨机乱码轮）、`2026-10-07`（Agent 自适应发现轮）、`2026-11-04`（技术文档盲审修正轮）。
- 序号在**同一轮次内**按主表顺序递增，跨轮次不重置，因此一个 ID 唯一指向一条缺陷。
- ID 一经分配即冻结：即使后续代码被重构，仍以首次分配时的 ID 指称该缺陷，不回收、不复用。

## 三、类别图例

| 类别 | 含义 |
|---|---|
| 数据损坏 | 文件被写坏、编码错乱、行尾错乱 |
| 并发与状态 | 竞态、锁失效、状态覆盖 |
| 边界判定 | 越界、空值、类型、长度、保留名 |
| 安全 | 路径穿越、密钥泄露、越权写 |
| 资源与生命周期 | 临时文件泄漏、进程未回收、句柄占用 |
| 错误处理 | 异常被吞、错误信息失真、失败被报成功 |
| 兼容性 | 换机/换环境后失效、编码/区域设置相关 |
| 可观测性 | 状态不可见、缺少判据 |

## 四、按类别统计

| 类别 | 有独立回归用例（主表） | 无独立回归用例（§八） | 小计 |
|---|---:|---:|---:|
| 数据损坏 | 8 | 2 | 10 |
| 并发与状态 | 2 | 5 | 7 |
| 边界判定 | 7 | 1 | 8 |
| 安全 | 2 | 2 | 4 |
| 资源与生命周期 | 1 | 2 | 3 |
| 错误处理 | 6 | 4 | 10 |
| 兼容性 | 6 | 0 | 6 |
| 可观测性 | 3 | 2 | 5 |
| **合计** | **35** | **18** | **53** |

## 五、按轮次统计

| 轮次 | 该轮可追溯到本台账的缺陷数 | 其中有独立回归用例 | 其中无独立回归用例 |
|---|---:|---:|---:|
| 2026-09-07 | 43 | 25 | 18 |
| 2026-10-04 | 5 | 5 | 0 |
| 2026-10-07 | 3 | 3 | 0 |
| 2026-11-04 | 2 | 2 | 0 |
| **合计** | **53** | **35** | **18** |

各轮次的含义：

- **2026-09-07** — 重审项目，解决所有bug（6 个并行审查代理报约 45 个疑点，主代理逐条核实后确认并修复约 40 个真实缺陷）
- **2026-10-04** — 跨机乱码全链路排查（5 处根因）
- **2026-10-07** — Agent 自适应发现 + 接口/版本中心动态化 + 导入自动扫描
- **2026-11-04** — 技术文档盲审后的事实性修正（含 apihub 回滚可观测性修复）

## 六、复发与二次修复

本台账记录了 2 条**「第一次的修复本身就是错的、后来被重做」**的缺陷。这类缺陷单看最终代码看不出来，必须连同第一次的做法一起记，否则会低估历史风险。

| 缺陷 ID | 类别 | 复发 / 二次修复情况 | 现行代码 |
|---|---|---|---|
| D-2026-09-07-16 | 数据损坏 | 有复发/二次修复：第一版修复只把旧文件移入回收目录（同名即覆盖，用户内容丢失）；第二版才追加 .N 序号去重。现行代码（src/main/winLinks.ts:148-165）是第二版。 | `ec610ba` · src/main/winLinks.ts:148（trashMove 遇同名追加 .1 / .2 … 序号） |
| D-2026-10-04-01 | 数据损坏 | 有复发/二次修复：第一版实现是「UTF-8 解码 + 重编码」，会把 GBK/UTF-16 文件永久写坏（该版本仍可在历史提交 a003e44 的 src/main/doctor.ts:265 看到）；2026-10-04 重做为字节级 crlfToLfBuffer，并新增 NUL 守卫跳过 UTF-16/二进制（src/main/doctor.ts:286）。现行代码（HEAD）是第二版。 | `6f370db` · src/main/doctor.ts:31（crlfToLfBuffer 纯字节级替换：预分配两遍扫描，仅删 CRLF 的 \r，孤立 \r 保留） |

**具体经过：**

1. **D-2026-10-04-01 · doctor 的 CRLF 修复（乱码制造机）**
   - **第一次（错误）**：`buf.toString('utf8').replace(/\r\n/g, '\n')` 再以 `'utf8'` 写回——「按 UTF-8 强解码再重编码」。GBK/ANSI（中文 Windows 记事本默认编码）与 UTF-16LE 文件的非法字节会被替换成 U+FFFD，**永久写坏且不可逆**。这一版仍能在历史提交 `a003e44` 的 `src/main/doctor.ts:265` 直接看到。
   - **第二次（现行）**：改为字节级 `crlfToLfBuffer`（`src/main/doctor.ts:31`），逐字节扫描、仅在 `\r` 后紧跟 `\n` 时删掉 `\r`，孤立 `\r`（旧 Mac 行尾）原样保留；写盘改为 Buffer 直写、不带 encoding 参数；另加 NUL 守卫跳过 UTF-16/二进制文件（`src/main/doctor.ts:286`）。
   - **结论：现行代码是第二版（字节级）。** 判据写在源码注释里：`src/main/doctor.ts:27-30` 明写「绝不 decode/re-encode …… 非法字节会被替换成 U+FFFD，文件永久乱码且换机器必现」。同一修复在 `backup-original-history` 线上的 squash 提交为 `6f370db`，在 `main` 线上由 `5f39d6e` 引入（`doctor.ts` 在两者之间逐字节相同）。

2. **D-2026-09-07-16 · winLinks 回收目录同名覆盖**
   - **第一次（错误）**：修复 agentsDir 冲突时把旧文件 `move` 进回收目录，重名目标被直接覆盖——**第一次修复留下的备份，第二次修复就把它吃掉了**。
   - **第二次（现行）**：`trashMove`（`src/main/winLinks.ts:148`）在目标已存在时追加 `.1` / `.2` … 序号，回收目录里同名备份互不覆盖。
   - **结论：现行代码是第二版（`.N` 序号去重）。** 回归用例标题本身即写明：「同一回收目录内同名备份不互相覆盖（追加 .1 序号；旧 bug：第二次修复静默覆盖第一次的备份）」。
   - **诚实补充：** 仓库历史里**找不到「静默覆盖」那一版实现**——两条历史线最早提交（`main` 的 `ec610ba` 与 `backup-original-history` 的 `a003e44`）里的 `trashMove` 都已经是 `.N` 版本。第一版实现的中间态没有被保存，因此这一条的「第一次修复」只能由用例标题反证其存在，不能给出对应的 SHA。

## 七、主表：有独立回归用例的缺陷（共 34 条）

> 「回归测试」列给出测试文件与**逐字复制的用例标题**，可用 `grep -F` 直接验证。

| 缺陷 ID | 类别 | 现象 | 根因 | 首次发现轮次 | 修复提交 | 修复位置（源码） | 回归测试（文件 + 精确标题） | 是否复发 / 二次修复 |
|---|---|---|---|---|---|---|---|---|
| D-2026-09-07-01 | 数据损坏 | 对 CRLF 行尾的 Codex/Grok config.toml 做一次接口切换，整文件损坏（每行变成 \r\r\n），Codex CLI 随即无法解析；重读校验靠 trim 侥幸通过，损坏内容直接落盘。 | tomlSetKey/removeBlock 用固定 '\n' 拆行再以 '\r\n' join，CRLF 文本每行尾残留 '\r'，join 后叠加成 '\r\r\n'。 | 2026-09-07 | `36cf826` | src/main/apihub/transforms.ts:256（removeBlock / tomlSetKeyLine 按文本实际 eol 拆行再用同一 eol join） | `tests/apihub-transforms.test.ts`<br>「grokApply：CRLF config.toml 切换 model 后绝无 \\r\\r（removeBlock 旧 bug 回归）」 | 无复发 |
| D-2026-09-07-02 | 边界判定 | tomlSetKey 传入带方括号的节名（'[models]'）时拼成 '[[models]]'，永远匹配不到目标节，键值静默退化为追加到文末。 | 实现直接 tomlHeader(sectionHeader)，没有兼容「带括号 / 不带括号」两种节名形态。 | 2026-09-07 | `36cf826` | src/main/apihub/transforms.ts:516（tomlSetKeyLine 节名兼容：剥掉外层方括号后再拼节头） | `tests/apihub-transforms.test.ts`<br>「节内既有键替换、缺键追加、整节缺失创建」 | 无复发 |
| D-2026-09-07-03 | 数据损坏 | Kimi 的 [thinking] 段被整块替换，用户在块内手工加的未知键被清掉。 | thinking 段用整块 upsert 覆盖，而不是只改 enabled 这一个键。 | 2026-09-07 | `36cf826` | src/main/apihub/transforms.ts:460（kimiApplyConfig 改用 tomlSetKeyRaw 键级 upsert） | `tests/apihub-transforms.test.ts`<br>「kimiApplyConfig：[thinking] 键级改写保留块内未知键（整块替换旧 bug 回归）」 | 无复发 |
| D-2026-09-07-04 | 错误处理 | codex 适配器切换时首文件（auth.json）不存在，校验失败后的回滚按 backupFiles[i] 下标对位，抛 TypeError 并把原始校验错误吞掉。 | 备份列表用数组下标与写入列表对位，首文件缺备份时索引错位。 | 2026-09-07 | `36cf826` | src/main/apihub/index.ts:561（backupOf 用 Map 按路径索引，回滚按路径取备份） | `tests/apihub-runtime.test.ts`<br>「codex：auth.json 不存在 + config.toml 存在，校验失败回滚不因 backup 下标错位崩（旧 bug：TypeError 吞掉原错误）」 | 无复发 |
| D-2026-09-07-05 | 数据损坏 | codex 双文件写盘中途失败时，已写成功的 auth.json 不回滚，磁盘上留下新旧不匹配的配置对。 | 写盘循环中途抛错时只清理 .tmp 文件，没有把已写入的文件从备份恢复。 | 2026-09-07 | `36cf826` | src/main/apihub/index.ts:575（rollbackWritten 按路径从备份逐个恢复） | `tests/apihub-runtime.test.ts`<br>「codex：双文件写盘中途失败 → 已写入的 auth.json 也从备份恢复（不留新旧不匹配的配置对）」 | 无复发 |
| D-2026-09-07-06 | 数据损坏 | zcode 适配器切换时，setting.json 里用户已有的非标准「选中键形态」被静默改写成兜底形态，且校验路径派生出不同形态导致永久切换失败。 | knownForms 传空串，zcodeDeriveSelectedForm 永远落到兜底公式，而不是从真实 setting 文件派生。 | 2026-09-07 | `36cf826` | src/main/apihub/index.ts:480（zcodeGlue 调用处传入 d.knownForms，来源是真实的 zcode setting 文件） | `tests/apihub-runtime.test.ts`<br>「zcode：setting.json 里的历史形态参与派生（knownForms 传空串的旧 bug：非标准形态被静默改写）」 | 无复发 |
| D-2026-09-07-07 | 兼容性 | 带 UTF-8 BOM 的 JSON 目标文件一读就抛错，该用户永远无法完成接口切换。 | 读入时未剥离 UTF-8 BOM，JSON.parse 直接失败。 | 2026-09-07 | `36cf826` | src/main/apihub/index.ts:76（readTextIfExists 读入即剥离 BOM） | `tests/apihub-runtime.test.ts`<br>「BOM：带 UTF-8 BOM 的 JSON 目标文件可正常切换（读入即剥 BOM）」 | 无复发 |
| D-2026-09-07-08 | 边界判定 | 技能目录名为 con / nul / aux / prn / com1-9 / lpt1-9 等 Windows 保留设备名时，正则校验通过，但 NTFS 建目录必败，错误拖到实跑阶段才暴露。 | 名称白名单只校验 kebab-case，未排除 Windows 保留设备名。 | 2026-09-07 | `ec610ba` | src/main/importer.ts:18（WIN_RESERVED_NAME 在 preview 阶段就拦） | `tests/importer.test.ts`<br>「拒绝 Windows 保留设备名（con：正则合法但 NTFS 建目录必败，preview 阶段就拦）」 | 无复发 |
| D-2026-09-07-09 | 数据损坏 | 导入的源目录内若含 junction/symlink，导入会先删原目录，链接随之消失且 vault 副本里并不存在，数据凭空丢失。 | walkFiles 跳过源内嵌链接以防越界复制，但删除原目录的步骤没有对链接做预检。 | 2026-09-07 | `ec610ba` | src/main/importer.ts:158（源内嵌链接预检：拒绝导入并给出人工处理指引） | `tests/importer.test.ts`<br>「拒绝含内嵌链接的源目录（静默放行会把链接连同原目录一起删掉，数据凭空丢失）」 | 无复发 |
| D-2026-09-07-10 | 边界判定 | 目标路径超过 240 字符（未开 LongPathsEnabled）时 mkdir/copy 必失败，报错发生在实跑阶段。 | 预览阶段没有做 Windows MAX_PATH 预检。 | 2026-09-07 | `ec610ba` | src/main/importer.ts:162（目标路径长度 >240 预检） | `tests/importer.test.ts`<br>「拒绝超长目标路径（>240 字符，Windows MAX_PATH 预检）」 | 无复发 |
| D-2026-09-07-11 | 并发与状态 | 没有配置文件时，remoteTargets 与模块级默认数组共享引用；用户在界面上 push 一条远程目标，默认值被就地污染，进程内所有默认设置实例都被改写。 | defaultSettings 用浅拷贝展开模块级 DEFAULT_SETTINGS，而 remoteTargets 直接复用同一个数组。 | 2026-09-07 | `ec610ba` | src/main/settings.ts:43（defaultSettings 每次调用派生新对象与新数组） | `tests/settings.test.ts`<br>「无配置文件时 remoteTargets 是新数组：原地 push 不污染默认值（旧 bug：浅拷贝共享引用）」 | 无复发 |
| D-2026-09-07-12 | 边界判定 | remoteTargets 里的 port 字段接受小数（2.5）、负数与越界值，会被拼进 ssh -p 等命令参数。 | 端口字段未做整数与范围校验。 | 2026-09-07 | `ec610ba` | src/main/settings.ts:34（isValidPort：1-65535 整数，非法值整条丢弃、条目保留） | `tests/settings.test.ts`<br>「小数/负数/越界端口字段被丢弃（条目保留），整数端口保留」 | 无复发 |
| D-2026-09-07-13 | 错误处理 | Docker Desktop 启动失败（权限/组策略拦截）时恒报成功：spawn 的 'error' 事件是异步的，同步 resolve 让 error 分支成了死代码。 | startEngine 同步 resolve 结果，没有等待异步 error 事件的窗口期。 | 2026-09-07 | `9036be1` | src/main/docker/index.ts:241（startEngine 改为窗口期确认：窗口内 error/非零退出 → ok:false） | `tests/docker.test.ts`<br>「异步 spawn error（权限/组策略拦截）→ 窗口期内如实 ok:false（旧 bug：同步 resolve 让 error 分支成死代码、恒报成功）」 | 无复发 |
| D-2026-09-07-14 | 可观测性 | 发行版处于 Installing / Converting 等过渡态时，wsl -l -v 的整行被丢弃，该发行版从监控列表里凭空消失。 | 解析器只认 Running / Stopped 两种状态，其余行直接跳过。 | 2026-09-07 | `9036be1` | src/main/wslmon/index.ts:31（parseWslList 以「末 token 是版本号(1\|2)」锚定数据行，过渡态归为 Other） | `tests/wslmon.test.ts`<br>「过渡态（Installing/Converting）不再被整行丢弃 → state=Other（旧 bug：发行版从监控里凭空消失）」 | 无复发 |
| D-2026-09-07-15 | 边界判定 | 发行版名含空格时，解析器依赖 Running/Stopped 关键字定位数据行，名字被截断或整行误判。 | 用状态关键字做行内锚点，而不是用结构上稳定的末尾版本号 token。 | 2026-09-07 | `9036be1` | src/main/wslmon/index.ts:29（以末 token 是版本号(1\|2) 锚定数据行，发行版名可含空格） | `tests/wslmon.test.ts`<br>「发行版名含空格：以末尾版本号锚定（不再依赖 Running/Stopped 关键字定位）」 | 无复发 |
| D-2026-09-07-16 | 数据损坏 | 同一回收目录里的同名备份互相覆盖：第一次修复移入回收目录的备份，被第二次修复静默盖掉，用户的旧内容永久丢失。 | trashMove 直接用原文件名作为回收目标名，重名时覆盖。 | 2026-09-07 | `ec610ba` | src/main/winLinks.ts:148（trashMove 遇同名追加 .1 / .2 … 序号） | `tests/winlinks-agentsdir.test.ts`<br>「同一回收目录内同名备份不互相覆盖（追加 .1 序号；旧 bug：第二次修复静默覆盖第一次的备份）」 | 有复发/二次修复：第一版修复只把旧文件移入回收目录（同名即覆盖，用户内容丢失）；第二版才追加 .N 序号去重。现行代码（src/main/winLinks.ts:148-165）是第二版。 |
| D-2026-09-07-17 | 边界判定 | agentsDir 判定为「硬链接共享」时，symlink/junction 形态（即便指向 vault 文件）也被算作硬链接共享，实际并未共享 inode。 | isHardlinkSharedAgentsDir 只比 inode，未排除链接形态。 | 2026-09-07 | `ec610ba` | src/main/winLinks.ts:105（symlink/junction 形态不算硬链接共享，交给修复流程重建） | `tests/winlinks-agentsdir.test.ts`<br>「junction 形态：仍是 linked 且无硬链接附注（现状不变）」 | 无复发 |
| D-2026-09-07-18 | 兼容性 | 中文 Windows 上 where.exe / reg.exe 的输出按 OEM 代码页（GBK）产生却按 UTF-8 解码：npm.cmd 路径解析成乱码、ARP 的非 ASCII DisplayName 匹配失败，版本中心整条链路失效。 | 子进程重定向输出默认走 OEM 代码页，代码按 UTF-8 硬解。 | 2026-09-07 | `894c846` | src/main/versionCenter/npm.ts:53（where.exe 经 cmd chcp 65001 通道执行；同款处理见 src/main/versionCenter/arp.ts:4 的 reg.exe） | `tests/versioncenter-npm.test.ts`<br>「npm ls -g：先 where.exe（经 cmd chcp 通道）解析 npm.cmd，再经 cmd.exe 参数数组执行（chcp 65001 前缀 + 绝对路径）」 | 无复发 |
| D-2026-09-07-19 | 边界判定 | npm 预发布版本（1.0.0-rc.1）被误判为「已是最新」，实际有可用更新时用户看不到提示。 | 版本比较只比数字主段，忽略 prerelease 段。 | 2026-09-07 | `894c846` | src/main/versionCenter/versionCompare.ts:115（compareSemver 按 semver 规则比较 prerelease） | `tests/versioncenter-compare.test.ts`<br>「核心相同 → 无 prerelease 者更新：0.1.2-alpha.4 < 0.1.2」 | 无复发 |
| D-2026-09-07-20 | 安全 | GitHub 更新通道把远端返回的 tag 直接拼进下载 URL，不安全的 tag（含路径分隔符等）会被拼进命令参数。 | tag 未做安全字符校验就进入 URL 与进程参数。 | 2026-09-07 | `894c846` | src/main/versionCenter/github.ts:160（downloadReleaseTarball 拒绝不安全 tag，绝不 spawn） | `tests/versioncenter-github.test.ts`<br>「文件未产出 / 过小 / tag 不安全 → 报错；不安全 tag 绝不 spawn」 | 无复发 |
| D-2026-09-07-21 | 资源与生命周期 | 取消更新后子进程树没被杀（npm install 仍挂着），staging 目录残留，安装目录处于半更新状态。 | 取消时没有杀整棵进程树，也没有回收 staging。 | 2026-09-07 | `894c846` | src/main/versionCenter/jobs.ts:309（cancelJob 杀进程树并置 cancelled；staging 由 github 通道回收） | `tests/versioncenter-github.test.ts`<br>「取消：npm install 挂起时 cancel → job cancelled、进程树被杀、staging 清理、安装目录不受影响」 | 无复发 |
| D-2026-09-07-22 | 错误处理 | 取消更新后，迟到的 close 事件把 job 状态改回 done，取消被覆盖。 | 子进程 close 回调无条件写回状态，没有区分已被取消的 job。 | 2026-09-07 | `894c846` | src/main/versionCenter/jobs.ts:392（cancelled 状态绝不能被 done 覆盖） | `tests/versioncenter-jobs.test.ts`<br>「取消：running 中 cancelJob → status=cancelled，进程树被杀（taskkill + kill），迟到 close 不改状态」 | 无复发 |
| D-2026-09-07-23 | 并发与状态 | 同一条目并发发起更新时互相踩，两个 job 抢同一安装目录。 | 启动更新 job 前没有检查该条目是否已有 running job。 | 2026-09-07 | `894c846` | src/main/versionCenter/jobs.ts:354（startUpdateJob 检查 running → 直接抛错「该条目已在更新中」） | `tests/versioncenter-jobs.test.ts`<br>「同一条目并发更新被拒绝；未知条目直接抛错；未知 jobId 查询抛错」 | 无复发 |
| D-2026-09-07-24 | 错误处理 | 版本中心实时检查全部失败时，界面直接报错，不再回落到上次缓存。 | 全量检查没有「全部失败 → 回落缓存 stale=true」的分支。 | 2026-09-07 | `894c846` | src/main/versionCenter/jobs.ts:250（全部失败回落缓存并给 reason） | `tests/versioncenter-jobs.test.ts`<br>「全部失败 → 回落缓存 stale=true 并给 reason」 | 无复发 |
| D-2026-09-07-25 | 错误处理 | VS Code 启动失败（spawn error）被静默吞掉，调用方以为已打开，UI 不显示任何原因。 | launchVsCode 没有监听并回传 spawn 的异步 'error' 事件。 | 2026-09-07 | `6829a95` | src/main/vscode.ts:98（窗口期内 spawn error → { ok:false, error }，交由调用方兜底） | `tests/vscode.test.ts`<br>「spawn error 事件 → { ok:false, error }（不再静默吞掉，交由调用方兜底）」 | 无复发 |
| D-2026-10-04-01 | 数据损坏 | 在中文 Windows 上点一次体检的「一键修复（CRLF→LF）」，GBK / ANSI 编码的 .ps1/.bat/.py 被永久写成乱码（非法字节被替换成 U+FFFD）；UTF-16LE 文件同样被写坏。换一台机器打开必现乱码。 | 旧实现是 buf.toString('utf8').replace(/\r\n/g,'\n') 再以 'utf8' 写回——按 UTF-8 强解码再重编码，非 UTF-8 字节必然被替换。 | 2026-10-04 | `6f370db` | src/main/doctor.ts:31（crlfToLfBuffer 纯字节级替换：预分配两遍扫描，仅删 CRLF 的 \r，孤立 \r 保留） | `tests/doctor-crlf.test.ts`<br>「GBK 高位字节夹杂 CRLF：转换后 GBK 字节逐字节保留（不被解码成 U+FFFD）」 | 有复发/二次修复：第一版实现是「UTF-8 解码 + 重编码」，会把 GBK/UTF-16 文件永久写坏（该版本仍可在历史提交 a003e44 的 src/main/doctor.ts:265 看到）；2026-10-04 重做为字节级 crlfToLfBuffer，并新增 NUL 守卫跳过 UTF-16/二进制（src/main/doctor.ts:286）。现行代码（HEAD）是第二版。 |
| D-2026-10-04-02 | 兼容性 | 中文文件名在 git 输出里变成 \346\226\207\346\241\243 八进制转义，同步页的冲突文件清单、doctor 输出看起来就是乱码。开发机全局配了 quotepath=false 才没露头，换机必现。 | 依赖目标机的全局 gitconfig，没有在每次调用时显式关闭 core.quotepath。 | 2026-10-04 | `6f370db` | src/main/git.ts:7（GIT_TEXT_ARGS 每次调用注入 -c core.quotepath=false -c i18n.logOutputEncoding=UTF-8） | `tests/git-quotepath.test.ts`<br>「args 以两个 -c 配置开头，用户 args 完整跟在后面」 | 无复发 |
| D-2026-10-04-03 | 兼容性 | 默认 vault / 裸仓 / agent 目录硬编码 C:\Users\sakuya\...，换一台电脑、换一个用户名安装后全部指向不存在的路径。 | 默认配置把开发机用户名写死成常量。 | 2026-10-04 | `6f370db` | src/main/settings.ts:43（defaultSettings 按 os.homedir() 运行时派生；注册表侧同款见 src/shared/registry.ts:15） | `tests/settings.test.ts`<br>「默认路径按当前用户主目录派生（os.homedir），不硬编码机器专属用户名」 | 无复发 |
| D-2026-10-04-04 | 兼容性 | 导入 GBK 编码的 SKILL.md 时，仪表盘的技能描述乱码。 | SKILL.md 一律按 UTF-8 读取，非 UTF-8 字节被替换成 U+FFFD。 | 2026-10-04 | `52df6f5` | src/shared/textDecode.ts:28（decodeTextBuffer：BOM → 严格 UTF-8（fatal）→ GBK 顺序探测，绝不产生 U+FFFD；结果只用于展示，绝不写回磁盘） | `tests/winlinks-skillmd.test.ts`<br>「GBK 编码能解出正确中文（按 UTF-8 强解会把中文安装的技能描述变乱码）」 | 无复发 |
| D-2026-10-04-05 | 兼容性 | VS Code 装在中文路径下时位置解析失败，静默兜底到系统默认打开，用户看不到原因。 | where.exe 裸启，输出按 OEM 代码页（GBK）产生却按 UTF-8 解码。 | 2026-10-04 | `6f370db` | src/main/vscode.ts:62（where.exe 走 cmd.exe /d /s /c chcp 65001 >nul && where.exe 通道） | `tests/vscode.test.ts`<br>「候选全缺席落到 where：走 cmd.exe /d /s /c chcp 65001 >nul && where.exe，中文安装路径可命中」 | 无复发 |
| D-2026-10-07-01 | 数据损坏 | 扫描 agent 时若 registry.json 已损坏，扫描流程把它当空表处理，下一次保存就把用户全部 agent 定义覆盖清空。 | 发现引擎的读写路径没有区分「损坏」与「不存在」。 | 2026-10-07 | `4b67721` | src/main/agentDiscover.ts:146（refreshRegistry 发现损坏即拒绝覆盖；setAgentEnabled 同款在 :201） | `tests/agentDiscover.test.ts`<br>「registry.json 损坏 → 拒绝覆盖（抛中文错误）」 | 无复发 |
| D-2026-10-07-02 | 可观测性 | WSL 侧 companion 掉线时，Windows 侧把 linux 平台的 agent 标成 missing，用户以为技能被删了。 | companion 不可达与「agent 确实消失」被当作同一种结果。 | 2026-10-07 | `4b67721` | src/main/agentDiscover.ts:166（WSL 侧本轮取不到时整段跳过 linux 合并，绝不标 missing） | `tests/agentDiscover.test.ts`<br>「WSL companion 失败 → wslStale:true 且 Linux 条目绝不误标 missing」 | 无复发 |
| D-2026-10-07-03 | 错误处理 | 导入扫描到与 vault 同名的技能时仍把它列为可导入，实跑阶段才报冲突。 | 候选状态判定没有先查 vault 是否已有同名 skill。 | 2026-10-07 | `4b67721` | src/main/skillScan.ts:62（statusOf：先判 linked，再判 vault 同名 → conflict） | `tests/skillScan.test.ts`<br>「重名冲突：vault 已有同名 skill → conflict（导入会被拒绝，绝不覆盖）」 | 无复发 |
| D-2026-11-04-01 | 可观测性 | 接口中心切换失败且回滚也没能完全恢复时，错误只写在代码注释里，调用方只看到一个笼统的失败，无法判断「文件是否已恢复」。 | 回滚失败的明细被 catch 后丢弃，只保留了原始错误。 | 2026-11-04 | `c458bcb` | src/main/apihub/index.ts:574（rollbackFailures 收集未能恢复的目标路径，并随异常消息一并抛出） | `tests/apihub-runtime.test.ts`<br>「回滚失败必须可观测：错误信息里带未能恢复的目标路径，而不是静默吞掉（回滚只报「只能如实报告」）」 | 无复发 |
| D-2026-11-04-02 | 安全 | `skm link ../../etc` / `skm unlink ../../etc` 能把链接建到 agent 技能目录**之外**（真实路径穿越）。伴生 CLI 的 `link` / `unlink` 把命令行参数直接拼进路径，**缺少技能名白名单** —— 主进程侧有 `SKILL_NAME_RE` 校验，伴生 CLI 侧没有，两侧口径分叉 | 命令行参数是不可信输入，但在被当作路径片段之前没有先证明它只能是 vault 内的一个技能目录名 | 2026-11-04 | `6910c81` | `src/companion/skm.ts` 的 `cmdLink` / `cmdUnlink`（就地加「单段 kebab 白名单 → 「根目录 + 分隔符 + 名字」拼接 → 前缀比对」）；`SKILLS_DIR` / `AGENTS_DIR` 改为经 `vaultRoot()` 归一化后拼接 | `tests/companion-arg-guard.test.ts` → `skm link 拒绝含 ../ 的技能名（路径穿越），不建任何链接` | 人工复核（AI 辅助） |

## 八、已修复但暂无独立回归用例（共 18 条）

> 这些缺陷的修复确实存在于当前代码树中（修复位置可查、提交可查），但**当前仓库里没有针对该缺陷的独立回归用例**——因此本节**不设测试列**，也**不编造用例名**。把它们单列出来，是为了不让「有测试」与「无测试」的条目混在一起，造成「全都测过了」的错觉。

| 缺陷 ID | 类别 | 现象 | 根因 | 修复位置 | 修复提交 |
|---|---|---|---|---|---|
| D-2026-09-07-X01 | 数据损坏 | registry.json 损坏被静默当作空 registry 返回，用户在设置页保存一次，就把全部 agent 定义覆盖清空。 | registry 读取只有「存在 / 不存在」两态，没有「损坏」态，损坏时回落空对象供上层覆盖保存。 | src/main/ipc.ts:120（readRegistry 读取三态：不存在 / 损坏携带原因 / 正常） | `c70d0b7` |
| D-2026-09-07-X02 | 安全 | doctor:fix 是全库唯一信任渲染层回传路径的 handler，理论上可在任意位置写文件、建 junction；CRLF 分支还从 git add -A 提交，会把用户 vault 里与本次修复无关的未提交草稿一并卷进提交。 | applyFix 直接使用渲染层回传的 linkPath / vaultSkillDir / skillsDir / files 等路径字段；提交粒度是整个工作区。 | src/main/doctor.ts:244（applyFix 安全边界：payload 只取定位用的名字，路径一律重新推导；:295 只提交实际转换过的文件，绝不 add -A） | `5f39d6e` |
| D-2026-09-07-X03 | 安全 | link:set / link:remove 未做 skillName 白名单校验，可借目录穿越在任意位置建链。 | 两个 handler 直接把渲染层传来的 skillName 拼进路径。 | src/main/ipc.ts:207（link:set）与 src/main/ipc.ts:240（link:remove）复用 isValidSkillName 白名单 | `c70d0b7` |
| D-2026-09-07-X04 | 错误处理 | 导入的数据已安全入 vault 并建链，仅最后一步本地 git commit 失败时，整个导入被报成失败。 | commit 失败与导入失败共用同一条错误路径。 | src/main/importer.ts:218（commit 失败降级为警告，变更留在暂存区） | `ec610ba` |
| D-2026-09-07-X05 | 资源与生命周期 | 远程同步上传 bundle 时 ssh 提前退出（认证失败/不可达），stdin 继续被写入却无人监听 error 事件，EPIPE 直接把 Electron 主进程打崩；%TEMP% 下 skm-bundle-* 临时目录每次残留。 | 只监听了子进程的 'error' 事件，漏了 child.stdin 的 'error' 事件；自建临时目录只删文件不删目录壳。 | src/main/remoteSync.ts:70（child.stdin?.on('error') 监听 EPIPE；:197 临时目录在 finally 整体回收） | `16406f3` |
| D-2026-09-07-X06 | 错误处理 | Windows 侧 git pull 未指定合并策略：双端各自提交后 git ≥2.34 直接 fatal，同步永久失败；即使走 merge，冲突状态会留给下一轮 add -A 被静默提交进历史。 | pull 依赖仓库本地配置的默认策略，且冲突后没有 abort 流程。 | src/main/sync.ts:50（显式 --no-rebase）与 src/main/sync.ts:55（检测 MERGE_HEAD → 收集冲突文件 → merge --abort） | `ec610ba` |
| D-2026-09-07-X07 | 错误处理 | WSL companion 执行 pull --rebase 冲突后，仓库卡死在 rebase 中间态，之后每轮 sync 永久失败（already a rebase-merge directory）；pull 失败后仍继续 push。 | 冲突后未检测 rebase 目录并 abort；pull 与 push 之间没有失败短路。 | src/companion/skm.ts:313（检测 rebase-merge / rebase-apply → 收集冲突 → rebase --abort，:318）与 src/companion/skm.ts:323（pull 失败不再 push） | `6aea654` |
| D-2026-09-07-X08 | 错误处理 | GitHub 更新通道下载源码包时缺 --fail：404 的 HTML 错误页被写进 .tar.gz，随后 tar 解包报出离题错误，真实原因被掩盖。 | curl 未加 --fail，HTTP 错误响应体照样落盘。 | src/main/versionCenter/github.ts:163（curl.exe -L --fail --max-time 300；:170 下载失败时透出退出码与 stderr 尾部） | `894c846` |
| D-2026-09-07-X09 | 资源与生命周期 | 取消更新时，前三步（fetch / download / extract）的 curl / tar 子进程杀不掉，更新任务继续在后台跑。 | 这三步没有把子进程句柄登记到可取消通道。 | src/main/versionCenter/github.ts:283（步骤 1-3 经 onHandle 登记 current，取消时真杀 curl/tar） | `894c846` |
| D-2026-09-07-X10 | 并发与状态 | 仪表盘两阶段扫描（Windows 先出矩阵、WSL 后补）时，先发起的旧请求后返回，把新状态整体覆盖。 | 异步结果没有序号校验，晚到的旧响应照样写 state。 | src/renderer/src/pages/Dashboard.tsx:83（seqRef 自增序号 + 过期结果作废判断） | `adead51` |
| D-2026-09-07-X11 | 并发与状态 | 接口中心快速切换选项卡时两次 loadSel 并发在飞，旧适配器的响应后到，把新选项卡的数据整体覆盖（界面高亮 B 但列表是 A 的档案，点「切换」会写错适配器）。 | loadSel 没有序号/代次校验。 | src/renderer/src/pages/ApiHub.tsx:58（loadSeqRef「最新请求获胜」防护） | `36cf826` |
| D-2026-09-07-X12 | 数据损坏 | 接口中心保存失败时表单被清空，用户填写的字段与 API Key 全部丢失。 | 保存失败分支与保存成功分支共用同一条清空表单路径。 | src/renderer/src/pages/ApiHub.tsx:151（保存失败绝不清空表单，只提示错误） | `36cf826` |
| D-2026-09-07-X13 | 可观测性 | 版本中心的更新 job 轮询一次失败即永久停摆，界面永远卡在「更新中…」。 | 失败 tick 没有触发下一轮调度（没有产生新 state，effect 不再重跑）。 | src/renderer/src/pages/VersionCenter.tsx:142（stale 标志 + 失败 tick 也 setJobs 触发下一轮） | `4b67721` |
| D-2026-09-07-X14 | 并发与状态 | 版本中心进页自动 checkAllFresh 在飞时点单行「检查」，后到的旧全量快照把行内最新结果整体覆盖。 | 全量检查与行内检查共用同一份 state，没有代次区分。 | src/renderer/src/pages/VersionCenter.tsx:51（checkSeqRef「最新请求获胜」防护） | `4b67721` |
| D-2026-09-07-X15 | 边界判定 | 设置页 include 输入框逐键 split+filter，把用户输入的「a,」里的逗号吞掉，用户永远打不出多项列表。 | 受控值直接从受控字符串切分，没有保留原始草稿。 | src/renderer/src/pages/Settings.tsx:35（includeDrafts 保存原始草稿，失焦/保存时才解析） | `adead51` |
| D-2026-09-07-X16 | 可观测性 | registry.json 损坏时设置页只显示默认内容，用户看不出「保存其实已被拒绝」，看上去一切正常。 | registry:get 损坏时返回默认值 + corrupt 原因，但渲染层没有把 corrupt 呈现出来。 | src/renderer/src/pages/Settings.tsx:32（registryCorrupt 状态）与 :228（红字提示「已损坏，仅供查看，无法保存」） | `adead51` |
| D-2026-09-07-X17 | 并发与状态 | 体检页多个条目同时点「一键修复」时互踩：先完成的条目把仍在飞行中的按钮恢复可点，用户重复点会造成重复修复。 | 修复中状态用单值记录，多个并发修复互相覆盖。 | src/renderer/src/pages/Doctor.tsx:10（fixing 改为 Set，逐条独立记录） | `5f39d6e` |
| D-2026-09-07-X18 | 并发与状态 | 连续两次 toast 提示时，前一个 6 秒计时器到点会把后一条提示提前清掉。 | 每次 notify 都新建计时器，没有清掉上一个。 | src/renderer/src/App.tsx:30（toastTimer 先 clearTimeout 再重置） | `ec610ba` |

## 九、已知限制（未修复，1 条）

> 这一条**没有修复提交**：代码侧无法可靠兜底。它被单列在此，**不计入缺陷修复数**，也**不假装已修**。

| 编号 | 类别 | 现象 | 根因 | 状态 | 证据 | 已有兜底 |
|---|---|---|---|---|---|---|
| D-2026-10-04-K01 | 兼容性 | 老版本 WSL（<0.58/0.64）无视 WSL_UTF8=1，wsl.exe 输出 UTF-16LE 被按 UTF-8 解码，WSL 页发行版名、doctor 的 WSL 项、companion 错误文本全部乱码。 | WSL_UTF8 需要较新的 WSL 才生效，旧版本忽略该变量；cleanWslOutput 只能剔 NUL，救不了中文。 | 未修复（代码侧无法可靠兜底） | REPRODUCE.md:218（已知限制条目）；2026-10-04 轮次收尾说明亦明确写「老 WSL（<0.58）无视 WSL_UTF8 的 UTF-16 输出没有做代码兜底」。 | src/main/wslBridge.ts:19（cleanWslOutput 只能剔除 UTF-16 的 NUL 空字节，救不了中文）。 |

## 十、两条历史线的提交对照

复核者若在 `backup-original-history` 分支上核对，会看到同一份修复由不同的 SHA 引入：该分支把多轮改动压成了三个提交（`a003e44` 含 2026-09-07 全轮修复、`6f370db` 是 2026-10-04 编码轮的 squash、`9035ca8` 是 2026-10-07 的 squash），而 `main` 线是按功能模块切分的语义历史。

**「修复提交」列的规则：** 记的是**引入该修复代码的提交**——可用 `git log -S'<源码片段>' -- <文件>` 核验。2026-10-04 编码轮的 4 行在 `main` 线上已被拆进若干重建后的语义切片提交，故改记 `backup-original-history` 线上专门记录该轮的 squash 提交 `6f370db`（`main` 线的等价 SHA 逐条列在下表）；D-2026-10-04-04 的模块本身在 `main` 线上有专项提交 `52df6f5`，因此记它。

| 缺陷 ID | 本台账记的 SHA | 另一条线上的等价 SHA / 说明 |
|---|---|---|
| D-2026-10-04-01 | `6f370db` | main 线上对应 5f39d6e（doctor.ts：重建后的语义切片，文件内容与 6f370db 逐字节相同） |
| D-2026-10-04-02 | `6f370db` | main 线上对应 ec610ba（git.ts：重建后的语义切片，文件内容与 6f370db 逐字节相同） |
| D-2026-10-04-03 | `6f370db` | main 线上对应 ec610ba（settings.ts：重建后的语义切片，文件内容与 6f370db 逐字节相同） |
| D-2026-10-04-04 | `52df6f5` | main 线上的专项提交（52df6f5 引入 src/shared/textDecode.ts 与配套用例）；backup-original-history 线上由 squash 提交 6f370db 引入（同一份模块，文件内容逐字节相同） |
| D-2026-10-04-05 | `6f370db` | main 线上对应 6829a95（vscode.ts：重建后的语义切片，文件内容与 6f370db 逐字节相同） |
| D-2026-11-04-01 | `c458bcb` | 该修复只存在于 main 线（backup-original-history 止于 9035ca8，早于本轮） |
| D-2026-10-07-01 ~ D-2026-10-07-03 | `4b67721` | backup-original-history 线上由 squash 提交 `9035ca8` 引入 |
| 其余各行（2026-09-07 轮） | 见主表 | backup-original-history 线上由 squash 提交 `a003e44` 引入（含该轮全部修复） |

## 十一、复核方式

### 11.1 逐行复核

见 §一 的四步命令。对 `docs/defect-ledger.json` 的每一行，可用自动化脚本一次性核对：

- `fixCommit` 是否是本仓库中真实存在的 commit（`git cat-file -t`）；
- `fixLocation` 里引用的文件是否存在于 HEAD；
- `fixLocationNeedle`（源码原文片段）是否同时出现在 HEAD 与该 `fixCommit` 的对应 blob 中；
- `regressionTest.title` 是否逐字出现在 HEAD 的 `regressionTest.file` 里。

本台账的全部条目已按上述四项逐一核对通过。

### 11.2 全量测试

```bash
pnpm test          # vitest run
```

当前工作区实测：**40 个测试文件、588 个用例全部通过**（其中 HEAD 已跟踪的为 37 个测试文件、560 个 `it(`；其余 3 个为工作区新增、尚未提交）。

### 11.3 权威测试计数

```bash
node scripts/count-stats.mjs --vitest
```

该脚本会真跑一遍 vitest 并输出 `testFiles` / `testCases` / `passed` / `failed` 统计，是用例数的权威来源（README 里写的数字是某次快照，会随新增用例变化）。

### 11.4 看某次修复的全貌

```bash
git show <修复提交>                 # 该提交改了什么
git show <修复提交> -- <文件路径>    # 只看与本台账某行相关的文件
git log --format='%h %s' -S'<源码片段>' -- <文件路径>   # 确认这段修复由哪个提交引入
git show a003e44:src/main/doctor.ts | sed -n '265p'       # 复核「第一次的错误修复」原文
```

## 十二、已知边界与本台账未覆盖的部分

诚实起见，以下内容**不在**本台账的收录范围内，但评审者应当知道：

1. **2026-09-07 轮的完整清单无法复原。** 原始会话导出只保留了 AI 回复文本与工具调用计数，没有保留每次 Edit 的完整参数；那一轮的发现顺序与中间状态已不可考。本台账是该轮的**可追溯子集**，不是它的完整枚举。
2. **渲染层缺陷没有直接单测。** 当前 `tests/` 下没有 `.tsx` 测试文件，Dashboard / ApiHub / VersionCenter / Settings / Import / Doctor / App 这 7 个页面的修复（D-2026-09-07-X10 ~ X18）没有针对渲染层自身的回归用例，已放进 §八。
3. **主进程 IPC 层没有直接单测。** `src/main/ipc.ts` 的同步互斥与 `doctor:fix` 的服务端重推导同样没有专门用例。
4. **部分主进程模块无独立用例。** `src/companion/skm.ts`（WSL 伴生 CLI）为单文件程序，`tests/` 下只覆盖了它调用的 `wslBridge`，没有直接用例。
5. **老版本 WSL 的 UTF-16 输出无法在代码侧可靠解码**（§九 D-2026-10-04-K01）。
6. **本台账只描述已经发生的缺陷。** 它不评价当前代码是否还残留其它问题，也不替代安全扫描与盲审。

---

*本文件与 `docs/defect-ledger.json` 同源：JSON 为机器可读版本，本文件为可读版本，两者的行 ID、类别、修复提交、修复位置、回归用例标题一一对应。*
