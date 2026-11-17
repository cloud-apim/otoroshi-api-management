import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import './backoffice.css';
import { initTheme } from '../shared/lib.js';
import { RouterProvider, Switch, useRouter } from '../shared/router.jsx';
import { ConfirmProvider, Loading, ToastProvider, errorMessage, Field, Input } from '../shared/ui.jsx';
import { api, SessionCtx } from './context.jsx';
import { Layout } from './layout.jsx';
import { Home } from './pages/Home.jsx';
import { ApisPage } from './pages/Apis.jsx';
import { ApiPage } from './pages/api/ApiPage.jsx';
import { ApplicationsPage, ApplicationPage } from './pages/Applications.jsx';
import { ObservabilityPage } from './pages/Observability.jsx';
import { AuditPage } from './pages/Audit.jsx';
import { WorkspaceSettingsPage } from './pages/WorkspaceSettings.jsx';
import { GatewayPage } from './pages/Gateway.jsx';
import { GlobalSettingsPage } from './pages/GlobalSettings.jsx';
import { SubscriptionsPage } from './pages/Subscriptions.jsx';

initTheme();

const LAST_WS = 'apim.workspace';

function Login({ onLogged }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
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
      <form className="card" onSubmit={submit}>
        <div className="card-body col gap-16">
          <div className="brand" style={{ padding: 0 }}>
            <div className="brand-mark">O</div>
            <div>
              <div className="brand-name">API Management</div>
              <div className="brand-sub">for Otoroshi</div>
            </div>
          </div>
          <h1>Sign in to the console</h1>
          <Field label="Email">
            <Input type="email" autoComplete="username" value={email} onChange={setEmail} autoFocus required />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" value={password} onChange={setPassword} required />
          </Field>
          {error && <div className="callout negative">{error}</div>}
          <button className="btn primary" disabled={busy} type="submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="faint small">Bootstrap administrators are declared by environment variable (APIM_BOOTSTRAP_ADMINS).</p>
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

  // the workspace is a session selector in the console (D-20), carried by the url
  const m = /^\/ws\/([^/]+)/.exec(path);
  const wsSlug = m?.[1];
  const workspaces = me.workspaces || [];
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
  const workspace = workspaces.find((w) => w.slug === wsSlug) || null;
  if (workspace) {
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
            ['/ws/:ws/applications', () => <ApplicationsPage />],
            ['/ws/:ws/applications/:app', (p) => <ApplicationPage id={p.app} />],
            ['/ws/:ws/subscriptions', () => <SubscriptionsPage />],
            ['/ws/:ws/observability', () => <ObservabilityPage />],
            ['/ws/:ws/audit', () => <AuditPage />],
            ['/ws/:ws/settings', () => <WorkspaceSettingsPage tab="general" />],
            ['/ws/:ws/settings/:tab', (p) => <WorkspaceSettingsPage tab={p.tab} />],
            ['/gateway', () => <GatewayPage tab="status" />],
            ['/gateway/:tab', (p) => <GatewayPage tab={p.tab} />],
            ['/settings', () => <GlobalSettingsPage tab="workspaces" />],
            ['/settings/:tab', (p) => <GlobalSettingsPage tab={p.tab} />],
          ]}
          fallback={
            <div className="page">
              <div className="empty">
                <h3>{workspaces.length ? 'Page not found' : 'You are not a member of any workspace'}</h3>
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
