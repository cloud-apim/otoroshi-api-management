// the language first: every module reads its texts in it
import './boot-i18n.js';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import './backoffice.css';
import { initTheme } from '../shared/lib.js';
import { RouterProvider, Switch, useRouter } from '../shared/router.jsx';
import { ConfirmProvider, Loading, ToastProvider, errorMessage, Field, Input } from '../shared/ui.jsx';
import { ThemeSwitch } from '../shared/theme-switch.jsx';
import { api, SessionCtx } from './context.jsx';
import { Layout } from './layout.jsx';
import { Home } from './pages/Home.jsx';
import { ApisPage } from './pages/Apis.jsx';
import { ApiPage } from './pages/api/ApiPage.jsx';
import { ApplicationsPage, ApplicationPage } from './pages/Applications.jsx';
import { ObservabilityPage } from './pages/Observability.jsx';
import { AuditPage } from './pages/Audit.jsx';
import { NotificationsPage } from './pages/Notifications.jsx';
import { WorkspaceSettingsPage } from './pages/WorkspaceSettings.jsx';
import { PortalPage } from './pages/Portal.jsx';
import { GatewayPage } from './pages/Gateway.jsx';
import { GlobalSettingsPage } from './pages/GlobalSettings.jsx';
import { SubscriptionsPage } from './pages/Subscriptions.jsx';
import { PolicyGroupsPage, PolicyGroupPage } from './pages/PolicyGroups.jsx';
import { DictionariesPage, DictionaryPage } from './pages/Dictionaries.jsx';
import { SharedResourcesPage, SharedResourcePage } from './pages/SharedResources.jsx';
import { tr, Tr } from '../shared/i18n.jsx';

initTheme();

const LAST_WS = 'apim.workspace';

// an address that moved, kept working
function Redirect({ to }) {
  const { navigate } = useRouter();
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return <Loading />;
}

// a consumer signed in to the console: its place is the developer portal of its workspaces
function PortalsOnly({ user, portals, onSignedOut }) {
  return (
    <div className="login">
      <div className="login-theme">
        <ThemeSwitch />
      </div>
      <div className="card" style={{ maxWidth: 460 }}>
        <div className="card-body col gap-16">
          <div className="brand" style={{ padding: 0 }}>
            <div className="brand-mark">{tr('O')}</div>
            <div>
              <div className="brand-name">{tr('API Management')}</div>
              <div className="brand-sub">{tr('for Otoroshi')}</div>
            </div>
          </div>
          <h2 style={{ margin: 0 }}>{tr('Your place is the developer portal')}</h2>
          <p className="muted small" style={{ margin: 0 }}>
            <Tr text={'The console is for the administrators and the producers of a workspace. {0}, you use the APIs of {1} from{2} developer portal: your applications, your keys, your consumption.'} args={[user.name || user.email, portals.length > 1 ? tr('these workspaces') : tr('this workspace'), portals.length > 1 ? tr(' their') : tr(' its')]} />
          </p>
          <div className="col gap-6">
            {portals.map((w) => (
              <a key={w.id} className="btn primary" href={w.portal_url}>
                <Tr text={'{0} — developer portal'} args={[w.name]} />
              </a>
            ))}
          </div>
          <button
            className="btn ghost"
            onClick={async () => {
              await api.post('/auth/logout').catch(() => {});
              onSignedOut();
            }}
          >
            {tr('Sign out')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Login({ onLogged }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get('error'));
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState({ local: true, oidc: null, mode: 'local' });
  useEffect(() => {
    api.get('/auth/config').then(setAuth).catch(() => {});
  }, []);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email, password });
      onLogged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <div className="login-theme">
        <ThemeSwitch />
      </div>
      <form className="card" onSubmit={submit}>
        <div className="card-body col gap-16">
          <div className="brand" style={{ padding: 0 }}>
            <div className="brand-mark">{tr('O')}</div>
            <div>
              <div className="brand-name">{tr('API Management')}</div>
              <div className="brand-sub">{tr('for Otoroshi')}</div>
            </div>
          </div>
          <h1>{tr('Sign in to the console')}</h1>
          {auth.mode === 'otoroshi' && (
            <div className="callout warning">{tr('Authentication is delegated to Otoroshi: open the console through the gateway route that protects it.')}</div>
          )}
          {auth.oidc && (
            <a className="btn primary" href="/backoffice/api/auth/oidc/login">
              <Tr text={'Continue with {0}'} args={[auth.oidc.label]} />
            </a>
          )}
          {auth.oidc && auth.local && <div className="center faint small">{tr('or with a local account')}</div>}
          {auth.local && (
          <>
          <Field label={tr('Email')}>
            <Input type="email" autoComplete="username" value={email} onChange={setEmail} autoFocus required />
          </Field>
          <Field label={tr('Password')}>
            <Input type="password" autoComplete="current-password" value={password} onChange={setPassword} required />
          </Field>
          <button className={`btn ${auth.oidc ? '' : 'primary'}`} disabled={busy} type="submit">
            {busy ? tr('Signing in…') : tr('Sign in')}
          </button>
          </>
          )}
          {error && <div className="callout negative">{error}</div>}
          <p className="faint small">{tr('Bootstrap administrators are declared by environment variable (APIM_BOOTSTRAP_ADMINS) and keep a local entry that depends on nothing.')}</p>
        </div>
      </form>
    </div>
  );
}

function App() {
  const [me, setMe] = useState(undefined);
  const { path, navigate } = useRouter();
  const load = () =>
    api
      .get('/me')
      .then(setMe)
      .catch(() => setMe(null));
  useEffect(() => {
    load();
  }, []);
  if (me === undefined) return <Loading />;
  if (me === null) return <Login onLogged={load} />;

  // the workspace is a session selector in the console, carried by the url; the console is for
  // the administrators and producers of a workspace — a consumer's place is the portal
  const m = /^\/ws\/([^/]+)/.exec(path);
  const wsSlug = m?.[1];
  const workspaces = (me.workspaces || []).filter((w) => ['admin', 'producer'].includes(w.role));
  const portals = (me.workspaces || []).filter((w) => !['admin', 'producer'].includes(w.role));
  if (!me.user.is_admin && !workspaces.length && portals.length) return <PortalsOnly user={me.user} portals={portals} onSignedOut={load} />;
  if (!wsSlug && (path === '/' || path === '')) {
    let last = null;
    try {
      last = localStorage.getItem(LAST_WS);
    } catch (e) {}
    const target = workspaces.find((w) => w.slug === last) || workspaces[0];
    if (target) {
      setTimeout(() => navigate(`/ws/${target.slug}`, { replace: true }));
      return <Loading />;
    }
  }
  // installation-level pages (gateway, global settings) keep the last workspace as context
  let lastWs = null;
  try {
    lastWs = localStorage.getItem(LAST_WS);
  } catch (e) {}
  const workspace = workspaces.find((w) => w.slug === wsSlug) || (!wsSlug ? workspaces.find((w) => w.slug === lastWs) || workspaces[0] : null) || null;
  if (workspace && wsSlug) {
    try {
      localStorage.setItem(LAST_WS, workspace.slug);
    } catch (e) {}
  }
  const session = { me, user: me.user, workspaces, workspace, reload: load };
  return (
    <SessionCtx.Provider value={session}>
      <Layout>
        <Switch
          routes={[
            ['/ws/:ws', () => <Home />],
            ['/ws/:ws/apis', () => <ApisPage />],
            ['/ws/:ws/apis/:api', (p) => <ApiPage id={p.api} tab="overview" />],
            ['/ws/:ws/apis/:api/:tab', (p) => <ApiPage id={p.api} tab={p.tab} />],
            ['/ws/:ws/policy-groups', () => <PolicyGroupsPage />],
            ['/ws/:ws/policy-groups/:pg', (p) => <PolicyGroupPage id={p.pg} />],
            ['/ws/:ws/shared-resources', () => <SharedResourcesPage />],
            ['/ws/:ws/shared-resources/:res', (p) => <SharedResourcePage id={p.res} />],
            ['/ws/:ws/dictionaries', () => <DictionariesPage />],
            ['/ws/:ws/dictionaries/:d', (p) => <DictionaryPage id={p.d} />],
            ['/ws/:ws/applications', () => <ApplicationsPage />],
            ['/ws/:ws/applications/:app', (p) => <ApplicationPage id={p.app} />],
            ['/ws/:ws/subscriptions', () => <SubscriptionsPage />],
            ['/ws/:ws/observability', () => <ObservabilityPage />],
            ['/ws/:ws/audit', () => <AuditPage />],
            ['/ws/:ws/notifications', () => <NotificationsPage />],
            ['/ws/:ws/portal', () => <PortalPage section="overview" />],
            ['/ws/:ws/portal/:section', (p) => <PortalPage section={p.section} />],
            ['/ws/:ws/settings', () => <WorkspaceSettingsPage tab="general" />],
            ['/ws/:ws/settings/portal', (p) => <Redirect to={`/ws/${p.ws}/portal/settings`} />],
            ['/ws/:ws/settings/:tab', (p) => <WorkspaceSettingsPage tab={p.tab} />],
            ['/gateway', () => <GatewayPage tab="status" />],
            ['/gateway/:tab', (p) => <GatewayPage tab={p.tab} />],
            ['/settings', () => <GlobalSettingsPage tab="workspaces" />],
            ['/settings/:tab', (p) => <GlobalSettingsPage tab={p.tab} />],
          ]}
          fallback={
            <div className="page">
              <div className="empty">
                <h3>{workspaces.length ? tr('Page not found') : tr('You are not a member of any workspace')}</h3>
              </div>
            </div>
          }
        />
      </Layout>
    </SessionCtx.Provider>
  );
}

createRoot(document.getElementById('root')).render(
  <RouterProvider base="/backoffice">
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </RouterProvider>
);
