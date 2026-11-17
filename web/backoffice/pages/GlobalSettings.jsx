import React, { useState } from 'react';
import { useRouter } from '../../shared/router.jsx';
import { fmtDate, fmtRelative } from '../../shared/lib.js';
import { Badge, Callout, Code, Field, Icon, Input, Loader, Switch, errorMessage, useLoad, useToast } from '../../shared/ui.jsx';
import { api, useSession } from '../context.jsx';
import { PageHead } from '../layout.jsx';

function Workspaces() {
  const { session } = { session: useSession() };
  const toast = useToast();
  const { navigate } = useRouter();
  const [f, setF] = useState({ name: '', slug: '' });
  const settings = useLoad(() => api.get('/settings'), []);
  return (
    <div className="col gap-16">
      <Loader state={settings}>
        {(s) => (
          <Callout kind="info" title={`Portal exposure: by ${s.portal.exposure === 'path' ? 'root path' : 'hostname'}`}>
            {s.portal.exposure === 'path' ? 'Each workspace portal is served under /<workspace>/.' : `Each workspace portal is served on <workspace>.${s.portal.domain}.`} The pattern holds for the whole installation and changes
            the form of every public url, so it is set at installation time (APIM_PORTAL_EXPOSURE). There is no global portal.
          </Callout>
        )}
      </Loader>
      <div className="card">
        <div className="card-body row wrap">
          <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder="workspace name" />
          <Input value={f.slug} onChange={(v) => setF({ ...f, slug: v })} placeholder="slug (optional)" mono />
          <button
            className="btn primary"
            disabled={!f.name}
            onClick={async () => {
              try {
                const ws = await api.post('/workspaces', f);
                await session.reload();
                navigate(`/ws/${ws.slug}`);
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            Create workspace
          </button>
        </div>
      </div>
      <div className="card">
        {session.workspaces.map((w) => (
          <div key={w.id} className="list-item">
            <span className="ws-avatar">{w.name[0]}</span>
            <div className="grow">
              <div className="bold">{w.name}</div>
              <div className="faint tiny mono">{w.slug}</div>
            </div>
            <a className="link small" href={`/${w.slug}/`} target="_blank" rel="noreferrer">
              portal
            </a>
            <button className="btn sm" onClick={() => navigate(`/ws/${w.slug}`)}>
              Open
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Users() {
  const state = useLoad(() => api.get('/users'), []);
  const toast = useToast();
  const [f, setF] = useState({ email: '', name: '', password: '', is_admin: false });
  return (
    <div className="col gap-16">
      <p className="muted small">Users are global — one record per person, with memberships in several workspaces (D-19). Bootstrap administrators come from APIM_BOOTSTRAP_ADMINS.</p>
      <div className="card">
        <div className="card-body row wrap">
          <Input value={f.email} onChange={(v) => setF({ ...f, email: v })} placeholder="email" />
          <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder="name" />
          <Input value={f.password} onChange={(v) => setF({ ...f, password: v })} placeholder="password" type="password" />
          <Switch checked={f.is_admin} onChange={(v) => setF({ ...f, is_admin: v })} label="admin" />
          <button
            className="btn primary"
            disabled={!f.email}
            onClick={async () => {
              try {
                await api.post('/users', f);
                setF({ email: '', name: '', password: '', is_admin: false });
                state.reload();
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            Create user
          </button>
        </div>
      </div>
      <Loader state={state}>
        {(users) => (
          <div className="card table-wrap">
            <table className="table">
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="bold">{u.name}</div>
                      <div className="faint tiny">{u.email}</div>
                    </td>
                    <td>{u.is_admin && <Badge kind="accent">installation admin</Badge>}</td>
                    <td className="small">
                      {(u.tags || []).map((t) => (
                        <span key={t} className="tag" style={{ marginRight: 4 }}>
                          {t}
                        </span>
                      ))}
                    </td>
                    <td className="muted small">{fmtRelative(u.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Loader>
    </div>
  );
}

// everything the console does replays from the cli with a token (D-28)
function Tokens() {
  const state = useLoad(() => api.get('/me/tokens'), []);
  const toast = useToast();
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);
  return (
    <div className="col gap-16">
      <p className="muted small">Personal tokens for the admin api (/api), the CLI and CI. Every action of the console is an admin api call, so every action replays from them.</p>
      <div className="card">
        <div className="card-body row">
          <Input value={name} onChange={setName} placeholder="token name (e.g. ci)" />
          <button
            className="btn primary"
            onClick={async () => {
              try {
                setCreated(await api.post('/me/tokens', { name }));
                setName('');
                state.reload();
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            Create token
          </button>
        </div>
      </div>
      {created && (
        <Callout kind="positive" title="Copy this token now: it is not shown again">
          <Code>{created.token}</Code>
          <div className="mt-8">
            <Code>{`APIM_URL=${window.location.origin} APIM_TOKEN=${created.token} bun cli/apim.js apis list default`}</Code>
          </div>
        </Callout>
      )}
      <Loader state={state}>
        {(tokens) => (
          <div className="card">
            {tokens.map((t) => (
              <div key={t.id} className="list-item">
                <Icon name="key" />
                <div className="grow">
                  <div className="bold">{t.name}</div>
                  <div className="faint tiny mono">{t.prefix}…</div>
                </div>
                <span className="muted small">created {fmtDate(t.created_at)} · used {t.last_used_at ? fmtRelative(t.last_used_at) : 'never'}</span>
                <button
                  className="btn ghost sm icon"
                  aria-label="revoke"
                  onClick={async () => {
                    await api.del(`/me/tokens/${t.id}`);
                    state.reload();
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Loader>
    </div>
  );
}

export function GlobalSettingsPage({ tab }) {
  const { navigate } = useRouter();
  const { user } = useSession();
  const tabs = user.is_admin ? ['workspaces', 'users', 'tokens'] : ['tokens'];
  return (
    <div className="page">
      <PageHead title="Global settings" sub="Installation-level: workspaces, users, access tokens." />
      <div className="tabs mb-16">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => navigate(`/settings/${t}`)}>
            {t === 'tokens' ? 'API tokens' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'workspaces' && user.is_admin && <Workspaces />}
      {tab === 'users' && user.is_admin && <Users />}
      {tab === 'tokens' && <Tokens />}
    </div>
  );
}
