// Hand-made components — no component library.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { copyText } from './lib.js';
import { tr } from './i18n.jsx';

// ---------------------------------------------------------------- icons (inline svg, stroke style)

const paths = {
  home: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  api: 'M4 6h16M4 12h16M4 18h10',
  apps: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  audit: 'M9 4h6l1 2h3v15H5V6h3zM9 12h6M9 16h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6 6 18',
  chevronDown: 'm6 9 6 6 6-6',
  chevronUp: 'm6 15 6-6 6 6',
  chevronRight: 'm9 6 6 6-6 6',
  arrowLeft: 'M19 12H5M11 18l-6-6 6-6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  rocket: 'M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M14 4c3-1 6-1 6-1s0 3-1 6l-6 6-5-5zM9 10l-4 1 3 3M14 15l-1 4-3-3',
  gateway: 'M3 12h4l3-8 4 16 3-8h4',
  key: 'M14 10a4 4 0 1 0-3.9 4H11l2 2h2v2h2v2h3v-3l-6.1-6.1A4 4 0 0 0 14 10z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7M22 21a7 7 0 0 0-4-6.3',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  doc: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 13h6M9 17h6',
  layers: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  refresh: 'M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12A9 9 0 0 1 18.5 5.7L21 8M21 3v5h-5M3 21v-5h5',
  play: 'M6 4l14 8-14 8z',
  pause: 'M7 4h4v16H7zM14 4h4v16h-4z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  upload: 'M12 21V9M7 14l5-5 5 5M4 3h16',
  git: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  menu: 'M3 6h18M3 12h18M3 18h18',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  swap: 'M7 16V4M3 8l4-4 4 4M17 8v12M21 16l-4 4-4-4',
  up: 'M12 19V5M5 12l7-7 7 7',
  left: 'M15 18l-6-6 6-6',
  right: 'M9 18l6-6-6-6',
  down: 'M12 5v14M19 12l-7 7-7-7',
};

export function Icon({ name, size = 16, className = '', strokeWidth = 1.8 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={paths[name] || paths.info} />
    </svg>
  );
}

// ---------------------------------------------------------------- toasts

const ToastCtx = createContext(() => {});

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setItems((x) => [...x, { id, message, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon name={t.kind === 'error' ? 'alert' : 'check'} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

export function errorMessage(e) {
  if (!e) return '';
  const d = e.details;
  if (d?.errors?.length) return `${e.message}: ${d.errors.map((x) => x.message).join(' · ')}`;
  if (typeof d === 'string') return `${e.message}: ${d}`;
  return e.message || String(e);
}

// ---------------------------------------------------------------- data loading

export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const counter = useRef(0);
  const reload = useCallback(async () => {
    const n = ++counter.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fn();
      if (n === counter.current) setState({ loading: false, data, error: null });
    } catch (error) {
      if (n === counter.current) setState({ loading: false, data: null, error });
    }
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { ...state, reload, setData: (data) => setState((s) => ({ ...s, data })) };
}

export function Loading() {
  return (
    <div className="loading">
      <span className="spinner" />
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  return (
    <div className="callout negative">
      <Icon name="alert" />
      <div className="grow">
        <div className="bold">{errorMessage(error)}</div>
        {onRetry && (
          <button className="btn sm mt-8" onClick={onRetry}>
            {tr('Retry')}
          </button>
        )}
      </div>
    </div>
  );
}

export function Loader({ state, children }) {
  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (state.loading && !state.data) return <Loading />;
  return children(state.data);
}

// ---------------------------------------------------------------- form controls

export function Field({ label, hint, children, error }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {error ? <div className="hint" style={{ color: 'var(--negative-text)' }}>{error}</div> : hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Input({ value, onChange, ...rest }) {
  return <input className={`input ${rest.mono ? 'mono' : ''}`} value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} {...rest} mono={undefined} />;
}

export function NumberInput({ value, onChange, placeholder, ...rest }) {
  return (
    <input
      className="input"
      type="number"
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value === '' ? null : Number(e.target.value))}
      {...rest}
    />
  );
}

export function TextArea({ value, onChange, mono, rows = 4, ...rest }) {
  return <textarea className={`textarea ${mono ? 'mono' : ''}`} rows={rows} value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} {...rest} />;
}

export function Select({ value, onChange, options, ...rest }) {
  return (
    <select className="select" value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} {...rest}>
      {options.map((o) => {
        // a value offered as such reads in the language of the console: a status, a role
        const opt = typeof o === 'string' ? { value: o, label: tr(o) } : o;
        return (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        );
      })}
    </select>
  );
}

export function Switch({ checked, onChange, label, disabled }) {
  return (
    <label className="switch" style={disabled ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
      <span className="track" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Seg({ value, onChange, options }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return (
          <button key={opt.value} type="button" role="radio" aria-checked={value === opt.value} className={value === opt.value ? 'on' : ''} onClick={() => onChange(opt.value)}>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// tags editor: comma or enter separated
export function TagsInput({ value = [], onChange, placeholder = 'add and press enter' }) {
  const [text, setText] = useState('');
  const add = () => {
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...(value || []), ...parts])]);
    setText('');
  };
  return (
    <div className="input" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minHeight: 34, padding: '4px 6px' }}>
      {(value || []).map((t) => (
        <span key={t} className="tag" style={{ gap: 4 }}>
          {t}
          <button type="button" className="btn ghost xs" style={{ height: 16, padding: 0, width: 16 }} onClick={() => onChange(value.filter((x) => x !== t))} aria-label={tr('remove {0}', [t])}>
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <input
        style={{ border: 0, outline: 'none', background: 'transparent', color: 'inherit', font: 'inherit', flex: 1, minWidth: 120 }}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !text && value?.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
      />
    </div>
  );
}

export function Setting({ label, help, children }) {
  return (
    <div className="setting">
      <div>
        <div className="s-label">{label}</div>
        {help && <div className="s-help">{help}</div>}
      </div>
      <div className="col">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- overlays

export function Modal({ title, onClose, children, footer, size = '' }) {
  useEffect(() => {
    const on = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${size}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-head">
          <h2 className="grow">{title}</h2>
          <button className="btn ghost sm icon" onClick={onClose} aria-label={tr('close')}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, footer, subtitle }) {
  useEffect(() => {
    const on = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="grow">
            <h2>{title}</h2>
            {subtitle && <div className="muted small">{subtitle}</div>}
          </div>
          <button className="btn ghost sm icon" onClick={onClose} aria-label={tr('close')}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>
  );
}

// confirm() replacement that never blocks the page
const ConfirmCtx = createContext(null);
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setState({ ...opts, resolve });
      }),
    []
  );
  const close = (v) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <Modal
          title={state.title || tr('Are you sure?')}
          onClose={() => close(false)}
          footer={
            <>
              <button className="btn" onClick={() => close(false)}>
                {tr('Cancel')}
              </button>
              <button className={`btn ${state.danger ? 'danger solid' : 'primary'}`} onClick={() => close(true)}>
                {state.confirmLabel || tr('Confirm')}
              </button>
            </>
          }
        >
          {typeof state.message === 'string' ? <p>{state.message}</p> : state.message}
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}
export function useConfirm() {
  return useContext(ConfirmCtx);
}

// ---------------------------------------------------------------- display

export function Badge({ kind = '', children, dot = false, title }) {
  return (
    <span className={`badge ${kind} ${dot ? 'dot' : ''}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_KIND = {
  active: 'positive',
  published: 'positive',
  deployed: 'positive',
  in_sync: 'positive',
  synced: 'positive',
  done: 'positive',
  succeeded: 'positive',
  enabled: 'positive',
  pending: 'warning',
  pending_payment: 'warning',
  waiting: 'warning',
  running: 'info',
  staging: 'info',
  created: 'info',
  drifted: 'warning',
  deprecated: 'warning',
  suspended: 'warning',
  expired: 'warning',
  unmanaged: 'info',
  rejected: 'negative',
  failed: 'negative',
  error: 'negative',
  missing: 'negative',
  closed: '',
  archived: '',
  revoked: '',
  removed: '',
  none: '',
};

export function StatusBadge({ status, label }) {
  return (
    <Badge kind={STATUS_KIND[status] ?? ''} dot>
      {label || tr(String(status || '—').replace(/_/g, ' '))}
    </Badge>
  );
}

export function CopyButton({ text, label, className = 'btn sm' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        copyText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      aria-label={tr('copy')}
    >
      <Icon name={done ? 'check' : 'copy'} />
      {label}
    </button>
  );
}

export function Code({ children, lang }) {
  return (
    <div className="copy">
      <pre>
        <code data-lang={lang}>{children}</code>
      </pre>
      <div className="copy-btn">
        <CopyButton text={children} className="btn xs ghost" />
      </div>
    </div>
  );
}

export function Secret({ value, reveal = false }) {
  const [shown, setShown] = useState(reveal);
  if (!value) return <span className="faint">—</span>;
  return (
    <span className="secret">
      <span className="ellipsis">{shown ? value : '•'.repeat(Math.min(24, value.length))}</span>
      <button className="btn ghost xs icon" onClick={() => setShown(!shown)} aria-label={shown ? tr('hide') : tr('show')}>
        <Icon name="eye" size={14} />
      </button>
      <CopyButton text={value} className="btn ghost xs icon" />
    </span>
  );
}

export function Empty({ title, children, action, icon = 'box' }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} className="faint" />
      <h3 className="mt-8">{title}</h3>
      {children && <div className="muted">{children}</div>}
      {action && <div className="mt-16">{action}</div>}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'on' : ''} onClick={() => onChange(t.id)} title={t.title}>
          {t.label}
          {t.count !== undefined && t.count !== null && <span className={t.attention ? 'count attention' : 'count'}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// the tabs under a tab: the pages of a group, lighter than their group
export function SubTabs({ tabs, value, onChange, label }) {
  return (
    <div className="subtabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'on' : ''} onClick={() => onChange(t.id)} title={t.title}>
          {t.label}
          {t.count !== undefined && t.count !== null && <span className={t.attention ? 'count attention' : 'count'}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function DiffView({ changes, empty = tr('No change') }) {
  if (!changes) return null;
  if (!changes.length) return <div className="muted small">{empty}</div>;
  const fmt = (v) => {
    if (v === undefined) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
  };
  return (
    <div className="col gap-4">
      {changes.map((c, i) => (
        <div key={i} className={`diff-line ${c.op}`}>
          <span className="bold">{c.op === 'add' ? '+' : c.op === 'remove' ? '−' : '~'}</span>
          <span className="bold">{c.path}</span>
          <span className="grow">{c.op === 'change' ? `${fmt(c.before)} → ${fmt(c.after)}` : fmt(c.op === 'add' ? c.after : c.before)}</span>
        </div>
      ))}
    </div>
  );
}

export function Markdown({ source }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source || '', { gfm: true })), [source]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

// picks a local file and hands over its text (never uploaded as such: the caller decides)
export function FileButton({ accept, onFile, children = 'From a file…', className = 'btn' }) {
  const input = useRef(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(await file.text(), file);
        }}
      />
      <button type="button" className={className} onClick={() => input.current?.click()}>
        <Icon name="upload" /> {children}
      </button>
    </>
  );
}

export function JsonBlock({ value }) {
  return <Code lang="json">{JSON.stringify(value, null, 2)}</Code>;
}

export function Callout({ kind = 'info', title, children, icon }) {
  return (
    <div className={`callout ${kind}`}>
      <Icon name={icon || (kind === 'info' ? 'info' : kind === 'positive' ? 'check' : 'alert')} />
      <div className="grow">
        {title && <div className="bold">{title}</div>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

export function Dropdown({ trigger, children, align = 'left', placement = 'down', width }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const on = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {trigger({ open, toggle: () => setOpen(!open) })}
      {open && (
        <div
          className="card"
          style={{ position: 'absolute', [align]: 0, [placement === 'up' ? 'bottom' : 'top']: 'calc(100% + 4px)', minWidth: 220, width, zIndex: 50, padding: 4 }}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, danger }) {
  return (
    <button className="btn ghost sm" style={{ width: '100%', justifyContent: 'flex-start', color: danger ? 'var(--negative-text)' : undefined }} onClick={onClick}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
