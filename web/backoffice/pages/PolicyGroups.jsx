import React, { useState } from 'react';
import { Link, useRouter } from '../../shared/router.jsx';
import { fmtDate, fmtRelative } from '../../shared/lib.js';
import { Badge, Callout, Empty, Field, Icon, Input, Loader, Modal, StatusBadge, TextArea, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { api as rootApi, useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { PluginModal, PluginRow, moveItem } from './api/tabs.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';

// shared policy groups: a named composition of Otoroshi plugins with its own lifecycle
export function ApisTabs({ current }) {
  const { slug } = useWs();
  return (
    <div className="tabs mb-16">
      <Link to={`/ws/${slug}/apis`} className={current === 'apis' ? 'on' : ''}>
        {tr('APIs')}
      </Link>
      <Link to={`/ws/${slug}/policy-groups`} className={current === 'groups' ? 'on' : ''}>
        {tr('Shared policy groups')}
      </Link>
    </div>
  );
}

export function PolicyGroupsPage() {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const state = useLoad(() => wapi.get('/policy-groups'), [slug]);
  const [creating, setCreating] = useState(null);
  return (
    <div className="page">
      <PageHead
        title={tr('Shared policy groups')}
        sub={tr('Name a composition of Otoroshi plugins once, govern it, use it on many APIs. An API pins a published version: publishing a group never changes what runs until each API is upgraded.')}
        actions={
          <button className="btn primary" onClick={() => setCreating({ name: '', description: '' })}>
            <Icon name="plus" /> {tr('New group')}
          </button>
        }
      />
      <ApisTabs current="groups" />
      <Loader state={state}>
        {(groups) =>
          groups.length ? (
            <div className="card table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{tr('Group')}</th>
                    <th>{tr('Version')}</th>
                    <th>{tr('Used by')}</th>
                    <th>{tr('Updated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.id} className="clickable" onClick={() => navigate(`/ws/${slug}/policy-groups/${g.id}`)}>
                      <td>
                        <div className="bold">{g.name}</div>
                        <div className="faint tiny">{g.description}</div>
                      </td>
                      <td>{g.last_version ? <Badge kind="accent"><Tr text={'v{0}'} args={[g.last_version]} /></Badge> : <StatusBadge status="created" label={tr('draft only')} />}</td>
                      <td className="small">
                        <Tr text={'{0} API(s){1}'} args={[g.usage.length, g.usage.some((u) => u.behind) && (
                          <span className="badge warning" style={{ marginLeft: 6 }}>
                            <Tr text={'{0} behind'} args={[g.usage.filter((u) => u.behind).length]} />
                          </span>
                        )]} />
                      </td>
                      <td className="muted small">{fmtRelative(g.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card">
              <Empty title={tr('No shared policy group')} icon="layers">
                {tr('For example: the security headers, the WAF and the CORS policy every public API must carry.')}
              </Empty>
            </div>
          )
        }
      </Loader>
      {creating && (
        <Modal
          title={tr('New policy group')}
          onClose={() => setCreating(null)}
          footer={
            <button
              className="btn primary"
              disabled={!creating.name}
              onClick={async () => {
                try {
                  const g = await wapi.post('/policy-groups', creating);
                  navigate(`/ws/${slug}/policy-groups/${g.id}`);
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
            <Input value={creating.description} onChange={(v) => setCreating({ ...creating, description: v })} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

export function PolicyGroupPage({ id }) {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const state = useLoad(() => wapi.get(`/policy-groups/${id}`), [id]);
  const catalog = useLoad(() => rootApi.get('/gateway/plugins').catch(() => []), []);
  const [draft, setDraft] = useState(null);
  const [editing, setEditing] = useState(null);
  const [comment, setComment] = useState('');
  return (
    <div className="page">
      <Loader state={state}>
        {(g) => {
          const plugins = draft || g.draft.plugins || [];
          const last = g.versions[0];
          const changed = !last || JSON.stringify(last.plugins) !== JSON.stringify(g.draft.plugins);
          return (
            <>
              <PageHead crumbs={[{ label: tr('Shared policy groups'), to: `/ws/${slug}/policy-groups` }, { label: g.name }]} title={g.name} sub={g.description} />
              <div className="grid-2" style={{ alignItems: 'start' }}>
                <div className="col gap-16">
                  <div className="card">
                    <div className="card-head">
                      <h3 className="grow">{tr('Draft')}</h3>
                      <button className="btn sm" onClick={() => setEditing({ index: -1, value: { plugin: '', enabled: true, include: [], exclude: [], config: {} } })}>
                        <Icon name="plus" /> {tr('Add plugin')}
                      </button>
                    </div>
                    {plugins.length ? (
                      plugins.map((p, i) => (
                        <PluginRow
                          key={i}
                          index={i}
                          count={plugins.length}
                          plugin={p}
                          catalog={catalog.data}
                          onMove={(delta) => setDraft(moveItem(plugins, i, delta))}
                          onEdit={() => setEditing({ index: i, value: p })}
                          onRemove={() => setDraft(plugins.filter((_, j) => j !== i))}
                        />
                      ))
                    ) : (
                      <div className="card-body muted small">{tr('No plugin yet.')}</div>
                    )}
                    {draft && (
                      <div className="card-body row" style={{ borderTop: '1px solid var(--border)' }}>
                        <button
                          className="btn primary sm"
                          onClick={async () => {
                            try {
                              await wapi.put(`/policy-groups/${id}`, { plugins: draft });
                              setDraft(null);
                              toast(tr('Draft saved'));
                              state.reload();
                            } catch (e) {
                              toast(errorMessage(e), 'error');
                            }
                          }}
                        >
                          {tr('Save draft')}
                        </button>
                        <button className="btn sm" onClick={() => setDraft(null)}>
                          {tr('Discard')}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="card">
                    <div className="card-head">
                      <h3>{tr('Publish a version')}</h3>
                    </div>
                    <div className="card-body col">
                      {!changed ? (
                        <p className="muted small"><Tr text={'The draft is identical to v{0}.'} args={[last?.number]} /></p>
                      ) : (
                        <>
                          <Input value={comment} onChange={setComment} placeholder={tr('what changes')} />
                          <button
                            className="btn primary"
                            style={{ alignSelf: 'flex-start' }}
                            disabled={!!draft}
                            title={draft ? tr('save the draft first') : ''}
                            onClick={async () => {
                              try {
                                const v = await wapi.post(`/policy-groups/${id}/publish`, { comment });
                                toast(tr('v{0} published — the APIs using the group stay on their pinned version', [v.number]));
                                setComment('');
                                state.reload();
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
                    {g.usage.length ? (
                      g.usage.map((u) => (
                        <Link key={u.id} to={`/ws/${slug}/apis/${u.id}/flows`} className="list-item" style={{ display: 'flex' }}>
                          <span className="grow bold">
                            {u.name} <span className="faint">{u.version}</span>
                          </span>
                          <span className="small"><Tr text={'pins v{0}'} args={[u.pinned.join(', v')]} /></span>
                          {u.behind ? <span className="badge warning"><Tr text={'behind v{0}'} args={[u.latest]} /></span> : <span className="badge positive">{tr('latest')}</span>}
                        </Link>
                      ))
                    ) : (
                      <div className="card-body muted small">{tr('No API uses this group yet: add it from the policy flows of an API.')}</div>
                    )}
                    {g.usage.some((u) => u.behind) && (
                      <div className="card-body">
                        <Callout kind="info">{tr("Upgrading is an edit of each API's draft, then a publication: what runs only changes through a snapshot.")}</Callout>
                      </div>
                    )}
                  </div>
                  <div className="card">
                    <div className="card-head">
                      <h3>{tr('Versions')}</h3>
                    </div>
                    {g.versions.map((v) => (
                      <div key={v.id} className="list-item">
                        <Badge kind="accent"><Tr text={'v{0}'} args={[v.number]} /></Badge>
                        <span className="grow small">{v.comment || <span className="faint">{tr('no comment')}</span>}</span>
                        <span className="faint small">
                          {fmtDate(v.published_at)} · {v.published_by_email}
                        </span>
                      </div>
                    ))}
                    {!g.versions.length && <div className="card-body muted small">{tr('Never published.')}</div>}
                  </div>
                  <button
                    className="btn danger"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={async () => {
                      if (!(await confirm({ title: tr('Delete {0}?', [g.name]), danger: true, confirmLabel: tr('Delete'), message: tr('Only possible when no API uses it.') }))) return;
                      try {
                        await wapi.del(`/policy-groups/${id}`);
                        navigate(`/ws/${slug}/policy-groups`);
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }}
                  >
                    <Icon name="trash" /> {tr('Delete group')}
                  </button>
                </div>
              </div>
              {editing && (
                <PluginModal
                  value={editing.value}
                  catalog={catalog.data}
                  onClose={() => setEditing(null)}
                  onSave={(p) => {
                    setDraft(editing.index < 0 ? [...plugins, p] : plugins.map((x, j) => (j === editing.index ? p : x)));
                    setEditing(null);
                  }}
                />
              )}
            </>
          );
        }}
      </Loader>
    </div>
  );
}
