/* i18n —— 2026-11-18 起与 PDF 仓同构：嵌套字典 + 点路径查找 + en 兜底 +
   {var} 插值 + 固定英文默认（不嗅探系统语言）。
   存储键按 PDF 的每应用命名空间：rocktier.md.lang；
   旧键 rocktier.lang / rocktier-md-lang 仅作读取回落，一次迁移后不再使用。
   对外 API（t / useUiLang / getUiLang / setUiLang / fmtKeys）保持不变，
   11 个消费文件无需改动。 */

import { useReducer, useEffect } from 'react';
import { LOCALES, type LocaleCode } from './locales';
import { en } from './en';
import { zh } from './zh';

export type Lang = LocaleCode;

const DICTS = { en, zh } as const;
const STORAGE_KEY = 'rocktier.md.lang';
const STORAGE_KEY_LEGACY_1 = 'rocktier.lang';
const STORAGE_KEY_LEGACY_2 = 'rocktier-md-lang';

type Vars = Record<string, string | number>;

function lookup(dict: unknown, path: string): string | undefined {
  const value = path.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object' && k in (acc as object)) {
      return (acc as Record<string, unknown>)[k];
    }
    return undefined;
  }, dict);
  return typeof value === 'string' ? value : undefined;
}

/** 当前语言 → en 兜底 → key。缺键绝不能把路径露给用户。 */
function resolve(lang: Lang, path: string): string {
  const dict = (DICTS as Record<string, unknown>)[lang];
  const hit = (dict ? lookup(dict, path) : undefined) ?? lookup(DICTS.en, path);
  if (hit === undefined && (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
    console.error(`[i18n] missing key: ${path}`);
  }
  return hit ?? path;
}

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m
  );
}

function detectLang(): Lang {
  try {
    const saved =
      localStorage.getItem(STORAGE_KEY) ??
      localStorage.getItem(STORAGE_KEY_LEGACY_1) ??
      localStorage.getItem(STORAGE_KEY_LEGACY_2);
    if (saved && (LOCALES as readonly { code: string }[]).some((l) => l.code === saved)) {
      return saved as Lang;
    }
  } catch {
    /* storage unavailable */
  }
  return 'en';
}

let currentLang: Lang = detectLang();
document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : currentLang;

const listeners = new Set<() => void>();

export function getUiLang(): Lang {
  return currentLang;
}

export function setUiLang(lang: Lang): void {
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((fn) => fn());
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
}

export function t(path: string, params?: Vars): string {
  const text = resolve(currentLang, path);
  const interpolated = interpolate(text, params);
  // 快捷键文案集中平台化：Windows 上 ⌘ → Ctrl+、⇧ → Shift+
  return fmtKeys(interpolated);
}

/** 订阅语言变化：语言切换时触发组件重渲染。 */
export function useUiLang(): Lang {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, [force]);
  return currentLang;
}

/** ⌘ on macOS, Ctrl+ elsewhere — the shortcut hints are written with ⌘ in the dictionary. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl+';
const SHIFT_KEY = IS_MAC ? '⇧' : 'Shift+';

export function fmtKeys(text: string): string {
  if (IS_MAC) return text;
  return text
    .replace(/⌘\s*⇧\s*/g, 'Ctrl+Shift+')
    .replace(/⌘\s*/g, MOD_KEY)
    .replace(/⇧\s*/g, SHIFT_KEY);
}

// 供 scripts/gen-i18n.mjs 取真实键结构（esbuild 求值，不用正则猜 TS）
export const __en = en;

export { LOCALES };
export type { LocaleCode };
