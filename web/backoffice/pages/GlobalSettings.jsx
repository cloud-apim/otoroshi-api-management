import React, { useState } from 'react';
import { useRouter } from '../../shared/router.jsx';
import { fmtDate, fmtRelative } from '../../shared/lib.js';
import { Badge, Callout, Code, Empty, Field, Icon, Input, Loader, Modal, NumberInput, Select, Setting, StatusBadge, Switch, TagsInput, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { api, useSession } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { ListToolbar, Pager, useLocalPaging, usePaging } from '../../shared/lists.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';

const FORM_TITLES = () => ({ path: tr('by root path'), hostname: tr('by hostname'), root: tr('one workspace, at the root') });

function formUrl(form, url) {
  if (form.kind === 'hostname') return `${new URL(url).protocol}//<workspace>.${form.domain}/`;
  if (form.kind === 'root') return `${url}/`;
  return `${url}/<workspace>/`;
}

// the form of the portal urls, set at installation, and the older forms still redirected
function Exposure({ portal }) {
  const { form, url, history } = portal;
  return (
    <Callout kind="info" title={tr('Portal exposure: {0}', [FORM_TITLES()[form.kind]])}>
      <div className="col gap-6">
        <span>
          <Tr text={'{0} The form holds for the whole installation and changes every public url: it is set at installation (APIM_TENANCY, APIM_PORTAL_EXPOSURE, APIM_PORTAL_DOMAIN, APIM_PORTAL_URL).'} args={[form.kind === 'root' ? (
            <>
              <Tr text={'This installation serves the single workspace {0} at {1}: no prefix, no workspace selector.'} args={[<span className="mono">{form.workspace}</span>, <span className="mono">{formUrl(form, url)}</span>]} />
            </>
          ) : (
            <>
              <Tr text={'Each workspace portal is served at {0}{1} There is no global portal.'} args={[<span className="mono">{formUrl(form, url)}</span>, form.kind === 'hostname' ? tr(', which takes a wildcard DNS entry and a wildcard certificate.') : '.']} />
            </>
          )]} />
        </span>
        {history.previous.length > 0 && (
          <span>
            <Tr text={'The urls of the forms served before are redirected to the same pages: {0}.'} args={[history.previous.map((f, i) => (
              <span key={i}>
                <Tr text={'{0}{1} (until {2})'} args={[i > 0 && ', ', <span className="mono">{formUrl(f, url)}</span>, fmtDate(f.until)]} />
              </span>
            ))]} />
          </span>
        )}
      </div>
    </Callout>
  );
}

function Workspaces() {
  const { session } = { session: useSession() };
  const toast = useToast();
  const { navigate } = useRouter();
  const [f, setF] = useState({ name: '', slug: '' });
  const settings = useLoad(() => api.get('/settings'), []);
  const page = useLocalPaging(session.workspaces, { prefix: 'ws', size: 25, text: (w) => `${w.name} ${w.slug} ${w.description || ''}` });
  // a single-workspace installation creates none
  const single = session.me.installation?.tenancy === 'single';
  return (
    <div className="col gap-16">
      <Loader state={settings}>{(s) => <Exposure portal={s.portal} />}</Loader>
      <div className="card" hidden={single}>
        <div className="card-body row wrap">
          <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder={tr('workspace name')} />
          <Input value={f.slug} onChange={(v) => setF({ ...f, slug: v })} placeholder={tr('slug (optional)')} mono />
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
            {tr('Create workspace')}
          </button>
        </div>
      </div>
      <ListToolbar paging={page} placeholder={tr('search workspaces, slugs')} onReload={session.reload} />
      <div className="card">
        {!page.items.length && <Empty title={page.q ? tr('No workspace matches') : tr('No workspace')} icon="layers" />}
        {page.items.map((w) => (
          <div key={w.id} className="list-item">
            <span className="ws-avatar">{w.name[0]}</span>
            <div className="grow">
              <div className="bold">{w.name}</div>
              <div className="faint tiny mono">{w.slug}</div>
            </div>
            <a className="link small" href={w.portal_url} target="_blank" rel="noreferrer">
              {tr('portal')}
            </a>
            <button className="btn sm" onClick={() => navigate(`/ws/${w.slug}`)}>
              {tr('Open')}
            </button>
          </div>
        ))}
        <Pager paging={page} total={page.total} />
      </div>
    </div>
  );
}

// the people are searched (email, name, tags) and paged on the server
function Users() {
  const usersPage = usePaging({ prefix: 'users', size: 25 });
  const state = useLoad(() => api.get(`/users?${usersPage.query}`), [usersPage.key]);
  const toast = useToast();
  const [f, setF] = useState({ email: '', name: '', password: '', is_admin: false });
  return (
    <div className="col gap-16">
      <p className="muted small">{tr('Users are global — one record per person, with memberships in several workspaces. Bootstrap administrators come from APIM_BOOTSTRAP_ADMINS.')}</p>
      <div className="card">
        <div className="card-body row wrap">
          <Input value={f.email} onChange={(v) => setF({ ...f, email: v })} placeholder={tr('email')} />
          <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder={tr('name')} />
          <Input value={f.password} onChange={(v) => setF({ ...f, password: v })} placeholder={tr('password')} type="password" />
          <Switch checked={f.is_admin} onChange={(v) => setF({ ...f, is_admin: v })} label={tr('admin')} />
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
            {tr('Create user')}
          </button>
        </div>
      </div>
      <ListToolbar paging={usersPage} placeholder={tr('search people, emails, tags')} onReload={state.reload} loading={state.loading} />
      <Loader state={state}>
        {({ items, total }) =>
          items.length ? (
            <div className="card">
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {items.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <div className="bold">{u.name}</div>
                          <div className="faint tiny">{u.email}</div>
                        </td>
                        <td>{u.is_admin && <Badge kind="accent">{tr('installation admin')}</Badge>}</td>
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
              <Pager paging={usersPage} total={total} />
            </div>
          ) : (
            <div className="card">
              <Empty title={usersPage.q ? tr('No user matches') : tr('No user')} icon="users" />
            </div>
          )
        }
      </Loader>
    </div>
  );
}

// everything the console does replays from the cli with a token
function Tokens() {
  const state = useLoad(() => api.get('/me/tokens'), []);
  const page = useLocalPaging(state.data, { prefix: 'tokens', size: 25, text: (t) => `${t.name} ${t.prefix}` });
  const toast = useToast();
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);
  return (
    <div className="col gap-16">
      <p className="muted small">{tr('Personal tokens for the admin api (/api), the CLI and CI. Every action of the console is an admin api call, so every action replays from them.')}</p>
      <div className="card">
        <div className="card-body row">
          <Input value={name} onChange={setName} placeholder={tr('token name (e.g. ci)')} />
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
            {tr('Create token')}
          </button>
        </div>
      </div>
      {created && (
        <Callout kind="positive" title={tr('Copy this token now: it is not shown again')}>
          <Code>{created.token}</Code>
          <div className="mt-8">
            <Code>{`APIM_URL=${window.location.origin} APIM_TOKEN=${created.token} bun cli/apim.js apis list default`}</Code>
          </div>
        </Callout>
      )}
      <ListToolbar paging={page} placeholder={tr('search tokens')} onReload={state.reload} loading={state.loading} />
      <Loader state={state}>
        {() => (
          <div className="card">
            {!page.items.length && <Empty title={page.q ? tr('No token matches') : tr('No token yet')} icon="key" />}
            {page.items.map((t) => (
              <div key={t.id} className="list-item">
                <Icon name="key" />
                <div className="grow">
                  <div className="bold">{t.name}</div>
                  <div className="faint tiny mono">{t.prefix}…</div>
                </div>
                <span className="muted small"><Tr text={'created {0} · used {1}'} args={[fmtDate(t.created_at), t.last_used_at ? fmtRelative(t.last_used_at) : tr('never')]} /></span>
                <button
                  className="btn ghost sm icon"
                  aria-label={tr('revoke')}
                  onClick={async () => {
                    await api.del(`/me/tokens/${t.id}`);
                    state.reload();
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>
            ))}
            <Pager paging={page} total={page.total} />
          </div>
        )}
      </Loader>
    </div>
  );
}

// one IdP for the console. local and oidc run in parallel; the otoroshi mode is exclusive.
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
                <Setting label={tr('Mode')} help={tr('local accounts and an OIDC provider compose; the Otoroshi mode reads the identity in a header set by the gateway and is exclusive.')}>
                  <Select
                    value={f.mode}
                    onChange={(v) => setForm({ ...f, mode: v })}
                    options={[
                      { value: 'local', label: tr('Local accounts + optional OIDC provider') },
                      { value: 'otoroshi', label: tr('Via Otoroshi (exclusive)') },
                    ]}
                  />
                  {f.mode === 'otoroshi' && (
                    <Callout kind="warning" title={tr('No fallback entry')}>
                      {tr('The identity comes from the gateway: a gateway outage locks the console — the very tool you need to diagnose it. A defensible trade-off when the gateway is already the single entry point of the organisation.')}
                    </Callout>
                  )}
                </Setting>
              </div>
            </div>
            {f.mode === 'local' ? (
              <div className="card">
                <div className="card-head">
                  <h3>{tr('OpenID Connect provider')}</h3>
                </div>
                <div className="card-body">
                  <Setting label={tr('Enabled')}>
                    <Switch checked={f.oidc.enabled} onChange={(v) => setO({ enabled: v })} />
                  </Setting>
                  <Setting label={tr('Button label')}>
                    <Input value={f.oidc.label} onChange={(v) => setO({ label: v })} />
                  </Setting>
                  <Setting label={tr('Issuer')} help={tr('discovery at <issuer>/.well-known/openid-configuration')}>
                    <Input value={f.oidc.issuer} onChange={(v) => setO({ issuer: v })} mono />
                  </Setting>
                  <Setting label={tr('Client')} help={tr('register this redirect uri at the provider: {0}', [s.auth.callback])}>
                    <Input value={f.oidc.clientId} onChange={(v) => setO({ clientId: v })} mono placeholder={tr('client id')} />
                    <Input value={f.oidc.clientSecret} onChange={(v) => setO({ clientSecret: v })} mono type="password" placeholder={tr('client secret')} />
                  </Setting>
                  <Setting label={tr('Scopes and claims')}>
                    <Input value={f.oidc.scopes} onChange={(v) => setO({ scopes: v })} mono />
                    <div className="row">
                      <Input value={f.oidc.emailClaim} onChange={(v) => setO({ emailClaim: v })} mono placeholder={tr('email claim')} />
                      <Input value={f.oidc.nameClaim} onChange={(v) => setO({ nameClaim: v })} mono placeholder={tr('name claim')} />
                    </div>
                  </Setting>
                  <Setting label={tr('Local accounts')} help={tr('when off, only the bootstrap administrators keep the local form')}>
                    <Switch checked={f.oidc.localLogin} onChange={(v) => setO({ localLogin: v })} label={tr('Keep the local sign-in form')} />
                  </Setting>
                </div>
              </div>
            ) : (
              <div className="card">
                <div className="card-head">
                  <h3>{tr('Otoroshi info token')}</h3>
                </div>
                <div className="card-body">
                  <Setting label={tr('Header')} help={tr('set by the Otoroshi info. token plugin (legacy version) on the route exposing the console, behind an auth module')}>
                    <Input value={f.otoroshi.header} onChange={(v) => setX({ header: v })} mono />
                  </Setting>
                  <Setting label={tr('Secret')} help={tr('the HMAC secret of the token, shared with the route')}>
                    <Input value={f.otoroshi.secret} onChange={(v) => setX({ secret: v })} mono type="password" />
                  </Setting>
                  <Setting label={tr('Issuer')} help={tr('optional check of the iss claim')}>
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
                    toast(tr('Authentication settings saved'));
                    st.reload();
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }}
              >
                {tr('Save')}
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
  const wsName = (id) => workspaces.find((w) => w.id === id)?.name || '';
  const page = useLocalPaging(state.data, { prefix: 'exporters', size: 25, text: (e) => `${e.name} ${e.url} ${(e.actions || []).join(' ')} ${wsName(e.workspace_id)} ${e.last_error || ''}` });
  const [editing, setEditing] = useState(null);
  const set = (k) => (v) => setEditing((e) => ({ ...e, [k]: v }));
  return (
    <div className="col gap-16">
      <div className="row">
        <p className="muted small grow">
          {tr('Every write of the admin api, and the reads of credentials and request logs, are in the audit trail. An exporter sends it in batches to a webhook (a SIEM, a log pipeline), in order and at least once: it keeps a cursor, so nothing is lost while the target is down.')}
        </p>
        <button className="btn primary" onClick={() => setEditing({ name: '', url: '', headers: {}, actions: [], workspace_id: '', enabled: true, batch_size: 100, from_beginning: false })}>
          <Icon name="plus" /> {tr('Add exporter')}
        </button>
      </div>
      <ListToolbar paging={page} placeholder={tr('search exporters, urls, actions, workspaces')} onReload={state.reload} loading={state.loading} />
      <Loader state={state}>
        {() =>
          page.items.length ? (
            <div className="card">
              {page.items.map((e) => (
                <div key={e.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <Icon name="upload" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="bold">
                      {e.name} {!e.enabled && <Badge>{tr('disabled')}</Badge>}
                    </div>
                    <div className="mono tiny faint ellipsis">{e.url}</div>
                    <div className="small mt-8">
                      <StatusBadge status={e.last_error ? 'error' : 'synced'} label={e.last_error ? tr('failing') : tr('delivering')} /> <Tr text={'{0} delivered · {1} behind{2}{3}'} args={[e.delivered, e.lag || 0, e.actions?.length ? ` · ${e.actions.join(', ')}` : tr(' · every action'), e.last_error && <span className="negative-text"> — {e.last_error}</span>]} />
                    </div>
                  </div>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const r = await api.post(`/audit/exporters/${e.id}/test`);
                      toast(r.ok ? tr('Test event delivered') : tr('Test failed: {0}', [r.error]), r.ok ? 'info' : 'error');
                    }}
                  >
                    {tr('Test')}
                  </button>
                  <button className="btn ghost sm icon" onClick={() => setEditing({ ...e, workspace_id: e.workspace_id || '' })} aria-label={tr('edit')}>
                    <Icon name="edit" />
                  </button>
                  <button
                    className="btn ghost sm icon"
                    aria-label={tr('delete')}
                    onClick={async () => {
                      if (!(await confirm({ title: tr('Delete {0}?', [e.name]), danger: true, confirmLabel: tr('Delete') }))) return;
                      await api.del(`/audit/exporters/${e.id}`);
                      state.reload();
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
              <Pager paging={page} total={page.total} />
            </div>
          ) : (
            <div className="card">
              <Empty title={page.q ? tr('No exporter matches') : tr('No audit exporter')} icon="audit" />
            </div>
          )
        }
      </Loader>
      {editing && (
        <Modal
          title={editing.id ? tr('Exporter {0}', [editing.name]) : tr('New audit exporter')}
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
                  toast(tr('Exporter saved'));
                  state.reload();
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
              }}
            >
              {tr('Save')}
            </button>
          }
        >
          <Field label={tr('Name')}>
            <Input value={editing.name} onChange={set('name')} />
          </Field>
          <Field label={tr('Webhook url')} hint={tr('receives POST batches of ApimAuditEvent as a json array')}>
            <Input value={editing.url} onChange={set('url')} mono />
          </Field>
          <Field label={tr('Header (e.g. a token)')}>
            <Input
              value={Object.entries(editing.headers || {}).map(([k, v]) => `${k}: ${v}`).join('')}
              onChange={(v) => {
                const [k, ...rest] = v.split(':');
                set('headers')(k && rest.length ? { [k.trim()]: rest.join(':').trim() } : {});
              }}
              mono
              placeholder={tr('Authorization: Bearer …')}
            />
          </Field>
          <div className="grid-2">
            <Field label={tr('Workspace')}>
              <Select value={editing.workspace_id} onChange={set('workspace_id')} options={[{ value: '', label: tr('every workspace') }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]} />
            </Field>
            <Field label={tr('Batch size')}>
              <NumberInput value={editing.batch_size} onChange={set('batch_size')} />
            </Field>
          </div>
          <Field label={tr('Actions')} hint={tr('prefixes, e.g. subscription. or credential.read — empty: everything')}>
            <TagsInput value={editing.actions} onChange={set('actions')} />
          </Field>
          <div className="row gap-24">
            <Switch checked={editing.enabled} onChange={set('enabled')} label={tr('Enabled')} />
            {!editing.id && <Switch checked={editing.from_beginning} onChange={set('from_beginning')} label={tr('Replay the whole trail')} />}
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
      <PageHead title={tr('Global settings')} sub={tr('Installation-level: workspaces, users, access tokens.')} />
      <div className="tabs mb-16">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => navigate(`/settings/${t}`)}>
            {t === 'tokens' ? tr('API tokens') : t === 'audit' ? tr('Audit export') : tr(t[0].toUpperCase() + t.slice(1))}
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
