/**
 * ConfirmDialog 的组件级回归测试。
 *
 * 这一层测的是「7 处丢弃确认现在真的走应用内框」，而不是系统弹窗：
 *   · 框里出现的是调用点传进来的那句话（不是路由错了、不是空字符串）；
 *   · 确定/取消两个方向都能把 Promise 结掉 —— 只结一边就等于「点了没反应」；
 *   · Esc 与点遮罩都算取消（与 UpdateDialog / LicenseDialog 同一个约定）。
 *
 * 2026-11-24 加关窗三按钮（取消 / 不保存 / 保存并关闭）后，回调从单个
 * `onResolve(ok)` 拆成 onResolve / onCancel / onSave：三态用 boolean 表达不了，
 * 而 onResolve(false) 同时当「取消」会让 Esc 和「不保存」分不清楚。
 *
 * ⚠️ 家族 vitest 的 include 只收 `.test.ts`（不含 `.test.tsx`），所以这里用
 * createElement 而非 JSX。别改成 `.tsx` —— 那样它不会被跑到。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** 挂载两按钮版，返回收集到的决议序列。 */
function mount(message: string) {
  const got: string[] = [];
  act(() => {
    root.render(
      createElement(ConfirmDialog, {
        message,
        onResolve: () => got.push("ok"),
        onCancel: () => got.push("cancel"),
      })
    );
  });
  return got;
}

/** 挂载三按钮版（关窗），返回决议序列。 */
function mountThree(message: string) {
  const got: string[] = [];
  act(() => {
    root.render(
      createElement(ConfirmDialog, {
        message,
        saveLabel: "Save and close",
        onResolve: () => got.push("discard"),
        onCancel: () => got.push("cancel"),
        onSave: () => got.push("save"),
      })
    );
  });
  return got;
}

const byText = (label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === label);

describe("ConfirmDialog", () => {
  it("把调用点给的文案原样放进对话框", () => {
    mount("当前文档有未保存的更改，确定要丢弃吗？");
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("当前文档有未保存的更改");
    // 没有 message 就只剩一个空框 —— 那等于把「要确认什么」弄丢了
    expect(host.querySelector(".confirm-message")!.textContent).not.toBe("");
  });

  it("点「确定」决议为 ok", () => {
    const got = mount("Discard?");
    // 界面文案取自 i18n，测试环境没有本地语言偏好 ⇒ 默认英文档
    const ok = byText("OK");
    expect(ok, "找不到确定按钮").toBeTruthy();
    act(() => ok!.click());
    expect(got).toEqual(["ok"]);
  });

  it("点「取消」决议为 cancel", () => {
    const got = mount("Discard?");
    const cancel = byText("Cancel");
    expect(cancel, "找不到取消按钮").toBeTruthy();
    act(() => cancel!.click());
    expect(got).toEqual(["cancel"]);
  });

  it("Esc 决议为 cancel", () => {
    const got = mount("丢弃？");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(got).toEqual(["cancel"]);
  });

  it("点遮罩决议为 cancel，点框内不误触", () => {
    const got = mount("丢弃？");
    const dialog = host.querySelector('[role="dialog"]') as HTMLElement;
    act(() => {
      dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(got).toEqual([]);
    act(() => {
      host.querySelector(".update-overlay")!.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
    });
    expect(got).toEqual(["cancel"]);
  });

  it("三按钮：保存与不保存各走各的，取消仍是 cancel", () => {
    const got = mountThree("Unsaved changes. Save before closing?");
    const save = byText("Save and close");
    const discard = byText("Don't save");
    expect(save, "关窗框缺「保存并关闭」").toBeTruthy();
    expect(discard, "关窗框缺「不保存」").toBeTruthy();
    act(() => discard!.click());
    expect(got).toEqual(["discard"]);
    act(() => save!.click());
    expect(got).toEqual(["discard", "save"]);
  });

  it("三按钮：主按钮是「保存并关闭」，不是「不保存」", () => {
    mountThree("Unsaved changes.");
    // 主按钮带 update-get-btn；顺手点最右边的是「保存」，丢不了内容
    const save = byText("Save and close");
    expect(save!.className).toContain("update-get-btn");
    expect(byText("Don't save")!.className).not.toContain("update-get-btn");
  });
});
