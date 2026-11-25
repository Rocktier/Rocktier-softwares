/**
 * 主题档位的判据（2026-11-25）。
 *
 * 只测「状态机」这一层：四档一轮回、顺序固定、未知值不卡死。
 * 颜色与令牌完整性不在这里管 —— 那在 contrast-gate 判据 ⑥（母版层面逐表面对比度）。
 * 为什么不用静态读文件：Vite/Vitest 对 CSS 的 ?raw 会返回空串（实测 LEN 0），
 * 而 node:fs 又要 @types/node，两样都会把 tsc --noEmit 弄红。
 */
import { describe, expect, it } from "vitest";
import { THEME_CYCLE, nextTheme, type ThemeMode } from "../hooks/useTheme";

describe("主题四档状态机", () => {
  it("四档顺序是 dark → light → sepia → contrast", () => {
    expect(THEME_CYCLE).toEqual(["dark", "light", "sepia", "contrast"]);
  });

  it("点四下回到原点，且每一档都走到了", () => {
    const seen: ThemeMode[] = [];
    let cur: ThemeMode = "dark";
    for (let i = 0; i < THEME_CYCLE.length; i++) {
      cur = nextTheme(cur);
      seen.push(cur);
    }
    expect(seen).toEqual(["light", "sepia", "contrast", "dark"]);
    expect(new Set(seen).size).toBe(4);
  });

  it("未知值不抛错，落回家族基线（深色）", () => {
    expect(nextTheme("nonsense" as ThemeMode)).toBe("dark");
  });
});
