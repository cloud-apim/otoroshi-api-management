import React, { useState } from 'react';
import { useRouter } from '../../shared/router.jsx';
import { fmtDate, fmtRelative } from '../../shared/lib.js';
import { Badge, Callout, Code, Empty, Field, Icon, Input, Loader, Modal, NumberInput, Select, Setting, StatusBadge, Switch, TagsInput, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
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

// D-25: one IdP for the console. local and oidc run in parallel; the otoroshi mode is exclusive.
function Authentication() {
  const st = useLoad(() => api.get('/settings'), []);
  const toast = useToast();
  const [form, setForm] = useState(null);
  return (
    <Loader state={st}>
      {(s) => {
        const f = form || s.auth;
        const setO = (patch) => setForm({ ...f, oidc: { ...f.oidc, ...patch } });
        const setX = (patch) => setForm({ ...f, otoroshi: { ...f.otoroshi, ...patch } });
        return (
          <div className="col gap-16">
            <div className="card">
              <div className="card-body">
                <Setting label="Mode" help="local accounts and an OIDC provider compose; the Otoroshi mode reads the identity in a header set by the gateway and is exclusive.">
                  <Select
                    value={f.mode}
                    onChange={(v) => setForm({ ...f, mode: v })}
                    options={[
                      { value: 'local', label: 'Local accounts + optional OIDC provider' },
                      { value: 'otoroshi', label: 'Via Otoroshi (exclusive)' },
                    ]}
                  />
                  {f.mode === 'otoroshi' && (
                    <Callout kind="warning" title="No fallback entry">
                      The identity comes from the gateway: a gateway outage locks the console — the very tool you need to diagnose it. A defensible trade-off when the gateway is already the single entry point of the organisation.
                    </Callout>
                  )}
                </Setting>
              </div>
            </div>
            {f.mode === 'local' ? (
              <div className="card">
                <div className="card-head">
                  <h3>OpenID Connect provider</h3>
                </div>
                <div className="card-body">
                  <Setting label="Enabled">
                    <Switch checked={f.oidc.enabled} onChange={(v) => setO({ enabled: v })} />
                  </Setting>
                  <Setting label="Button label">
                    <Input value={f.oidc.label} onChange={(v) => setO({ label: v })} />
                  </Setting>
                  <Setting label="Issuer" help="discovery at <issuer>/.well-known/openid-configuration">
                    <Input value={f.oidc.issuer} onChange={(v) => setO({ issuer: v })} mono />
                  </Setting>
                  <Setting label="Client" help={`register this redirect uri at the provider: ${s.auth.callback}`}>
                    <Input value={f.oidc.clientId} onChange={(v) => setO({ clientId: v })} mono placeholder="client id" />
                    <Input value={f.oidc.clientSecret} onChange={(v) => setO({ clientSecret: v })} mono type="password" placeholder="client secret" />
                  </Setting>
                  <Setting label="Scopes and claims">
                    <Input value={f.oidc.scopes} onChange={(v) => setO({ scopes: v })} mono />
                    <div className="row">
                      <Input value={f.oidc.emailClaim} onChange={(v) => setO({ emailClaim: v })} mono placeholder="email claim" />
                      <Input value={f.oidc.nameClaim} onChange={(v) => setO({ nameClaim: v })} mono placeholder="name claim" />
                    </div>
                  </Setting>
                  <Setting label="Local accounts" help="when off, only the bootstrap administrators keep the local form">
                    <Switch checked={f.oidc.localLogin} onChange={(v) => setO({ localLogin: v })} label="Keep the local sign-in form" />
                  </Setting>
                </div>
              </div>
            ) : (
              <div className="card">
                <div className="card-head">
                  <h3>Otoroshi info token</h3>
                </div>
                <div className="card-body">
                  <Setting label="Header" help="set by the Otoroshi info. token plugin (legacy version) on the route exposing the console, behind an auth module">
                    <Input value={f.otoroshi.header} onChange={(v) => setX({ header: v })} mono />
                  </Setting>
                  <Setting label="Secret" help="the HMAC secret of the token, shared with the route">
                    <Input value={f.otoroshi.secret} onChange={(v) => setX({ secret: v })} mono type="password" />
                  </Setting>
                  <Setting label="Issuer" help="optional check of the iss claim">
                    <Input value={f.otoroshi.issuer} onChange={(v) => setX({ issuer: v })} mono />
                  </Setting>
                </div>
              </div>
            )}
            <div className="row">
              <button
                className="btn primary"
                disabled={!form}
                onClick={async () => {
                  try {
                    await api.put('/settings/auth', { mode: form.mode, oidc: form.oidc, otoroshi: form.otoroshi });
                    setForm(null);
                    toast('Authentication settings saved');
                    st.reload();
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }}
              >
                Save
              </button>
            </div>
          </div>
        );
      }}
    </Loader>
  );
}

// the audit trail leaves the product like Otoroshi's events do: exporters with a cursor
function AuditExport() {
  const { workspaces } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const state = useLoad(() => api.get('/audit/exporters'), []);
  const [editing, setEditing] = useState(null);
  const set = (k) => (v) => setEditing((e) => ({ ...e, [k]: v }));
  return (
    <div className="col gap-16">
      <div className="row">
        <p className="muted small grow">
          Every write of the admin api, and the reads of credentials and request logs, are in the audit trail. An exporter sends it in batches to a webhook (a SIEM, a log pipeline), in order and
          at least once: it keeps a cursor, so nothing is lost while the target is down.
        </p>
        <button className="btn primary" onClick={() => setEditing({ name: '', url: '', headers: {}, actions: [], workspace_id: '', enabled: true, batch_size: 100, from_beginning: false })}>
          <Icon name="plus" /> Add exporter
        </button>
      </div>
      <Loader state={state}>
        {(list) =>
          list.length ? (
            <div className="card">
              {list.map((e) => (
                <div key={e.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <Icon name="upload" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="bold">
                      {e.name} {!e.enabled && <Badge>disabled</Badge>}
                    </div>
                    <div className="mono tiny faint ellipsis">{e.url}</div>
                    <div className="small mt-8">
                      <StatusBadge status={e.last_error ? 'error' : 'synced'} label={e.last_error ? 'failing' : 'delivering'} /> {e.delivered} delivered · {e.lag || 0} behind
                      {e.actions?.length ? ` · ${e.actions.join(', ')}` : ' · every action'}
                      {e.last_error && <span className="negative-text"> — {e.last_error}</span>}
                    </div>
                  </div>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const r = await api.post(`/audit/exporters/${e.id}/test`);
                      toast(r.ok ? 'Test event delivered' : `Test failed: ${r.error}`, r.ok ? 'info' : 'error');
                    }}
                  >
                    Test
                  </button>
                  <button className="btn ghost sm icon" onClick={() => setEditing({ ...e, workspace_id: e.workspace_id || '' })} aria-label="edit">
                    <Icon name="edit" />
                  </button>
                  <button
                    className="btn ghost sm icon"
                    aria-label="delete"
                    onClick={async () => {
                      if (!(await confirm({ title: `Delete ${e.name}?`, danger: true, confirmLabel: 'Delete' }))) return;
                      await api.del(`/audit/exporters/${e.id}`);
                      state.reload();
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="card">
              <Empty title="No audit exporter" icon="audit" />
            </div>
          )
        }
      </Loader>
      {editing && (
        <Modal
          title={editing.id ? `Exporter ${editing.name}` : 'New audit exporter'}
          onClose={() => setEditing(null)}
          footer={
            <button
              className="btn primary"
              disabled={!editing.url}
              onClick={async () => {
                try {
                  const body = { ...editing, workspace_id: editing.workspace_id || null };
                  if (editing.id) await api.put(`/audit/exporters/${editing.id}`, body);
                  else await api.post('/audit/exporters', body);
                  setEditing(null);
                  toast('Exporter saved');
                  state.reload();
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
              }}
            >
              Save
            </button>
          }
        >
          <Field label="Name">
            <Input value={editing.name} onChange={set('name')} />
          </Field>
          <Field label="Webhook url" hint="receives POST batches of ApimAuditEvent as a json array">
            <Input value={editing.url} onChange={set('url')} mono />
          </Field>
          <Field label="Header (e.g. a token)">
            <Input
              value={Object.entries(editing.headers || {}).map(([k, v]) => `${k}: ${v}`).join('')}
              onChange={(v) => {
                const [k, ...rest] = v.split(':');
                set('headers')(k && rest.length ? { [k.trim()]: rest.join(':').trim() } : {});
              }}
              mono
              placeholder="Authorization: Bearer …"
            />
          </Field>
          <div className="grid-2">
            <Field label="Workspace">
              <Select value={editing.workspace_id} onChange={set('workspace_id')} options={[{ value: '', label: 'every workspace' }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]} />
            </Field>
            <Field label="Batch size">
              <NumberInput value={editing.batch_size} onChange={set('batch_size')} />
            </Field>
          </div>
          <Field label="Actions" hint="prefixes, e.g. subscription. or credential.read — empty: everything">
            <TagsInput value={editing.actions} onChange={set('actions')} />
          </Field>
          <div className="row gap-24">
            <Switch checked={editing.enabled} onChange={set('enabled')} label="Enabled" />
            {!editing.id && <Switch checked={editing.from_beginning} onChange={set('from_beginning')} label="Replay the whole trail" />}
          </div>
        </Modal>
      )}
    </div>
  );
}

export function GlobalSettingsPage({ tab }) {
  const { navigate } = useRouter();
  const { user } = useSession();
  const tabs = user.is_admin ? ['workspaces', 'users', 'authentication', 'audit', 'tokens'] : ['tokens'];
  return (
    <div className="page">
      <PageHead title="Global settings" sub="Installation-level: workspaces, users, access tokens." />
      <div className="tabs mb-16">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => navigate(`/settings/${t}`)}>
            {t === 'tokens' ? 'API tokens' : t === 'audit' ? 'Audit export' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'workspaces' && user.is_admin && <Workspaces />}
      {tab === 'users' && user.is_admin && <Users />}
      {tab === 'authentication' && user.is_admin && <Authentication />}
      {tab === 'audit' && user.is_admin && <AuditExport />}
      {tab === 'tokens' && <Tokens />}
    </div>
  );
}
