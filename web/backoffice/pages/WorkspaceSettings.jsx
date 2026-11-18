import React, { useState } from 'react';
import { useRouter } from '../../shared/router.jsx';
import { Badge, Callout, DiffView, Empty, Field, FileButton, Icon, Input, Loader, Markdown, Modal, NumberInput, Seg, Select, Setting, StatusBadge, Switch, TagsInput, TextArea, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { CodeEditor } from '../../shared/code-editor.jsx';
import { fmtRelative } from '../../shared/lib.js';
import { useWs, useMetadataFields } from '../context.jsx';
import { MetadataForm } from '../../shared/metadata.jsx';
import { PageHead } from '../layout.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../shared/lists.jsx';

// what a producer may read but not change: disabled, with the reason
function ReadOnly({ when, children }) {
  if (!when) return children;
  return (
    <>
      <Callout kind="info">Read only: the administrators of the workspace change these settings.</Callout>
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
        <Setting label="Name" help="the workspace is the tenant — the same word on every surface: console, api, cli, crds">
          <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} />
        </Setting>
        <Setting label="Slug" help="read from the url of its portal, never from a session">
          <Input value={ws.slug} disabled mono />
        </Setting>
        <Setting label="Description">
          <TextArea value={f.description} onChange={(v) => setF({ ...f, description: v })} rows={2} />
        </Setting>
        <div className="row mt-16">
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await wapi.put('', f);
                toast('Workspace saved');
                session.reload();
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
    </ReadOnly>
  );
}

// a text of the portal: one string per language; a plain string is the default language's
const asLocalized = (v, def) => (v && typeof v === 'object' ? v : v ? { [def]: v } : {});

function Portal() {
  const { wapi, ws, session, isAdmin } = useWs();
  const ro = !isAdmin;
  const toast = useToast();
  const [p, setP] = useState(ws.portal || {});
  const set = (k) => (v) => setP((x) => ({ ...x, [k]: v }));
  const languages = p.languages?.length ? p.languages : ['en'];
  const def = languages.includes(p.defaultLanguage) ? p.defaultLanguage : languages[0];
  const [lang, setLang] = useState(def);
  const current = languages.includes(lang) ? lang : def;
  const [view, setView] = useState('write');
  const text = (k) => asLocalized(p[k], def)[current] || '';
  const setText = (k) => (v) => setP((x) => ({ ...x, [k]: { ...asLocalized(x[k], def), [current]: v } }));
  const missing = (l) => ['title', 'tagline', 'homeMarkdown'].filter((k) => asLocalized(p[k], def)[def] && !asLocalized(p[k], def)[l]);
  const save = async () => {
    try {
      // the texts are saved per language, the old plain strings with them
      const portal = { ...p, title: asLocalized(p.title, def), tagline: asLocalized(p.tagline, def), homeMarkdown: asLocalized(p.homeMarkdown, def) };
      await wapi.put('', { portal });
      setP(portal);
      toast('Portal settings saved');
      session.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="col gap-16">
      {ro && <Callout kind="info">Read only: the administrators of the workspace change the portal.</Callout>}
      <Callout kind="info">
        One portal per workspace, at <a className="link" href={`/${ws.slug}/`} target="_blank" rel="noreferrer">/{ws.slug}/</a>. Its exposure pattern — root path or hostname — is an installation setting.
      </Callout>
      <div className="card">
        <div className="card-head">
          <h3 className="grow">Content</h3>
          <Seg
            value={current}
            onChange={setLang}
            options={languages.map((l) => ({ value: l, label: `${l.toUpperCase()}${l === def ? ' · default' : ''}${missing(l).length ? ' · …' : ''}` }))}
          />
        </div>
        <div className="card-body">
          {current !== def && missing(current).length > 0 && (
            <Callout kind="info">Not written in {current.toUpperCase()} yet: {missing(current).map((k) => ({ title: 'title', tagline: 'tagline', homeMarkdown: 'home page' })[k]).join(', ')} — the portal shows the {def.toUpperCase()} text meanwhile.</Callout>
          )}
          <Setting label={`Title (${current})`} help="the name of the portal, in its header and the browser tab">
            <Input value={text('title')} onChange={setText('title')} placeholder={current !== def ? asLocalized(p.title, def)[def] : ''} disabled={ro} />
          </Setting>
          <Setting label={`Tagline (${current})`} help="below the title, on the home page">
            <Input value={text('tagline')} onChange={setText('tagline')} placeholder={current !== def ? asLocalized(p.tagline, def)[def] : ''} disabled={ro} />
          </Setting>
          <Setting label={`Home page (${current})`} help="markdown, below the hero of the portal home">
            <Seg
              value={view}
              onChange={setView}
              options={[
                { value: 'write', label: 'Write' },
                { value: 'preview', label: 'Preview' },
              ]}
            />
            {view === 'write' ? (
              <CodeEditor key={current} value={text('homeMarkdown')} onChange={setText('homeMarkdown')} readOnly={ro} language="markdown" wordWrap="on" minHeight={260} maxHeight={640} ariaLabel={`home page (${current})`} placeholder="# Markdown" />
            ) : (
              <div className="panel" style={{ background: 'var(--surface)' }}>
                {text('homeMarkdown') ? <Markdown source={text('homeMarkdown')} /> : <span className="muted small">Nothing written yet.</span>}
              </div>
            )}
          </Setting>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Settings</h3>
        </div>
        <fieldset disabled={ro} className="ro-fieldset card-body">
          <Setting label="Languages" help="of the portal: its interface (English and French today) and its texts above; the documentation pages declare their own">
            <TagsInput value={p.languages || []} onChange={set('languages')} />
            <Select value={def} onChange={set('defaultLanguage')} options={languages.map((l) => ({ value: l, label: `default: ${l}` }))} />
          </Setting>
          <Setting label="Accent color">
            <div className="row">
              <input type="color" value={p.accentColor || '#0061bd'} onChange={(e) => set('accentColor')(e.target.value)} aria-label="accent color" />
              <Input value={p.accentColor} onChange={set('accentColor')} mono />
            </div>
          </Setting>
          <Setting label="Logo url">
            <Input value={p.logoUrl} onChange={set('logoUrl')} />
          </Setting>
          <Setting label="Self signup" help="anyone can create an account and get a key on public plans">
            <Switch checked={p.selfSignup} onChange={set('selfSignup')} />
          </Setting>
          <Setting label="Identity provider" help={`One IdP per portal: the people of this workspace sign in with it and join as consumers. Redirect uri: ${window.location.origin}/${ws.slug}/front/api/auth/oidc/callback`}>
            <Switch checked={p.oidc?.enabled} onChange={(v) => set('oidc')({ ...p.oidc, enabled: v })} label="Sign in with an OpenID Connect provider" />
            {p.oidc?.enabled && (
              <>
                <Input value={p.oidc?.label} onChange={(v) => set('oidc')({ ...p.oidc, label: v })} placeholder="button label, e.g. Corporate SSO" />
                <Input value={p.oidc?.issuer} onChange={(v) => set('oidc')({ ...p.oidc, issuer: v })} mono placeholder="issuer" />
                <div className="row">
                  <Input value={p.oidc?.clientId} onChange={(v) => set('oidc')({ ...p.oidc, clientId: v })} mono placeholder="client id" />
                  <Input value={p.oidc?.clientSecret} onChange={(v) => set('oidc')({ ...p.oidc, clientSecret: v })} mono type="password" placeholder="client secret" />
                </div>
                <Switch checked={p.localLogin !== false} onChange={set('localLogin')} label="Keep local accounts on this portal" />
              </>
            )}
          </Setting>
        </fieldset>
      </div>
      {!ro && (
        <div className="row">
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      )}
    </div>
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
      {!isAdmin && <Callout kind="info">Read only: the administrators of the workspace choose its members and their roles.</Callout>}
      {isAdmin && (
      <div className="card">
        <div className="card-body row wrap">
          <Input value={invite.email} onChange={(v) => setInvite({ ...invite, email: v })} placeholder="email" />
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
            Add member
          </button>
        </div>
      </div>
      )}
      <ListToolbar paging={membersPage} placeholder="search members, emails, roles, tags" onReload={state.reload} loading={state.loading} />
      <Loader state={state}>
        {() => (
          <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>Tags</th>
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
                        aria-label="remove member"
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
        )}
      </Loader>
    </div>
  );
}

function Teams() {
  const { wapi, slug } = useWs();
  const toast = useToast();
  const state = useLoad(() => wapi.get('/teams'), [slug]);
  const [name, setName] = useState('');
  const [open, setOpen] = useState(null);
  return (
    <div className="col gap-16">
      <div className="card">
        <div className="card-body row">
          <Input value={name} onChange={setName} placeholder="team name" />
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
            Create team
          </button>
        </div>
      </div>
      <Loader state={state}>
        {(teams) => (
          <div className="card">
            {teams.map((t) => (
              <div key={t.id} className="list-item">
                <Icon name="users" />
                <div className="grow">
                  <div className="bold">
                    {t.name} {t.personal && <Badge>personal</Badge>}
                  </div>
                  <div className="faint tiny mono">team:{t.id}</div>
                </div>
                <span className="muted small">{t.members_count} member(s)</span>
                <button className="btn sm" onClick={() => setOpen(t.id)}>
                  Members
                </button>
              </div>
            ))}
          </div>
        )}
      </Loader>
      {open && <TeamMembers id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TeamMembers({ id, onClose }) {
  const { wapi, isAdmin, session } = useWs();
  const toast = useToast();
  const state = useLoad(() => wapi.get(`/teams/${id}`), [id]);
  const [email, setEmail] = useState('');
  return (
    <Modal title="Team members" onClose={onClose}>
      <Loader state={state}>
        {(t) => {
          const manages = isAdmin || t.members.some((m) => m.id === session.user.id && m.role === 'owner');
          return (
          <>
            {!manages && <Callout kind="info">The owners of the team and the administrators of the workspace choose its members.</Callout>}
            {manages && (
            <div className="row">
              <Input value={email} onChange={setEmail} placeholder="email of a workspace member" />
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await wapi.post(`/teams/${id}/members`, { email });
                    setEmail('');
                    state.reload();
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }}
              >
                Add
              </button>
            </div>
            )}
            {t.members.map((m) => (
              <div key={m.id} className="row">
                <span className="grow">
                  {m.name} <span className="faint small">{m.email}</span>
                </span>
                <Badge>{m.role}</Badge>
                {manages && (
                <button
                  className="btn ghost sm icon"
                  aria-label="remove"
                  onClick={async () => {
                    await wapi.del(`/teams/${id}/members/${m.id}`);
                    state.reload();
                  }}
                >
                  <Icon name="trash" />
                </button>
                )}
              </div>
            ))}
          </>
          );
        }}
      </Loader>
    </Modal>
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
  return (
    <Loader state={state}>
      {(stored) => {
        const list = fields || stored;
        const save = async () => {
          try {
            await wapi.put('/metadata-fields', { fields: list });
            setFields(null);
            toast('Metadata fields saved');
            state.reload();
          } catch (e) {
            toast(errorMessage(e), 'error');
          }
        };
        return (
          <ReadOnly when={!isAdmin}>
          <div className="col gap-16">
            <Callout kind="info">
              Typed key/values attached to an object, wherever the model cannot foresee everything. They serve display, notifications and the review of requests, and are never projected on the gateway.
              On the subscription scope, the fields marked <b>portal</b> form the request form of every plan.
            </Callout>
            <div className="card">
              <div className="card-head">
                <h3 className="grow">Fields</h3>
                <button className="btn sm" onClick={() => setEditing({ scope: 'subscription', key: '', label: '', type: 'string', options: [], required: false, portal: false, help: '', _new: true })}>
                  <Icon name="plus" /> Add field
                </button>
              </div>
              {list.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Scope</th>
                        <th>Key</th>
                        <th>Label</th>
                        <th>Type</th>
                        <th>Flags</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((f, i) => (
                        <tr key={`${f.scope}:${f.key}`}>
                          <td>
                            <Badge>{f.scope}</Badge>
                          </td>
                          <td className="mono small">{f.key}</td>
                          <td>{f.label}</td>
                          <td className="small">{f.type === 'enum' ? `enum (${f.options.join(', ')})` : f.type}</td>
                          <td className="small">
                            {f.required && <Badge kind="warning">required</Badge>} {f.portal && <Badge kind="accent">portal</Badge>}
                          </td>
                          <td className="actions">
                            <button className="btn ghost sm icon" onClick={() => setEditing({ ...f, _index: i })} aria-label="edit">
                              <Icon name="edit" />
                            </button>
                            <button className="btn ghost sm icon" onClick={() => setFields(list.filter((_, j) => j !== i))} aria-label="remove">
                              <Icon name="trash" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="card-body muted small">No field declared.</div>
              )}
              {fields && (
                <div className="card-body row" style={{ borderTop: '1px solid var(--border)' }}>
                  <button className="btn primary sm" onClick={save}>
                    Save fields
                  </button>
                  <button className="btn sm" onClick={() => setFields(null)}>
                    Discard
                  </button>
                </div>
              )}
            </div>
            {wsFields.length > 0 && (
              <div className="card">
                <div className="card-head">
                  <h3>Values of this workspace</h3>
                </div>
                <div className="card-body col">
                  <MetadataForm fields={wsFields} values={values || ws.metadata} onChange={setValues} />
                  <button
                    className="btn primary"
                    style={{ alignSelf: 'flex-start' }}
                    disabled={!values}
                    onClick={async () => {
                      try {
                        await wapi.put('', { metadata: values });
                        setValues(null);
                        toast('Saved');
                        session.reload();
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
            {editing && (
              <Modal
                title={editing._new ? 'New field' : `Field ${editing.key}`}
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
                    Apply
                  </button>
                }
              >
                <div className="grid-2">
                  <Field label="Scope">
                    <Select value={editing.scope} onChange={(v) => setEditing({ ...editing, scope: v })} options={SCOPES.map(([value, label]) => ({ value, label }))} />
                  </Field>
                  <Field label="Type">
                    <Select value={editing.type} onChange={(v) => setEditing({ ...editing, type: v })} options={TYPES} />
                  </Field>
                </div>
                <div className="grid-2">
                  <Field label="Key" hint="lowercase, stable: it is what the api and the exports carry">
                    <Input value={editing.key} onChange={(v) => setEditing({ ...editing, key: v })} mono />
                  </Field>
                  <Field label="Label">
                    <Input value={editing.label} onChange={(v) => setEditing({ ...editing, label: v })} />
                  </Field>
                </div>
                {editing.type === 'enum' && (
                  <Field label="Options">
                    <TagsInput value={editing.options} onChange={(v) => setEditing({ ...editing, options: v })} />
                  </Field>
                )}
                <Field label="Help">
                  <Input value={editing.help} onChange={(v) => setEditing({ ...editing, help: v })} />
                </Field>
                <div className="row gap-24">
                  <Switch checked={editing.required} onChange={(v) => setEditing({ ...editing, required: v })} label="Required" />
                  {['subscription', 'application'].includes(editing.scope) && (
                    <Switch checked={editing.portal} onChange={(v) => setEditing({ ...editing, portal: v })} label={editing.scope === 'subscription' ? 'Asked in the request form' : 'Filled by the consumer'} />
                  )}
                </div>
              </Modal>
            )}
          </div>
          </ReadOnly>
        );
      }}
    </Loader>
  );
}

// remote catalogs — an external source of truth for a set of apis
function CatalogModal({ value, onClose, onSaved }) {
  const { wapi } = useWs();
  const toast = useToast();
  const [c, setC] = useState(value);
  const set = (k) => (v) => setC((x) => ({ ...x, [k]: v }));
  return (
    <Modal
      title={value.id ? `Catalog ${value.name}` : 'New remote catalog'}
      size="wide"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!c.url}
          onClick={async () => {
            try {
              const saved = c.id ? await wapi.put(`/catalogs/${c.id}`, c) : await wapi.post('/catalogs', c);
              onSaved(saved);
            } catch (e) {
              toast(errorMessage(e), 'error');
            }
          }}
        >
          Save
        </button>
      }
    >
      <div className="grid-2">
        <Field label="Name">
          <Input value={c.name} onChange={set('name')} />
        </Field>
        <Field label="Kind">
          <Select value={c.kind} onChange={set('kind')} options={[{ value: 'http', label: 'HTTP (one url, yaml or json)' }, { value: 'git', label: 'Git repository' }]} />
        </Field>
      </div>
      <Field label="Url" hint={c.kind === 'git' ? 'https or file url of the repository' : 'a yaml (multi-document) or json file of api documents'}>
        <Input value={c.url} onChange={set('url')} mono />
      </Field>
      {c.kind === 'git' && (
        <div className="grid-2">
          <Field label="Branch or tag">
            <Input value={c.ref} onChange={set('ref')} mono placeholder="main" />
          </Field>
          <Field label="Directory">
            <Input value={c.path} onChange={set('path')} mono placeholder="apis/" />
          </Field>
        </div>
      )}
      <Field label="What a sync does" hint="chosen per catalog">
        <Select
          value={c.mode}
          onChange={set('mode')}
          options={[
            { value: 'draft', label: 'Write the drafts — publishing stays an explicit act in the console' },
            { value: 'publish', label: 'Publish snapshots — deploying stays explicit' },
            { value: 'deploy', label: 'Publish and deploy — the commit is the deployment (GitOps)' },
          ]}
        />
      </Field>
      <div className="grid-2">
        <Field label="Interval (seconds)">
          <NumberInput value={c.interval_seconds} onChange={set('interval_seconds')} />
        </Field>
        <Field label="Header (e.g. a token)">
          <Input
            value={Object.entries(c.headers || {}).map(([k, v]) => `${k}: ${v}`).join('')}
            onChange={(v) => {
              const [k, ...rest] = v.split(':');
              set('headers')(k && rest.length ? { [k.trim()]: rest.join(':').trim() } : {});
            }}
            mono
            placeholder="Authorization: Bearer …"
          />
        </Field>
      </div>
      <div className="row gap-24">
        <Switch checked={c.enabled} onChange={set('enabled')} label="Scheduled sync" />
        <Switch checked={c.prune} onChange={set('prune')} label="Delete the apis that leave the source" />
      </div>
    </Modal>
  );
}

function PreviewModal({ cat, onClose, onSynced }) {
  const { wapi } = useWs();
  const toast = useToast();
  const plan = useLoad(() => wapi.post(`/catalogs/${cat.id}/preview`), [cat.id]);
  const [busy, setBusy] = useState(false);
  const kind = { create: 'positive', update: 'warning', delete: 'negative', conflict: 'negative', orphaned: 'info', unchanged: '' };
  return (
    <Modal
      title={`Preview — ${cat.name}`}
      size="wide"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={busy || plan.loading || !!plan.error}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await wapi.post(`/catalogs/${cat.id}/sync`);
              toast(r.ok ? 'Catalog synchronised' : `Sync finished with errors`, r.ok ? 'info' : 'error');
              onSynced();
            } catch (e) {
              toast(errorMessage(e), 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          Sync now ({cat.mode})
        </button>
      }
    >
      <p className="muted small">A dry run: nothing is written. {cat.mode === 'deploy' ? 'This sync deploys: every change below reaches the gateway.' : ''}</p>
      <Loader state={plan}>
        {(p) => (
          <>
            {p.revision && <div className="small muted">revision <span className="mono">{String(p.revision).slice(0, 12)}</span>{p.ignored ? ` · ${p.ignored} non-api document(s) ignored` : ''}</div>}
            {p.items.map((i) => (
              <div key={`${i.slug}@${i.version}`} className="panel col gap-6">
                <div className="row">
                  <Badge kind={kind[i.action]}>{i.action}</Badge>
                  <span className="bold">
                    {i.slug} <span className="faint">{i.version}</span>
                  </span>
                  {i.adopt && <span className="badge info">will take over an api edited by hand</span>}
                  {i.reason && <span className="small muted">{i.reason}</span>}
                </div>
                {i.changes?.length > 0 && <DiffView changes={i.changes} />}
              </div>
            ))}
            {!p.items.length && <p className="muted small">The source carries no api document.</p>}
          </>
        )}
      </Loader>
    </Modal>
  );
}

function Catalogs() {
  const { wapi, slug } = useWs();
  const toast = useToast();
  const confirm = useConfirm();
  const state = useLoad(() => wapi.get('/catalogs'), [slug]);
  const [editing, setEditing] = useState(null);
  const [previewing, setPreviewing] = useState(null);
  return (
    <div className="col gap-16">
      <div className="row">
        <p className="muted small grow">
          A remote catalog — an http file or a git repository of declarative api documents — becomes the source of truth of the apis it carries. They are marked as managed by it, and the console
          refuses to edit them. Every sync can be previewed first.
        </p>
        <button className="btn primary" onClick={() => setEditing({ name: '', kind: 'git', url: '', ref: 'main', path: '', mode: 'draft', interval_seconds: 300, enabled: true, prune: false, headers: {} })}>
          <Icon name="plus" /> Add catalog
        </button>
      </div>
      <Loader state={state}>
        {(list) =>
          list.length ? (
            <div className="card">
              {list.map((c) => (
                <div key={c.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <Icon name="git" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="bold">
                      {c.name} <Badge>{c.kind}</Badge> <Badge kind="accent">{c.mode}</Badge> {!c.enabled && <Badge>manual</Badge>}
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
                  <button className="btn sm" onClick={() => setPreviewing(c)}>
                    Preview & sync
                  </button>
                  <button className="btn ghost sm icon" onClick={() => setEditing(c)} aria-label="edit">
                    <Icon name="edit" />
                  </button>
                  <button
                    className="btn ghost sm icon"
                    aria-label="delete"
                    onClick={async () => {
                      if (!(await confirm({ title: `Delete ${c.name}?`, message: 'Its apis stay, and become editable by hand again.', danger: true, confirmLabel: 'Delete' }))) return;
                      await wapi.del(`/catalogs/${c.id}`);
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
              <Empty title="No remote catalog" icon="git" />
            </div>
          )
        }
      </Loader>
      {editing && (
        <CatalogModal
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast('Catalog saved');
            state.reload();
          }}
        />
      )}
      {previewing && (
        <PreviewModal
          cat={previewing}
          onClose={() => setPreviewing(null)}
          onSynced={() => {
            setPreviewing(null);
            state.reload();
          }}
        />
      )}
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
          <h3>Export</h3>
        </div>
        <div className="card-body col">
          <p className="muted small">Every api (one document per api-version, plans inside, documentation and snapshots beside it), application and subscription of the workspace.</p>
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
            <Icon name="download" /> Download export
          </button>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <Icon name="upload" />
          <h3>Import</h3>
        </div>
        <div className="card-body col">
          <p className="muted small">Idempotent: objects are upserted by id, snapshots are never rewritten, and nothing is deployed. Paste an export document, or load a file and review it.</p>
          <div className="row">
            <FileButton
              accept=".json,application/json"
              onFile={(content, file) => {
                setText(content);
                toast(`${file.name} loaded — review it, then import`);
              }}
            >
              Load a file…
            </FileButton>
          </div>
          <CodeEditor value={text} onChange={setText} language="json" minHeight={140} maxHeight={360} ariaLabel="export document" placeholder="paste an export document" />
          <button
            className="btn primary"
            style={{ alignSelf: 'flex-start' }}
            disabled={!text}
            onClick={async () => {
              try {
                const res = await wapi.post('/import', JSON.parse(text));
                toast(`Imported: ${JSON.stringify(res.imported)}`);
                setText('');
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            Import
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
  const tabs = isAdmin ? ['general', 'portal', 'members', 'teams', 'metadata', 'catalogs', 'export'] : ['general', 'portal', 'members', 'teams', 'metadata'];
  const allowed = tabs.includes(tab);
  return (
    <div className="page">
      <PageHead title="Workspace settings" sub={ws.name} />
      <div className="tabs mb-16">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => navigate(`/ws/${slug}/settings/${t}`)}>
            {t === 'portal' ? 'Developer portal' : t === 'export' ? 'Export / import' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'general' && <General />}
      {tab === 'portal' && <Portal />}
      {tab === 'members' && <Members />}
      {tab === 'teams' && <Teams />}
      {tab === 'metadata' && <MetadataSettings />}
      {tab === 'catalogs' && allowed && <Catalogs />}
      {tab === 'export' && allowed && <Exchange />}
      {!allowed && <Callout kind="info">The administrators of the workspace manage its remote catalogs and its export.</Callout>}
    </div>
  );
}
