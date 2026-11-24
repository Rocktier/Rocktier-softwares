import { useState } from 'react';
import { useT } from '../i18n';
import { useDialogA11y } from '../hooks/useDialog';
import type { CropMargins, DocumentInfo } from '../types';

interface CropDialogProps {
  doc: DocumentInfo;
  /** 0 基选中页；空数组 = 全部页。 */
  selected: number[];
  onClose: () => void;
  onRun: (
    indices: number[],
    margins: CropMargins
  ) => Promise<{ ok: boolean; error: string | null }>;
}

const EMPTY: CropMargins = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * 四边留白裁剪。数字是**显示方向**上的边（用户看到的上下左右），
 * 旋转页的换算在 Rust 侧做 —— 这里只需要把屏幕上量到的数交出去。
 *
 * 参考页取第一张受影响的页：一页一个尺寸的文档（扫描件、外卖单）
 * 是裁剪的主要场景，给它们显示"当前 595×842"比让用户自己去量更实际。
 */
export function CropDialog({ doc, selected, onClose, onRun }: CropDialogProps) {
  const t = useT();
  const { overlayProps, dialogProps } = useDialogA11y(onClose);
  const [margins, setMargins] = useState<CropMargins>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets = selected.length > 0 ? selected : doc.pages.map((p) => p.index);
  const reference = doc.pages.find((p) => p.index === targets[0]) ?? doc.pages[0];
  const rotated = reference ? reference.rotation === 90 || reference.rotation === 270 : false;
  const width = reference ? (rotated ? reference.height : reference.width) : 0;
  const height = reference ? (rotated ? reference.width : reference.height) : 0;

  const keptWidth = width - margins.left - margins.right;
  const keptHeight = height - margins.top - margins.bottom;
  const valid =
    Number.isFinite(keptWidth) &&
    Number.isFinite(keptHeight) &&
    keptWidth > 0 &&
    keptHeight > 0 &&
    margins.top >= 0 &&
    margins.right >= 0 &&
    margins.bottom >= 0 &&
    margins.left >= 0;

  const set = (key: keyof CropMargins) => (raw: string) => {
    const value = Number(raw);
    setMargins((prev) => ({ ...prev, [key]: Number.isFinite(value) ? value : 0 }));
  };

  const run = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { ok, error: message } = await onRun(targets, margins);
      if (!ok) {
        setError(message ?? t('crop.failed'));
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const num = (key: keyof CropMargins, label: string) => (
    <div className="field">
      <label>{label}</label>
      <input
        className="input"
        type="number"
        min={0}
        step={1}
        value={margins[key]}
        onChange={(e) => set(key)(e.target.value)}
      />
    </div>
  );

  return (
    <div className="overlay" {...overlayProps}>
      <div
        className="modal"
        {...dialogProps}
        aria-label={t('crop.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{t('crop.title')}</h3>
        </div>

        <div className="modal-body">
          <p className="hint">
            {selected.length > 0
              ? t('crop.scopeSelected', { count: targets.length })
              : t('crop.scopeAll', { count: targets.length })}
          </p>

          <div className="row">
            {num('top', t('crop.top'))}
            {num('bottom', t('crop.bottom'))}
          </div>
          <div className="row">
            {num('left', t('crop.left'))}
            {num('right', t('crop.right'))}
          </div>

          <p className="hint">
            {valid
              ? t('crop.result', {
                  width: Math.round(keptWidth * 10) / 10,
                  height: Math.round(keptHeight * 10) / 10,
                  from: `${Math.round(width * 10) / 10}×${Math.round(height * 10) / 10}`,
                })
              : t('crop.tooMuch')}
          </p>

          {error ? (
            <p className="hint" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          ) : null}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('crop.cancel')}
          </button>
          <button className="btn btn-primary" onClick={run} disabled={busy || !valid}>
            {t('crop.run')}
          </button>
        </div>
      </div>
    </div>
  );
}
