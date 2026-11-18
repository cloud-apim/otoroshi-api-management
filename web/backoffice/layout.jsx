import React, { useEffect, useRef, useState } from 'react';
import { Link, useRouter } from '../shared/router.jsx';
import { Dropdown, Icon, MenuItem, Modal, Seg } from '../shared/ui.jsx';
import { getThemePref, setThemePref } from '../shared/lib.js';
import { api, useSession, wsApi } from './context.jsx';

function NavLink({ to, icon, children, exact = false, count, also = [] }) {
  const { path } = useRouter();
  const on = exact ? path === to : [to, ...also].some((t) => path === t || path.startsWith(t + '/'));
  return (
    <Link to={to} className={`navlink ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined}>
      <Icon name={icon} />
      <span>{children}</span>
      {count ? <span className="count">{count}</span> : null}
    </Link>
  );
}

// ⌘K: finds workspaces, pages, and objects (apis, plans, applications, subscriptions, credentials)
function SearchPalette({ onClose }) {
  const { workspace, workspaces } = useSession();
  const { navigate } = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [sel, setSel] = useState(0);
  useEffect(() => {
    const ws = workspace?.slug;
    const pages = ws
      ? [
          { kind: 'page', name: 'Home', to: `/ws/${ws}` },
          { kind: 'page', name: 'APIs', to: `/ws/${ws}/apis` },
          { kind: 'page', name: 'Applications', to: `/ws/${ws}/applications` },
          { kind: 'page', name: 'Subscriptions to review', to: `/ws/${ws}/subscriptions?status=pending` },
          { kind: 'page', name: 'Observability', to: `/ws/${ws}/observability` },
          { kind: 'page', name: 'Audit', to: `/ws/${ws}/audit` },
          { kind: 'page', name: 'Workspace settings', to: `/ws/${ws}/settings` },
          { kind: 'page', name: 'Developer portal settings', to: `/ws/${ws}/settings/portal` },
          { kind: 'page', name: 'Gateway', to: `/gateway` },
          { kind: 'page', name: 'Global settings', to: `/settings` },
        ]
      : [];
    const wsItems = workspaces.map((w) => ({ kind: 'workspace', name: w.name, to: `/ws/${w.slug}` }));
    const local = [...pages, ...wsItems].filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase()));
    if (!q || !ws) {
      setResults(local);
      return;
    }
    const t = setTimeout(() => {
      wsApi(ws)
        .get(`/search?q=${encodeURIComponent(q)}`)
        .then((objs) => {
          const mapped = objs.map((o) => {
            if (o.kind === 'api') return { kind: 'api', name: `${o.name} ${o.version}`, to: `/ws/${ws}/apis/${o.id}` };
            if (o.kind === 'plan') return { kind: 'plan', name: `${o.name} — ${o.api_name} ${o.version}`, to: `/ws/${ws}/apis/${o.api_id}/plans` };
            if (o.kind === 'application') return { kind: 'application', name: o.name, to: `/ws/${ws}/applications/${o.id}` };
            if (o.kind === 'subscription') return { kind: 'subscription', name: `${o.app_name} → ${o.api_name} (${o.status})`, to: `/ws/${ws}/subscriptions?open=${o.id}` };
            if (o.kind === 'team') return { kind: 'team', name: o.name, to: `/ws/${ws}/settings/teams` };
            if (o.kind === 'credential') return { kind: 'credential', name: o.client_id, to: `/ws/${ws}/subscriptions?open=${o.id}` };
            return { kind: o.kind, name: o.name || o.id, to: `/ws/${ws}` };
          });
          setResults([...mapped, ...local]);
          setSel(0);
        })
        .catch(() => setResults(local));
    }, 150);
    return () => clearTimeout(t);
  }, [q]);
  const go = (r) => {
    onClose();
    navigate(r.to);
  };
  return (
    <Modal title="Search" onClose={onClose} size="palette">
      <input
        className="input"
        autoFocus
        placeholder="Search apis, plans, applications, subscriptions, client ids…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, results.length - 1));
          if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0));
          if (e.key === 'Enter' && results[sel]) go(results[sel]);
        }}
        aria-label="search"
      />
      <div style={{ maxHeight: 380, overflow: 'auto' }}>
        {results.map((r, i) => (
          <div key={i} className={`palette-item ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => go(r)}>
            <span className="badge">{r.kind}</span>
            <span className="grow ellipsis">{r.name}</span>
          </div>
        ))}
        {!results.length && <div className="muted small" style={{ padding: 12 }}>No result</div>}
      </div>
    </Modal>
  );
}

// in-app notifications of the producers (requests to review, transfers to decide)
function NotificationsBell() {
  const { workspace } = useSession();
  const { navigate } = useRouter();
  const [data, setData] = useState({ unread: 0, items: [] });
  const ws = workspace?.slug;
  const load = () => ws && wsApi(ws).get('/notifications').then(setData).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [ws]);
  if (!ws) return null;
  return (
    <Dropdown
      trigger={({ toggle }) => (
        <button
          className="gw-pill"
          style={{ border: 0, background: 'none', font: 'inherit', cursor: 'pointer', width: '100%' }}
          onClick={() => {
            toggle();
            if (data.unread) wsApi(ws).post('/notifications/read').then(load);
          }}
          aria-label="notifications"
        >
          <Icon name="inbox" />
          <span className="grow" style={{ textAlign: 'left' }}>
            Notifications
          </span>
          {data.unread > 0 && <span className="badge warning">{data.unread}</span>}
        </button>
      )}
    >
      <div style={{ maxHeight: 360, overflow: 'auto', width: 320 }}>
        {data.items.length ? (
          data.items.slice(0, 15).map((n) => (
            <button key={n.id} className="btn ghost sm" style={{ width: '100%', height: 'auto', padding: '8px 10px', justifyContent: 'flex-start', textAlign: 'left', whiteSpace: 'normal' }} onClick={() => n.link && navigate(`/ws/${ws}${n.link}`)}>
              <span className="col gap-4" style={{ alignItems: 'flex-start' }}>
                <span className={n.read_at ? '' : 'bold'}>{n.title}</span>
                {n.body && <span className="faint tiny">{n.body}</span>}
              </span>
            </button>
          ))
        ) : (
          <div className="muted small" style={{ padding: 10 }}>
            Nothing new.
          </div>
        )}
      </div>
    </Dropdown>
  );
}

function GatewayPill() {
  const [st, setSt] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get('/gateway/status')
        .then((s) => alive && setSt(s))
        .catch(() => alive && setSt({ health: { ok: false } }));
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const ok = st?.health?.ok;
  const pending = (st?.queue?.pending || 0) + (st?.queue?.failed || 0);
  const drift = (st?.drift?.drifted || 0) + (st?.drift?.missing || 0);
  return (
    <Link to="/gateway" className="gw-pill" title="the installation's Otoroshi cluster">
      <span className={`gw-dot ${st ? (ok ? 'ok' : 'ko') : ''}`} />
      <span className="grow">Gateway {st ? (ok ? 'reachable' : 'unreachable') : '…'}</span>
      {pending > 0 && <span className="badge warning" title="projections waiting">{pending}</span>}
      {drift > 0 && <span className="badge negative" title="drift detected">{drift}</span>}
    </Link>
  );
}

export function Layout({ children }) {
  const { user, workspaces, workspace } = useSession();
  const { navigate } = useRouter();
  const [search, setSearch] = useState(false);
  const [theme, setTheme] = useState(getThemePref());
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const on = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(true);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  useEffect(() => {
    if (!workspace) return;
    wsApi(workspace.slug)
      .get('/subscriptions?status=pending')
      .then((x) => setPending(x.length))
      .catch(() => {});
  }, [workspace?.slug]);
  const ws = workspace?.slug;
  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    window.location.href = '/backoffice/';
  };
  return (
    <div className="app">
      <aside className="sidebar" aria-label="main navigation">
        <div className="brand">
          <div className="brand-mark">O</div>
          <div>
            <div className="brand-name">API Management</div>
            <div className="brand-sub">Otoroshi</div>
          </div>
        </div>
        {/* the workspace selector opens the sidebar: it sets the context of everything below */}
        {workspaces.length > 1 || user.is_admin ? (
          <Dropdown
            trigger={({ toggle }) => (
              <button className="ws-switch" onClick={toggle} aria-label="switch workspace">
                <span className="ws-avatar">{(workspace?.name || '?').slice(0, 1).toUpperCase()}</span>
                <span className="grow">
                  <span className="tiny faint" style={{ display: 'block' }}>
                    Workspace
                  </span>
                  <span className="bold ellipsis" style={{ display: 'block' }}>
                    {workspace?.name || 'Select…'}
                  </span>
                </span>
                <Icon name="chevronDown" />
              </button>
            )}
          >
            {workspaces.map((w) => (
              <MenuItem key={w.id} icon={w.slug === ws ? 'check' : 'box'} onClick={() => navigate(`/ws/${w.slug}`)}>
                {w.name}
              </MenuItem>
            ))}
            {user.is_admin && (
              <MenuItem icon="plus" onClick={() => navigate('/settings/workspaces')}>
                New workspace
              </MenuItem>
            )}
          </Dropdown>
        ) : null}
        <button className="search-trigger" onClick={() => setSearch(true)}>
          <Icon name="search" />
          <span className="grow" style={{ textAlign: 'left' }}>
            Search
          </span>
          <span className="kbd">⌘K</span>
        </button>
        {ws && (
          <>
            <NavLink to={`/ws/${ws}`} icon="home" exact>
              Home
            </NavLink>
            <NavLink to={`/ws/${ws}/apis`} icon="api" count={pending} also={[`/ws/${ws}/policy-groups`]}>
              APIs
            </NavLink>
            <NavLink to={`/ws/${ws}/applications`} icon="apps">
              Applications
            </NavLink>
            <NavLink to={`/ws/${ws}/observability`} icon="chart">
              Observability
            </NavLink>
            <NavLink to={`/ws/${ws}/audit`} icon="audit">
              Audit
            </NavLink>
            <NavLink to={`/ws/${ws}/settings`} icon="settings">
              Workspace settings
            </NavLink>
            <a className="navlink" href={`/${ws}/`} target="_blank" rel="noreferrer">
              <Icon name="external" />
              <span>Developer portal</span>
            </a>
          </>
        )}
        <div className="sidebar-bottom">
          <NotificationsBell />
          <GatewayPill />
          {user.is_admin && (
            <NavLink to="/settings" icon="settings">
              Global settings
            </NavLink>
          )}
          <Dropdown
            align="left"
            trigger={({ toggle }) => (
              <button className="ws-switch" style={{ border: 0, marginTop: 4 }} onClick={toggle} aria-label="user menu">
                <span className="ws-avatar" style={{ borderRadius: '50%' }}>
                  {user.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="bold ellipsis" style={{ display: 'block' }}>
                    {user.name}
                  </span>
                  <span className="tiny faint ellipsis" style={{ display: 'block' }}>
                    {user.email}
                  </span>
                </span>
              </button>
            )}
          >
            <div style={{ padding: 8 }} onClick={(e) => e.stopPropagation()}>
              <div className="tiny faint mb-8">Theme</div>
              <Seg
                value={theme}
                onChange={(v) => {
                  setTheme(v);
                  setThemePref(v);
                }}
                options={[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                  { value: 'system', label: 'System' },
                ]}
              />
            </div>
            <MenuItem icon="key" onClick={() => navigate('/settings/tokens')}>
              API tokens
            </MenuItem>
            <MenuItem icon="logout" onClick={logout}>
              Sign out
            </MenuItem>
          </Dropdown>
        </div>
      </aside>
      <main className="main">{children}</main>
      {search && <SearchPalette onClose={() => setSearch(false)} />}
    </div>
  );
}

export function PageHead({ title, sub, actions, crumbs }) {
  return (
    <>
      {crumbs && (
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <Icon name="chevronRight" size={12} />}
              {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
            </React.Fragment>
          ))}
        </div>
      )}
      <div className="page-head">
        <div className="grow">
          <h1>{title}</h1>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
    </>
  );
}
