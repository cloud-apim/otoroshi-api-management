import React, { useState } from 'react';
import { Link, useRouter } from '../../shared/router.jsx';
import { fmtDate, fmtRelative } from '../../shared/lib.js';
import { Badge, Callout, Empty, Field, Icon, Input, Loader, Modal, StatusBadge, TextArea, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { api as rootApi, useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { ApisTabs } from './PolicyGroups.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';

const EMPTY = { issuer: '', jwksUrl: '', discoveryUrl: '', userInfoUrl: '', clientId: '', clientSecret: '', scope: 'openid' };

// shared resources: a dependency a plan consumes — an authorization server — named once, published
// by versions, pinned by the plans that use it
export function SharedResourcesPage() {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const state = useLoad(() => wapi.get('/shared-resources'), [slug]);
  const [creating, setCreating] = useState(null);
  return (
    <div className="page">
      <PageHead
        title={tr('Shared resources')}
        sub={tr('A dependency the plans consume, described once — an authorization server: its issuer, its keys, its endpoints. A plan pins a published version instead of describing it again; publishing a new version changes nothing until each API is upgraded.')}
        actions={
          <button className="btn primary" onClick={() => setCreating({ name: '', description: '' })}>
            <Icon name="plus" /> {tr('New authorization server')}
          </button>
        }
      />
      <ApisTabs current="resources" />
      <Loader state={state}>
        {(list) =>
          list.length ? (
            <div className="card table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{tr('Resource')}</th>
                    <th>{tr('Version')}</th>
                    <th>{tr('Used by')}</th>
                    <th>{tr('Updated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/ws/${slug}/shared-resources/${r.id}`)}>
                      <td>
                        <div className="bold">{r.name}</div>
                        <div className="faint tiny">{r.draft?.issuer || r.description}</div>
                      </td>
                      <td>{r.last_version ? <Badge kind="accent"><Tr text={'v{0}'} args={[r.last_version]} /></Badge> : <StatusBadge status="created" label={tr('draft only')} />}</td>
                      <td className="small">
                        <Tr
                          text={'{0} API(s){1}'}
                          args={[
                            r.usage.length,
                            r.usage.some((u) => u.behind) && (
                              <span className="badge warning" style={{ marginLeft: 6 }}>
                                <Tr text={'{0} behind'} args={[r.usage.filter((u) => u.behind).length]} />
                              </span>
                            ),
                          ]}
                        />
                      </td>
                      <td className="muted small">{fmtRelative(r.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card">
              <Empty title={tr('No shared resource')} icon="layers">
                {tr('For example: the identity provider of the company, that every jwt and oauth2 plan validates its tokens with.')}
              </Empty>
            </div>
          )
        }
      </Loader>
      {creating && (
        <Modal
          title={tr('New authorization server')}
          onClose={() => setCreating(null)}
          footer={
            <button
              className="btn primary"
              disabled={!creating.name}
              onClick={async () => {
                try {
                  const r = await wapi.post('/shared-resources', { ...creating, kind: 'authorization-server' });
                  navigate(`/ws/${slug}/shared-resources/${r.id}`);
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
              }}
            >
              {tr('Create')}
            </button>
          }
        >
          <Field label={tr('Name')}>
            <Input value={creating.name} onChange={(v) => setCreating({ ...creating, name: v })} autoFocus />
          </Field>
          <Field label={tr('Description')}>
            <TextArea value={creating.description} onChange={(v) => setCreating({ ...creating, description: v })} rows={2} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

export function SharedResourcePage({ id }) {
  const { wapi } = useWs();
  const state = useLoad(() => wapi.get(`/shared-resources/${id}`), [id]);
  return <Loader state={state}>{(r) => <ResourceEditor key={r.updated_at + (r.versions[0]?.number || 0)} r={r} reload={state.reload} />}</Loader>;
}

function ResourceEditor({ r, reload }) {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [c, setC] = useState({ ...EMPTY, ...(r.draft || {}) });
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch) => setC((x) => ({ ...x, ...patch }));
  const last = r.versions[0];
  const dirty = JSON.stringify({ ...EMPTY, ...(r.draft || {}) }) !== JSON.stringify(c);
  const changed = !last || JSON.stringify(last.content) !== JSON.stringify(r.draft);
  const save = async () => {
    try {
      await wapi.put(`/shared-resources/${r.id}`, { content: c });
      toast(tr('Draft saved'));
      reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const discover = async () => {
    setBusy(true);
    try {
      const d = await rootApi.post('/oidc/discovery', { url: c.discoveryUrl });
      set({ discoveryUrl: d.discoveryUrl, jwksUrl: d.jwksUrl || c.jwksUrl, userInfoUrl: d.userInfoUrl || c.userInfoUrl, issuer: d.issuer || c.issuer });
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <PageHead
        crumbs={[{ label: tr('Shared resources'), to: `/ws/${slug}/shared-resources` }, { label: r.name }]}
        title={r.name}
        sub={r.description}
        actions={
          <>
            <button
              className="btn danger"
              onClick={async () => {
                if (!(await confirm({ title: tr('Delete {0}?', [r.name]), danger: true, confirmLabel: tr('Delete'), message: tr('Only possible once no plan pins it.') }))) return;
                try {
                  await wapi.del(`/shared-resources/${r.id}`);
                  navigate(`/ws/${slug}/shared-resources`);
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
              }}
            >
              <Icon name="trash" /> {tr('Delete')}
            </button>
            <button className="btn primary" disabled={!dirty} onClick={save}>
              {tr('Save draft')}
            </button>
          </>
        }
      />
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="col gap-16">
          <div className="card">
            <div className="card-head">
              <h3>{tr('Draft')}</h3>
            </div>
            <div className="card-body col gap-12">
              <Field label={tr('Discovery')} hint={tr('the server, or its .well-known/openid-configuration: fills the fields below')}>
                <div className="row" style={{ width: '100%' }}>
                  <div className="grow">
                    <Input value={c.discoveryUrl} onChange={(v) => set({ discoveryUrl: v })} mono placeholder={tr('https://idp.example/realms/partners')} />
                  </div>
                  <button className="btn" disabled={!c.discoveryUrl || busy} onClick={discover}>
                    <Icon name="search" /> {tr('Discover')}
                  </button>
                </div>
              </Field>
              <Field label={tr('Issuer')} hint={tr('the iss its tokens carry: the plans check it')}>
                <Input value={c.issuer} onChange={(v) => set({ issuer: v })} mono />
              </Field>
              <Field label={tr('JWKS url')} hint={tr('the keys the tokens are signed with')}>
                <Input value={c.jwksUrl} onChange={(v) => set({ jwksUrl: v })} mono />
              </Field>
              <Field label={tr('Userinfo url')} hint={tr('where an oauth2-remote plan fetches the user profile, when it asks for it')}>
                <Input value={c.userInfoUrl} onChange={(v) => set({ userInfoUrl: v })} mono />
              </Field>
              <div className="grid-2">
                <Field label={tr('Client id')} hint={tr('of the gateway at the server, if it needs one')}>
                  <Input value={c.clientId} onChange={(v) => set({ clientId: v })} mono />
                </Field>
                <Field label={tr('Client secret')}>
                  <Input value={c.clientSecret} onChange={(v) => set({ clientSecret: v })} mono type="password" placeholder={tr('secret, or a vault reference ${vault://…}')} />
                </Field>
              </div>
              <Field label={tr('Scope')}>
                <Input value={c.scope} onChange={(v) => set({ scope: v })} mono />
              </Field>
              {c.clientSecret && !c.clientSecret.startsWith('${vault://') && <Callout kind="warning">{tr('The client secret is kept in clear in the versions and the snapshots: prefer a vault reference.')}</Callout>}
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3>{tr('Publish a version')}</h3>
            </div>
            <div className="card-body col">
              {!changed ? (
                <p className="muted small">
                  <Tr text={'The draft is identical to v{0}.'} args={[last?.number]} />
                </p>
              ) : (
                <>
                  <Input value={comment} onChange={setComment} placeholder={tr('what changes')} />
                  <button
                    className="btn primary"
                    style={{ alignSelf: 'flex-start' }}
                    disabled={dirty}
                    title={dirty ? tr('save the draft first') : ''}
                    onClick={async () => {
                      try {
                        const v = await wapi.post(`/shared-resources/${r.id}/publish`, { comment });
                        toast(tr('v{0} published — the plans using it stay on their pinned version', [v.number]));
                        setComment('');
                        reload();
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }}
                  >
                    <Tr text={'Publish v{0}'} args={[(last?.number || 0) + 1]} />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="col gap-16">
          <div className="card">
            <div className="card-head">
              <h3 className="grow">{tr('Used by')}</h3>
            </div>
            {r.usage.length ? (
              r.usage.map((u) => (
                <Link key={u.id} to={`/ws/${slug}/apis/${u.id}/plans`} className="list-item" style={{ display: 'flex' }}>
                  <span className="grow">
                    {u.name} {u.version}
                  </span>
                  <span className="small muted">
                    <Tr text={'pins v{0}'} args={[u.pinned.join(', v')]} />
                  </span>
                  {u.behind && (
                    <span className="badge warning" style={{ marginLeft: 6 }}>
                      {tr('behind')}
                    </span>
                  )}
                </Link>
              ))
            ) : (
              <div className="card-body muted small">{tr('No plan pins it yet: a jwt or oauth2-remote plan chooses it in its Access tab.')}</div>
            )}
          </div>
          <div className="card">
            <div className="card-head">
              <h3>{tr('Versions')}</h3>
            </div>
            {r.versions.length ? (
              r.versions.map((v) => (
                <div key={v.id} className="list-item" style={{ display: 'flex' }}>
                  <Badge kind="accent">
                    <Tr text={'v{0}'} args={[v.number]} />
                  </Badge>
                  <span className="grow small" style={{ marginLeft: 8 }}>
                    {v.comment || '—'}
                  </span>
                  <span className="faint tiny">
                    {fmtDate(v.published_at)}
                    {v.published_by_email ? ` · ${v.published_by_email}` : ''}
                  </span>
                </div>
              ))
            ) : (
              <div className="card-body muted small">{tr('No version yet: publish one, and the plans can pin it.')}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
