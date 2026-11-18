// The lists of the console: searched, reloaded and paged. The state of a list lives in the url
// (a filtered page can be bookmarked and shared); lists the server pages are asked page by page,
// lists already in memory are paged here.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from './router.jsx';
import { fmtNumber } from './lib.js';
import { Icon } from './ui.jsx';

const SIZES = [10, 25, 50, 100];

// search, page and page size of a list, in the url under a prefix (several lists on a page)
export function usePaging({ prefix = '', size = 25 } = {}) {
  const [params, setParams] = useQuery();
  const k = (n) => (prefix ? `${prefix}_${n}` : n);
  const q = params.get(k('q')) || '';
  const asked = parseInt(params.get(k('size')), 10);
  const limit = SIZES.includes(asked) ? asked : size;
  const page = Math.max(1, parseInt(params.get(k('page')), 10) || 1);
  const offset = (page - 1) * limit;
  return {
    q,
    limit,
    page,
    offset,
    setQ: (v) => setParams({ [k('q')]: v, [k('page')]: null }),
    setPage: (p) => setParams({ [k('page')]: p > 1 ? p : null }),
    setSize: (s) => setParams({ [k('size')]: s === size ? null : s, [k('page')]: null }),
    // the query string of a server-paged list
    query: `limit=${limit}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    key: `${q}|${limit}|${offset}`,
  };
}

// a list already in memory, searched and paged the same way
export function useLocalPaging(items, { prefix = '', size = 25, text = (x) => JSON.stringify(x) } = {}) {
  const paging = usePaging({ prefix, size });
  const filtered = useMemo(() => {
    const words = paging.q.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? (items || []).filter((x) => words.every((w) => text(x).toLowerCase().includes(w))) : items || [];
  }, [items, paging.q]);
  return { ...paging, total: filtered.length, items: filtered.slice(paging.offset, paging.offset + paging.limit) };
}

export function SearchInput({ value, onChange, placeholder = 'search' }) {
  const [text, setText] = useState(value);
  const timer = useRef(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const change = (v) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(v), 300);
  };
  return (
    <div className="search-input">
      <Icon name="search" size={14} />
      <input value={text} onChange={(e) => change(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {text && (
        <button type="button" className="btn ghost xs icon" onClick={() => change('')} aria-label="clear the search">
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

export function ReloadButton({ onReload, loading }) {
  return (
    <button type="button" className="btn sm" onClick={onReload} disabled={loading} title="reload">
      <Icon name="refresh" className={loading ? 'spinning' : ''} /> Reload
    </button>
  );
}

// search, the filters of the list, and reload
export function ListToolbar({ paging, placeholder, onReload, loading, children }) {
  return (
    <div className="list-toolbar">
      {paging && <SearchInput value={paging.q} onChange={paging.setQ} placeholder={placeholder} />}
      {children}
      <span className="grow" />
      {onReload && <ReloadButton onReload={onReload} loading={loading} />}
    </div>
  );
}

export function Pager({ paging, total, sizes = SIZES }) {
  if (total === undefined || total === null) return null;
  const pages = Math.max(1, Math.ceil(total / paging.limit));
  const from = total ? paging.offset + 1 : 0;
  const to = Math.min(paging.offset + paging.limit, total);
  return (
    <div className="pager">
      <span className="muted small">
        {fmtNumber(from)}–{fmtNumber(to)} of {fmtNumber(total)}
      </span>
      <span className="grow" />
      <label className="row muted small" style={{ gap: 6 }}>
        per page
        <select className="select sm" value={paging.limit} onChange={(e) => paging.setSize(parseInt(e.target.value, 10))} aria-label="page size">
          {sizes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn sm icon" disabled={paging.page <= 1} onClick={() => paging.setPage(paging.page - 1)} aria-label="previous page">
        <Icon name="left" />
      </button>
      <span className="small" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {paging.page} / {pages}
      </span>
      <button type="button" className="btn sm icon" disabled={paging.page >= pages} onClick={() => paging.setPage(paging.page + 1)} aria-label="next page">
        <Icon name="right" />
      </button>
    </div>
  );
}

// a small pager for a widget (state of its own, not in the url)
export function MiniPager({ page, pages, onPage, from, to, total }) {
  if (pages <= 1) return null;
  return (
    <div className="row small muted" style={{ marginTop: 10 }}>
      <span className="grow" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {from}–{to} of {total}
      </span>
      <button type="button" className="btn xs icon" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="previous page">
        <Icon name="left" size={12} />
      </button>
      <button type="button" className="btn xs icon" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="next page">
        <Icon name="right" size={12} />
      </button>
    </div>
  );
}
