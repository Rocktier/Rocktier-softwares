/**
 * 读 dwebp 解码出来的原始像素。
 *
 * 为什么走 `dwebp -pam` 而不是在 JS 里解 WebP：node 没有内置 WebP 解码，
 * 装 sharp 会给 CI 添一个原生依赖。libwebp 的 dwebp 在 CI 上是
 * `brew install webp` / `apt install webp` 一条命令，解码结果也是未压缩的
 * 原始字节，正好直接喂给 SSIM。
 *
 * PAM（P7）与 PPM（P6）都支持：PAM 能带 alpha，alpha 图的透明度损失才量得到。
 */
import { readFileSync } from "node:fs";

function readHeaderToken(buf, offset) {
  let i = offset;
  while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i += 1;
  const start = i;
  while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) i += 1;
  return { token: buf.subarray(start, i).toString("latin1"), offset: i };
}

/**
 * 跳过空白与 `#` 注释 —— 必须一起跳。
 * PPM 的注释可以紧跟在任何 token 之后（`P6\n# comment\n2 1\n`），
 * 只跳 `#` 不看前面空白的话，下一次取 token 会把 `#` 本身读成宽度。
 */
function skipSpaceAndComments(buf, offset) {
  let i = offset;
  for (;;) {
    while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i += 1;
    if (buf[i] === 0x23) {
      while (i < buf.length && buf[i] !== 0x0a) i += 1;
      continue;
    }
    return i;
  }
}

/**
 * @param {string} path
 * @returns {{width:number, height:number, channels:number, data:Uint8Array}}
 */
export function readPnm(path) {
  const buf = readFileSync(path);
  if (buf[0] === 0x50 && buf[1] === 0x37) {
    // PAM: 逐行 key value，ENDHDR 之后是裸像素
    let i = 2;
    let width = 0;
    let height = 0;
    let depth = 0;
    let maxval = 0;
    let headerEnd = -1;
    while (i < buf.length) {
      let lineEnd = buf.indexOf(0x0a, i);
      if (lineEnd < 0) lineEnd = buf.length;
      const line = buf.subarray(i, lineEnd).toString("latin1").trim();
      i = lineEnd + 1;
      if (line === "" || line.startsWith("#")) continue;
      if (line === "ENDHDR") {
        headerEnd = i;
        break;
      }
      const [key, value] = line.split(/\s+/);
      if (key === "WIDTH") width = Number(value);
      if (key === "HEIGHT") height = Number(value);
      if (key === "DEPTH") depth = Number(value);
      if (key === "MAXVAL") maxval = Number(value);
    }
    if (headerEnd < 0) throw new Error(`${path}: PAM header has no ENDHDR`);
    if (maxval !== 255) throw new Error(`${path}: only 8-bit PAM is supported, got MAXVAL ${maxval}`);
    return { width, height, channels: depth, data: buf.subarray(headerEnd) };
  }

  let offset = skipSpaceAndComments(buf, 2);
  const w = readHeaderToken(buf, offset);
  offset = skipSpaceAndComments(buf, w.offset);
  const h = readHeaderToken(buf, offset);
  offset = skipSpaceAndComments(buf, h.offset);
  const m = readHeaderToken(buf, offset);
  offset = skipSpaceAndComments(buf, m.offset);
  const width = Number(w.token);
  const height = Number(h.token);
  const maxval = Number(m.token);
  if (maxval !== 255) throw new Error(`${path}: only 8-bit PPM is supported, got ${maxval}`);
  return { width, height, channels: 3, data: buf.subarray(offset) };
}
