// 安全作用域书签到路径的映射（准则 §二十二 第 5 条）。
//
// 为什么另存一份映射而不是把 token 塞进最近列表：最近列表是有序数组、会被去重和
// 截断，而书签要跟着路径走。两件事的生命周期不同，混在一个结构里必然互相牵连。
//
// 容量上限存在的理由与最近列表不同：书签本身只有几百字节，但 localStorage 总量
// 有限；超出时淘汰最早写入的一条即可 —— 丢一条书签的后果是「这个文件下次要重新
// 选择」，不是数据损坏。

import { invoke } from "@tauri-apps/api/core";

const KEY = "rocktier.md.bookmarks";
const LIMIT = 24;

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type TokenMap = Record<string, string>;

function readMap(): TokenMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: TokenMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch {
    // 存储不可用或内容损坏 —— 退回「没有书签」，行为等同改动前
    return {};
  }
}

function writeMap(map: TokenMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // 配额满：书签是增强项，写不进去不该影响打开与保存
  }
}

export function tokenFor(path: string): string | undefined {
  return readMap()[path];
}

export function forgetBookmark(path: string): void {
  const map = readMap();
  if (!(path in map)) return;
  delete map[path];
  writeMap(map);
}

/**
 * 为一个刚被成功读到的路径生成书签。
 *
 * 只在读取成功之后调用：那一刻进程确实持有系统授权，生成的凭据才在重启后有效。
 * 失败静默 —— 直发版与 Windows 上这个命令恒返回 Err，属于预期。
 */
export async function rememberBookmark(path: string): Promise<void> {
  if (!isTauri) return;
  try {
    const token = await invoke<string>("bookmark_create", { path });
    if (!token) return;
    const map = readMap();
    map[path] = token;
    const keys = Object.keys(map);
    if (keys.length > LIMIT) {
      for (const k of keys.slice(0, keys.length - LIMIT)) delete map[k];
    }
    writeMap(map);
  } catch {
    // 非 macOS / 非沙盒：没有书签也不影响任何现有行为
  }
}

/**
 * 书签 → 当前路径。文件被移动或改名时返回新位置。
 *
 * 解不出来就原样返回入参：调用方随后按普通路径打开，失败时仍走原有的「诚实降级」
 * （见 App.tsx 的 forgetRecent）。
 */
export async function resolveBookmarkPath(path: string): Promise<string> {
  if (!isTauri) return path;
  const token = tokenFor(path);
  if (!token) return path;
  try {
    const resolved = await invoke<string>("bookmark_resolve", { bookmark: token });
    if (!resolved) return path;
    if (resolved !== path) {
      // 路径变了：书签跟着新路径走，旧键让位，避免同一文件留两份
      const map = readMap();
      delete map[path];
      map[resolved] = token;
      writeMap(map);
    }
    return resolved;
  } catch {
    return path;
  }
}

/** 清空全部书签（测试与「重置偏好」用）。 */
export function clearBookmarks(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 存储不可用
  }
}
