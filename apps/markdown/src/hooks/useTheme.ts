import { useCallback, useEffect, useState } from "react";

/** 四档循环：dark → light → sepia → contrast → dark。
 *  2026-11-15 用户令：全家族取消「跟随系统」，原 §6.5 三态状态机退役。
 *  2026-11-25：浅/深之外加两套扩展主题（母版 tokens.css 里的
 *  [data-theme="sepia"] 暖纸 / [data-theme="contrast"] 高对比）。
 *  仍然只有一个 data-theme 属性 + 一组变量覆盖 —— 没有主题引擎、没有运行时算色。 */
export type ThemeMode = "dark" | "light" | "sepia" | "contrast";
export const THEME_CYCLE: ThemeMode[] = ["dark", "light", "sepia", "contrast"];

/** 下一档。抽成纯函数是为了能测：按钮点一下必须换一档、四档一轮回，
 *  而不是靠人肉点四遍看颜色。 */
export function nextTheme(prev: ThemeMode): ThemeMode {
  const i = THEME_CYCLE.indexOf(prev);
  return THEME_CYCLE[(i < 0 ? 0 : i + 1) % THEME_CYCLE.length];
}
type Resolved = ThemeMode;

/* 2026-10-04 键改名（"rocktier-md-theme" → "rocktier.theme"），理由同 i18n.ts。 */
const THEME_KEY = "rocktier.theme";
const THEME_KEY_LEGACY = "rocktier-md-theme";

function systemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function persist(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // ignore —— 主题本次会话仍然生效
  }
}

function readMode(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = (localStorage.getItem(THEME_KEY) ??
      localStorage.getItem(THEME_KEY_LEGACY)) as ThemeMode | "auto" | null;
    if (stored && (THEME_CYCLE as string[]).includes(stored)) return stored as ThemeMode;
    if (stored === "auto") {
      // 旧「跟随系统」用户：按读取当时的系统值一次性落定并持久化，
      // 此后不再跟随系统变化（用户看得见的偏好不丢）。
      const resolved = systemTheme();
      persist(resolved);
      return resolved;
    }
  } catch {
    // 隐私模式 / 存储被禁用：偏好读取失败不能把整个 App 渲染打挂
  }
  // 从没手动选过：深色（家族基线；2026-11-15 起不再跟随系统）
  return "dark";
}

function applyResolved(resolved: Resolved) {
  document.documentElement.setAttribute("data-theme", resolved);
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readMode);

  useEffect(() => {
    applyResolved(mode);
  }, [mode]);

  // 「跟随系统」已取消：不再监听 prefers-color-scheme 变化，
  // light/dark 都是明确选择，启动后保持不变。

  const cycleTheme = useCallback(() => {
    setMode((prev) => {
      const next = nextTheme(prev);
      persist(next);
      return next;
    });
  }, []);

  return { mode, cycleTheme };
}
