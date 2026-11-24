/**
 * 编码对比跑分：同一张图、同一档质量，谁的体积更小；同一档体积，谁的 SSIM 更高。
 *
 * 为什么参数长这样：
 * - 参考编码器固定 `cwebp -m 6 -q N`（libwebp 的最慢档，社区公认的质量基线），
 *   换档位必须显式传 `--ref-method`，否则历史数字不可比；
 * - 被测编码器通过 `--bin` 指一个可执行文件，走它自己的 `--cli` 入口 ——
 *   benchmark 量的必须是**产品实际使用的代码路径**，不能另写一份编码逻辑；
 * - 质量扫描默认 50/60/70/80/90/95：够密到能插值出「达到某 SSIM 需要多少字节」，
 *   又不至于让 CI 跑到十分钟。
 *
 * 输出两份：`report.md` 给人看，`report.json` 给 CI 比对历史。
 *
 * 用法：
 *   node bench/run.mjs --bin src-tauri/target/release/pic2webp
 *   node bench/run.mjs --bin /path/to/pic2webp --qualities 50,70,85,95 --only screenshot-ui
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  renameSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCorpus } from "./gen-corpus.mjs";
import { encodePng } from "./lib/png.mjs";
import { readPnm } from "./lib/ppm.mjs";
import { ssimFromLuma, psnrFromLuma, toLuma } from "./lib/ssim.mjs";
import { bdRate } from "./lib/bdrate.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    bin: "",
    qualities: [50, 60, 70, 80, 90, 95],
    outDir: join(here, "report"),
    only: null,
    refMethod: 6,
    cwebp: "cwebp",
    dwebp: "dwebp",
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (a === "--bin") args.bin = next();
    else if (a === "--qualities") args.qualities = next().split(",").map(Number);
    else if (a === "--out") args.outDir = next();
    else if (a === "--only") args.only = next();
    else if (a === "--ref-method") args.refMethod = Number(next());
    else if (a === "--cwebp") args.cwebp = next();
    else if (a === "--dwebp") args.dwebp = next();
    else if (a === "--keep") args.keep = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "node bench/run.mjs --bin <pic2webp> [--qualities 50,60,70,80,90,95] " +
          "[--only name] [--out dir] [--keep]",
      );
      process.exit(0);
    }
  }
  return args;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.error) throw new Error(`${cmd} 起不来：${res.error.message}`);
  return res;
}

function toolVersion(cmd) {
  const res = run(cmd, ["-version"]);
  return (res.stdout || res.stderr || "").split("\n")[0].trim();
}

/** 每个质量档跑一次编码，返回 { bytes, ssim }。 */
function measure({ encoder, image, quality, workDir, args }) {
  const pngPath = join(workDir, "source.png");
  const webpPath = join(workDir, `${encoder}-q${quality}.webp`);
  const pamPath = join(workDir, `${encoder}-q${quality}.pam`);

  let encoded;
  if (encoder === "ref") {
    encoded = run(args.cwebp, [
      "-quiet",
      "-m",
      String(args.refMethod),
      "-q",
      String(quality),
      pngPath,
      "-o",
      webpPath,
    ]);
    if (encoded.status !== 0) {
      throw new Error(`cwebp 失败（${image.name} q${quality}）：${encoded.stderr}`);
    }
  } else {
    const outDir = join(workDir, `out-${quality}`);
    mkdirSync(outDir, { recursive: true });
    encoded = run(args.bin, ["--cli", pngPath, "-q", String(quality), "-o", outDir]);
    // 应用 CLI 的产物名是 `<stem>-webp.webp`（见 run_cli），不带质量后缀。
    const produced = join(outDir, `${basename(pngPath, ".png")}-webp.webp`);
    if (!existsSync(produced)) {
      throw new Error(
        `被测编码器没有产出预期文件 ${produced}\nstdout: ${encoded.stdout}\nstderr: ${encoded.stderr}`,
      );
    }
    renameSync(produced, webpPath);
  }

  const decoded = run(args.dwebp, ["-quiet", webpPath, "-pam", "-o", pamPath]);
  if (decoded.status !== 0) throw new Error(`dwebp 失败：${decoded.stderr}`);
  const pam = readPnm(pamPath);
  if (pam.width !== image.width || pam.height !== image.height) {
    throw new Error(
      `解码尺寸不一致：${image.name} 原图 ${image.width}x${image.height}，解码 ${pam.width}x${pam.height}`,
    );
  }
  const { size: bytes } = statSync(webpPath);
  // 源图通道数必须跟着图走：alpha 图是 4 通道，写死 3 会让 R/G/B 全部错位，
  // SSIM 直接掉到 0.03（本地第一次跑就踩了，解码图看着没问题、指标全废）。
  const lumaRef = toLuma(image.width, image.height, image.pixels, image.alpha ? 4 : 3);
  const lumaDec = toLuma(image.width, image.height, pam.data, pam.channels);
  if (quality === args.qualities[0]) {
    const same = ssimFromLuma(lumaRef, lumaRef, image.width, image.height);
    if (Math.abs(same - 1) > 1e-6) throw new Error(`SSIM 自检失败：同图应为 1，得到 ${same}`);
  }
  return {
    bytes,
    ssim: ssimFromLuma(lumaRef, lumaDec, image.width, image.height),
    psnr: psnrFromLuma(lumaRef, lumaDec),
  };
}

function interpByBytes(points, target) {
  const sorted = [...points].sort((a, b) => a.bytes - b.bytes);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.bytes <= target && b.bytes >= target) {
      const t = (Math.log(target) - Math.log(a.bytes)) / (Math.log(b.bytes) - Math.log(a.bytes));
      return a.ssim + (b.ssim - a.ssim) * t;
    }
  }
  return null;
}

const kb = (n) => (n === null ? "—" : `${(n / 1024).toFixed(1)} KB`);

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bin) {
    console.error("缺少 --bin：benchmark 要量的是产品自己的编码路径，请指向编译出来的 pic2webp。");
    process.exit(2);
  }
  if (!existsSync(args.bin)) {
    console.error(`--bin 指向的文件不存在：${args.bin}`);
    process.exit(2);
  }

  const corpus = buildCorpus().filter((c) => !args.only || c.name === args.only);
  if (corpus.length === 0) {
    console.error(`--only ${args.only} 没有匹配到任何图`);
    process.exit(2);
  }

  mkdirSync(args.outDir, { recursive: true });
  const workRoot = mkdtempSync(join(tmpdir(), "p2w-bench-"));

  console.log(`参考编码器：${toolVersion(args.cwebp)}（-m ${args.refMethod}）`);
  console.log(`解码器：${toolVersion(args.dwebp)}`);
  console.log(`被测：${args.bin}`);
  console.log(`质量档：${args.qualities.join(", ")}  ·  ${corpus.length} 张图\n`);

  const rows = [];
  for (const image of corpus) {
    const imgDir = join(workRoot, image.name);
    mkdirSync(imgDir, { recursive: true });
    const pngPath = join(imgDir, "source.png");
    writeFileSync(pngPath, encodePng(image.width, image.height, image.pixels, { alpha: image.alpha }));

    const pts = { app: [], ref: [] };
    for (const encoder of ["ref", "app"]) {
      for (const quality of args.qualities) {
        const m = measure({
          encoder,
          image: { ...image },
          quality,
          workDir: imgDir,
          args,
        });
        pts[encoder].push({ quality, ...m });
      }
    }
    process.stdout.write(`  ${image.name.padEnd(20)} 完成\n`);

    const row = {
      name: image.name,
      kind: image.kind,
      width: image.width,
      height: image.height,
      alpha: image.alpha,
      points: pts,
      bdrate: (() => {
        // SSIM 先上；截图那类图 SSIM 贴着 1.0、重叠带窄到不可信，就换 PSNR 这把尺子。
        const bySsim = bdRate(pts.ref, pts.app, "ssim");
        if (bySsim.percent !== null) return { ...bySsim, usedMetric: "ssim" };
        const byPsnr = bdRate(pts.ref, pts.app, "psnr");
        if (byPsnr.percent !== null) return { ...byPsnr, usedMetric: "psnr" };
        return { ...bySsim, usedMetric: "ssim" };
      })(),
      atRefBytes: {},
    };
    // 同体积比 SSIM：以参考编码器 q80 的体积为锚点
    const anchor = pts.ref.find((p) => p.quality === 80) || pts.ref[pts.ref.length - 1];
    row.atRefBytes = {
      bytes: anchor.bytes,
      appSsim: interpByBytes(pts.app, anchor.bytes),
      refSsim: anchor.ssim,
    };
    rows.push(row);
  }

  const lines = [];
  lines.push("# Pic2WebP benchmark");
  lines.push("");
  lines.push(`- 参考：${toolVersion(args.cwebp)}，参数 \`-m ${args.refMethod}\``);
  lines.push(`- 解码：${toolVersion(args.dwebp)}；SSIM 在 BT.601 亮度通道上算（11×11 高斯，σ=1.5）`);
  lines.push(`- 被测：\`${args.bin}\`，走应用自带的 \`--cli\` 路径（量的是产品真实代码）`);
  lines.push(`- 质量档：${args.qualities.join(" / ")}`);
  lines.push("");
  lines.push("## 结论：BD-rate（同等 SSIM 下的码率差，负数表示本应用更省）");
  lines.push("");
  lines.push("| 图 | 类别 | BD-rate | 口径 | 重叠区间 | 参考 q80 | 本应用 q80 | 同体积 SSIM 差 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const bd = r.bdrate.percent;
    const range = r.bdrate.range
      ? `${r.bdrate.range[0].toFixed(3)}–${r.bdrate.range[1].toFixed(3)}`
      : "—";
    const ref80 = r.points.ref.find((p) => p.quality === 80) || null;
    const app80 = r.points.app.find((p) => p.quality === 80) || null;
    const q80 = ref80 && app80
      ? `${kb(ref80.bytes)} / ${kb(app80.bytes)}`
      : "—";
    const atBytes = r.atRefBytes;
    const dPt =
      atBytes.refSsim && atBytes.appSsim
        ? `${((atBytes.appSsim - atBytes.refSsim) * 100 >= 0 ? "+" : "")}${(
            (atBytes.appSsim - atBytes.refSsim) * 100
          ).toFixed(3)} pt`
        : "—";
    lines.push(
      `| ${r.name} | ${r.kind} | ${bd === null ? "—" : `${bd >= 0 ? "+" : ""}${bd.toFixed(1)}%`} | ${
        bd === null ? "—" : r.bdrate.usedMetric.toUpperCase()
      } | ${range} | ${q80} | ${dPt} |`,
    );
  }
  const bds = rows.map((r) => r.bdrate.percent).filter((v) => v !== null);
  if (bds.length) {
    const avg = bds.reduce((a, b) => a + b, 0) / bds.length;
    lines.push("");
    lines.push(
      `**平均 BD-rate（${bds.length} 张可测）**：${avg >= 0 ? "+" : ""}${avg.toFixed(1)}%`,
    );
  }
  lines.push("");
  lines.push("## 同体积比画质（把体积对齐到参考 q80 时的 SSIM，越大越好）");
  lines.push("");
  lines.push("| 图 | 体积锚点 | 参考 SSIM | 本应用 SSIM |");
  lines.push("|---|---|---|---|");
  for (const r of rows) {
    const v = r.atRefBytes;
    lines.push(
      `| ${r.name} | ${kb(v.bytes)} | ${v.refSsim ? v.refSsim.toFixed(4) : "—"} | ${
        v.appSsim ? v.appSsim.toFixed(4) : "—"
      } |`,
    );
  }
  lines.push("");
  lines.push("## 原始数据");
  lines.push("");
  lines.push("| 图 | 质量 | 参考体积 | 参考 SSIM / PSNR | 本应用体积 | 本应用 SSIM / PSNR |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    for (let i = 0; i < args.qualities.length; i += 1) {
      const ref = r.points.ref[i];
      const app = r.points.app[i];
      lines.push(
        `| ${r.name} | ${ref.quality} | ${kb(ref.bytes)} | ${ref.ssim.toFixed(4)} / ${ref.psnr.toFixed(
          2,
        )} dB | ${kb(app.bytes)} | ${app.ssim.toFixed(4)} / ${app.psnr.toFixed(2)} dB |`,
      );
    }
  }
  lines.push("");
  lines.push(
    "> 图集由 `bench/gen-corpus.mjs` 按固定种子算出（PNG 逐字节可复现），不含 HEIC / Display-P3 —— " +
      "这两类要有真实相机样本与 16 bit + ICC 数据，合成物不可信，见 `bench/README.md`。",
  );
  lines.push("");

  const md = `${lines.join("\n")}\n`;
  writeFileSync(join(args.outDir, "report.md"), md);
  writeFileSync(
    join(args.outDir, "report.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ref: { encoder: toolVersion(args.cwebp), method: args.refMethod },
        app: args.bin,
        qualities: args.qualities,
        targets: args.targets,
        rows,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n${md}`);
  console.log(`报告写入 ${args.outDir}/report.md 与 report.json`);
  if (!args.keep) rmSync(workRoot, { recursive: true, force: true });
  else console.log(`临时目录保留在 ${workRoot}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
