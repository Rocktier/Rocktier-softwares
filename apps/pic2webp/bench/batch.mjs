/**
 * 批量吞吐 benchmark：1000 张一次跑完，量「耗时」与「内存峰值」。
 *
 * 与 run.mjs 的分工：run.mjs 量的是**画质**（同一张图 vs cwebp 的 SSIM/BD-rate），
 * 这里量的是**批量行为** —— 台账里「1000 张图集（耗时 / 内存峰值 / 失败清单）」
 * 那条缺的正是这两个数。两件事都在 CI 上跑、都走被测二进制自己的 `--cli` 入口，
 * 因为它们回答的是不同问题：编码器好不好，和这个工具能不能扛住一千张。
 *
 * 为什么不用「跑完看进程 RSS」的写法：进程结束就取不到了。这里按 100ms 采样
 * `ps -o rss=`，取峰值 —— 内存峰值是这条待办的原始诉求，不能量完只剩终值。
 *
 * 用法：
 *   node bench/batch.mjs --bin src-tauri/target/release/pic2webp
 *   node bench/batch.mjs --bin ... --count 1000 --quality 80
 *
 * 退出码：0 = 全部成功；1 = 有文件失败或产物数量对不上（数字不可信就别报数）。
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

const arg = (name, def = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};
const BIN = arg("--bin");
const COUNT = parseInt(arg("--count", "1000"), 10);
const QUALITY = parseInt(arg("--quality", "80"), 10);
const OUT = arg("--out", join(here, "report"));

if (!BIN) {
  console.error("缺少 --bin <被测二进制路径>");
  process.exit(2);
}

/** 语料：复用 gen-corpus 的固定种子图集，再按需复制成 COUNT 个文件。
 *  为什么复制而不是生成：图集要可复现（同一条命令任何机器逐字节相同），而
 *  批量场景关心的是「一千个文件跑多久」，不是「一千张不同的图」。 */
function buildCorpus(dir, seedDir, count) {
  const r = spawnSync(process.execPath, [join(here, "gen-corpus.mjs"), seedDir], {
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("gen-corpus 失败，无法构造批量语料");
  const seeds = readdirSync(seedDir).filter((f) => extname(f).toLowerCase() === ".png");
  if (!seeds.length) throw new Error("gen-corpus 没产出任何 PNG");

  // 分 10 个目录放，顺便让 --recursive 这条路径真的被走到（单目录也能跑，
  // 但批量用户几乎都是「一堆文件夹」的形态）。
  const files = [];
  for (let i = 0; i < count; i++) {
    const bucket = join(dir, `batch${String(i % 10).padStart(2, "0")}`);
    mkdirSync(bucket, { recursive: true });
    const src = join(seedDir, seeds[i % seeds.length]);
    const dst = join(bucket, `img-${String(i).padStart(5, "0")}.png`);
    copyFileSync(src, dst);
    files.push(dst);
  }
  return { files, seeds: seeds.length };
}

/** 读进程内存。返回 null 表示**量不到**（不返回 0 —— 0 会被当成「测出来很省」）。
 *  两条路：Linux 用内核记着的峰值 VmHWM（比采样准，不受采样间隔影响）；
 *  没有 /proc 的 macOS 退回 100ms 采样 `ps -o rss=`。 */
function readRssMb(pid) {
  try {
    const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (m) return parseInt(m[1], 10) / 1024;
  } catch { /* 没有 /proc（macOS），走下面 */ }
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
    const kb = parseInt(out.trim(), 10);
    return Number.isFinite(kb) ? kb / 1024 : null;
  } catch {
    return null; // 进程已退出，或 ps 被沙箱挡住
  }
}

function run() {
  const work = join(tmpdir(), `pic2webp-batch-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const inputDir = join(work, "in");
  const outDir = join(work, "out");
  // 种子图集放在 inputDir **之外**：放里面会被一起转换，产出数就对不上了
  // （第一次自测就是 20 张变 26 张）。
  const seedDir = join(work, "seed");
  mkdirSync(inputDir, { recursive: true });

  const t0build = Date.now();
  const { files } = buildCorpus(inputDir, seedDir, COUNT);
  const corpusMs = Date.now() - t0build;

  const args = ["--cli", inputDir, "--recursive", "-q", String(QUALITY), "-o", outDir];
  const started = Date.now();
  const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

  let peak = null;
  const timer = setInterval(() => {
    const mb = readRssMb(child.pid);
    if (mb != null) peak = Math.max(peak ?? 0, mb);
  }, 100);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });

  const code = new Promise((resolve) => {
    child.on("close", (c) => resolve(c ?? -1));
    child.on("error", () => resolve(-1));
  });

  return code.then((exit) => {
    clearInterval(timer);
    const wallMs = Date.now() - started;

    // 产物与失败清单：只认磁盘上的事实，不解析文案。
    const produced = [];
    try {
      for (const f of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
        if (f.isFile() && extname(f.name).toLowerCase() === ".webp") produced.push(f.name);
      }
    } catch { /* 全失败时 outDir 可能不存在 */ }

    // `  FAIL: <src> — <reason>` 是 run_cli 的固定形状，逐行抠出来给用户一份清单。
    const failures = stderr
      .split("\n")
      .filter((l) => l.trim().startsWith("FAIL:"))
      .map((l) => l.trim().replace(/^FAIL:\s*/, ""));

    const bytes = produced.reduce((n, name) => {
      try { return n + statSync(join(outDir, name)).size; } catch { return n; }
    }, 0);

    const summary = {
      count: COUNT,
      quality: QUALITY,
      exit,
      wallMs,
      corpusMs,
      perImageMs: +(wallMs / COUNT).toFixed(2),
      imagesPerSec: +(COUNT / (wallMs / 1000)).toFixed(1),
      peakRssMb: peak == null ? null : +peak.toFixed(1),
      produced: produced.length,
      failures: failures.length,
      failureList: failures.slice(0, 50),
      outputBytes: bytes,
    };

    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "batch.json"), JSON.stringify(summary, null, 2) + "\n");
    writeFileSync(
      join(OUT, "batch.md"),
      [
        `# Pic2WebP 批量吞吐（${COUNT} 张 · q${QUALITY}）`,
        "",
        "| 指标 | 数值 |",
        "|---|---|",
        `| 总耗时 | ${(wallMs / 1000).toFixed(2)} s |`,
        `| 单张均值 | ${summary.perImageMs} ms |`,
        `| 吞吐 | ${summary.imagesPerSec} 张/s |`,
        `| 内存峰值 | ${peak == null ? "未量到（本机无 /proc 且 ps 不可用）" : summary.peakRssMb + " MB"} |`,
        `| 产出 / 预期 | ${produced.length} / ${COUNT} |`,
        `| 失败 | ${failures.length} |`,
        "",
        "口径：单线程顺序转换（产品真实行为）；峰值按 100ms 采样 `ps -o rss=` 取最大；",
        `语料为 gen-corpus 的固定种子图集复制 ${COUNT} 份（共 ${files.length} 个文件，分 10 个目录）。`,
        "",
      ].join("\n"),
    );

    console.log(`批量 ${COUNT} 张：${(wallMs / 1000).toFixed(2)}s / ${summary.imagesPerSec} 张每秒 / 峰值 ${peak == null ? "未量到" : summary.peakRssMb + " MB"}`);
    console.log(`产出 ${produced.length}，失败 ${failures.length}`);
    if (failures.length) console.log(failures.slice(0, 10).join("\n"));

    rmSync(work, { recursive: true, force: true });

    // 产物数量对不上就是数字不可信：宁可报红，也不给一份看着漂亮的报告。
    if (exit !== 0 || produced.length !== COUNT || failures.length !== 0) process.exit(1);
  });
}

run().catch((e) => {
  console.error(e.message ?? e);
  process.exit(2);
});
