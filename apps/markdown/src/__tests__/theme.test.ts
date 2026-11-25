/**
 * 主题档位的静态判据（2026-11-25）。
 *
 * 为什么用静态断言而不是渲染测试：这套主题的「正确性」全在 CSS 令牌里 ——
 * 少一个令牌就会静默回落到深色值，而这种回落只有肉眼在某个特定面板上才看得见。
 * contrast-gate 判据 ⑥ 已经在母版层面核完整性 + 对比度，这里再钉三件事：
 *   ① 母版两套扩展主题块真的在（有人删掉 CSS 时测试先红）；
 *   ② 首帧引导认识这两个值（否则切到暖纸的用户每次启动闪一帧深色）；
 *   ③ useTheme 的循环里四档齐、顺序固定（按钮点一下换一档，不能跳档）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "../..");
const read = (rel: string) => readFileSync(resolve(appRoot, rel), "utf8");

describe("主题四档", () => {
  it("母版 tokens.css 里有 sepia 与 contrast 两个块", () => {
    const css = read("src/styles/tokens.css");
    expect(css).toContain('[data-theme="sepia"]');
    expect(css).toContain('[data-theme="contrast"]');
  });

  it("两套扩展主题的令牌数与 :root 一致（109）", () => {
    const css = read("src/styles/tokens.css");
    for (const theme of ["sepia", "contrast"]) {
      const start = css.indexOf(`[data-theme="${theme}"]`);
      expect(start, `${theme} 块缺失`).toBeGreaterThan(-1);
      const end = css.indexOf("\n}", start);
      const body = css.slice(start, end);
      const count = body.match(/^\s+--[A-Za-z0-9-_]+\s*:/gm)?.length ?? 0;
      expect(count, `${theme} 令牌数`).toBe(109);
    }
  });

  it("首帧引导认识四个值（含扩展主题）", () => {
    const html = read("index.html");
    for (const theme of ["light", "dark", "sepia", "contrast"]) {
      expect(html).toContain(`"${theme}"`);
    }
  });

  it("useTheme 的循环是四档且顺序为 dark→light→sepia→contrast", () => {
    const src = read("src/hooks/useTheme.ts");
    const cycle = /const THEME_CYCLE: ThemeMode\[\] = \[([^\]]+)\]/.exec(src);
    expect(cycle, "THEME_CYCLE 缺失").toBeTruthy();
    const order = cycle![1]
      .split(",")
      .map((s) => s.trim().replace(/["']/g, ""))
      .filter(Boolean);
    expect(order).toEqual(["dark", "light", "sepia", "contrast"]);
  });
});
