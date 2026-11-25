// File I/O service — Tauri-backed

import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { rememberBookmark, tokenFor } from "../bookmarks";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Atomic write (temp file + rename, see `save_document` in lib.rs).
 * The plugin's writeTextFile truncates the target first, so a failure halfway
 * leaves the user's document destroyed; this never touches the original until
 * the new content is safely on disk.
 *
 * 带上书签：沙盒版重启后，路径本身不再带授权，只有书签能解出可写的作用域。
 */
async function writeAtomic(path: string, content: string): Promise<void> {
  if (isTauri) {
    await invoke("save_document", { path, content, bookmark: tokenFor(path) ?? null });
    return;
  }
  await writeTextFile(path, content);
}

/**
 * 读文件（沙盒下走 Rust 侧安全作用域命令，见 lib.rs with_scope）。
 *
 * 成功读完之后顺手生成一份书签：这一刻进程确实持有授权，凭据才在重启后有效。
 * 所有入口（面板、拖放、最近列表、命令行参数）都经过这里，因此书签不会漏。
 *
 * `remember = false` 给外部改动轮询用：那条路径每 3 秒读一次，没必要每轮都去
 * 生成一份书签。
 */
export async function readRaw(path: string, remember = true): Promise<string> {
  const raw = await invoke<string>("read_document", {
    path,
    bookmark: tokenFor(path) ?? null,
  });
  if (remember) void rememberBookmark(path);
  return raw;
}

const MD_EXTENSIONS = [
  { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdtxt", "mdtext", "text", "txt"] },
  { name: "All Files", extensions: ["*"] },
];

/**
 * Splits raw file text into LF-normalised content plus the line ending it used.
 *
 * A textarea's value normalises \r\n and \r to \n, so a CRLF file (the norm on
 * Windows) came back as LF on the first keystroke and was written back that way —
 * silently rewriting every line of the user's file.
 */
export function normalizeEol(raw: string): { content: string; eol: Eol } {
  const eol: Eol = raw.includes("\r\n") ? "\r\n" : "\n";
  return { content: raw.replace(/\r\n?/g, "\n"), eol };
}

/** Restores the document's original line ending on its way back to disk. */
export function applyEol(content: string, eol: Eol): string {
  return eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

export type Eol = "\n" | "\r\n";

export async function openFile(): Promise<{ path: string; content: string; eol: Eol } | null> {
  try {
    const path = await dialogOpen({
      multiple: false,
      filters: MD_EXTENSIONS,
    });

    if (!path || Array.isArray(path)) return null;

    // 沙盒（MAS）下面板路径的读取走 Rust 侧安全作用域命令（lib.rs with_scoped）；
    // 插件的 readTextFile 在沙盒里对容器外路径会 EPERM（2.1(a) 被拒根因）。
    const raw = await readRaw(path);
    const { content, eol } = normalizeEol(raw);
    return { path, content, eol };
  } catch (err) {
    console.error("Failed to open file:", err);
    return null;
  }
}

export async function saveFile(path: string, content: string): Promise<void> {
  await writeAtomic(path, content);
}

export async function saveFileAs(content: string, defaultName?: string): Promise<string | null> {
  const path = await dialogSave({
    filters: MD_EXTENSIONS,
    defaultPath: defaultName || "Untitled.md",
  });

  if (!path) return null;

  await writeAtomic(path, content);
  // 另存到新位置后先签一份书签：否则这个路径要等到下次被「打开」才有凭据
  void rememberBookmark(path);
  return path;
}

const HTML_EXTENSIONS = [
  { name: "HTML", extensions: ["html", "htm"] },
  { name: "All Files", extensions: ["*"] },
];

/**
 * 单文件 HTML 导出。与 saveFileAs 共用同一条原子写 + 授权闸门，
 * 只是另存对话框给出 .html 过滤器，避免用户拿到一份叫 Untitled.md 的网页。
 */
export async function saveHtmlAs(content: string, defaultName?: string): Promise<string | null> {
  const path = await dialogSave({
    filters: HTML_EXTENSIONS,
    defaultPath: defaultName || "Untitled.html",
  });

  if (!path) return null;

  await writeAtomic(path, content);
  return path;
}
