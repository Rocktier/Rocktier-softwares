/**
 * 最小 PNG 写入器 —— 只做 benchmark 图集需要的那一种：8 bit、无隔行、filter 0。
 *
 * 为什么不用 sharp / canvas：benchmark 要能在 CI 的裸 runner 上跑，
 * 而 sharp 是原生模块（装它要联网编译），node-canvas 要 cairo。
 * 图集是我们自己按固定种子算出来的像素，只要能落成 PNG 喂给编码器就行，
 * 所以宁可用 60 行 zlib + CRC，也不要多一个会烂的依赖。
 */
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} pixels RGB 或 RGBA 连续字节
 * @param {{alpha?: boolean}} [opts]
 * @returns {Buffer}
 */
export function encodePng(width, height, pixels, opts = {}) {
  const alpha = opts.alpha === true;
  const channels = alpha ? 4 : 3;
  const expected = width * height * channels;
  if (pixels.length !== expected) {
    throw new Error(`pixel buffer is ${pixels.length} bytes, expected ${expected}`);
  }
  const rowBytes = width * channels;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (rowBytes + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * rowBytes, rowBytes).copy(
      raw,
      y * (rowBytes + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // colour type: truecolour (+alpha)
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
