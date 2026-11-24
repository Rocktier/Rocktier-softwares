/**
 * benchmark 工具链的自检。
 *
 * 这些判据的存在理由：benchmark 最丢人的失败不是算错一名小数，而是**悄悄错了还
 * 出报告**。本地搭这套东西时就踩过两次 —— 拟合取错数组（BD-rate 符号反了）、
 * alpha 图通道数写死 3（SSIM 掉到 0.03 却照样出表）。所以每条都钉死在这里：
 * PNG 可复现、PPM/PAM 头能读、SSIM/PSNR 自一致、BD-rate 在「已知 10% 更省」
 * 的合成数据上必须回 -10%。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodePng } from "../bench/lib/png.mjs";
import { readPnm } from "../bench/lib/ppm.mjs";
import { ssimFromLuma, psnrFromLuma, toLuma } from "../bench/lib/ssim.mjs";
import { bdRate, cubicFit } from "../bench/lib/bdrate.mjs";
import { buildCorpus } from "../bench/gen-corpus.mjs";

test("PNG 写入可复现：同像素两次编码逐字节相同", () => {
  const pixels = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
  const a = encodePng(2, 2, pixels);
  const b = encodePng(2, 2, pixels);
  assert.deepEqual(a, b);
  assert.deepEqual([...a.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("PNG 写入拒绝尺寸不符的像素缓冲", () => {
  assert.throws(() => encodePng(2, 2, new Uint8Array(4)), /expected 12/);
});

test("PPM（P6）头带注释也能读", () => {
  const dir = mkdtempSync(join(tmpdir(), "p2w-test-"));
  try {
    const path = join(dir, "a.ppm");
    const head = Buffer.from("P6\n# comment\n2 1\n255\n", "latin1");
    const body = Buffer.from([1, 2, 3, 4, 5, 6]);
    writeFileSync(path, Buffer.concat([head, body]));
    const img = readPnm(path);
    assert.equal(img.width, 2);
    assert.equal(img.height, 1);
    assert.equal(img.channels, 3);
    assert.deepEqual([...img.data], [1, 2, 3, 4, 5, 6]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PAM（P7）读得出 alpha 通道", () => {
  const dir = mkdtempSync(join(tmpdir(), "p2w-test-"));
  try {
    const path = join(dir, "a.pam");
    const head = Buffer.from(
      "P7\nWIDTH 1\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n",
      "latin1",
    );
    writeFileSync(path, Buffer.concat([head, Buffer.from([10, 20, 30, 40])]));
    const img = readPnm(path);
    assert.equal(img.channels, 4);
    assert.deepEqual([...img.data], [10, 20, 30, 40]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SSIM 自一致：同图 = 1，错位图 < 1", () => {
  const w = 24;
  const h = 24;
  const a = new Float32Array(w * h).map((_, i) => (i * 7) % 255);
  const b = new Float32Array(w * h).map((_, i) => ((i + 3) * 11) % 255);
  assert.ok(Math.abs(ssimFromLuma(a, a, w, h) - 1) < 1e-9);
  assert.ok(ssimFromLuma(a, b, w, h) < 0.9);
  assert.equal(psnrFromLuma(a, a), Infinity);
});

test("亮度转换按通道数取值（alpha 图不能当 3 通道读）", () => {
  const rgba = new Uint8Array([255, 0, 0, 128, 0, 255, 0, 128]);
  const luma3 = toLuma(1, 1, rgba, 3);
  const luma4 = toLuma(1, 1, rgba, 4);
  assert.ok(Math.abs(luma3[0] - 0.299 * 255) < 1e-3);
  assert.ok(Math.abs(luma4[0] - (0.299 * 255 + 0.587 * 0)) < 1e-3);
});

test("BD-rate 在「已知省 10% 码率」的合成数据上回到 -10%", () => {
  const ref = [];
  const app = [];
  for (let q = 50; q <= 95; q += 9) {
    const metric = 0.9 + (q - 50) / 45 * 0.09;
    const bytes = 10000 * 1.12 ** ((q - 50) / 15);
    ref.push({ quality: q, bytes, ssim: metric, psnr: 30 + (q - 50) / 3 });
    app.push({ quality: q, bytes: bytes * 0.9, ssim: metric, psnr: 30 + (q - 50) / 3 });
  }
  const result = bdRate(ref, app);
  assert.equal(result.metric, "ssim");
  assert.ok(result.percent !== null);
  assert.ok(Math.abs(result.percent + 10) < 0.5, `期望 -10%，得到 ${result.percent}`);
});

test("BD-rate 在重叠带过窄时拒绝给结论", () => {
  const flat = [50, 60, 70, 80].map((q) => ({ quality: q, bytes: 1000 * q, ssim: 0.9998 }));
  const result = bdRate(flat, flat.map((p) => ({ ...p, bytes: p.bytes * 0.9 })));
  assert.equal(result.percent, null);
  assert.equal(result.saturated, true);
});

test("三次拟合能还原已知多项式", () => {
  const coef = [1, -2, 0.5, 0.25];
  const xs = [-2, -1, 0, 1, 2, 3];
  const ys = xs.map((x) => coef.reduce((acc, c, i) => acc + c * x ** i, 0));
  const fit = cubicFit(xs, ys);
  assert.ok(fit);
  for (let i = 0; i < 4; i += 1) assert.ok(Math.abs(fit[i] - coef[i]) < 1e-6);
});

test("图集逐字节可复现（固定种子）", () => {
  const first = buildCorpus();
  const second = buildCorpus();
  assert.equal(first.length, 6);
  for (let i = 0; i < first.length; i += 1) {
    assert.equal(first[i].sha256, second[i].sha256, `${first[i].name} 像素不稳定`);
    assert.equal(first[i].pixels.length, first[i].width * first[i].height * (first[i].alpha ? 4 : 3));
  }
  const kinds = new Set(first.map((c) => c.kind));
  for (const kind of ["photo-smooth", "photo-detail", "screenshot", "lineart", "flat-graphic", "alpha"]) {
    assert.ok(kinds.has(kind), `图集缺少 ${kind}`);
  }
});
