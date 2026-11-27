import React, { useState } from 'react';
import { Link, useRouter } from '../../shared/router.jsx';
import { Badge, Callout, DiffView, Empty, Field, FileButton, Icon, Input, Loader, Modal, NumberInput, Select, Setting, StatusBadge, Switch, TagsInput, TextArea, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { CodeEditor } from '../../shared/code-editor.jsx';
import { fmtRelative } from '../../shared/lib.js';
import { useWs, useMetadataFields } from '../context.jsx';
import { MetadataForm } from '../../shared/metadata.jsx';
import { PageHead } from '../layout.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../shared/lists.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';
import { PaymentsSettings } from './Payments.jsx';
import { WorkspaceEmail } from './Email.jsx';
import { WebhooksSettings } from './Webhooks.jsx';

// what a producer may read but not change: disabled, with the reason
function ReadOnly({ when, children }) {
  if (!when) return children;
  return (
    <>
      <Callout kind="info">{tr('Read only: the administrators of the workspace change these settings.')}</Callout>
      <fieldset disabled className="ro-fieldset">
        {children}
      </fieldset>
    </>
  );
}

function General() {
  const { wapi, ws, session, isAdmin } = useWs();
  const toast = useToast();
  const [f, setF] = useState({ name: ws.name, description: ws.description });
  return (
    <ReadOnly when={!isAdmin}>
    <div className="card">
      <div className="card-body">
        <Setting label={tr('Name')} help={tr('the workspace is the tenant — the same word on every surface: console, api, cli, crds')}>
          <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} />
        </Setting>
        <Setting label={tr('Slug')} help={tr('read from the url of its portal, never from a session')}>
          <Input value={ws.slug} disabled mono />
        </Setting>
        <Setting label={tr('Description')}>
          <TextArea value={f.description} onChange={(v) => setF({ ...f, description: v })} rows={2} />
        </Setting>
        <div className="row mt-16">
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await wapi.put('', f);
                toast(tr('Workspace saved'));
                session.reload();
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            {tr('Save')}
          </button>
        </div>
      </div>
    </div>
    </ReadOnly>
  );
}

function Members() {
  const { wapi, slug, isAdmin } = useWs();
  const toast = useToast();
  const state = useLoad(() => wapi.get('/members'), [slug]);
  const membersPage = useLocalPaging(state.data, { prefix: 'members', size: 25, text: (m) => `${m.name} ${m.email} ${m.role} ${(m.tags || []).join(' ')}` });
  const [invite, setInvite] = useState({ email: '', role: 'producer' });
  return (
    <div className="col gap-16">
      {!isAdmin && <Callout kind="info">{tr('Read only: the administrators of the workspace choose its members and their roles.')}</Callout>}
      {isAdmin && (
      <div className="card">
        <div className="card-body row wrap">
          <Input value={invite.email} onChange={(v) => setInvite({ ...invite, email: v })} placeholder={tr('email')} />
          <Select value={invite.role} onChange={(v) => setInvite({ ...invite, role: v })} options={['admin', 'producer', 'consumer']} style={{ width: 160 }} />
          <button
            className="btn primary"
            disabled={!invite.email}
            onClick={async () => {
              try {
                await wapi.post('/members', invite);
                setInvite({ email: '', role: 'producer' });
                state.reload();
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            {tr('Add member')}
          </button>
        </div>
      </div>
      )}
      <ListToolbar paging={membersPage} placeholder={tr('search members, emails, roles, tags')} onReload={state.reload} loading={state.loading} />
      <Loader state={state}>
        {() =>
          membersPage.items.length ? (
          <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{tr('Member')}</th>
                  <th>{tr('Role')}</th>
                  <th>{tr('Tags')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {membersPage.items.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="bold">{m.name}</div>
                      <div className="faint tiny">{m.email}</div>
                    </td>
                    <td>
                      {!isAdmin ? (
                        <Badge>{m.role}</Badge>
                      ) : (
                      <Select
                        value={m.role}
                        onChange={async (role) => {
                          await wapi.post('/members', { user_id: m.id, role });
                          state.reload();
                        }}
                        options={['admin', 'producer', 'consumer']}
                        style={{ width: 140 }}
                      />
                      )}
                    </td>
                    <td className="small">
                      {(m.tags || []).map((t) => (
                        <span key={t} className="tag" style={{ marginRight: 4 }}>
                          {t}
                        </span>
                      ))}
                    </td>
                    <td className="actions">
                      {isAdmin && (
                      <button
                        className="btn ghost sm icon"
                        aria-label={tr('remove member')}
                        onClick={async () => {
                          await wapi.del(`/members/${m.id}`);
                          state.reload();
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager paging={membersPage} total={membersPage.total} />
          </div>
          ) : (
            <div className="card">
              <Empty title={membersPage.q ? tr('No member matches') : tr('No member')} icon="users" />
            </div>
          )
        }
      </Loader>
    </div>
  );
}

function Teams() {
  const { wapi, slug } = useWs();
  const toast = useToast();
  const state = useLoad(() => wapi.get('/teams'), [slug]);
  const page = useLocalPaging(state.data, { prefix: 'teams', size: 25, text: (t) => `${t.name} ${t.id}` });
  const [name, setName] = useState('');
  return (
    <div className="col gap-16">
      <div className="card">
        <div className="card-body row">
          <Input value={name} onChange={setName} placeholder={tr('team name')} />
          <button
            className="btn primary"
            disabled={!name}
            onClick={async () => {
              try {
                await wapi.post('/teams', { name });
                setName('');
                state.reload();
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            {tr('Create team')}
          </button>
        </div>
      </div>
      <ListToolbar paging={page} placeholder={tr('search teams')} onReload={state.reload} loading={state.loading} />
      <Loader state={state}>
        {() => (
          <div className="card">
            {!page.items.length && <Empty title={page.q ? tr('No team matches') : tr('No team')} icon="users" />}
            {page.items.map((t) => (
              <Link key={t.id} to={`/ws/${slug}/settings/teams/${t.id}`} className="list-item clickable">
                <Icon name="users" />
                <div className="grow">
                  <div className="bold">
                    {t.name} {t.personal && <Badge>{tr('personal')}</Badge>}
                  </div>
                  <div className="faint tiny mono"><Tr text={'team:{0}'} args={[t.id]} /></div>
                </div>
                <span className="muted small"><Tr text={'{0} member(s)'} args={[t.members_count]} /></span>
                <Icon name="chevronRight" size={14} />
              </Link>
            ))}
            <Pager paging={page} total={page.total} />
          </div>
        )}
      </Loader>
    </div>
  );
}

// a team on a page of its own: its members — added, removed, owners or members — by its owners and the
// administrators of the workspace; the APIs and the applications it owns, read here
export function TeamPage({ id }) {
  const { wapi, slug, isAdmin, session } = useWs();
  const toast = useToast();
  const state = useLoad(() => wapi.get(`/teams/${id}`), [id]);
  const apis = useLoad(() => wapi.get(`/apis?team=${encodeURIComponent(id)}`), [id]);
  const apps = useLoad(() => wapi.get(`/applications?team=${encodeURIComponent(id)}`), [id]);
  const members = useLocalPaging(state.data?.members, { prefix: 'members', size: 10, text: (m) => `${m.name} ${m.email} ${m.role}` });
  const apisPage = useLocalPaging(apis.data, { prefix: 'apis', size: 10, text: (a) => `${a.name} ${a.version} ${a.lifecycle}` });
  const appsPage = useLocalPaging(apps.data, { prefix: 'apps', size: 10, text: (a) => `${a.name} ${a.description || ''}` });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const roles = [
    { value: 'member', label: tr('member') },
    { value: 'owner', label: tr('owner') },
  ];
  const change = async (fn) => {
    try {
      await fn();
      state.reload();
      return true;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return false;
    }
  };
  return (
    <div className="page">
      <Loader state={state}>
        {(t) => {
          const manages = isAdmin || t.members.some((m) => m.id === session.user.id && m.role === 'owner');
          return (
            <>
              <PageHead
                crumbs={[{ label: tr('Workspace settings'), to: `/ws/${slug}/settings` }, { label: tr('Teams'), to: `/ws/${slug}/settings/teams` }, { label: t.name }]}
                title={t.name}
                sub={
                  <span className="row wrap gap-6">
                    {t.personal && <Badge>{tr('personal')}</Badge>}
                    <span className="faint mono small">
                      <Tr text={'team:{0}'} args={[t.id]} />
                    </span>
                    <span className="faint">·</span>
                    <span>
                      <Tr text={'{0} member(s)'} args={[t.members.length]} />
                    </span>
                  </span>
                }
              />
              <div className="grid-2" style={{ alignItems: 'start' }}>
                <div className="card">
                  <div className="card-head">
                    <Icon name="users" />
                    <h3>{tr('Members')}</h3>
                  </div>
                  <div className="card-body col gap-12">
                    {!manages && <Callout kind="info">{tr('The owners of the team and the administrators of the workspace choose its members.')}</Callout>}
                    {manages && (
                      <div className="row">
                        <Input value={email} onChange={setEmail} placeholder={tr('email of a workspace member')} aria-label={tr('email of a workspace member')} />
                        <Select value={role} onChange={setRole} options={roles} style={{ width: 130 }} aria-label={tr('role in the team')} />
                        <button className="btn" disabled={!email.trim()} onClick={async () => (await change(() => wapi.post(`/teams/${id}/members`, { email: email.trim(), role }))) && setEmail('')}>
                          {tr('Add')}
                        </button>
                      </div>
                    )}
                    <ListToolbar paging={members} placeholder={tr('search members, emails, roles')} />
                    {members.items.length ? (
                      <div>
                        {members.items.map((m) => (
                          <div key={m.id} className="list-item" style={{ paddingLeft: 0, paddingRight: 0 }}>
                            <span className="grow">
                              {m.name} <span className="faint small">{m.email}</span>
                            </span>
                            {manages ? (
                              <Select value={m.role} onChange={(v) => change(() => wapi.post(`/teams/${id}/members`, { user_id: m.id, role: v }))} options={roles} style={{ width: 120 }} aria-label={tr('role of {0}', [m.email])} />
                            ) : (
                              <Badge>{tr(m.role)}</Badge>
                            )}
                            {manages && (
                              <button className="btn ghost sm icon" aria-label={tr('remove')} onClick={() => change(() => wapi.del(`/teams/${id}/members/${m.id}`))}>
                                <Icon name="trash" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Empty title={members.q ? tr('No member matches') : tr('No member')} icon="users" />
                    )}
                    <Pager paging={members} total={members.total} />
                  </div>
                </div>
                <div className="col gap-16">
                  <div className="card">
                    <div className="card-head">
                      <Icon name="api" />
                      <h3>{tr('APIs')}</h3>
                    </div>
                    <div className="card-body col gap-8">
                      <ListToolbar paging={apisPage} placeholder={tr('search apis')} />
                      <Loader state={apis}>
                        {() =>
                          apisPage.items.length ? (
                            <div>
                              {apisPage.items.map((a) => (
                                <Link key={a.id} to={`/ws/${slug}/apis/${a.id}`} className="list-item clickable" style={{ paddingLeft: 0, paddingRight: 0 }}>
                                  <span className="grow">
                                    {a.name} <span className="faint">{a.version}</span>
                                  </span>
                                  <StatusBadge status={a.lifecycle} />
                                </Link>
                              ))}
                            </div>
                          ) : (
                            <p className="faint small">{apisPage.q ? tr('No API matches.') : tr('No API is owned by this team.')}</p>
                          )
                        }
                      </Loader>
                      <Pager paging={apisPage} total={apisPage.total} />
                    </div>
                  </div>
                  <div className="card">
                    <div className="card-head">
                      <Icon name="apps" />
                      <h3>{tr('Applications')}</h3>
                    </div>
                    <div className="card-body col gap-8">
                      <ListToolbar paging={appsPage} placeholder={tr('search applications')} />
                      <Loader state={apps}>
                        {() =>
                          appsPage.items.length ? (
                            <div>
                              {appsPage.items.map((a) => (
                                <Link key={a.id} to={`/ws/${slug}/applications/${a.id}`} className="list-item clickable" style={{ paddingLeft: 0, paddingRight: 0 }}>
                                  <span className="grow">{a.name}</span>
                                  {a.description && <span className="faint small">{a.description}</span>}
                                </Link>
                              ))}
                            </div>
                          ) : (
                            <p className="faint small">{appsPage.q ? tr('No application matches.') : tr('No application belongs to this team.')}</p>
                          )
                        }
                      </Loader>
                      <Pager paging={appsPage} total={appsPage.total} />
                    </div>
                  </div>
                </div>
              </div>
            </>
          );
        }}
      </Loader>
    </div>
  );
}

// one metadata mechanism, the scope as a parameter — same model, same screen, same api
const SCOPES = [
  ['workspace', 'Workspace'],
  ['api', 'API'],
  ['plan', 'Plan'],
  ['subscription', 'Subscription'],
  ['application', 'Application'],
];
const TYPES = ['string', 'text', 'number', 'boolean', 'date', 'url', 'email', 'enum'];

function MetadataSettings() {
  const { wapi, slug, ws, session, isAdmin } = useWs();
  const toast = useToast();
  const state = useLoad(() => wapi.get('/metadata-fields'), [slug]);
  const wsFields = useMetadataFields('workspace');
  const [fields, setFields] = useState(null);
  const [editing, setEditing] = useState(null);
  const [values, setValues] = useState(null);
  // the fields as edited, before they are saved
  const list = fields || state.data || [];
  const page = useLocalPaging(list, { prefix: 'fields', size: 25, text: (f) => `${f.scope} ${f.key} ${f.label} ${f.type} ${(f.options || []).join(' ')} ${f.help || ''}` });
  return (
    <Loader state={state}>
      {() => {
        const save = async () => {
          try {
            await wapi.put('/metadata-fields', { fields: list });
            setFields(null);
            toast(tr('Metadata fields saved'));
            state.reload();
          } catch (e) {
            toast(errorMessage(e), 'error');
          }
        };
        // read only, the edits are disabled but the fields are still searched and paged
        return (
          <div className="col gap-16">
            {!isAdmin && <Callout kind="info">{tr('Read only: the administrators of the workspace change these settings.')}</Callout>}
            <Callout kind="info">
              <Tr text={'Typed key/values attached to an object, wherever the model cannot foresee everything. They serve display, notifications and the review of requests, and are never projected on the gateway. On the subscription scope, the fields marked {0} form the request form of every plan.'} args={[<b>{tr('portal')}</b>]} />
            </Callout>
            <div className="card">
              <div className="card-head">
                <h3 className="grow">{tr('Fields')}</h3>
                <button className="btn sm" disabled={!isAdmin} onClick={() => setEditing({ scope: 'subscription', key: '', label: '', type: 'string', options: [], required: false, portal: false, help: '', _new: true })}>
                  <Icon name="plus" /> {tr('Add field')}
                </button>
              </div>
              <div className="card-body" style={{ paddingBottom: 0 }}>
                <ListToolbar paging={page} placeholder={tr('search scopes, keys, labels, types')} />
              </div>
              {page.items.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{tr('Scope')}</th>
                        <th>{tr('Key')}</th>
                        <th>{tr('Label')}</th>
                        <th>{tr('Type')}</th>
                        <th>{tr('Flags')}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map((f) => (
                        <tr key={`${f.scope}:${f.key}`}>
                          <td>
                            <Badge>{f.scope}</Badge>
                          </td>
                          <td className="mono small">{f.key}</td>
                          <td>{f.label}</td>
                          <td className="small">{f.type === 'enum' ? tr('enum ({0})', [f.options.join(', ')]) : f.type}</td>
                          <td className="small">
                            {f.required && <Badge kind="warning">{tr('required')}</Badge>} {f.portal && <Badge kind="accent">{tr('portal')}</Badge>}
                          </td>
                          <td className="actions">
                            <button className="btn ghost sm icon" disabled={!isAdmin} onClick={() => setEditing({ ...f, _index: list.indexOf(f) })} aria-label={tr('edit')}>
                              <Icon name="edit" />
                            </button>
                            <button className="btn ghost sm icon" disabled={!isAdmin} onClick={() => setFields(list.filter((x) => x !== f))} aria-label={tr('remove')}>
                              <Icon name="trash" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="card-body muted small">{page.q ? tr('No field matches.') : tr('No field declared.')}</div>
              )}
              {page.items.length > 0 && <Pager paging={page} total={page.total} />}
              {fields && (
                <div className="card-body row" style={{ borderTop: '1px solid var(--border)' }}>
                  <button className="btn primary sm" onClick={save}>
                    {tr('Save fields')}
                  </button>
                  <button className="btn sm" onClick={() => setFields(null)}>
                    {tr('Discard')}
                  </button>
                </div>
              )}
            </div>
            {wsFields.length > 0 && (
              <div className="card">
                <div className="card-head">
                  <h3>{tr('Values of this workspace')}</h3>
                </div>
                <fieldset disabled={!isAdmin} className="ro-fieldset card-body col">
                  <MetadataForm fields={wsFields} values={values || ws.metadata} onChange={setValues} />
                  <button
                    className="btn primary"
                    style={{ alignSelf: 'flex-start' }}
                    disabled={!values}
                    onClick={async () => {
                      try {
                        await wapi.put('', { metadata: values });
                        setValues(null);
                        toast(tr('Saved'));
                        session.reload();
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }}
                  >
                    {tr('Save')}
                  </button>
                </fieldset>
              </div>
            )}
            {editing && (
              <Modal
                title={editing._new ? tr('New field') : tr('Field {0}', [editing.key])}
                onClose={() => setEditing(null)}
                footer={
                  <button
                    className="btn primary"
                    disabled={!editing.key}
                    onClick={() => {
                      const { _new, _index, ...f } = editing;
                      const clean = { ...f, label: f.label || f.key, options: f.type === 'enum' ? f.options : [] };
                      setFields(_new ? [...list, clean] : list.map((x, j) => (j === _index ? clean : x)));
                      setEditing(null);
                    }}
                  >
                    {tr('Apply')}
                  </button>
                }
              >
                <div className="grid-2">
                  <Field label={tr('Scope')}>
                    <Select value={editing.scope} onChange={(v) => setEditing({ ...editing, scope: v })} options={SCOPES.map(([value, label]) => ({ value, label: tr(label) }))} />
                  </Field>
                  <Field label={tr('Type')}>
                    <Select value={editing.type} onChange={(v) => setEditing({ ...editing, type: v })} options={TYPES} />
                  </Field>
                </div>
                <div className="grid-2">
                  <Field label={tr('Key')} hint={tr('lowercase, stable: it is what the api and the exports carry')}>
                    <Input value={editing.key} onChange={(v) => setEditing({ ...editing, key: v })} mono />
                  </Field>
                  <Field label={tr('Label')}>
                    <Input value={editing.label} onChange={(v) => setEditing({ ...editing, label: v })} />
                  </Field>
                </div>
                {editing.type === 'enum' && (
                  <Field label={tr('Options')}>
                    <TagsInput value={editing.options} onChange={(v) => setEditing({ ...editing, options: v })} />
                  </Field>
                )}
                <Field label={tr('Help')}>
                  <Input value={editing.help} onChange={(v) => setEditing({ ...editing, help: v })} />
                </Field>
                {/* the label and the help in the other languages of the portal and of the console */}
                {[...new Set([...(ws.portal?.languages || []), 'en', 'fr'])].map((l) => {
                  const t = editing.translations?.[l] || {};
                  const setT = (patch) => setEditing({ ...editing, translations: { ...(editing.translations || {}), [l]: { ...t, ...patch } } });
                  return (
                    <div key={l} className="grid-2">
                      <Field label={tr('Label ({0})', [l])}>
                        <Input value={t.label || ''} onChange={(v) => setT({ label: v })} placeholder={editing.label} />
                      </Field>
                      <Field label={tr('Help ({0})', [l])}>
                        <Input value={t.help || ''} onChange={(v) => setT({ help: v })} placeholder={editing.help} />
                      </Field>
                    </div>
                  );
                })}
                <div className="row gap-24">
                  <Switch checked={editing.required} onChange={(v) => setEditing({ ...editing, required: v })} label={tr('Required')} />
                  {['subscription', 'application'].includes(editing.scope) && (
                    <Switch checked={editing.portal} onChange={(v) => setEditing({ ...editing, portal: v })} label={editing.scope === 'subscription' ? tr('Asked in the request form') : tr('Filled by the consumer')} />
                  )}
                </div>
              </Modal>
            )}
          </div>
        );
      }}
    </Loader>
  );
}

// remote catalogs — an external source of truth for a set of apis
const NEW_CATALOG = { name: '', kind: 'git', url: '', ref: 'main', path: '', mode: 'draft', interval_seconds: 300, enabled: true, prune: false, headers: {} };

function CatalogFields({ c, set }) {
  return (
    <>
      <div className="grid-2">
        <Field label={tr('Name')}>
          <Input value={c.name} onChange={set('name')} />
        </Field>
        <Field label={tr('Kind')}>
          <Select
            value={c.kind}
            onChange={set('kind')}
            options={[
              { value: 'http', label: tr('HTTP (one url, yaml or json)') },
              { value: 'git', label: tr('Git repository') },
              { value: 's3', label: tr('Object store (S3)') },
            ]}
          />
        </Field>
      </div>
      <Field
        label={tr('Url')}
        hint={
          c.kind === 'git'
            ? tr('https or file url of the repository')
            : c.kind === 's3'
              ? tr('s3://<bucket>/<prefix>: every yaml and json object under the prefix')
              : tr('a yaml (multi-document) or json file of api documents')
        }
      >
        <Input value={c.url} onChange={set('url')} mono placeholder={c.kind === 's3' ? tr('s3://catalog/apis/') : ''} />
      </Field>
      {c.kind === 's3' && (
        <>
          <div className="grid-2">
            <Field label={tr('Endpoint')} hint={tr('empty for AWS; the url of another object store that speaks its api')}>
              <Input value={c.options?.endpoint || ''} onChange={(v) => set('options')({ ...(c.options || {}), endpoint: v })} mono placeholder={tr('https://s3.fr-par.scw.cloud')} />
            </Field>
            <Field label={tr('Region')}>
              <Input value={c.options?.region || ''} onChange={(v) => set('options')({ ...(c.options || {}), region: v })} mono placeholder={tr('eu-west-3')} />
            </Field>
          </div>
          <div className="grid-2">
            <Field label={tr('Access key id')}>
              <Input value={c.headers?.access_key_id || ''} onChange={(v) => set('headers')({ ...(c.headers || {}), access_key_id: v })} mono />
            </Field>
            <Field label={tr('Secret access key')} hint={tr('sealed at rest, never shown again')}>
              <Input value={c.headers?.secret_access_key || ''} onChange={(v) => set('headers')({ ...(c.headers || {}), secret_access_key: v })} mono type="password" />
            </Field>
          </div>
        </>
      )}
      {c.kind === 'git' && (
        <div className="grid-2">
          <Field label={tr('Branch or tag')}>
            <Input value={c.ref} onChange={set('ref')} mono placeholder={tr('main')} />
          </Field>
          <Field label={tr('Directory')}>
            <Input value={c.path} onChange={set('path')} mono placeholder={tr('apis/')} />
          </Field>
        </div>
      )}
      <Field label={tr('What a sync does')} hint={tr('chosen per catalog')}>
        <Select
          value={c.mode}
          onChange={set('mode')}
          options={[
            { value: 'draft', label: tr('Write the drafts — publishing stays an explicit act in the console') },
            { value: 'publish', label: tr('Publish snapshots — deploying stays explicit') },
            { value: 'deploy', label: tr('Publish and deploy — the commit is the deployment (GitOps)') },
          ]}
        />
      </Field>
      <div className="grid-2">
        <Field label={tr('Interval (seconds)')}>
          <NumberInput value={c.interval_seconds} onChange={set('interval_seconds')} />
        </Field>
        {c.kind !== 's3' && <Field label={tr('Header (e.g. a token)')}>
          <Input
            value={Object.entries(c.headers || {}).map(([k, v]) => `${k}: ${v}`).join('')}
            onChange={(v) => {
              const [k, ...rest] = v.split(':');
              set('headers')(k && rest.length ? { [k.trim()]: rest.join(':').trim() } : {});
            }}
            mono
            placeholder={tr('Authorization: Bearer …')}
          />
        </Field>}
      </div>
      <div className="row gap-24">
        <Switch checked={c.enabled} onChange={set('enabled')} label={tr('Scheduled sync')} />
        <Switch checked={c.prune} onChange={set('prune')} label={tr('Delete the apis that leave the source')} />
      </div>
    </>
  );
}

// the dry run of a sync, asked on demand — it reads the source —, then the sync itself
function CatalogPreview({ cat, onSynced }) {
  const { wapi } = useWs();
  const toast = useToast();
  const [asked, setAsked] = useState(0);
  const plan = useLoad(() => (asked ? wapi.post(`/catalogs/${cat.id}/preview`) : Promise.resolve(null)), [cat.id, asked]);
  const page = useLocalPaging(plan.data?.items, { prefix: 'plan', size: 10, text: (i) => `${i.slug} ${i.version} ${i.action} ${i.reason || ''}` });
  const [busy, setBusy] = useState(false);
  const kind = { create: 'positive', update: 'warning', delete: 'negative', conflict: 'negative', orphaned: 'info', unchanged: '' };
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="eye" />
        <h3 className="grow">{tr('Preview & sync')}</h3>
        <button className="btn sm" disabled={plan.loading} onClick={() => setAsked((n) => n + 1)}>
          <Icon name="refresh" /> {asked ? tr('Preview again') : tr('Preview a sync')}
        </button>
        <button
          className="btn sm primary"
          disabled={busy || !plan.data || plan.loading || !!plan.error}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await wapi.post(`/catalogs/${cat.id}/sync`);
              toast(r.ok ? tr('Catalog synchronised') : tr('Sync finished with errors'), r.ok ? 'info' : 'error');
              setAsked(0);
              onSynced();
            } catch (e) {
              toast(errorMessage(e), 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          <Tr text={'Sync now ({0})'} args={[cat.mode]} />
        </button>
      </div>
      <div className="card-body col gap-8">
        {!asked ? (
          <p className="muted small" style={{ margin: 0 }}>
            {tr('A dry run reads the source and says what a sync would create, update, orphan or delete; nothing is written. The sync is offered after it.')}
          </p>
        ) : (
          <Loader state={plan}>
            {(p) =>
              p && (
                <>
                  <p className="muted small" style={{ margin: 0 }}><Tr text={'A dry run: nothing is written. {0}'} args={[cat.mode === 'deploy' ? tr('This sync deploys: every change below reaches the gateway.') : '']} /></p>
                  {p.revision && <div className="small muted"><Tr text={'revision {0}{1}'} args={[<span className="mono">{String(p.revision).slice(0, 12)}</span>, p.ignored ? tr(' · {0} non-api document(s) ignored', [p.ignored]) : '']} /></div>}
                  {p.items.length > 0 && <ListToolbar paging={page} placeholder={tr('search apis, versions, actions')} />}
                  {page.items.map((i) => (
                    <div key={`${i.slug}@${i.version}`} className="panel col gap-6">
                      <div className="row">
                        <Badge kind={kind[i.action]}>{i.action}</Badge>
                        <span className="bold">
                          {i.slug} <span className="faint">{i.version}</span>
                        </span>
                        {i.adopt && <span className="badge info">{tr('will take over an api edited by hand')}</span>}
                        {i.reason && <span className="small muted">{i.reason}</span>}
                      </div>
                      {i.changes?.length > 0 && <DiffView changes={i.changes} />}
                    </div>
                  ))}
                  {p.items.length > 0 && !page.items.length && <p className="muted small">{tr('No api document matches.')}</p>}
                  {p.items.length > 0 && <Pager paging={page} total={page.total} />}
                  {!p.items.length && <p className="muted small">{tr('The source carries no api document.')}</p>}
                </>
              )
            }
          </Loader>
        )}
      </div>
    </div>
  );
}

// a remote catalog on a page of its own: its settings, its last sync, the APIs it manages, a sync
// previewed then run; a new one at …/catalogs/new
export function CatalogPage({ id }) {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const isNew = id === 'new';
  const state = useLoad(() => (isNew ? Promise.resolve(NEW_CATALOG) : wapi.get(`/catalogs/${id}`)), [id]);
  const managed = useLoad(() => (isNew ? Promise.resolve([]) : wapi.get('/apis')), [id]);
  const list = `/ws/${slug}/settings/catalogs`;
  const [form, setForm] = useState(null);
  return (
    <div className="page">
      <Loader state={state}>
        {(cat) => {
          const c = form || cat;
          const set = (k) => (v) => setForm((x) => ({ ...(x || cat), [k]: v }));
          const save = async () => {
            try {
              const saved = isNew ? await wapi.post('/catalogs', c) : await wapi.put(`/catalogs/${cat.id}`, c);
              toast(tr('Catalog saved'));
              setForm(null);
              if (isNew) navigate(`${list}/${saved.id}`, { replace: true });
              else state.reload();
            } catch (e) {
              toast(errorMessage(e), 'error');
            }
          };
          const remove = async () => {
            if (!(await confirm({ title: tr('Delete {0}?', [cat.name]), message: tr('Its apis stay, and become editable by hand again.'), danger: true, confirmLabel: tr('Delete') }))) return;
            try {
              await wapi.del(`/catalogs/${cat.id}`);
              toast(tr('Catalog deleted'));
              navigate(list);
            } catch (e) {
              toast(errorMessage(e), 'error');
            }
          };
          const apis = (managed.data || []).filter((a) => a.managed_by === `catalog:${cat.id}`);
          return (
            <>
              <PageHead
                crumbs={[{ label: tr('Workspace settings'), to: `/ws/${slug}/settings` }, { label: tr('Catalogs'), to: list }, { label: isNew ? tr('New remote catalog') : cat.name }]}
                title={isNew ? tr('New remote catalog') : cat.name}
                sub={
                  !isNew && (
                    <span className="row wrap gap-6">
                      <Badge>{cat.kind}</Badge>
                      <Badge kind="accent">{cat.mode}</Badge>
                      {!cat.enabled && <Badge>{tr('manual')}</Badge>}
                      <span className="mono small faint">
                        {cat.url}
                        {cat.ref ? ` @ ${cat.ref}` : ''}
                        {cat.path ? ` / ${cat.path}` : ''}
                      </span>
                    </span>
                  )
                }
                actions={
                  !isNew && (
                    <button className="btn ghost danger" onClick={remove}>
                      <Icon name="trash" /> {tr('Delete')}
                    </button>
                  )
                }
              />
              <div className="col gap-16">
                <div className="grid-2" style={{ alignItems: 'start' }}>
                  <div className="card">
                    <div className="card-head">
                      <Icon name="settings" />
                      <h3>{tr('Settings')}</h3>
                    </div>
                    <div className="card-body col gap-12">
                      <CatalogFields c={c} set={set} />
                      <div className="row">
                        <span className="spacer" />
                        {form && !isNew && (
                          <button className="btn" onClick={() => setForm(null)}>
                            {tr('Cancel')}
                          </button>
                        )}
                        <button className="btn primary" disabled={!c.url || (!isNew && !form)} onClick={save}>
                          {isNew ? tr('Create') : tr('Save')}
                        </button>
                      </div>
                    </div>
                  </div>
                  {!isNew && (
                    <div className="col gap-16">
                      <div className="card">
                        <div className="card-head">
                          <Icon name="refresh" />
                          <h3>{tr('Last sync')}</h3>
                        </div>
                        <div className="card-body col gap-6">
                          {cat.last_sync ? (
                            <>
                              <div className="row wrap gap-6">
                                <StatusBadge status={cat.last_sync.ok ? 'synced' : 'error'} />
                                <span className="small muted">{fmtRelative(cat.last_sync_at)}</span>
                              </div>
                              {cat.last_sync.error && <div className="negative-text small">{cat.last_sync.error}</div>}
                              {cat.last_sync.items?.length > 0 && <div className="small muted">{cat.last_sync.items.map((i) => `${i.slug} ${i.action}`).join(', ')}</div>}
                            </>
                          ) : (
                            <p className="faint small" style={{ margin: 0 }}>
                              {cat.enabled ? tr('Not synchronised yet: the first sync comes within its interval.') : tr('Not synchronised yet: its syncs are run by hand.')}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="card">
                        <div className="card-head">
                          <Icon name="api" />
                          <h3>{tr('The APIs it manages')}</h3>
                        </div>
                        <div className="card-body">
                          <Loader state={managed}>
                            {() =>
                              apis.length ? (
                                <div>
                                  {apis.map((a) => (
                                    <Link key={a.id} to={`/ws/${slug}/apis/${a.id}`} className="list-item clickable" style={{ paddingLeft: 0, paddingRight: 0 }}>
                                      <span className="grow">
                                        {a.name} <span className="faint">{a.version}</span>
                                      </span>
                                      <StatusBadge status={a.lifecycle} />
                                    </Link>
                                  ))}
                                </div>
                              ) : (
                                <p className="faint small" style={{ margin: 0 }}>
                                  {tr('None yet: a sync writes the APIs of the source.')}
                                </p>
                              )
                            }
                          </Loader>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                {!isNew && <CatalogPreview cat={cat} onSynced={() => (state.reload(), managed.reload())} />}
              </div>
            </>
          );
        }}
      </Loader>
    </div>
  );
}

function Catalogs() {
  const { wapi, slug } = useWs();
  const state = useLoad(() => wapi.get('/catalogs'), [slug]);
  const page = useLocalPaging(state.data, { prefix: 'catalogs', size: 25, text: (c) => `${c.name} ${c.kind} ${c.mode} ${c.url} ${c.ref || ''} ${c.path || ''} ${c.last_sync?.error || ''}` });
  return (
    <div className="col gap-16">
      <div className="row">
        <p className="muted small grow">
          {tr('A remote catalog — an http file or a git repository of declarative api documents — becomes the source of truth of the apis it carries. They are marked as managed by it, and the console refuses to edit them. Every sync can be previewed first.')}
        </p>
        <Link to={`/ws/${slug}/settings/catalogs/new`} className="btn primary">
          <Icon name="plus" /> {tr('Add catalog')}
        </Link>
      </div>
      <ListToolbar paging={page} placeholder={tr('search catalogs, urls, kinds, modes')} onReload={state.reload} loading={state.loading} />
      <Loader state={state}>
        {() =>
          page.items.length ? (
            <div className="card">
              {page.items.map((c) => (
                <Link key={c.id} to={`/ws/${slug}/settings/catalogs/${c.id}`} className="list-item clickable" style={{ alignItems: 'flex-start' }}>
                  <Icon name="git" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="bold">
                      {c.name} <Badge>{c.kind}</Badge> <Badge kind="accent">{c.mode}</Badge> {!c.enabled && <Badge>{tr('manual')}</Badge>}
                    </div>
                    <div className="mono tiny faint ellipsis">
                      {c.url}
                      {c.ref ? ` @ ${c.ref}` : ''}
                      {c.path ? ` / ${c.path}` : ''}
                    </div>
                    {c.last_sync && (
                      <div className="small mt-8">
                        <StatusBadge status={c.last_sync.ok ? 'synced' : 'error'} /> {fmtRelative(c.last_sync_at)}
                        {c.last_sync.error && <span className="negative-text"> — {c.last_sync.error}</span>}
                        {c.last_sync.items?.length > 0 && (
                          <span className="muted">
                            {' '}
                            — {c.last_sync.items.map((i) => `${i.slug} ${i.action}`).join(', ')}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <Icon name="chevronRight" size={14} />
                </Link>
              ))}
              <Pager paging={page} total={page.total} />
            </div>
          ) : (
            <div className="card">
              <Empty title={page.q ? tr('No catalog matches') : tr('No remote catalog')} icon="git" />
            </div>
          )
        }
      </Loader>
    </div>
  );
}

// a complete export, re-importable elsewhere
function Exchange() {
  const { wapi, slug } = useWs();
  const toast = useToast();
  const [text, setText] = useState('');
  return (
    <div className="grid-2">
      <div className="card">
        <div className="card-head">
          <Icon name="download" />
          <h3>{tr('Export')}</h3>
        </div>
        <div className="card-body col">
          <p className="muted small">{tr('Every api (one document per api-version, plans inside, documentation and snapshots beside it), application and subscription of the workspace.')}</p>
          <button
            className="btn"
            style={{ alignSelf: 'flex-start' }}
            onClick={async () => {
              const doc = await wapi.get('/export');
              const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = `${slug}-export.json`;
              a.click();
            }}
          >
            <Icon name="download" /> {tr('Download export')}
          </button>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <Icon name="upload" />
          <h3>{tr('Import')}</h3>
        </div>
        <div className="card-body col">
          <p className="muted small">{tr('Idempotent: objects are upserted by id, snapshots are never rewritten, and nothing is deployed. Paste an export document, or load a file and review it.')}</p>
          <div className="row">
            <FileButton
              accept=".json,application/json"
              onFile={(content, file) => {
                setText(content);
                toast(tr('{0} loaded — review it, then import', [file.name]));
              }}
            >
              {tr('Load a file…')}
            </FileButton>
          </div>
          <CodeEditor value={text} onChange={setText} language="json" minHeight={140} maxHeight={360} ariaLabel={tr('export document')} placeholder={tr('paste an export document')} />
          <button
            className="btn primary"
            style={{ alignSelf: 'flex-start' }}
            disabled={!text}
            onClick={async () => {
              try {
                const res = await wapi.post('/import', JSON.parse(text));
                toast(tr('Imported: {0}', [JSON.stringify(res.imported)]));
                setText('');
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            {tr('Import')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceSettingsPage({ tab }) {
  const { slug, ws, isAdmin } = useWs();
  const { navigate } = useRouter();
  // a producer reads the settings it may not change; catalogs and the export are an administrator's
  const tabs = isAdmin ? ['general', 'members', 'teams', 'metadata', 'payments', 'email', 'webhooks', 'catalogs', 'export'] : ['general', 'members', 'teams', 'metadata', 'payments'];
  const allowed = tabs.includes(tab);
  return (
    <div className="page">
      <PageHead title={tr('Workspace settings')} sub={ws.name} />
      <div className="tabs mb-16">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => navigate(`/ws/${slug}/settings/${t}`)}>
            {t === 'export' ? tr('Export / import') : tr(t[0].toUpperCase() + t.slice(1))}
          </button>
        ))}
      </div>
      {tab === 'general' && <General />}
      {tab === 'members' && <Members />}
      {tab === 'teams' && <Teams />}
      {tab === 'metadata' && <MetadataSettings />}
      {tab === 'payments' && <PaymentsSettings />}
      {tab === 'email' && allowed && <WorkspaceEmail />}
      {tab === 'webhooks' && allowed && <WebhooksSettings />}
      {tab === 'catalogs' && allowed && <Catalogs />}
      {tab === 'export' && allowed && <Exchange />}
      {!allowed && <Callout kind="info">{tr('The administrators of the workspace manage its email, its webhooks, its remote catalogs and its export.')}</Callout>}
    </div>
  );
}
