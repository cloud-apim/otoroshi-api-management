import React, { useEffect, useState } from 'react';
import { Link, Switch as Routes, useRouter } from '../shared/router.jsx';
import { Icon, Loading, ErrorBox, Dropdown, MenuItem } from '../shared/ui.jsx';
import { getThemePref, setThemePref } from '../shared/lib.js';
import { api, usePortal } from './context.jsx';
import { I18nProvider, useI18n, usePortalText, UI_LANGUAGES } from './i18n.jsx';
import { Home } from './pages/Home.jsx';
import { Catalogue } from './pages/Catalogue.jsx';
import { ApiPage } from './pages/ApiPage.jsx';
import { SignIn, SignUp } from './pages/Auth.jsx';
import { Apps, AppDetail } from './pages/Apps.jsx';
import { Usage } from './pages/Usage.jsx';
import { Teams } from './pages/Teams.jsx';

export function App() {
  const portal = usePortal();
  if (portal.loading && !portal.portal) return <Loading />;
  if (portal.error && !portal.portal)
    return (
      <div className="pt-container" style={{ paddingTop: 60 }}>
        <ErrorBox error={portal.error} onRetry={portal.reload} />
      </div>
    );
  return (
    <I18nProvider defaultLanguage={portal.portal?.defaultLanguage || 'en'}>
      <Shell />
    </I18nProvider>
  );
}

function ThemeMenu() {
  const { t } = useI18n();
  const [pref, setPref] = useState(getThemePref());
  const icon = pref === 'dark' ? 'moon' : pref === 'light' ? 'sun' : 'monitor';
  return (
    <Dropdown
      align="right"
      trigger={({ toggle }) => (
        <button className="btn ghost sm icon" onClick={toggle} aria-label={t('theme.label')} title={t('theme.label')}>
          <Icon name={icon} />
        </button>
      )}
    >
      {['light', 'dark', 'system'].map((p) => (
        <MenuItem
          key={p}
          icon={p === 'dark' ? 'moon' : p === 'light' ? 'sun' : 'monitor'}
          onClick={() => {
            setThemePref(p);
            setPref(p);
          }}
        >
          <span className="grow" style={{ textAlign: 'left' }}>
            {t(`theme.${p}`)}
          </span>
          {pref === p && <Icon name="check" />}
        </MenuItem>
      ))}
    </Dropdown>
  );
}

function LangMenu() {
  const { lang, setLang, t } = useI18n();
  return (
    <label className="pt-lang" title={t('lang.label')}>
      <span className="sr-only">{t('lang.label')}</span>
      <Icon name="globe" />
      <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label={t('lang.label')}>
        {UI_LANGUAGES.map((l) => (
          <option key={l.value} value={l.value}>
            {l.value.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  );
}

// what happened to my subscriptions (systematic notification)
function NotificationsMenu() {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const [data, setData] = useState({ unread: 0, items: [] });
  const load = () => api.get('/notifications').then(setData).catch(() => {});
  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Dropdown
      align="right"
      trigger={({ toggle }) => (
        <button
          className="btn ghost sm icon"
          style={{ position: 'relative' }}
          aria-label={`${t('notif.title')}${data.unread ? ` (${data.unread})` : ''}`}
          onClick={() => {
            toggle();
            if (data.unread) api.post('/notifications/read').then(load);
          }}
        >
          <Icon name="inbox" />
          {data.unread > 0 && (
            <span style={{ position: 'absolute', top: 2, right: 2, width: 8, height: 8, borderRadius: '50%', background: 'var(--negative)' }} aria-hidden="true" />
          )}
        </button>
      )}
    >
      <div style={{ width: 320, maxHeight: 360, overflow: 'auto' }}>
        {data.items.length ? (
          data.items.slice(0, 15).map((n) => (
            <button key={n.id} className="btn ghost sm" style={{ width: '100%', height: 'auto', padding: '8px 10px', justifyContent: 'flex-start', textAlign: 'left', whiteSpace: 'normal' }} onClick={() => n.link && navigate(n.link)}>
              <span className="col gap-4" style={{ alignItems: 'flex-start' }}>
                <span className={n.read_at ? '' : 'bold'}>{n.title}</span>
                {n.body && <span className="faint tiny">{n.body}</span>}
              </span>
            </button>
          ))
        ) : (
          <div className="muted small" style={{ padding: 10 }}>
            {t('notif.empty')}
          </div>
        )}
      </div>
    </Dropdown>
  );
}

function UserMenu() {
  const { user, signOut } = usePortal();
  const { t } = useI18n();
  const { navigate } = useRouter();
  if (!user)
    return (
      <div className="row gap-6">
        <Link to="/signin" className="btn ghost sm">
          {t('nav.signin')}
        </Link>
        <Link to="/signup" className="btn primary sm pt-hide-sm">
          {t('nav.signup')}
        </Link>
      </div>
    );
  const initials = (user.name || user.email).slice(0, 2).toUpperCase();
  return (
    <Dropdown
      align="right"
      trigger={({ toggle, open }) => (
        <button className="pt-avatar" onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label={user.email}>
          {initials}
        </button>
      )}
    >
      <div style={{ padding: '8px 10px 10px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
        <div className="bold ellipsis">{user.name}</div>
        <div className="muted small ellipsis">{user.email}</div>
      </div>
      <MenuItem icon="apps" onClick={() => navigate('/apps')}>
        {t('nav.apps')}
      </MenuItem>
      <MenuItem icon="chart" onClick={() => navigate('/usage')}>
        {t('nav.usage')}
      </MenuItem>
      <MenuItem icon="users" onClick={() => navigate('/teams')}>
        {t('nav.teams')}
      </MenuItem>
      <MenuItem
        icon="logout"
        onClick={async () => {
          await signOut();
          navigate('/');
        }}
      >
        {t('nav.signout')}
      </MenuItem>
    </Dropdown>
  );
}

function NavLink({ to, children, onClick }) {
  const { path } = useRouter();
  const on = to === '/' ? path === '/' : path === to || path.startsWith(to + '/');
  return (
    <Link to={to} className={`pt-navlink ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined} onClick={onClick}>
      {children}
    </Link>
  );
}

function Shell() {
  const { portal, workspace, user } = usePortal();
  const portalText = usePortalText(portal);
  const title = portalText(portal?.title);
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  const { t } = useI18n();
  const [menu, setMenu] = useState(false);
  const close = () => setMenu(false);
  return (
    <div className="pt-app">
      <a href="#main" className="pt-skip">
        Skip to content
      </a>
      <header className="pt-topbar">
        <div className="pt-container pt-topbar-inner">
          <Link to="/" className="pt-brand" onClick={close}>
            {portal?.logoUrl ? <img src={portal.logoUrl} alt="" className="pt-logo" /> : <span className="pt-mark" aria-hidden="true">{(workspace?.name || 'A').slice(0, 1)}</span>}
            <span className="pt-brand-name">{title || workspace?.name}</span>
          </Link>
          <nav className={`pt-nav ${menu ? 'open' : ''}`} aria-label="main">
            <NavLink to="/apis" onClick={close}>
              {t('nav.apis')}
            </NavLink>
            {user && (
              <>
                <NavLink to="/apps" onClick={close}>
                  {t('nav.apps')}
                </NavLink>
                <NavLink to="/usage" onClick={close}>
                  {t('nav.usage')}
                </NavLink>
              </>
            )}
          </nav>
          <div className="spacer" />
          <div className="row gap-6">
            {user && <NotificationsMenu />}
            <LangMenu />
            <ThemeMenu />
            <UserMenu />
            <button className="btn ghost sm icon pt-menu-btn" onClick={() => setMenu(!menu)} aria-label={t('nav.menu')} aria-expanded={menu}>
              <Icon name="menu" />
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="pt-main">
        <Routes
          routes={[
            ['/', () => <Home />],
            ['/apis', () => <Catalogue />],
            ['/apis/:api', (p) => <ApiPage id={p.api} tab="overview" />],
            ['/apis/:api/docs', (p) => <ApiPage id={p.api} tab="docs" />],
            ['/apis/:api/docs/:page', (p) => <ApiPage id={p.api} tab="docs" page={p.page} />],
            ['/apis/:api/reference', (p) => <ApiPage id={p.api} tab="reference" />],
            ['/apis/:api/plans', (p) => <ApiPage id={p.api} tab="plans" />],
            ['/signin', () => <SignIn />],
            ['/signup', () => <SignUp />],
            ['/apps', () => <Apps />],
            ['/apps/:app', (p) => <AppDetail id={p.app} />],
            ['/usage', () => <Usage />],
            ['/teams', () => <Teams />],
          ]}
          fallback={
            <div className="pt-container pt-section">
              <div className="empty">
                <h3>404</h3>
                <Link to="/" className="link">
                  {t('common.back')}
                </Link>
              </div>
            </div>
          }
        />
      </main>
      <footer className="pt-footer">
        <div className="pt-container row">
          <span className="faint small">
            © {new Date().getFullYear()} {workspace?.name}
          </span>
          <span className="spacer" />
          <span className="faint small">{t('footer.powered')}</span>
        </div>
      </footer>
    </div>
  );
}
