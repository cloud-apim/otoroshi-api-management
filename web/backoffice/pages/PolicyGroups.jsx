import React, { useState } from 'react';
import { Link, useRouter } from '../../shared/router.jsx';
import { fmtDate, fmtRelative } from '../../shared/lib.js';
import { Badge, Callout, Empty, Field, Icon, Input, Loader, Modal, StatusBadge, Switch, TextArea, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { api as rootApi, useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../shared/lists.jsx';
import { PluginModal, PluginRow, moveItem } from './api/tabs.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';

const UPGRADE_KIND = { upgraded: 'accent', published: 'positive', deployed: 'positive', skipped: 'warning', error: 'negative' };

// the apis behind a shared object — a policy group, a shared resource — moved to its latest version:
// each by its own draft, and on demand its own snapshot and deployment. Nothing propagates by itself
export function UpgradeModal({ path, name, latest, behind, onClose, onDone }) {
  const { wapi, slug } = useWs();
  const toast = useToast();
  const [publish, setPublish] = useState(false);
  const [deploy, setDeploy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const list = done ? done.results : behind;
  const page = useLocalPaging(list, { local: true, size: 10, text: (u) => `${u.name} ${u.version} ${u.action || ''} ${u.reason || ''}` });
  const run = async () => {
    setBusy(true);
    try {
      setDone(await wapi.post(`${path}/upgrade`, { publish, deploy: publish && deploy }));
      onDone?.();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={tr('Upgrade the APIs behind to v{0}', [latest])}
      onClose={onClose}
      footer={
        done ? (
          <button className="btn" onClick={onClose}>
            {tr('Close')}
          </button>
        ) : (
          <button className="btn primary" disabled={busy || !behind.length} onClick={run}>
            <Tr text={'Upgrade {0} API(s)'} args={[behind.length]} />
          </button>
        )
      }
    >
      <div className="col gap-12">
        <p className="muted small">
          <Tr text={'{0} stays where each API pinned it until it is upgraded: an edit of its draft, then, when asked, a snapshot and a deployment of its own — every step in the audit trail.'} args={[<span className="bold">{name}</span>]} />
        </p>
        {!done && (
          <div className="col gap-6">
            <Switch checked={publish} onChange={setPublish} label={tr('Also publish a snapshot of each API')} />
            <Switch checked={publish && deploy} disabled={!publish} onChange={setDeploy} label={tr('and deploy it, where it runs')} />
            <Callout kind="info">{tr('An API managed by a source is upgraded at its source; one you do not manage is left to its team; one whose draft holds other unpublished changes is upgraded in its draft only — publishing would ship them along.')}</Callout>
          </div>
        )}
        {list.length > 1 && <ListToolbar paging={page} placeholder={tr('search apis, versions')} />}
        <div className="card">
          {page.items.map((u) => (
            <div key={u.id} className="list-item" style={{ display: 'flex', alignItems: 'flex-start' }}>
              <div className="grow">
                <Link to={`/ws/${slug}/apis/${u.id}`} className="bold">
                  {u.name} <span className="faint">{u.version}</span>
                </Link>
                {u.reason && <div className="faint tiny">{u.reason}</div>}
              </div>
              <span className="small muted">
                <Tr text={'v{0} → v{1}'} args={[(u.from || u.pinned).join(', v'), latest]} />
              </span>
              {u.action && (
                <span className={`badge ${UPGRADE_KIND[u.action] || ''}`} style={{ marginLeft: 6 }}>
                  {tr(u.action)}
                  {u.snapshot ? ` #${u.snapshot}` : ''}
                </span>
              )}
            </div>
          ))}
          {!page.items.length && <div className="card-body muted small">{page.q ? tr('No matching API') : tr('No API behind.')}</div>}
          <Pager paging={page} total={page.total} />
        </div>
      </div>
    </Modal>
  );
}

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
      <Link to={`/ws/${slug}/shared-resources`} className={current === 'resources' ? 'on' : ''}>
        {tr('Shared resources')}
      </Link>
      <Link to={`/ws/${slug}/dictionaries`} className={current === 'dictionaries' ? 'on' : ''}>
        {tr('Dictionaries')}
      </Link>
    </div>
  );
}

export function PolicyGroupsPage() {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const state = useLoad(() => wapi.get('/policy-groups'), [slug]);
  const page = useLocalPaging(state.data, {
    size: 25,
    text: (g) => `${g.name} ${g.description || ''} ${g.id} ${g.last_version ? `v${g.last_version}` : 'draft'} ${g.usage.map((u) => `${u.name} ${u.version}`).join(' ')}`,
  });
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
      <ListToolbar paging={page} placeholder={tr('search groups, apis')} onReload={state.reload} loading={state.loading} />
      <Loader state={state}>
        {() =>
          page.items.length ? (
            <div className="card">
              <div className="table-wrap">
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
                  {page.items.map((g) => (
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
              <Pager paging={page} total={page.total} />
            </div>
          ) : (
            <div className="card">
              <Empty title={page.q ? tr('No policy group matches') : tr('No shared policy group')} icon="layers">
                {page.q ? null : tr('For example: the security headers, the WAF and the CORS policy every public API must carry.')}
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
  const [upgrading, setUpgrading] = useState(false);
  const usedPage = useLocalPaging(state.data?.usage, { prefix: 'used', size: 10, text: (u) => `${u.name} ${u.version} ${u.id} v${u.pinned.join(' v')} ${u.behind ? `behind v${u.latest}` : 'latest'}` });
  const versionsPage = useLocalPaging(state.data?.versions, { prefix: 'versions', size: 10, text: (v) => `v${v.number} ${v.comment || ''} ${v.published_by_email || ''}` });
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
                      {g.usage.some((u) => u.behind) && (
                        <button className="btn sm" onClick={() => setUpgrading(true)}>
                          <Icon name="refresh" /> <Tr text={'Upgrade the {0} behind'} args={[g.usage.filter((u) => u.behind).length]} />
                        </button>
                      )}
                    </div>
                    {g.usage.length ? (
                      <>
                        <div className="card-body" style={{ paddingBottom: 0 }}>
                          <ListToolbar paging={usedPage} placeholder={tr('search apis, versions')} />
                        </div>
                        <div>
                          {usedPage.items.map((u) => (
                            <Link key={u.id} to={`/ws/${slug}/apis/${u.id}/flows`} className="list-item" style={{ display: 'flex' }}>
                              <span className="grow bold">
                                {u.name} <span className="faint">{u.version}</span>
                              </span>
                              <span className="small"><Tr text={'pins v{0}'} args={[u.pinned.join(', v')]} /></span>
                              {u.behind ? <span className="badge warning"><Tr text={'behind v{0}'} args={[u.latest]} /></span> : <span className="badge positive">{tr('latest')}</span>}
                            </Link>
                          ))}
                        </div>
                        {!usedPage.items.length && <div className="card-body muted small">{tr('No matching API')}</div>}
                        <Pager paging={usedPage} total={usedPage.total} />
                      </>
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
                    {g.versions.length ? (
                      <>
                        <div className="card-body" style={{ paddingBottom: 0 }}>
                          <ListToolbar paging={versionsPage} placeholder={tr('search numbers, comments, people')} />
                        </div>
                        <div>
                          {versionsPage.items.map((v) => (
                            <div key={v.id} className="list-item">
                              <Badge kind="accent"><Tr text={'v{0}'} args={[v.number]} /></Badge>
                              <span className="grow small">{v.comment || <span className="faint">{tr('no comment')}</span>}</span>
                              <span className="faint small">
                                {fmtDate(v.published_at)} · {v.published_by_email}
                              </span>
                            </div>
                          ))}
                        </div>
                        {!versionsPage.items.length && <div className="card-body muted small">{tr('No version matches.')}</div>}
                        <Pager paging={versionsPage} total={versionsPage.total} />
                      </>
                    ) : (
                      <div className="card-body muted small">{tr('Never published.')}</div>
                    )}
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
              {upgrading && (
                <UpgradeModal
                  path={`/policy-groups/${g.id}`}
                  name={g.name}
                  latest={g.last_version}
                  behind={g.usage.filter((u) => u.behind)}
                  onClose={() => setUpgrading(false)}
                  onDone={state.reload}
                />
              )}
            </>
          );
        }}
      </Loader>
    </div>
  );
}
