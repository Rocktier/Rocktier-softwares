/**
 * 固定图集生成器：图不是拍的，是算出来的。
 *
 * 公开 benchmark 最怕的是「图集不可复现」—— 换台机器换张图，数字就不能比了。
 * 所以这里的每一张都由固定种子算出来，同一条命令在任何机器上得到逐字节相同的
 * PNG（`manifest.json` 里记着像素哈希，改一行生成逻辑就会被发现）。
 *
 * 五类覆盖，对应台账点名的场景：
 *   照片（平滑渐变 + 高光）      —— 有损压缩最擅长的
 *   照片（多倍频噪声 / 植被质感）—— 细节多，最考验编码器
 *   截图（平色块 + 1px 细线 + 文字条）—— 对色度二次采样最不友好的场景
 *   线稿（白底细线）            —— 笔画一糊就废
 *   透明（RGBA 软边）           —— alpha 通道的独立编码
 *
 * 台账里还写了「HEIC / P3」两类：HEIC 要有真实相机样本，P3 要有 16 bit + ICC，
 * 都造不出可信的合成物，宁可缺也不要拿假图凑数（README 里写明）。
 *
 * 用法：node bench/gen-corpus.mjs [输出目录]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { encodePng } from "./lib/png.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** mulberry32：32 位状态、周期够用、实现只有三行，跨平台结果一致。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** 值噪声：格点随机值 + 平滑插值，比纯白噪声更接近自然纹理。 */
function valueNoise(width, height, cell, rand) {
  const gw = Math.ceil(width / cell) + 2;
  const gh = Math.ceil(height / cell) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i += 1) grid[i] = rand();
  const at = (x, y) => grid[y * gw + x];
  const smooth = (t) => t * t * (3 - 2 * t);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const gy = y / cell;
    const y0 = Math.floor(gy);
    const fy = smooth(gy - y0);
    for (let x = 0; x < width; x += 1) {
      const gx = x / cell;
      const x0 = Math.floor(gx);
      const fx = smooth(gx - x0);
      const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
      const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
      out[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

/** 多倍频叠加（fBm），octaves 越多细节越密。 */
function fbm(width, height, baseCell, octaves, rand) {
  const acc = new Float32Array(width * height);
  let amp = 1;
  let norm = 0;
  let cell = baseCell;
  for (let o = 0; o < octaves; o += 1) {
    const layer = valueNoise(width, height, cell, rand);
    for (let i = 0; i < acc.length; i += 1) acc[i] += layer[i] * amp;
    norm += amp;
    amp *= 0.5;
    cell = Math.max(1, Math.floor(cell / 2));
  }
  for (let i = 0; i < acc.length; i += 1) acc[i] /= norm;
  return acc;
}

function photoLandscape(width, height, seed = 0x51ce) {
  const rand = rng(seed);
  const px = new Uint8Array(width * height * 3);
  const hills = [0.62, 0.7, 0.78];
  const sunX = width * 0.68;
  const sunY = height * 0.3;
  const grain = fbm(width, height, 3, 3, rand);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = y / height;
      let r = 120 + 90 * (1 - t);
      let g = 160 + 70 * (1 - t);
      let b = 210 + 40 * (1 - t);
      const dx = x - sunX;
      const dy = y - sunY;
      const glow = Math.exp(-(dx * dx + dy * dy) / (2 * (width * 0.18) ** 2));
      r += 70 * glow;
      g += 55 * glow;
      b += 20 * glow;
      for (let i = 0; i < hills.length; i += 1) {
        const base = hills[i] * height;
        const wave = Math.sin(x / (120 + i * 40) + i * 1.7) * (18 + i * 10);
        if (y > base + wave) {
          const shade = 0.55 - i * 0.12;
          r = 60 * shade + 40;
          g = 90 * shade + 50;
          b = 70 * shade + 45;
        }
      }
      const grainAmount = (grain[y * width + x] - 0.5) * 14;
      const p = (y * width + x) * 3;
      px[p] = clamp(r + grainAmount);
      px[p + 1] = clamp(g + grainAmount);
      px[p + 2] = clamp(b + grainAmount);
    }
  }
  return { width, height, pixels: px, alpha: false };
}

function photoTexture(width, height, seed = 0x7e37) {
  const rand = rng(seed);
  const fine = fbm(width, height, 2, 5, rand);
  const coarse = fbm(width, height, 48, 3, rand);
  const px = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const v = fine[i] * 0.65 + coarse[i] * 0.35;
      const p = i * 3;
      px[p] = clamp(70 + v * 130);
      px[p + 1] = clamp(95 + v * 120);
      px[p + 2] = clamp(50 + v * 90);
    }
  }
  return { width, height, pixels: px, alpha: false };
}

function screenshotUi(width, height, seed = 0x5c12) {
  const rand = rng(seed);
  const px = new Uint8Array(width * height * 3).fill(246);
  const fill = (x0, y0, w, h, rgb) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x += 1) {
        const p = (y * width + x) * 3;
        px[p] = rgb[0];
        px[p + 1] = rgb[1];
        px[p + 2] = rgb[2];
      }
    }
  };
  // 顶栏 + 侧栏 + 卡片列表，全是平色块与 1px 分隔线
  fill(0, 0, width, 56, [32, 34, 40]);
  fill(0, 56, 220, height - 56, [240, 241, 245]);
  for (let i = 0; i < 9; i += 1) {
    fill(16, 80 + i * 34, 120 + Math.round(rand() * 60), 12, [110, 114, 126]);
  }
  for (let i = 0; i < 4; i += 1) {
    const cy = 84 + i * 190;
    fill(248, cy, width - 296, 168, [255, 255, 255]);
    fill(248, cy, width - 296, 1, [214, 217, 224]); // 1px 顶线
    fill(248, cy + 40, width - 296, 1, [232, 234, 240]);
    // 标题 + 三行正文：细横条模拟文字，正是色度二次采样最容易糊掉的东西
    fill(272, cy + 16, 180, 14, [28, 30, 36]);
    for (let s = 0; s < 3; s += 1) {
      let x = 272;
      while (x < width - 340) {
        const run = 18 + Math.round(rand() * 46);
        fill(x, cy + 62 + s * 28, run, 7, [58, 62, 70]);
        x += run + 8 + Math.round(rand() * 14);
      }
    }
    fill(width - 96, cy + 16, 56, 22, [42, 120, 255]);
  }
  return { width, height, pixels: px, alpha: false };
}

function lineart(width, height, seed = 0x1122) {
  const rand = rng(seed);
  const px = new Uint8Array(width * height * 3).fill(252);
  const stroke = (x0, y0, x1, y1) => {
    const minX = Math.max(0, Math.floor(Math.min(x0, x1)) - 2);
    const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1)) + 2);
    const minY = Math.max(0, Math.floor(Math.min(y0, y1)) - 2);
    const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1)) + 2);
    const vx = x1 - x0;
    const vy = y1 - y0;
    const len2 = vx * vx + vy * vy || 1;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const t = Math.min(1, Math.max(0, ((x - x0) * vx + (y - y0) * vy) / len2));
        const dx = x - (x0 + t * vx);
        const dy = y - (y0 + t * vy);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1.1) {
          const v = clamp(20 + d * 120);
          const p = (y * width + x) * 3;
          px[p] = Math.min(px[p], v);
          px[p + 1] = Math.min(px[p + 1], v);
          px[p + 2] = Math.min(px[p + 2], v);
        }
      }
    }
  };
  for (let i = 0; i < 260; i += 1) {
    const x0 = rand() * width;
    const y0 = rand() * height;
    const angle = rand() * Math.PI * 2;
    const len = 30 + rand() * 220;
    stroke(x0, y0, x0 + Math.cos(angle) * len, y0 + Math.sin(angle) * len);
  }
  return { width, height, pixels: px, alpha: false };
}

function flatIllustration(width, height, seed = 0x9a44) {
  const rand = rng(seed);
  const palette = [
    [244, 196, 48],
    [232, 93, 74],
    [72, 149, 239],
    [46, 196, 182],
    [250, 240, 230],
    [30, 41, 59],
  ];
  const px = new Uint8Array(width * height * 3);
  const circles = [];
  for (let i = 0; i < 26; i += 1) {
    circles.push({
      cx: rand() * width,
      cy: rand() * height,
      r: 40 + rand() * 220,
      color: palette[Math.floor(rand() * palette.length)],
    });
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let color = palette[4];
      for (const c of circles) {
        const dx = x - c.cx;
        const dy = y - c.cy;
        if (dx * dx + dy * dy < c.r * c.r) color = c.color;
      }
      const p = (y * width + x) * 3;
      px[p] = color[0];
      px[p + 1] = color[1];
      px[p + 2] = color[2];
    }
  }
  return { width, height, pixels: px, alpha: false };
}

function alphaGlow(width, height, seed = 0x3b7d) {
  const rand = rng(seed);
  const px = new Uint8Array(width * height * 4);
  const ringR = width * 0.3;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (x - width / 2) / (width / 2);
      const dy = (y - height / 2) / (height / 2);
      const d = Math.sqrt(dx * dx + dy * dy);
      const glow = Math.max(0, 1 - d);
      const ring = Math.exp(-(((d - ringR / (width / 2)) * 14) ** 2));
      const alpha = clamp((glow * 210 + ring * 180) * (0.9 + rand() * 0.1));
      const p = (y * width + x) * 4;
      px[p] = 40;
      px[p + 1] = clamp(120 + glow * 90);
      px[p + 2] = clamp(200 + ring * 40);
      px[p + 3] = alpha;
    }
  }
  return { width, height, pixels: px, alpha: true };
}

const CASES = [
  { name: "photo-landscape", kind: "photo-smooth", build: () => photoLandscape(1600, 1067) },
  { name: "photo-texture", kind: "photo-detail", build: () => photoTexture(1400, 1050) },
  { name: "screenshot-ui", kind: "screenshot", build: () => screenshotUi(1440, 900) },
  { name: "lineart-sketch", kind: "lineart", build: () => lineart(1200, 1200) },
  { name: "flat-illustration", kind: "flat-graphic", build: () => flatIllustration(1200, 900) },
  { name: "alpha-glow", kind: "alpha", build: () => alphaGlow(900, 900) },
];

export function buildCorpus() {
  return CASES.map((c) => {
    const img = c.build();
    return {
      ...c,
      ...img,
      sha256: createHash("sha256").update(img.pixels).digest("hex").slice(0, 16),
    };
  });
}

function main() {
  const outDir = process.argv[2] ? process.argv[2] : join(here, "corpus");
  mkdirSync(outDir, { recursive: true });
  const manifest = [];
  for (const item of buildCorpus()) {
    const file = `${item.name}.png`;
    const png = encodePng(item.width, item.height, item.pixels, { alpha: item.alpha });
    writeFileSync(join(outDir, file), png);
    manifest.push({
      file,
      kind: item.kind,
      width: item.width,
      height: item.height,
      alpha: item.alpha,
      bytes: png.length,
      pixelsSha256: item.sha256,
    });
    console.log(`  ${file.padEnd(24)} ${item.width}x${item.height}  ${(png.length / 1024).toFixed(0)} KB  ${item.kind}`);
  }
  writeFileSync(
    join(outDir, "manifest.json"),
    `${JSON.stringify({ generator: "bench/gen-corpus.mjs", seedPolicy: "fixed", images: manifest }, null, 2)}\n`,
  );
  console.log(`\n${manifest.length} 张写入 ${outDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
