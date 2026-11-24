import { memo } from "react";
import { t, useUiLang, getUiLang, setUiLang } from "../i18n";
import type { LicenseInfo } from "../services/license";

interface Props {
  words: number;
  /** 全文行数（按 \n 计），来自当前内容本身 */
  lines: number;
  minutes: number;
  /** 是否已落到磁盘：决定状态词是「已保存」还是「草稿」 */
  hasPath: boolean;
  modified: boolean;
  /** 预览还在追当前内容（useDeferredValue 尚未追上）——真实的进行态 */
  syncing: boolean;
  gitBranch?: string;
  /** 许可状态：显示试用剩余天数，并作为进入"许可与激活"的入口。 */
  license?: LicenseInfo | null;
  onLicenseClick?: () => void;
}

export const StatusBar = memo(function StatusBar({
  words,
  lines,
  minutes,
  hasPath,
  modified,
  syncing,
  gitBranch,
  license,
  onLicenseClick,
}: Props) {
  useUiLang(); // 语言切换时重渲染（复审 F9）

  /* 只在直链版且尚未买断时提示 —— 商店版由商店收款，这里再提一句"试买"既多余，
     又容易在审核眼里变成"引导外部购买"。已激活时同样不占状态栏（入口在帮助菜单）。 */
  const showLicenseChip =
    !!license && license.channel === "direct" && license.status !== "licensed";

  /* 三种真实状态，按优先级取一个：
     · 有未保存改动 → 未保存
     · 预览尚未追上编辑内容 → 预览更新中
     · 落过盘 → 已保存；从未落盘 → 尚未保存
     红点只在上面两种「进行中」出现，静止态不放；文字始终在场。 */
  const busy = modified || syncing;
  const stateText = modified
    ? t("doc.unsaved")
    : syncing
      ? t("status.syncing")
      : hasPath
        ? t("doc.saved")
        : t("status.draft");

  return (
    <footer className="status-bar" role="status" aria-live="polite">
      <span className="status-state">
        {busy && <span className="dot-live" role="img" aria-label={stateText} />}
        <span>{stateText}</span>
      </span>
      <span className="sep" />
      <span className="mono">{t("status.stats", { n: words, lines, m: minutes })}</span>
      {gitBranch && (
        <>
          <span className="sep" />
          <span className="mono">{gitBranch}</span>
        </>
      )}
      <span className="spacer" />
      {showLicenseChip && (
        /* 徽标颜色统一由 .badge-license（母版 tokens.css）负责，试用/过期同色，
            不再用 expired 修饰类切警示色。 */
        <button
          type="button"
          className="badge-license"
          onClick={onLicenseClick}
          title={license.status === "expired" ? t("license.expired") : t("license.trialLeft", { days: license.daysLeft })}
        >
          {license.status === "expired"
            ? t("license.expiredChip")
            : t("license.trialChip", { days: license.daysLeft })}
        </button>
      )}
      <span className="sep" />
      {/* 家族语言 2026-10-13 收敛为 en/zh 两门。2026-11-15 用户令：语言切换
          一律收成 地球图标按钮，点击在两门间对切（与主题按钮同款交互），
          不再占文字位。外层 span 沿用 .status-lang 的右推布局职责。 */}
      <span className="status-lang">
        <button
          className="icon-btn"
          onClick={() => setUiLang(getUiLang() === "en" ? "zh" : "en")}
          aria-label="Language"
          title="Language"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <ellipse cx="12" cy="12" rx="3.8" ry="9" />
            <path d="M3 12h18" />
          </svg>
        </button>
      </span>
    </footer>
  );
});
