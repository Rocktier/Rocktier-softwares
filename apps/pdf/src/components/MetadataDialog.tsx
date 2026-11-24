import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useDialogA11y } from '../hooks/useDialog';
import type { DocumentInfo, PdfMetadata } from '../types';

interface MetadataDialogProps {
  onClose: () => void;
  onLoad: () => Promise<PdfMetadata | null>;
  onRun: (
    meta: PdfMetadata
  ) => Promise<{ info: DocumentInfo | null; error: string | null }>;
}

const BLANK: PdfMetadata = { title: '', author: '', subject: '', keywords: '' };

/**
 * 文档属性（PDF Info 字典）的四个标准字段。
 *
 * 只放这四个：`Creator` 是生成原稿的软件、`Producer` 是它自己，
 * 让用户改等于给文件伪造来源，而 `CreationDate` 一改就和签名/审计对不上。
 * 空字段会被删除而不是写成空串（见 Rust 侧 write_metadata 的说明）。
 */
export function MetadataDialog({ onClose, onLoad, onRun }: MetadataDialogProps) {
  const t = useT();
  const { overlayProps, dialogProps } = useDialogA11y(onClose);
  const [meta, setMeta] = useState<PdfMetadata>(BLANK);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    onLoad()
      .then((loaded) => {
        if (!alive) return;
        if (loaded) setMeta(loaded);
        else setError(t('metadata.loadFailed'));
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [onLoad, t]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { info, error: message } = await onRun(meta);
      if (!info) {
        setError(message ?? t('metadata.failed'));
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof PdfMetadata, label: string, placeholder?: string) => (
    <div className="field">
      <label>{label}</label>
      <input
        className="input"
        value={meta[key]}
        placeholder={placeholder}
        onChange={(e) => setMeta((prev) => ({ ...prev, [key]: e.target.value }))}
      />
    </div>
  );

  return (
    <div className="overlay" {...overlayProps}>
      <div
        className="modal"
        {...dialogProps}
        aria-label={t('metadata.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{t('metadata.title')}</h3>
        </div>

        <div className="modal-body">
          {loading ? <p className="hint">{t('metadata.loading')}</p> : null}
          {field('title', t('metadata.fieldTitle'))}
          {field('author', t('metadata.fieldAuthor'))}
          {field('subject', t('metadata.fieldSubject'))}
          {field('keywords', t('metadata.fieldKeywords'), t('metadata.keywordsHint'))}

          {error ? (
            <p className="hint" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          ) : null}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('metadata.cancel')}
          </button>
          <button className="btn btn-primary" onClick={run} disabled={busy || loading}>
            {t('metadata.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
