/**
 * 简繁转换 —— 只动正文，不动代码。
 *
 * 为什么不是「整篇过一次 OpenCC」：
 * 中文写作者的文件里除了正文，还有行内代码、围栏代码块、链接地址、frontmatter。
 * 把这些一起转，结果是 `npm install` 变成 `npm install`（还好）、
 * 但 `第一章.md` 这种中文文件名会变成另一条指向不存在文件的链接，
 * 而 frontmatter 的键虽然都是 ASCII、值却可能刚被用户在「文档信息」里核对过。
 * 所以按「受保护片段 / 正文」切开，只转正文那几段。
 *
 * 为什么两个方向分开 import 子路径：
 * `opencc-js` 的 cn→t 词表 1.0 MB、t→cn 只有 107 KB。整包静态 import 会让
 * 应用启动就多解析 1.1 MB；这里用动态 import，用户真按了菜单才加载，
 * Vite 会把它们切成独立的 chunk。
 *
 * 为什么 frontmatter 整体保护而不只保护键：
 * YAML 值里也可能有引号、冒号、日期，转换后仍要能被同一套解析器读回；
 * 「转换标题」这个需求可以后续做成显式的「只转正文 / 也转元数据」选项，
 * 不该由一次隐式转换决定。
 */
import type { ConverterFunction } from "opencc-js/core";

export type HanDirection = "s2t" | "t2s";

type Converter = (text: string) => string;

const loaders: Record<HanDirection, () => Promise<Converter>> = {
  s2t: async () => {
    const { Converter } = await import("opencc-js/cn2t");
    return Converter({ from: "cn", to: "t" }) as ConverterFunction;
  },
  t2s: async () => {
    const { Converter } = await import("opencc-js/t2cn");
    return Converter({ from: "t", to: "cn" }) as ConverterFunction;
  },
};

const cache = new Map<HanDirection, Converter>();

async function converterFor(direction: HanDirection): Promise<Converter> {
  const hit = cache.get(direction);
  if (hit) return hit;
  const made = await loaders[direction]();
  cache.set(direction, made);
  return made;
}

export interface Segment {
  text: string;
  /** true = 原样保留（代码、链接、元数据） */
  protect: boolean;
}

/** 行内需要原样保留的东西：行内代码、链接目标、裸 URL。 */
const INLINE_PROTECTED = /(`[^`\n]*`|\]\([^)\n]*\)|<https?:\/\/[^>\n]*>|https?:\/\/[^\s)\]]+)/g;

/**
 * 把 markdown 切成「可转换 / 受保护」两类片段。
 * 导出是为了让测试能直接盯住分段结果，而不是只测最终字符串。
 */
export function splitSegments(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const push = (text: string, protect: boolean) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.protect === protect) last.text += text;
    else segments.push({ text, protect });
  };

  let body = markdown;
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (frontmatter) {
    push(frontmatter[0], true);
    body = body.slice(frontmatter[0].length);
  }

  let fence: string | null = null;
  // 按行切但保留行尾：拼接回去必须与原文字节一致
  for (const line of body.split(/(?<=\n)/)) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      push(line, true);
      if (opener && line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1];
      push(line, true);
      continue;
    }
    let last = 0;
    INLINE_PROTECTED.lastIndex = 0;
    let hit = INLINE_PROTECTED.exec(line);
    while (hit) {
      push(line.slice(last, hit.index), false);
      push(hit[0], true);
      last = hit.index + hit[0].length;
      hit = INLINE_PROTECTED.exec(line);
    }
    push(line.slice(last), false);
  }
  return segments;
}

/**
 * 转换整篇 markdown。`changed` 为 false 时调用方应给「没有可转换内容」的提示，
 * 而不是静默成功 —— 简体用户点「转为简体」很可能是点错了方向。
 */
export async function convertHan(
  markdown: string,
  direction: HanDirection,
): Promise<{ text: string; changed: boolean }> {
  const segments = splitSegments(markdown);
  const convert = await converterFor(direction);
  let changed = false;
  const text = segments
    .map((segment) => {
      if (segment.protect) return segment.text;
      const next = convert(segment.text);
      if (next !== segment.text) changed = true;
      return next;
    })
    .join("");
  return { text, changed };
}
