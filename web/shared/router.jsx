// A tiny pushState router with a base path. Filters live in the url (AI Studio precedent): a
// filtered view can be bookmarked and shared.
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

const RouterCtx = createContext(null);

export function RouterProvider({ base = '', children }) {
  const read = () => {
    const p = window.location.pathname;
    return { path: p.startsWith(base) ? p.slice(base.length) || '/' : p, search: window.location.search };
  };
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const navigate = useCallback(
    (to, { replace = false } = {}) => {
      const url = to.startsWith('http') ? to : `${base}${to}`;
      if (replace) window.history.replaceState({}, '', url);
      else window.history.pushState({}, '', url);
      setLoc(read());
      if (!replace) window.scrollTo(0, 0);
    },
    [base]
  );
  return <RouterCtx.Provider value={{ ...loc, base, navigate }}>{children}</RouterCtx.Provider>;
}

export function useRouter() {
  return useContext(RouterCtx);
}

export function useQuery() {
  const { search, path, navigate } = useRouter();
  const params = new URLSearchParams(search);
  const set = (patch) => {
    const next = new URLSearchParams(search);
    Object.entries(patch).forEach(([k, v]) => {
      if (v === null || v === undefined || v === '') next.delete(k);
      else next.set(k, v);
    });
    const s = next.toString();
    navigate(`${path}${s ? `?${s}` : ''}`, { replace: true });
  };
  return [params, set];
}

export function matchPath(pattern, path) {
  const keys = [];
  const re = new RegExp(
    '^' +
      pattern
        .split('/')
        .map((p) => {
          if (p === '*') {
            keys.push('rest');
            return '(.*)';
          }
          if (p.startsWith(':')) {
            keys.push(p.slice(1));
            return '([^/]+)';
          }
          return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '/?$'
  );
  const m = re.exec(path);
  if (!m) return null;
  const params = {};
  keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] || '')));
  return params;
}

export function Link({ to, children, className, onClick, ...rest }) {
  const { base, navigate } = useRouter();
  return (
    <a
      href={`${base}${to}`}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onClick?.(e);
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

// renders the first matching route: routes = [[pattern, (params) => element], ...]
export function Switch({ routes, fallback = null }) {
  const { path } = useRouter();
  for (const [pattern, render] of routes) {
    const params = matchPath(pattern, path);
    if (params) return render(params);
  }
  return fallback;
}
