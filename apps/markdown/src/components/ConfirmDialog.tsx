// 应用内确认框。家族规范（docs/ROCKTIER-UI规范-v2.md §7）禁止原生
// Tauri ask() / window.confirm；视觉直接复用 UpdateDialog 的
// .update-overlay / .update-dialog / .update-footer 与 tokens，不另造一套。
import { useEffect } from "react";
import { t } from "../i18n";

interface ConfirmDialogProps {
  message: string;
  /** 三按钮模式（关窗用）：显示「保存并关闭」，由 onSave 处理。 */
  saveLabel?: string;
  /** 确认（两按钮时是「确定」，三按钮时是「不保存」）。 */
  onResolve: () => void;
  /** 取消：按钮、Esc、点遮罩三处共用。 */
  onCancel: () => void;
  onSave?: () => void;
}

export function ConfirmDialog({
  message,
  saveLabel,
  onResolve,
  onCancel,
  onSave,
}: ConfirmDialogProps) {
  // Esc = 取消（与 UpdateDialog / LicenseDialog 一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const threeWay = Boolean(saveLabel && onSave);

  return (
    <div className="update-overlay" onMouseDown={onCancel} role="presentation">
      <div
        className="update-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("confirm.title")}
      >
        <div className="update-header">
          <h3>{t("confirm.title")}</h3>
        </div>
        <div className="update-body">
          <p className="confirm-message">{message}</p>
        </div>
        <div className="update-footer">
          <button type="button" onClick={onCancel}>
            {t("confirm.cancel")}
          </button>
          <span className="update-footer-spacer" />
          {/* 三按钮时「不保存」不再是主按钮：主按钮要让给「保存并关闭」，
              否则用户顺手点最右边，丢的正是他刚写的东西。 */}
          <button
            type="button"
            className={threeWay ? undefined : "update-get-btn"}
            onClick={onResolve}
          >
            {threeWay ? t("confirm.discardClose") : t("confirm.ok")}
          </button>
          {threeWay && (
            <button type="button" className="update-get-btn" onClick={onSave}>
              {saveLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
