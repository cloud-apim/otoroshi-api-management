// The lists of the console: searched, reloaded and paged. The state of a list lives in the url
// (a filtered page can be bookmarked and shared); lists the server pages are asked page by page,
// lists already in memory are paged here.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from './router.jsx';
import { fmtNumber } from './lib.js';
import { Icon } from './ui.jsx';
import { tr, Tr } from './i18n.jsx';

const SIZES = [10, 25, 50, 100];

// search, page and page size of a list, in the url under a prefix (several lists on a page) — or,
// with `local`, in the state of the component: a list in a modal or a drawer leaves the url alone
export function usePaging({ prefix = '', size = 25, local = false } = {}) {
  const [params, setParams] = useQuery();
  const [own, setOwn] = useState({});
  const k = (n) => (prefix ? `${prefix}_${n}` : n);
  const get = (n) => (local ? own[n] : params.get(k(n)));
  const set = (patch) => (local ? setOwn((x) => ({ ...x, ...patch })) : setParams(Object.fromEntries(Object.entries(patch).map(([n, v]) => [k(n), v]))));
  const q = get('q') || '';
  const asked = parseInt(get('size'), 10);
  const limit = SIZES.includes(asked) ? asked : size;
  const page = Math.max(1, parseInt(get('page'), 10) || 1);
  const offset = (page - 1) * limit;
  return {
    q,
    limit,
    page,
    offset,
    setQ: (v) => set({ q: v, page: null }),
    setPage: (p) => set({ page: p > 1 ? p : null }),
    setSize: (s) => set({ size: s === size ? null : s, page: null }),
    // the query string of a server-paged list
    query: `limit=${limit}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    key: `${q}|${limit}|${offset}`,
  };
}

// a list already in memory, searched and paged the same way
export function useLocalPaging(items, { prefix = '', size = 25, local = false, text = (x) => JSON.stringify(x) } = {}) {
  const paging = usePaging({ prefix, size, local });
  const filtered = useMemo(() => {
    const words = paging.q.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? (items || []).filter((x) => words.every((w) => text(x).toLowerCase().includes(w))) : items || [];
  }, [items, paging.q]);
  // a removal, or a shorter list, leaves the page past the last one: back to the last page
  useEffect(() => {
    const last = Math.max(1, Math.ceil(filtered.length / paging.limit));
    if (filtered.length && paging.page > last) paging.setPage(last);
  }, [filtered.length, paging.limit, paging.page]);
  return { ...paging, total: filtered.length, items: filtered.slice(paging.offset, paging.offset + paging.limit) };
}

export function SearchInput({ value, onChange, placeholder = tr('search') }) {
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
        <button type="button" className="btn ghost xs icon" onClick={() => change('')} aria-label={tr('clear the search')}>
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

export function ReloadButton({ onReload, loading }) {
  return (
    <button type="button" className="btn sm" onClick={onReload} disabled={loading} title={tr('reload')}>
      <Icon name="refresh" className={loading ? 'spinning' : ''} /> {tr('Reload')}
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
  // nothing to page: the empty state of the list says why
  if (!total) return null;
  const pages = Math.max(1, Math.ceil(total / paging.limit));
  const from = total ? paging.offset + 1 : 0;
  const to = Math.min(paging.offset + paging.limit, total);
  return (
    <div className="pager">
      <span className="muted small">
        <Tr text={'{0}–{1} of {2}'} args={[fmtNumber(from), fmtNumber(to), fmtNumber(total)]} />
      </span>
      <span className="grow" />
      <label className="row muted small" style={{ gap: 6 }}>
        <Tr text={'per page{0}'} args={[<select className="select sm" value={paging.limit} onChange={(e) => paging.setSize(parseInt(e.target.value, 10))} aria-label={tr('page size')}>
          {sizes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>]} />
      </label>
      <button type="button" className="btn sm icon" disabled={paging.page <= 1} onClick={() => paging.setPage(paging.page - 1)} aria-label={tr('previous page')}>
        <Icon name="left" />
      </button>
      <span className="small" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {paging.page} / {pages}
      </span>
      <button type="button" className="btn sm icon" disabled={paging.page >= pages} onClick={() => paging.setPage(paging.page + 1)} aria-label={tr('next page')}>
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
        <Tr text={'{0}–{1} of {2}'} args={[from, to, total]} />
      </span>
      <button type="button" className="btn xs icon" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={tr('previous page')}>
        <Icon name="left" size={12} />
      </button>
      <button type="button" className="btn xs icon" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={tr('next page')}>
        <Icon name="right" size={12} />
      </button>
    </div>
  );
}
