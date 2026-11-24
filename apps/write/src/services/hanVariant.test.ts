/**
 * 简繁转换的判据。
 *
 * 重点不在「OpenCC 能不能转」（那是它的事），而在**边界**：哪些片段必须一动不动。
 * 这些用例都是会静默毁掉文档的那类错误 —— 链接指向不存在的文件、代码被改、
 * frontmatter 被解析器读不回来。
 */
import { describe, expect, it } from "vitest";

import { convertHan, splitSegments } from "./hanVariant";

describe("convertHan", () => {
  it("正文里的简体字转成繁体", async () => {
    const { text, changed } = await convertHan("他的头发很长。", "s2t");
    expect(changed).toBe(true);
    expect(text).toBe("他的頭髮很長。");
  });

  it("繁体转回简体，与原文一致（往返）", async () => {
    const original = "他写的后台程序出了问题，头发都白了。";
    const toTraditional = await convertHan(original, "s2t");
    const back = await convertHan(toTraditional.text, "t2s");
    expect(back.text).toBe(original);
  });

  it("本来就无需转换时 changed 为 false（调用方要据此提示）", async () => {
    const { text, changed } = await convertHan("　　他头发很长。", "t2s");
    expect(changed).toBe(false);
    expect(text).toBe("　　他头发很长。");
  });

  it("围栏代码块里的中文原样保留", async () => {
    const markdown = ["前言里的头发", "", "```js", 'const 题目 = "头发";', "```", "", "结尾的头发"].join("\n");
    const { text } = await convertHan(markdown, "s2t");
    expect(text).toContain('const 题目 = "头发";');
    // OpenCC 的標準繁體用「裏」而不是台灣正體的「裡」—— 这也是为什么这里
    // 不做地区变体：默认给「标准繁体」，地区口味留给以后显式选项。
    expect(text).toContain("前言裏的頭髮");
    expect(text).toContain("結尾的頭髮");
  });

  it("行内代码原样保留", async () => {
    const { text } = await convertHan("运行 `npm run 构建` 之后头发就长了", "s2t");
    expect(text).toContain("`npm run 构建`");
    expect(text).toContain("頭髮");
  });

  it("链接地址原样保留，链接文字照转", async () => {
    const { text } = await convertHan("见 [第一章](./第一章.md) 和 https://例子.com/头发", "s2t");
    expect(text).toContain("](./第一章.md)");
    expect(text).toContain("https://例子.com/头发");
    expect(text).toContain("見 [第一章](./第一章.md)");
  });

  it("frontmatter 整体不动", async () => {
    const markdown = ["---", "title: 头发", "tags: [后台]", "---", "", "正文的头发"].join("\n");
    const { text } = await convertHan(markdown, "s2t");
    expect(text).toContain("title: 头发");
    expect(text).toContain("tags: [后台]");
    expect(text).toContain("正文的頭髮");
  });

  it("拼接结果不改变行数与长度以外的结构", async () => {
    const markdown = "一\n\n二\n";
    const { text } = await convertHan(markdown, "s2t");
    expect(text.split("\n").length).toBe(markdown.split("\n").length);
  });
});

describe("splitSegments", () => {
  it("分段拼回去等于原文（逐字节）", async () => {
    const markdown = [
      "---",
      "title: 测试",
      "---",
      "第一段 `code` 与 [链接](./a.md)",
      "```",
      "块内",
      "```",
      "最后一行 头发",
    ].join("\n");
    const segments = splitSegments(markdown);
    expect(segments.map((s) => s.text).join("")).toBe(markdown);
  });

  it("未闭合的围栏一直保护到文末（不吞掉后面的正文转换）", () => {
    const segments = splitSegments("正文\n```\n没关的代码");
    const protectedText = segments.filter((s) => s.protect).map((s) => s.text).join("");
    expect(protectedText).toContain("没关的代码");
    expect(segments[0]).toEqual({ text: "正文\n", protect: false });
  });
});
