import React, { useEffect, useRef, useState } from 'react';
import { Link, useRouter } from '../shared/router.jsx';
import { Dropdown, Icon, MenuItem, Modal } from '../shared/ui.jsx';
import { ThemeSwitch } from '../shared/theme-switch.jsx';
import { fmtRelative } from '../shared/lib.js';
import { api, useSession, wsApi } from './context.jsx';
import { chooseLanguage, language, LANGUAGES, tr, Tr } from '../shared/i18n.jsx';

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
          { kind: 'page', name: tr('Home'), to: `/ws/${ws}` },
          { kind: 'page', name: tr('APIs'), to: `/ws/${ws}/apis` },
          { kind: 'page', name: tr('Applications'), to: `/ws/${ws}/applications` },
          { kind: 'page', name: tr('Subscriptions to review'), to: `/ws/${ws}/subscriptions?status=pending` },
          { kind: 'page', name: tr('Observability'), to: `/ws/${ws}/observability` },
          { kind: 'page', name: tr('Audit'), to: `/ws/${ws}/audit` },
          { kind: 'page', name: tr('Workspace settings'), to: `/ws/${ws}/settings` },
          { kind: 'page', name: tr('Developer portal settings'), to: `/ws/${ws}/settings/portal` },
          { kind: 'page', name: tr('Notifications'), to: `/ws/${ws}/notifications` },
          { kind: 'page', name: tr('Gateway'), to: `/gateway` },
          { kind: 'page', name: tr('Global settings'), to: `/settings` },
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
    <Modal title={tr('Search')} onClose={onClose} size="palette">
      <input
        className="input"
        autoFocus
        placeholder={tr('Search apis, plans, applications, subscriptions, client ids…')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, results.length - 1));
          if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0));
          if (e.key === 'Enter' && results[sel]) go(results[sel]);
        }}
        aria-label={tr('search')}
      />
      <div style={{ maxHeight: 380, overflow: 'auto' }}>
        {results.map((r, i) => (
          <div key={i} className={`palette-item ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => go(r)}>
            <span className="badge">{tr(r.kind)}</span>
            <span className="grow ellipsis">{r.name}</span>
          </div>
        ))}
        {!results.length && <div className="muted small" style={{ padding: 12 }}>{tr('No result')}</div>}
      </div>
    </Modal>
  );
}

// in-app notifications of the producers (requests to review, transfers to decide), polled. Each
// person reads them and marks them done on their own
export function useNotifications(ws) {
  const [data, setData] = useState({ unread: 0, items: [] });
  const load = () => ws && wsApi(ws).get('/notifications?limit=8').then(setData).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [ws]);
  return {
    ...data,
    reload: load,
    markRead: (ids) => wsApi(ws).post('/notifications/read', ids ? { ids } : {}).then(load),
    markDone: (ids) => wsApi(ws).post('/notifications/done', { ids }).then(load),
  };
}

// the language of the console, remembered in this browser; every text is read again in it
function LanguageSwitch() {
  return (
    <div className="seg" role="radiogroup" aria-label={tr('Language')}>
      {LANGUAGES.map(([l, name]) => (
        <button
          key={l}
          role="radio"
          aria-checked={language() === l}
          className={language() === l ? 'on' : ''}
          title={name}
          onClick={() => {
            if (language() === l) return;
            chooseLanguage(l);
            window.location.reload();
          }}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

// the person signed in: notifications, theme, language, tokens, sign out — one menu at the bottom left
function UserMenu({ user, ws, logout }) {
  const { navigate } = useRouter();
  const notes = useNotifications(ws);
  return (
    <Dropdown
      align="left"
      placement="up"
      width="100%"
      trigger={({ open, toggle }) => (
        <button
          className="ws-switch"
          style={{ border: 0, marginTop: 4 }}
          onClick={toggle}
          aria-label={notes.unread ? tr('user menu, {0} unread notifications', [notes.unread]) : tr('user menu')}
          aria-haspopup="menu"
        >
          <span className="ws-avatar avatar-with-dot" style={{ borderRadius: '50%' }}>
            {user.name.slice(0, 1).toUpperCase()}
            {notes.unread > 0 && <span className="avatar-dot" aria-hidden="true" />}
          </span>
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="bold ellipsis" style={{ display: 'block' }}>
              {user.name}
            </span>
            <span className="tiny faint ellipsis" style={{ display: 'block' }}>
              {user.email}
            </span>
          </span>
          {notes.unread > 0 && <span className="badge warning">{notes.unread}</span>}
        </button>
      )}
    >
      {ws && (
        <div className="menu-section">
          <div className="row menu-title">
            <Icon name="inbox" size={14} />
            <span className="grow">{tr('Notifications')}</span>
            {notes.unread > 0 && (
              <button
                className="btn xs ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  notes.markRead();
                }}
              >
                {tr('Mark all read')}
              </button>
            )}
          </div>
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            {notes.items.length ? (
              notes.items.map((n) => (
                <div key={n.id} className={`menu-note-row ${n.read_at ? '' : 'unread'}`}>
                  <button
                    className="menu-note"
                    onClick={() => {
                      if (!n.read_at) notes.markRead([n.id]);
                      if (n.link) navigate(`/ws/${ws}${n.link}`);
                    }}
                  >
                    <span className={n.read_at ? '' : 'bold'}>{n.title}</span>
                    {n.body && <span className="faint tiny">{n.body}</span>}
                    <span className="faint tiny">{fmtRelative(n.created_at)}</span>
                  </button>
                  <button
                    className="btn xs ghost icon"
                    title={tr('done: out of the list')}
                    aria-label={tr('mark "{0}" done', [n.title])}
                    onClick={(e) => {
                      e.stopPropagation();
                      notes.markDone([n.id]);
                    }}
                  >
                    <Icon name="check" size={14} />
                  </button>
                </div>
              ))
            ) : (
              <div className="muted small" style={{ padding: '6px 10px' }}>
                {tr('Nothing to deal with.')}
              </div>
            )}
          </div>
          <MenuItem icon="inbox" onClick={() => navigate(`/ws/${ws}/notifications`)}>
            <Tr text={'All notifications{0}'} args={[notes.total > notes.items.length ? ` (${notes.total})` : '']} />
          </MenuItem>
        </div>
      )}
      <div className="menu-section row" onClick={(e) => e.stopPropagation()}>
        <span className="small muted grow">{tr('Theme')}</span>
        <ThemeSwitch />
      </div>
      <div className="menu-section row" onClick={(e) => e.stopPropagation()}>
        <span className="small muted grow">{tr('Language')}</span>
        <LanguageSwitch />
      </div>
      <MenuItem icon="key" onClick={() => navigate('/settings/tokens')}>
        {tr('API tokens')}
      </MenuItem>
      <MenuItem icon="logout" onClick={logout}>
        {tr('Sign out')}
      </MenuItem>
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
  const waiting = (st?.queue?.pending || 0) + (st?.queue?.running || 0);
  const failed = st?.queue?.failed || 0;
  const drift = (st?.drift?.drifted || 0) + (st?.drift?.missing || 0);
  // it leads to what needs looking at first: a failed projection, a waiting one, then the drift
  const to = failed ? '/gateway?tasks_status=failed' : waiting ? '/gateway?tasks_status=pending' : drift ? '/gateway/drift' : '/gateway';
  const said = [failed && tr('{0} projection(s) failed', [failed]), waiting && tr('{0} waiting for the gateway', [waiting]), drift && tr('{0} drifted on the gateway', [drift])].filter(Boolean);
  return (
    <Link to={to} className="gw-pill" title={said.length ? said.join(' · ') : tr("the installation's Otoroshi cluster")}>
      <span className={`gw-dot ${st ? (ok ? 'ok' : 'ko') : ''}`} />
      <span className="grow"><Tr text={'Gateway {0}'} args={[st ? (ok ? tr('reachable') : tr('unreachable')) : '…']} /></span>
      {failed > 0 && <span className="badge negative" title={tr('{0} projection(s) failed: open the queue', [failed])}>{failed}</span>}
      {waiting > 0 && <span className="badge warning" title={tr('{0} projection(s) waiting for the gateway', [waiting])}>{waiting}</span>}
      {drift > 0 && <span className="badge negative" title={tr('{0} object(s) drifted on the gateway', [drift])}>{drift}</span>}
    </Link>
  );
}

export function Layout({ children }) {
  const { user, workspaces, workspace, me } = useSession();
  const single = me.installation?.tenancy === 'single';
  const { navigate } = useRouter();
  const [search, setSearch] = useState(false);
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
      <aside className="sidebar" aria-label={tr('main navigation')}>
        {/* the brand leads home: the home of the current workspace */}
        <Link to={ws ? `/ws/${ws}` : '/'} className="brand" aria-label={tr('home')}>
          <div className="brand-mark">{tr('O')}</div>
          <div>
            <div className="brand-name">{tr('API Management')}</div>
            <div className="brand-sub">{tr('Otoroshi')}</div>
          </div>
        </Link>
        {/* the workspace selector opens the sidebar: it sets the context of everything below. A
            single-workspace installation has none */}
        {!single && (workspaces.length > 1 || user.is_admin) ? (
          <Dropdown
            trigger={({ toggle }) => (
              <button className="ws-switch" onClick={toggle} aria-label={tr('switch workspace')}>
                <span className="ws-avatar">{(workspace?.name || '?').slice(0, 1).toUpperCase()}</span>
                <span className="grow">
                  <span className="tiny faint" style={{ display: 'block' }}>
                    {tr('Workspace')}
                  </span>
                  <span className="bold ellipsis" style={{ display: 'block' }}>
                    {workspace?.name || tr('Select…')}
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
                {tr('New workspace')}
              </MenuItem>
            )}
          </Dropdown>
        ) : null}
        <button className="search-trigger" onClick={() => setSearch(true)}>
          <Icon name="search" />
          <span className="grow" style={{ textAlign: 'left' }}>
            {tr('Search')}
          </span>
          <span className="kbd">{tr('⌘K')}</span>
        </button>
        {ws && (
          <>
            <NavLink to={`/ws/${ws}`} icon="home" exact>
              {tr('Home')}
            </NavLink>
            <NavLink to={`/ws/${ws}/apis`} icon="api" count={pending} also={[`/ws/${ws}/policy-groups`]}>
              {tr('APIs')}
            </NavLink>
            <NavLink to={`/ws/${ws}/applications`} icon="apps">
              {tr('Applications')}
            </NavLink>
            <NavLink to={`/ws/${ws}/observability`} icon="chart">
              {tr('Observability')}
            </NavLink>
            <NavLink to={`/ws/${ws}/audit`} icon="audit">
              {tr('Audit')}
            </NavLink>
            <NavLink to={`/ws/${ws}/settings`} icon="settings">
              {tr('Workspace settings')}
            </NavLink>
            <a className="navlink" href={workspace.portal_url} target="_blank" rel="noreferrer">
              <Icon name="external" />
              <span>{tr('Developer portal')}</span>
            </a>
          </>
        )}
        <div className="sidebar-bottom">
          <GatewayPill />
          {user.is_admin && (
            <NavLink to="/settings" icon="settings">
              {tr('Global settings')}
            </NavLink>
          )}
          <UserMenu user={user} ws={ws} logout={logout} />
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
