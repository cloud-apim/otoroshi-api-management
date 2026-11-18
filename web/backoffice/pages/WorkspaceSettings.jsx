import React, { useState } from 'react';
import { useRouter } from '../../shared/router.jsx';
import { Badge, Callout, Field, Icon, Input, Loader, Markdown, Modal, Select, Setting, Switch, TagsInput, TextArea, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';

function General() {
  const { wapi, ws, session } = useWs();
  const toast = useToast();
  const [f, setF] = useState({ name: ws.name, description: ws.description });
  return (
    <div className="card">
      <div className="card-body">
        <Setting label="Name" help="the workspace is the tenant — the same word on every surface: console, api, cli, crds (D-19)">
          <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} />
        </Setting>
        <Setting label="Slug" help="read from the url of its portal, never from a session (D-20)">
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
  );
}

function Portal() {
  const { wapi, ws, session } = useWs();
  const toast = useToast();
  const [p, setP] = useState(ws.portal || {});
  const set = (k) => (v) => setP((x) => ({ ...x, [k]: v }));
  return (
    <div className="col gap-16">
      <Callout kind="info">
        One portal per workspace (D-20), at <a className="link" href={`/${ws.slug}/`} target="_blank" rel="noreferrer">/{ws.slug}/</a>. Its exposure pattern — root path or hostname — is an installation setting.
      </Callout>
      <div className="card">
        <div className="card-body">
          <Setting label="Title">
            <Input value={p.title} onChange={set('title')} />
          </Setting>
          <Setting label="Tagline">
            <Input value={p.tagline} onChange={set('tagline')} />
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
          <Setting label="Languages" help="of the portal interface; the documentation pages declare their own">
            <TagsInput value={p.languages || []} onChange={set('languages')} />
            <Select value={p.defaultLanguage || 'en'} onChange={set('defaultLanguage')} options={(p.languages || ['en']).map((l) => ({ value: l, label: `default: ${l}` }))} />
          </Setting>
          <Setting label="Self signup" help="anyone can create an account and get a key on public plans">
            <Switch checked={p.selfSignup} onChange={set('selfSignup')} />
          </Setting>
          <Setting label="Identity provider" help={`One IdP per portal (D-25): the people of this workspace sign in with it and join as consumers. Redirect uri: ${window.location.origin}/${ws.slug}/front/api/auth/oidc/callback`}>
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
          <Setting label="Home page content" help="markdown, below the hero of the portal home">
            <TextArea value={p.homeMarkdown} onChange={set('homeMarkdown')} mono rows={6} />
            {p.homeMarkdown && (
              <div className="panel">
                <Markdown source={p.homeMarkdown} />
              </div>
            )}
          </Setting>
          <div className="row mt-16">
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await wapi.put('', { portal: p });
                  toast('Portal settings saved');
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
    </div>
  );
}

function Members() {
  const { wapi, slug } = useWs();
  const toast = useToast();
  const state = useLoad(() => wapi.get('/members'), [slug]);
  const [invite, setInvite] = useState({ email: '', role: 'producer' });
  return (
    <div className="col gap-16">
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
      <Loader state={state}>
        {(members) => (
          <div className="card table-wrap">
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
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="bold">{m.name}</div>
                      <div className="faint tiny">{m.email}</div>
                    </td>
                    <td>
                      <Select
                        value={m.role}
                        onChange={async (role) => {
                          await wapi.post('/members', { user_id: m.id, role });
                          state.reload();
                        }}
                        options={['admin', 'producer', 'consumer']}
                        style={{ width: 140 }}
                      />
                    </td>
                    <td className="small">
                      {(m.tags || []).map((t) => (
                        <span key={t} className="tag" style={{ marginRight: 4 }}>
                          {t}
                        </span>
                      ))}
                    </td>
                    <td className="actions">
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
                    </td>
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
  const { wapi } = useWs();
  const toast = useToast();
  const state = useLoad(() => wapi.get(`/teams/${id}`), [id]);
  const [email, setEmail] = useState('');
  return (
    <Modal title="Team members" onClose={onClose}>
      <Loader state={state}>
        {(t) => (
          <>
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
            {t.members.map((m) => (
              <div key={m.id} className="row">
                <span className="grow">
                  {m.name} <span className="faint small">{m.email}</span>
                </span>
                <Badge>{m.role}</Badge>
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
              </div>
            ))}
          </>
        )}
      </Loader>
    </Modal>
  );
}

// PX-07: a complete export, re-importable elsewhere
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
          <p className="muted small">Idempotent: objects are upserted by id, snapshots are never rewritten, and nothing is deployed.</p>
          <TextArea value={text} onChange={setText} mono rows={6} placeholder="paste an export document" />
          <button
            className="btn"
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
  const { slug, ws } = useWs();
  const { navigate } = useRouter();
  const tabs = ['general', 'portal', 'members', 'teams', 'export'];
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
      {tab === 'export' && <Exchange />}
    </div>
  );
}
