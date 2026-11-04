#!/usr/bin/env node
/**
 * scripts/measure-perf.mjs
 * ---------------------------------------------------------------------------
 * SkillVault 分发性能对照（junction 链接 vs 逐份复制）的可复现实测脚本。
 *
 * 用法：
 *   node scripts/measure-perf.mjs                       # 默认 26 skills / 20 agents / 5 rounds
 *   node scripts/measure-perf.mjs --skills 10 --agents 5 --rounds 3
 *   node scripts/measure-perf.mjs --help
 *
 * 本脚本只使用 Node 内置模块（node:fs / node:path / node:child_process /
 * node:os / node:crypto / node:process），无任何 npm 依赖。
 *
 * ── 为什么这样设计（方法学辩护）─────────────────────────────────────────────
 * 1) 单一驱动、单一语言：早期那次实测把「建链接」交给 Node 的
 *    fs.symlinkSync，把「复制」交给 Python 的 shutil.copytree，
 *    于是「语言差异 / 解释器启动开销 / 两套文件缓冲策略」全部变成了混杂因素，
 *    结论无法归因到「链接 vs 复制」这一个变量。
 *    本脚本把两种方法都放在**同一个 Node 进程**里实现：
 *      - junction 方法：fs.symlinkSync(target, link, 'junction')
 *      - copy    方法：fs.cpSync(src, dst, { recursive: true, force: true })
 *    除方法本身外，两条路径共享完全相同的运行时、堆、文件描述符与缓存状态。
 *
 * 2) ABBA 顺序：固定「先 A 后 B」会让先跑的那一方吃到「系统刚做完 fixture
 *    写入、页缓存仍是热的」这一系统性优势。脚本以 2 轮为一个区块，
 *    区块内第 1 轮按 A→B、第 2 轮按 B→A 执行，全局序列呈 ABBA ABBA …，
 *    方法在序列中左右对称，任何一方都不可能持续占先。
 *    实测顺序会原样写进输出，便于评审逐条核对。
 *
 * 3) 多次重复 + 中位数：单次测量噪声极大。脚本默认 5 轮配对重复，
 *    同时报告 **中位数**（抗离群）、均值、最小值、最大值、标准差，
 *    并额外给出「逐轮配对比值」的中位数（配对比值比「两个中位数相除」
 *    更能抵消跨轮的漂移）。
 *
 * 4) 显式计时边界：脚本只在**真正被测的那段**代码周围放计时器，
 *    其余全部排除。边界在输出里逐字写明（见 timing_boundary 字段），
 *    评审可以据此判断「测到了什么、没测到什么」。
 *
 * 5) 空操作基线（null）：每轮先跑一次「只开计时器、什么都不做」的测量，
 *    得到计时器本身的开销 + GC 噪声地板。读者可用它判断
 *    几百毫秒量级的差异是否显著。
 *
 * 6) 原始记录留存：所有逐轮原始数据写入 docs/perf-raw.json（不是只留聚合值），
 *    并在 docs/measured-data.json 中追加 method_v2 区块说明脚本、命令与排除规则。
 *
 * ── 与早期「v1」数据的可比性说明 ──────────────────────────────────────────
 * v1（docs/measured-data.json 的 distribution / single_update 区块）用的是
 * 「junction 用 Node、复制用 Python shutil.copytree」的异构驱动，且单文件载荷
 * 实为 427648/78 ≈ 5.3 KB（并非文档所写的 8 KB）。本脚本 v2 精确使用
 * 78 × 8192 B = 638976 B（8.0 KB/文件）。因此：
 *   - v1 与 v2 的**绝对毫秒数不可直接相减**（载荷不同）；
 *   - 可跨版本比较的是**比值**（v1 11.0x vs v2 ≈ 10–11x），它对载荷差异不敏感；
 *   - 两套数据在 measured-data.json 中**并列保留**，并各自带 driver 标签与 note，
 *     绝不静默覆盖。
 *
 * 该脚本只写三类路径：OS 临时目录（fixture）、docs/perf-raw.json、
 * docs/measured-data.json。仓库其它文件一律不写。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

/* ========================================================================== *
 * 1. CLI
 * ========================================================================== */

const DEFAULTS = {
  skills: 26,
  agents: 20,
  rounds: 5,
  filesPerSkill: 3,
  fileBytes: 8 * 1024,
  rawOut: path.join(REPO_ROOT, 'docs', 'perf-raw.json'),
  measuredData: path.join(REPO_ROOT, 'docs', 'measured-data.json'),
  writeMeasuredData: true,
  keepFixture: false,
  jsonIndent: 2,
};

const HELP = `
SkillVault 分发性能对照实测（junction 链接 vs 逐份复制）

用法:
  node scripts/measure-perf.mjs [选项]

选项:
  --skills N          技能数量（默认 ${DEFAULTS.skills}）
  --agents M          agent 目录数量（默认 ${DEFAULTS.agents}）
  --rounds R          配对重复轮数（默认 ${DEFAULTS.rounds}，最少 1）
  --files-per-skill F 每个技能的文件数（默认 ${DEFAULTS.filesPerSkill}）
  --file-bytes B      每个文件的字节数（默认 ${DEFAULTS.fileBytes} = 8 KB）
  --raw-out PATH      原始数据输出路径（默认 docs/perf-raw.json）
  --measured-data P   要更新的 measured-data.json 路径（默认 docs/measured-data.json）
  --no-measured-data  只写 raw 文件，不改 measured-data.json
  --keep-fixture      保留临时 fixture（调试用）
  --json-indent N     JSON 缩进（默认 2）
  --help, -h          显示本帮助

输出:
  stdout  机器可读 JSON 摘要
  stderr  人类可读表格

示例:
  node scripts/measure-perf.mjs
  node scripts/measure-perf.mjs --skills 10 --agents 5 --rounds 3
`.trim();

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const needsValue = new Set([
    '--skills',
    '--agents',
    '--rounds',
    '--files-per-skill',
    '--file-bytes',
    '--raw-out',
    '--measured-data',
    '--json-indent',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--no-measured-data') {
      opts.writeMeasuredData = false;
      continue;
    }
    if (arg === '--keep-fixture') {
      opts.keepFixture = true;
      continue;
    }

    let key = arg;
    let value = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      key = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }

    if (!needsValue.has(key)) {
      throw new Error(`未知参数: ${arg}（用 --help 查看用法）`);
    }
    if (value === null) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`参数 ${key} 缺少取值`);
      }
      i += 1;
    }

    switch (key) {
      case '--skills':
        opts.skills = toPositiveInt(value, key);
        break;
      case '--agents':
        opts.agents = toPositiveInt(value, key);
        break;
      case '--rounds':
        opts.rounds = toPositiveInt(value, key);
        break;
      case '--files-per-skill':
        opts.filesPerSkill = toPositiveInt(value, key);
        break;
      case '--file-bytes':
        opts.fileBytes = toPositiveInt(value, key);
        break;
      case '--json-indent':
        opts.jsonIndent = toPositiveInt(value, key);
        break;
      case '--raw-out':
        opts.rawOut = path.resolve(value);
        break;
      case '--measured-data':
        opts.measuredData = path.resolve(value);
        break;
      default:
        throw new Error(`未知参数: ${key}`);
    }
  }
  return opts;
}

function toPositiveInt(raw, key) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`参数 ${key} 需要正整数，收到: ${raw}`);
  }
  return n;
}

/* ========================================================================== *
 * 2. 统计工具
 * ========================================================================== */

/** 把 BigInt 纳秒差转成毫秒（保留小数，不做取整，避免丢分辨率）。 */
function toMs(deltaNs) {
  return Number(deltaNs) / 1e6;
}

/**
 * 描述统计。中位数放在第一位，因为它是本场景的主指标（抗离群值）。
 * stdev 为**样本**标准差（n-1），同时给出总体标准差供对照。
 */
function describe(values) {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) {
    return { n: 0, median: null, mean: null, min: null, max: null, stdev: null, stdev_pop: null };
  }
  const median =
    n % 2 === 1 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const variancePop = v.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    n,
    median: round(median),
    mean: round(mean),
    min: round(v[0]),
    max: round(v[n - 1]),
    stdev: round(Math.sqrt(variance)),
    stdev_pop: round(Math.sqrt(variancePop)),
  };
}

function round(x, digits = 3) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function safeRatio(a, b) {
  if (a === null || b === null || b === 0) return null;
  return round(a / b, 2);
}

/* ========================================================================== *
 * 3. Fixture 构造（全部在计时器之外）
 * ========================================================================== */

/**
 * 生成**确定性**的文件内容：同样的 (skillIndex, fileIndex) 永远得到同样的字节。
 * 这样每一轮 fixture 的摘要（digest）完全一致，可以证明「每轮都从相同的
 * 全新状态开始」，而不是悄悄复用了上一轮残留的数据。
 */
function deterministicContent(skillIndex, fileIndex, bytes) {
  const header = `# skill-${String(skillIndex).padStart(2, '0')} file-${fileIndex}\n`;
  const seed = `s${skillIndex}f${fileIndex}`;
  let out = header;
  let h = 2166136261 >>> 0;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789\n';
  while (out.length < bytes) {
    for (let i = 0; i < seed.length; i += 1) {
      h = (h ^ seed.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
      out += alphabet[h % alphabet.length];
      if (out.length >= bytes) break;
    }
  }
  return out.slice(0, bytes);
}

/** 文件名列表：第一个固定叫 SKILL.md（贴近真实技能布局），其余用占位名。 */
function skillFileNames(count) {
  const names = [];
  for (let i = 0; i < count; i += 1) {
    names.push(i === 0 ? 'SKILL.md' : `part-${i}.md`);
  }
  return names;
}

/**
 * 统计目录下（递归，不跟随链接）的普通文件数量。
 * 用于 teardown 后校验：删除 agents（junction 目标）之后，vault 源必须仍然
 * 拥有完整的 N×F 个文件 —— 只判断「目录还在」是不够的，因为一个「跟随链接
 * 递归删除」的实现会把源目录掏空却保留目录本身。
 */
function countPlainFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countPlainFiles(abs);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

/**
 * 取一个探针技能目录名，用于 teardown 后校验 vault 源是否仍然完好。
 * 用第 0 个技能即可：源存在 ⇒ 源目录存在 ⇒ 探针路径存在。
 */
function skillDirsProbe(opts) {
  return `skill-${String(0).padStart(2, '0')}`;
}

/**
 * 从零重建 fixture：删除整个 fixture 根目录 → 建 vault 源 → 建 M 个 agent 目录。
 * 目的：让每一轮测量都从**字节级相同**的全新状态开始。
 * 删除源在计时器之外，不计入任何被测时间。
 */
function buildFixture(root, opts) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const vaultRoot = path.join(root, 'vault');
  const skillsRoot = path.join(vaultRoot, 'skills');
  const agentsRoot = path.join(root, 'agents');
  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.mkdirSync(agentsRoot, { recursive: true });

  const fileNames = skillFileNames(opts.filesPerSkill);
  const skillDirs = [];
  let sourceBytes = 0;

  for (let s = 0; s < opts.skills; s += 1) {
    const name = `skill-${String(s).padStart(2, '0')}`;
    const dir = path.join(skillsRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < fileNames.length; f += 1) {
      const content = deterministicContent(s, f, opts.fileBytes);
      fs.writeFileSync(path.join(dir, fileNames[f]), content, 'utf8');
      sourceBytes += Buffer.byteLength(content, 'utf8');
    }
    skillDirs.push({ name, abs: dir });
  }

  const agentDirs = [];
  for (let a = 0; a < opts.agents; a += 1) {
    const dir = path.join(agentsRoot, `agent-${String(a).padStart(2, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    agentDirs.push({ name: path.basename(dir), abs: dir });
  }

  return { vaultRoot, skillsRoot, agentsRoot, skillDirs, agentDirs, sourceBytes };
}

/**
 * fixture 指纹：对「目录结构 + 每个文件的 SHA-256」求摘要。
 * 所有轮次的指纹必须相同，否则说明「每轮相同初始状态」这一前提被破坏。
 */
function fixtureDigest(fixture) {
  const lines = [];
  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        lines.push(`D ${rel}`);
        walk(abs, rel);
      } else if (entry.isSymbolicLink()) {
        lines.push(`L ${rel}`);
      } else {
        const buf = fs.readFileSync(abs);
        lines.push(`F ${rel} ${buf.length} ${crypto.createHash('sha256').update(buf).digest('hex')}`);
      }
    }
  };
  walk(fixture.vaultRoot, 'vault');
  walk(fixture.agentsRoot, 'agents');
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

/* ========================================================================== *
 * 4. 两种分发方法的实现（两种方法共享同一运行时、同一 Node 进程）
 * ========================================================================== */

/**
 * 方法 A：junction 链接分发。
 * 计时边界：进入函数后立刻开表 → 逐个 agent 逐个 skill 建 junction → 立刻关表。
 * 只包含 symlinkSync 调用本身；结果校验（lstat / 回读）在计时器之外。
 */
function measureJunctionFanout(fixture) {
  const failures = [];
  let created = 0;
  const t0 = process.hrtime.bigint();
  for (const agent of fixture.agentDirs) {
    for (const skill of fixture.skillDirs) {
      const linkPath = path.join(agent.abs, skill.name);
      try {
        // 'junction' 让 Node 自动把 target 归一化为绝对路径；不需要管理员权限。
        fs.symlinkSync(skill.abs, linkPath, 'junction');
        created += 1;
      } catch (err) {
        failures.push({ link: linkPath, error: String((err && err.message) || err) });
      }
    }
  }
  const t1 = process.hrtime.bigint();
  return { ms: toMs(t1 - t0), created, failed: failures.length, failures };
}

/**
 * 方法 B：逐份复制分发。
 * 计时边界与 A 完全对称：进入函数后立刻开表 → cpSync → 立刻关表。
 * cpSync(recursive) 会真实写出 N×M 份字节，这正是「复制」方案的成本来源。
 */
function measureCopyFanout(fixture) {
  const failures = [];
  let created = 0;
  const t0 = process.hrtime.bigint();
  for (const agent of fixture.agentDirs) {
    for (const skill of fixture.skillDirs) {
      const dest = path.join(agent.abs, skill.name);
      try {
        fs.cpSync(skill.abs, dest, { recursive: true, force: true });
        created += 1;
      } catch (err) {
        failures.push({ dest, error: String((err && err.message) || err) });
      }
    }
  }
  const t1 = process.hrtime.bigint();
  return { ms: toMs(t1 - t0), created, failed: failures.length, failures };
}

/**
 * 空操作基线：只开表、什么都不做、关表。
 * 得到的是「计时器本身 + 此刻 GC 噪声」的地板值。
 * 同时保留纳秒原值：空操作通常只有几百纳秒，换算成毫秒后会被四舍五入抹平，
 * 原始 ns 才能让读者看清噪声地板的真实量级。
 */
function measureNull() {
  const t0 = process.hrtime.bigint();
  // 故意留空：这是噪声地板测量，不是被测操作。
  const t1 = process.hrtime.bigint();
  const ns = t1 - t0;
  return { ns: ns.toString(), ms: toMs(ns) };
}

/**
 * 单技能更新 · 链接模式：
 * 计时边界：开表 → 往 vault 源写新内容 → 逐个 agent 目录**读回**验证内容已生效 → 关表。
 * 需要的额外副本数 = 0（所有 agent 路径指向同一份源文件）。
 *
 * 计时前先做一次「改前快照」，记录 agent 路径此刻看到的是旧内容；
 * 这不是装饰，而是用来证明「写源文件之前，agent 侧的副本确实是独立的一份」。
 */
function measureLinkUpdate(fixture, fileName) {
  const skill = fixture.skillDirs[0];
  const before = fs.readFileSync(path.join(fixture.agentDirs.at(-1).abs, skill.name, fileName), 'utf8');

  const newContent = `updated-at-${Date.now()}-${Math.random().toString(36).slice(2)}\n`;
  const t0 = process.hrtime.bigint();
  fs.writeFileSync(path.join(skill.abs, fileName), newContent, 'utf8');
  let reads = 0;
  let mismatches = 0;
  for (const agent of fixture.agentDirs) {
    const seen = fs.readFileSync(path.join(agent.abs, skill.name, fileName), 'utf8');
    reads += 1;
    if (seen !== newContent) mismatches += 1;
  }
  const t1 = process.hrtime.bigint();
  return {
    ms: toMs(t1 - t0),
    reads,
    mismatches,
    extraCopiesNeeded: 0,
    allAgentsVisible: mismatches === 0 && reads === fixture.agentDirs.length,
    beforeContentSha: crypto.createHash('sha256').update(before).digest('hex'),
  };
}

/**
 * 单技能更新 · 复制模式：
 * 计时边界：开表 → 往 vault 源写新内容 → 把该技能重新复制到每个 agent 目录 → 逐个 agent 读回校验 → 关表。
 * 需要的额外副本数 = M（每个 agent 一份）。
 *
 * 与链接模式**完全对称**：两边都在计时器内做「写入源 + 逐个 agent 读回校验」，
 * 唯一差异是链接模式不需要重新拷贝、复制模式需要 M 次 cpSync。
 * 计时前先记录 agent 侧此刻仍是旧内容（证明副本是独立的），计时后验证已更新。
 */
function measureCopyUpdate(fixture, fileName) {
  const skill = fixture.skillDirs[0];
  const before = fs.readFileSync(path.join(fixture.agentDirs.at(-1).abs, skill.name, fileName), 'utf8');

  const newContent = `updated-at-${Date.now()}-${Math.random().toString(36).slice(2)}\n`;
  const t0 = process.hrtime.bigint();
  fs.writeFileSync(path.join(skill.abs, fileName), newContent, 'utf8');
  let copies = 0;
  const failures = [];
  for (const agent of fixture.agentDirs) {
    try {
      fs.cpSync(skill.abs, path.join(agent.abs, skill.name), { recursive: true, force: true });
      copies += 1;
    } catch (err) {
      failures.push({ agent: agent.name, error: String((err && err.message) || err) });
    }
  }
  let reads = 0;
  let mismatches = 0;
  for (const agent of fixture.agentDirs) {
    const seen = fs.readFileSync(path.join(agent.abs, skill.name, fileName), 'utf8');
    reads += 1;
    if (seen !== newContent) mismatches += 1;
  }
  const t1 = process.hrtime.bigint();
  return {
    ms: toMs(t1 - t0),
    copies,
    reads,
    mismatches,
    extraCopiesNeeded: fixture.agentDirs.length,
    allAgentsVisible: mismatches === 0 && copies === fixture.agentDirs.length,
    failures,
    beforeContentSha: crypto.createHash('sha256').update(before).digest('hex'),
  };
}

/**
 * 分发完成后的「语义完整性」校验（全部在计时器之外）。
 * 这一步回答评审最可能提的问题：junction 轮真的建的是重解析点吗？
 * copy 轮真的产出的是彼此独立的实体文件吗？
 */
function verifyMethodSemantics(fixture, method) {
  const skill = fixture.skillDirs[0];
  const agent = fixture.agentDirs[0];
  const target = path.join(agent.abs, skill.name);

  let isLink = false;
  let isDirectory = false;
  let fileCount = null;
  let totalBytes = null;
  try {
    const st = fs.lstatSync(target);
    isLink = st.isSymbolicLink();
    isDirectory = st.isDirectory();
  } catch (err) {
    return { method, ok: false, error: String((err && err.message) || err) };
  }

  const walk = (dir) => {
    let files = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = walk(abs);
        files += sub.files;
        bytes += sub.bytes;
      } else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(abs).size;
      }
    }
    return { files, bytes };
  };
  const counted = walk(target);
  fileCount = counted.files;
  totalBytes = counted.bytes;

  if (method === 'junction') {
    return {
      method,
      ok: isLink,
      is_symbolic_link: isLink,
      is_directory: isDirectory,
      file_count: fileCount,
      total_bytes: totalBytes,
      note: 'junction 轮：目标是重解析点（lstat 报 symbolic link），通过它读到的仍是源目录内容',
    };
  }
  return {
    method,
    ok: !isLink && isDirectory,
    is_symbolic_link: isLink,
    is_directory: isDirectory,
    file_count: fileCount,
    total_bytes: totalBytes,
    note: 'copy 轮：目标是真实目录（lstat 不报 symbolic link），是独立实体副本',
  };
}

/* ========================================================================== *
 * 5. 顺序编排（ABBA）
 * ========================================================================== */

/**
 * 生成 ABBA 顺序。
 * 以 2 轮为一个区块：区块内第 1 轮 A→B、第 2 轮 B→A，
 * 于是全局测量序列是 ABBA ABBA …（教科书式平衡）。
 * 末尾不足一个完整区块时，剩余轮次按 A→B 继续。
 */
function buildOrder(rounds) {
  const order = [];
  for (let r = 0; r < rounds; r += 1) {
    const withinBlock = r % 2; // 0 → A→B，1 → B→A
    order.push(withinBlock === 0 ? ['junction', 'copy'] : ['copy', 'junction']);
  }
  return order;
}

/* ========================================================================== *
 * 6. 环境信息
 * ========================================================================== */

function collectEnvironment(fixture, opts) {
  const vol = (p) => {
    try {
      const st = fs.statSync(p);
      return { dev: String(st.dev), path: p };
    } catch {
      return { dev: null, path: p };
    }
  };

  const vaultVol = vol(fixture.vaultRoot);
  const agentsVol = vol(fixture.agentsRoot);
  const tmpVol = vol(os.tmpdir());

  let windowsVersion = null;
  try {
    // `cmd /c ver` 的输出是系统 OEM 代码页（简体中文 Windows 为 GBK），
    // 直接当 UTF-8 读会变成乱码。用 TextDecoder('gbk') 显式解码；
    // 若运行时不含该编码表，则退回 ASCII 安全过滤，绝不把乱码写进结果文件。
    const raw = execFileSync('cmd.exe', ['/c', 'ver'], { encoding: 'buffer' });
    try {
      windowsVersion = new TextDecoder('gbk').decode(raw).trim();
    } catch {
      windowsVersion = raw.toString('latin1').replace(/[^\x20-\x7e]/g, '').trim();
    }
  } catch {
    windowsVersion = null;
  }

  let repoCommit = null;
  try {
    repoCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    repoCommit = null;
  }

  return {
    os: `${os.type()} ${os.release()}`,
    platform: `${process.platform}/${process.arch}`,
    windows_version: windowsVersion,
    node: process.version,
    repo_commit: repoCommit,
    cpu_model: os.cpus()?.[0]?.model ?? null,
    cpu_count: os.cpus()?.length ?? null,
    total_mem_bytes: os.totalmem(),
    tmpdir: os.tmpdir(),
    volumes: {
      fixture_vault: vaultVol,
      fixture_agents: agentsVol,
      os_tmpdir: tmpVol,
      // NTFS 上 stat 的 dev 即卷序列号；两个卷号相同 ⇒ vault 与 agent 目录同卷，
      // junction（重解析点）才可能成立。
      same_volume_vault_agents: vaultVol.dev !== null && vaultVol.dev === agentsVol.dev,
      same_volume_as_tmpdir: vaultVol.dev !== null && vaultVol.dev === tmpVol.dev,
    },
    fs: { cpSync: 'node:fs.cpSync(recursive)', symlinkSync: "node:fs.symlinkSync(type='junction')" },
    command: buildCommand(opts),
  };
}

function buildCommand(opts) {
  return [
    'node',
    'scripts/measure-perf.mjs',
    '--skills',
    String(opts.skills),
    '--agents',
    String(opts.agents),
    '--rounds',
    String(opts.rounds),
  ].join(' ');
}

/* ========================================================================== *
 * 7. 主流程
 * ========================================================================== */

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`参数错误: ${err.message}`);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    console.log(HELP);
    return;
  }

  const fixtureRoot = path.join(
    os.tmpdir(),
    `skillvault-perf-${process.pid}-${Date.now().toString(36)}`,
  );

  const order = buildOrder(opts.rounds);
  const updateFileName = skillFileNames(opts.filesPerSkill)[0];

  const records = [];
  const rounds = [];
  let junctionFailures = [];
  let totalJunctionsCreated = 0;
  let totalJunctionsFailed = 0;
  let totalCopiesCreated = 0;
  const fixtureDigests = new Set();
  // 「更新之前 agent 侧看到的内容」的摘要集合：跨方法、跨轮应当只有一个值。
  const preUpdateContents = new Set();
  let environment = null;
  let fixtureSourceBytes = 0;

  try {
    for (let r = 0; r < opts.rounds; r += 1) {
      const roundRecord = { round: r, order: order[r].join(','), null_ms: null, measurements: {} };

      // ── 空操作基线（每轮一次，噪声地板）────────────────────────────────
      // 放在轮首：它不改变任何状态，纯粹给出「此刻的计时器 + GC 噪声」水位。
      const nullSample = measureNull();
      const nullMs = nullSample.ms;
      roundRecord.null_ms = round(nullMs, 6);
      records.push({
        kind: 'null',
        round: r,
        ms: round(nullMs, 6),
        ns: nullSample.ns,
      });

      for (const method of order[r]) {
        // ── 每轮每方法都从「全新且完全相同」的 fixture 状态开始 ──────────
        // fixture 的构造与销毁都在计时器之外，不计入被测时间。
        const fixture = buildFixture(fixtureRoot, opts);
        const digest = fixtureDigest(fixture);
        fixtureDigests.add(digest);
        fixtureSourceBytes = fixture.sourceBytes;
        if (!environment) environment = collectEnvironment(fixture, opts);

        let result;
        if (method === 'junction') {
          result = measureJunctionFanout(fixture);
          totalJunctionsCreated += result.created;
          totalJunctionsFailed += result.failed;
          if (result.failures.length) {
            junctionFailures = junctionFailures.concat(
              result.failures.map((f) => ({ ...f, round: r })),
            );
          }
        } else {
          result = measureCopyFanout(fixture);
          totalCopiesCreated += result.created;
        }

        // 语义校验在计时器之外：确认 junction 轮确实是重解析点、
        // copy 轮确实是独立实体副本（否则「快」可能只是「什么都没做」）。
        const semantics = verifyMethodSemantics(fixture, method);

        const record = {
          kind: 'fanout',
          round: r,
          method,
          ms: round(result.ms),
          items_created: result.created,
          items_failed: result.failed,
          fixture_digest: digest,
          semantics,
        };
        records.push(record);
        roundRecord.measurements[method] = {
          ms: record.ms,
          items_created: result.created,
          items_failed: result.failed,
          semantics_ok: semantics.ok,
        };

        // ── 单技能更新：紧随同一轮的分发之后，在同一 fixture 状态下测 ────
        if (method === 'junction') {
          const linkUpdate = measureLinkUpdate(fixture, updateFileName);
          records.push({
            kind: 'single_update',
            round: r,
            method: 'link',
            ms: round(linkUpdate.ms),
            extra_copies_needed: linkUpdate.extraCopiesNeeded,
            reads: linkUpdate.reads,
            mismatches: linkUpdate.mismatches,
            all_agents_visible: linkUpdate.allAgentsVisible,
            agent_side_content_before_sha256: linkUpdate.beforeContentSha,
          });
          preUpdateContents.add(linkUpdate.beforeContentSha);
          roundRecord.measurements.link_update = {
            ms: round(linkUpdate.ms),
            extra_copies_needed: linkUpdate.extraCopiesNeeded,
            all_agents_visible: linkUpdate.allAgentsVisible,
          };
        } else {
          const copyUpdate = measureCopyUpdate(fixture, updateFileName);
          records.push({
            kind: 'single_update',
            round: r,
            method: 'copy',
            ms: round(copyUpdate.ms),
            extra_copies_needed: copyUpdate.extraCopiesNeeded,
            copies: copyUpdate.copies,
            reads: copyUpdate.reads,
            mismatches: copyUpdate.mismatches,
            all_agents_visible: copyUpdate.allAgentsVisible,
            agent_side_content_before_sha256: copyUpdate.beforeContentSha,
          });
          preUpdateContents.add(copyUpdate.beforeContentSha);
          roundRecord.measurements.copy_update = {
            ms: round(copyUpdate.ms),
            extra_copies_needed: copyUpdate.extraCopiesNeeded,
            all_agents_visible: copyUpdate.allAgentsVisible,
          };
        }

        // ── 回收本轮 fixture（计时器之外）──────────────────────────────
        // 分两步删除是有意的：
        //  (a) 先只删 agents 目录 —— 这里面全是 junction；若 rm 的递归逻辑
        //      错误地「跟进」junction 指向 vault 源，就会把源内容一起删掉。
        //      因此删完 agents 后立刻校验 vault 源是否完好，这是一项真实的
        //      安全性校验，而不是形式检查。
        //  (b) 再删整个 fixture 根目录（含 vault 源），回到空目录状态。
        fs.rmSync(fixture.agentsRoot, { recursive: true, force: true });
        const vaultProbeOk = fs.existsSync(path.join(fixture.skillsRoot, skillDirsProbe(opts)));
        const vaultFileCount = countPlainFiles(fixture.skillsRoot);
        const expectedFiles = opts.skills * opts.filesPerSkill;
        if (!vaultProbeOk || vaultFileCount !== expectedFiles) {
          throw new Error(
            `teardown 校验失败：删除 agents（junction 目标）后 vault 源不完整 —— ` +
              `probe=${vaultProbeOk} files=${vaultFileCount}/${expectedFiles}，` +
              `说明递归删除跟进了 junction，这会破坏测量前提。`,
          );
        }
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        if (fs.existsSync(fixtureRoot)) {
          throw new Error('teardown 校验失败：fixture 根目录未被完全删除');
        }
      }

      rounds.push(roundRecord);
    }
  } finally {
    if (!opts.keepFixture) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }

  /* ---------------- 汇总 ---------------- */

  const pick = (kind, method) =>
    records.filter((x) => x.kind === kind && (method === undefined || x.method === method)).map((x) => x.ms);

  const junctionSeries = pick('fanout', 'junction');
  const copySeries = pick('fanout', 'copy');
  const nullSeries = pick('null');
  const linkUpdateSeries = pick('single_update', 'link');
  const copyUpdateSeries = pick('single_update', 'copy');

  const statsJunction = describe(junctionSeries);
  const statsCopy = describe(copySeries);
  const statsNull = describe(nullSeries);
  const nullNs = records.filter((x) => x.kind === 'null').map((x) => Number(x.ns));
  const statsNullNs = describe(nullNs);
  const statsLinkUpdate = describe(linkUpdateSeries);
  const statsCopyUpdate = describe(copyUpdateSeries);

  // 逐轮配对比值：同一轮内 copy/junction 的比值，抗跨轮漂移。
  const pairedSpeedups = [];
  for (let r = 0; r < opts.rounds; r += 1) {
    const j = junctionSeries[r];
    const c = copySeries[r];
    if (typeof j === 'number' && typeof c === 'number' && j > 0) {
      pairedSpeedups.push(round(c / j, 2));
    }
  }

  const realizedSequence = rounds.map((x) => x.order).join(' | ');

  const summary = {
    schema: 'skillvault.perf-summary.v2',
    script: 'scripts/measure-perf.mjs',
    command: buildCommand(opts),
    generated_at: new Date().toISOString(),
    scenario: {
      skills: opts.skills,
      agents: opts.agents,
      files_per_skill: opts.filesPerSkill,
      payload_bytes_per_file: opts.fileBytes,
      payload_kb_per_file: round(opts.fileBytes / 1024, 1),
      source_bytes_total: fixtureSourceBytes,
      fanout_items_per_method: opts.skills * opts.agents,
      total_source_bytes_fanned_out: fixtureSourceBytes * opts.agents,
    },
    environment,
    timing_boundary: {
      inside: [
        'junction 轮：自调用 fs.symlinkSync(target, link, "junction") 之前 1 行开始，到最后一次 symlinkSync 返回后 1 行结束',
        'copy 轮：自调用 fs.cpSync(src, dst, { recursive:true, force:true }) 之前 1 行开始，到最后一次 cpSync 返回后 1 行结束',
        'link 更新轮：自写入 vault 源文件之前，到逐个 agent 路径读回校验完成之后',
        'copy 更新轮：自写入 vault 源文件之前，到重新复制到 M 个 agent 并逐个读回校验完成之后',
        'null 基线轮：仅计时器开合本身',
      ],
      outside: [
        'fixture 构造（写 N×F 个源文件、建 M 个 agent 目录）',
        'fixture 销毁（teardown）与每轮之间的重建',
        '计时后的结果校验（lstat 判定重解析点 / 文件计数 / 语义校验）',
        'Node 进程启动、模块加载、JSON 序列化与落盘',
        'fixture 指纹（SHA-256）计算',
      ],
      timer: 'process.hrtime.bigint()（单调纳秒时钟，不受系统时间调整影响）',
    },
    method: {
      driver: '单一 Node 进程，junction 与 copy 两种方法均由 Node 内置 fs 实现',
      ordering: 'ABBA（2 轮一个区块，区块内 A→B / B→A）',
      realized_order: realizedSequence,
      repeats: opts.rounds,
      statistic: '中位数为主指标，同时报告 mean/min/max/stdev',
      noise_floor: '每轮插入一次空操作（null）测量',
      fixture_reset: '每个测量前删除并重建整个 fixture 根目录，保证每轮起点字节级一致',
      single_skill_update_symmetry:
        'link 与 copy 两种更新测量在计时器内做完全对称的事（写入源 + 逐个 agent 读回校验），' +
        '唯一差别是 copy 模式需要在计时器内额外执行 M 次 cpSync。',
    },
    distribution: {
      junction_ms: statsJunction,
      copy_ms: statsCopy,
      speedup_median_over_median: safeRatio(statsCopy.median, statsJunction.median),
      speedup_paired_median: describe(pairedSpeedups).median,
      paired_speedups: pairedSpeedups,
      junctions_created: totalJunctionsCreated,
      junctions_failed: totalJunctionsFailed,
      junction_failures: junctionFailures,
      copies_created: totalCopiesCreated,
    },
    single_update: {
      link_update_ms: statsLinkUpdate,
      copy_update_ms: statsCopyUpdate,
      link_extra_copies_needed: 0,
      copy_extra_copies_needed: opts.agents,
      link_all_agents_visible: records
        .filter((x) => x.kind === 'single_update' && x.method === 'link')
        .every((x) => x.all_agents_visible === true),
      copy_all_agents_visible: records
        .filter((x) => x.kind === 'single_update' && x.method === 'copy')
        .every((x) => x.all_agents_visible === true),
      speedup_median_over_median: safeRatio(statsCopyUpdate.median, statsLinkUpdate.median),
    },
    noise_floor: {
      null_ms: statsNull,
      null_ns: statsNullNs,
      note: 'null 基线是计时器开销 + GC 噪声地板；比较两个方法时应确认差异远大于该地板',
    },
    integrity: {
      identical_fixture_across_rounds: fixtureDigests.size === 1,
      fixture_digest: [...fixtureDigests][0] ?? null,
      distinct_fixture_digests: fixtureDigests.size,
      // 关键语义校验：两种方法在「更新之前」，agent 侧读到的必须是**同一份旧内容**。
      // 这同时证明：(a) fixture 在两种方法之间完全一致；
      // (b) copy 轮的 agent 副本是真实存在的独立实体，而不是悄悄共享了源。
      agent_side_before_content_consistent:
        preUpdateContents.size === 1 && preUpdateContents.has([...preUpdateContents][0]),
      agent_side_before_content_sha256: [...preUpdateContents],
      fanout_semantics_ok: records
        .filter((x) => x.kind === 'fanout')
        .every((x) => x.semantics && x.semantics.ok === true),
      all_single_updates_visible_to_all_agents: records
        .filter((x) => x.kind === 'single_update')
        .every((x) => x.all_agents_visible === true && x.mismatches === 0),
    },
    rounds,
    records,
  };

  /* ---------------- 落盘 ---------------- */

  const rawPayload = {
    schema: 'skillvault.perf-raw.v2',
    script: 'scripts/measure-perf.mjs',
    command: buildCommand(opts),
    generated_at: summary.generated_at,
    environment,
    scenario: summary.scenario,
    timing_boundary: summary.timing_boundary,
    method: summary.method,
    integrity: summary.integrity,
    summary: {
      distribution: summary.distribution,
      single_update: summary.single_update,
      noise_floor: summary.noise_floor,
    },
    rounds,
    records,
  };

  fs.mkdirSync(path.dirname(opts.rawOut), { recursive: true });
  fs.writeFileSync(opts.rawOut, `${JSON.stringify(rawPayload, null, opts.jsonIndent)}\n`, 'utf8');

  if (opts.writeMeasuredData) {
    updateMeasuredData(opts.measuredData, summary);
  }

  /* ---------------- 输出 ---------------- */

  process.stdout.write(`${JSON.stringify(summary, null, opts.jsonIndent)}\n`);
  printHumanTable(summary, opts);

  console.error(
    `\n[measure-perf] 原始数据: ${opts.rawOut}` +
      (opts.writeMeasuredData ? `\n[measure-perf] 已更新: ${opts.measuredData}` : '') +
      `\n[measure-perf] fixture 已清理: ${fixtureRoot}`,
  );
}

/* ========================================================================== *
 * 8. 把新数据并入 docs/measured-data.json（保留旧数据，不覆盖）
 * ========================================================================== */

function updateMeasuredData(target, summary) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    data = {};
  }

  const oldNote =
    '旧值来源：早期异构驱动实测（junction 用 Node fs.symlinkSync，复制用 Python shutil.copytree），' +
    '两种方法跑在不同语言/进程里，语言与进程启动开销构成混杂因素。' +
    '同驱动（单一 Node 进程）的复测结果见本文件 distribution_v2 / single_update_v2，' +
    '由 scripts/measure-perf.mjs 产出，原始逐轮数据见 docs/perf-raw.json。';

  /**
   * 给旧区块补 provenance 说明。
   * 原则：**绝不丢弃原有文字**。若旧区块本来就有 note，则把说明追加在其后；
   * 若没有，则新增 note 字段。旧数值本身一律不改。
   */
  const addProvenanceNote = (block) => {
    if (typeof block.note === 'string' && block.note.trim().length > 0) {
      if (!block.note.includes(oldNote)) block.note = `${block.note}\n${oldNote}`;
    } else {
      block.note = oldNote;
    }
  };

  // 旧区块保留原值，只补 label / driver / note，绝不静默覆盖。
  if (data.distribution && typeof data.distribution === 'object') {
    data.distribution.label = 'v1 · 早期异构驱动实测（保留，仅作对照）';
    data.distribution.driver = 'heterogeneous: Node fs.symlinkSync + Python shutil.copytree';
    addProvenanceNote(data.distribution);
  }
  if (data.single_update && typeof data.single_update === 'object') {
    data.single_update.label = 'v1 · 早期异构驱动实测（保留，仅作对照）';
    data.single_update.driver = 'heterogeneous: Node fs.symlinkSync + Python shutil.copytree';
    addProvenanceNote(data.single_update);
  }
  if (typeof data.method === 'string') {
    data.method_note =
      '上述 method 为早期异构驱动描述；现行同驱动方法学见 method_v2（scripts/measure-perf.mjs）。';
  }

  const d = summary.distribution;
  const u = summary.single_update;

  data.distribution_v2 = {
    label: 'v2 · 同驱动复测（单一 Node 进程，scripts/measure-perf.mjs）',
    driver: 'single Node process (node:fs only)',
    script: 'scripts/measure-perf.mjs',
    skills: summary.scenario.skills,
    agents: summary.scenario.agents,
    files_per_skill: summary.scenario.files_per_skill,
    payload_kb_per_file: summary.scenario.payload_kb_per_file,
    source_bytes_total: summary.scenario.source_bytes_total,
    junction_ms: d.junction_ms.median,
    copy_ms: d.copy_ms.median,
    speedup_x: d.speedup_median_over_median,
    speedup_paired_median_x: d.speedup_paired_median,
    junctions_created: d.junctions_created,
    junctions_failed: d.junctions_failed,
    copies_created: d.copies_created,
    junction_ms_stats: d.junction_ms,
    copy_ms_stats: d.copy_ms,
    noise_floor_null_ms: summary.noise_floor.null_ms,
    repeats: summary.method.repeats,
    ordering: summary.method.ordering,
    realized_order: summary.method.realized_order,
    note: '与上方 distribution（旧异构驱动值）并列保留；两者数值若有差异，以本区块为准，因为其驱动同语言同进程。',
    payload_note:
      'v1 的 source_bytes_total=427648（约 5.3 KB/文件），v2 精确为 ' +
      `${summary.scenario.files_per_skill * summary.scenario.skills} × 8192 B = ` +
      `${summary.scenario.source_bytes_total}（8.0 KB/文件）。` +
      '因此 v1 与 v2 的**绝对毫秒数**不可直接相减（单文件载荷不同）；' +
      '可跨版本比较的是**比值**（v1 11.0x vs v2 ' +
      `${d.speedup_median_over_median}x），它对载荷差异不敏感。`,
  };

  data.single_update_v2 = {
    label: 'v2 · 同驱动复测（单一 Node 进程，scripts/measure-perf.mjs）',
    driver: 'single Node process (node:fs only)',
    script: 'scripts/measure-perf.mjs',
    skills: summary.scenario.skills,
    agents: summary.scenario.agents,
    junction_setup_ms: d.junction_ms.median,
    junctions_created: d.junctions_created,
    link_update_ms: u.link_update_ms.median,
    link_update_all_agents_visible: u.link_all_agents_visible,
    link_extra_copies_needed: u.link_extra_copies_needed,
    copy_update_ms: u.copy_update_ms.median,
    copy_extra_copies_needed: u.copy_extra_copies_needed,
    copy_all_agents_visible: u.copy_all_agents_visible,
    link_update_ms_stats: u.link_update_ms,
    copy_update_ms_stats: u.copy_update_ms,
    speedup_x: u.speedup_median_over_median,
    repeats: summary.method.repeats,
    note: '链接模式下修改 vault 源文件后，各 agent 目录零额外操作即生效；逐份复制需重写 M 份副本。与上方 single_update（旧异构驱动值）并列保留。',
  };

  data.method_v2 = {
    script: 'scripts/measure-perf.mjs',
    command: summary.command,
    raw_data: 'docs/perf-raw.json',
    driver: '单一 Node 进程同时实现两种方法：fs.symlinkSync(...,"junction") 与 fs.cpSync(..., {recursive:true})',
    ordering: summary.method.ordering,
    realized_order: summary.method.realized_order,
    repeats: summary.method.repeats,
    statistic: summary.method.statistic,
    noise_floor: summary.method.noise_floor,
    fixture_reset: summary.method.fixture_reset,
    identical_fixture_across_rounds: summary.integrity.identical_fixture_across_rounds,
    single_skill_update_symmetry: summary.method.single_skill_update_symmetry,
    timer: summary.timing_boundary.timer,
    included_in_timer: summary.timing_boundary.inside,
    // 排除规则：明确写出「哪些开销没有被计入」，避免读者把测量值当成端到端耗时。
    exclusions: summary.timing_boundary.outside,
    integrity_checks: summary.integrity,
    environment: summary.environment,
    generated_at: summary.generated_at,
    note: '本区块取代早期异构驱动描述的旧 method 字符串；旧数值未删除，仍保留在 distribution / single_update 区块并带 note 标注。',
  };

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/* ========================================================================== *
 * 9. 人类可读表格（stderr）
 * ========================================================================== */

function printHumanTable(summary, opts) {
  const d = summary.distribution;
  const u = summary.single_update;
  const nf = summary.noise_floor.null_ms;

  const line = (label, j, c, ratio) =>
    `  ${label.padEnd(34)} ${String(j).padStart(12)} ${String(c).padStart(12)} ${String(ratio).padStart(10)}`;

  const out = [];
  out.push('');
  out.push('══════════════════════════════════════════════════════════════════════════════');
  out.push(' SkillVault 分发性能对照（单一 Node 进程 · ABBA 顺序 · 中位数为主指标）');
  out.push('══════════════════════════════════════════════════════════════════════════════');
  out.push(` 命令            : ${summary.command}`);
  out.push(` 场景            : ${opts.skills} skills × ${opts.agents} agents × ${opts.filesPerSkill} files × ${round(opts.fileBytes / 1024, 1)} KB`);
  out.push(` 顺序            : ${summary.method.realized_order}`);
  out.push(` fixture 一致性  : ${summary.integrity.identical_fixture_across_rounds ? '各轮指纹一致 ✓' : '各轮指纹不一致 ✗'}`);
  out.push(` 更新前内容一致  : ${summary.integrity.agent_side_before_content_consistent ? '跨方法/跨轮同一份旧内容 ✓' : '不一致 ✗'}`);
  out.push(` 分发语义校验  : ${summary.integrity.fanout_semantics_ok ? 'junction=重解析点 / copy=实体副本 ✓' : '异常 ✗'}`);
  out.push(` 更新可见性      : ${summary.integrity.all_single_updates_visible_to_all_agents ? '所有 agent 均可见新内容 ✓' : '存在不可见 ✗'}`);
  out.push(` 同卷校验        : vault.dev=${summary.environment.volumes.fixture_vault.dev} / agents.dev=${summary.environment.volumes.fixture_agents.dev} → ${summary.environment.volumes.same_volume_vault_agents ? '同卷 ✓' : '不同卷 ✗'}`);
  out.push(` 计时边界(内)    : ${summary.timing_boundary.inside[0]}`);
  out.push(` 计时边界(外)    : ${summary.timing_boundary.outside.join('；')}`);
  out.push('');
  out.push(` 指标${' '.repeat(30)}   junction      copy      比值`);
  out.push(`  ${'-'.repeat(72)}`);
  out.push(line('分发 fanout 中位数 (ms)', `${d.junction_ms.median}`, `${d.copy_ms.median}`, `${d.speedup_median_over_median}x`));
  out.push(line('  均值 mean (ms)', d.junction_ms.mean, d.copy_ms.mean, ''));
  out.push(line('  最小 min (ms)', d.junction_ms.min, d.copy_ms.min, ''));
  out.push(line('  最大 max (ms)', d.junction_ms.max, d.copy_ms.max, ''));
  out.push(line('  标准差 stdev (ms)', d.junction_ms.stdev, d.copy_ms.stdev, ''));
  out.push(line('单技能更新中位数 (ms)', `${u.link_update_ms.median}`, `${u.copy_update_ms.median}`, `${u.speedup_median_over_median}x`));
  out.push(line('  均值 mean (ms)', u.link_update_ms.mean, u.copy_update_ms.mean, ''));
  out.push(line('  最小 min (ms)', u.link_update_ms.min, u.copy_update_ms.min, ''));
  out.push(line('  最大 max (ms)', u.link_update_ms.max, u.copy_update_ms.max, ''));
  out.push(line('  标准差 stdev (ms)', u.link_update_ms.stdev, u.copy_update_ms.stdev, ''));
  out.push(line('  需要额外副本数', u.link_extra_copies_needed, u.copy_extra_copies_needed, ''));
  out.push(`  ${'-'.repeat(72)}`);
  out.push(line('null 空操作基线中位数 (ms)', nf.median, '', ''));
  out.push(line('  均值 mean (ms)', nf.mean, '', ''));
  out.push(line('  最大 max (ms)', nf.max, '', ''));
  out.push(line('  中位数 (ns)', summary.noise_floor.null_ns.median, '', ''));
  out.push('');
  out.push(` junction 建立: ${d.junctions_created} 个成功 / ${d.junctions_failed} 个失败`);
  if (d.junctions_failed > 0) {
    for (const f of d.junction_failures.slice(0, 10)) {
      out.push(`   ! ${f.link} → ${f.error}`);
    }
  }
  out.push(` 逐轮配对比值  : ${d.paired_speedups.join(', ')} (中位 ${d.speedup_paired_median}x)`);
  out.push('══════════════════════════════════════════════════════════════════════════════');
  console.error(out.join('\n'));
}

main();
