import React, { useEffect, useState } from 'react';
import { useQuery, useRouter } from '../../shared/router.jsx';
import { Badge, Callout, CopyButton, Empty, Field, Icon, Input, Loader, Modal, Select, Setting, StatusBadge, Switch, TagsInput, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { CodeView } from '../../shared/code-editor.jsx';
import { ListToolbar, Pager, useLocalPaging, usePaging } from '../../shared/lists.jsx';
import { fmtDate, fmtRelative } from '../../shared/lib.js';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { tr } from '../../shared/i18n.jsx';

// The outgoing webhooks of a workspace: its events — what its audit trail records — sent to endpoints,
// signed as Standard Webhooks, retried, kept and replayed by hand.
// the webhook just created, for its page to show its secret once
let justMade = null;

export function WebhooksSettings() {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const state = useLoad(() => wapi.get('/webhooks'), []);
  const page = useLocalPaging(state.data, { prefix: 'hooks', size: 10, text: (x) => `${x.name} ${x.url} ${(x.types || []).join(' ')}` });
  const [params] = useQuery();
  const [creating, setCreating] = useState(false);
  const pageOf = (id) => `/ws/${slug}/settings/webhooks/${id}`;
  // the links of before, ?open=<id>, lead to the page of the webhook
  const legacy = params.get('open');
  useEffect(() => {
    if (legacy) navigate(pageOf(legacy), { replace: true });
  }, [legacy]);
  return (
    <div className="col gap-16">
      <p className="muted small" style={{ margin: 0 }}>
        {tr('The events of this workspace — what its audit trail records — sent to your endpoints, signed as Standard Webhooks: each one tried again at 5 s, 5 min, 30 min, 2 h, 5 h, 10 h and 10 h, then kept 30 days and replayed by hand.')}
      </p>
      <ListToolbar paging={page} placeholder={tr('search names, urls, types')} onReload={state.reload} loading={state.loading}>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> {tr('New webhook')}
        </button>
      </ListToolbar>
      <Loader state={state}>
        {() =>
          page.items.length ? (
            <div className="card">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{tr('Webhook')}</th>
                      <th>{tr('Events')}</th>
                      <th>{tr('Status')}</th>
                      <th className="right">{tr('Waiting')}</th>
                      <th className="right">{tr('Failed')}</th>
                      <th>{tr('Last delivered')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((h) => (
                      <tr key={h.id} className="clickable" onClick={() => navigate(pageOf(h.id))}>
                        <td>
                          <div className="bold">{h.name}</div>
                          <div className="faint tiny mono">{h.url}</div>
                        </td>
                        <td className="small">{h.types.join(', ')}</td>
                        <td>
                          <HookStatus h={h} />
                        </td>
                        <td className="right">{h.pending}</td>
                        <td className="right">{h.failed ? <Badge kind="negative">{h.failed}</Badge> : 0}</td>
                        <td className="small muted">{h.last_success ? fmtRelative(h.last_success) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager paging={page} total={page.total} />
            </div>
          ) : (
            <div className="card">
              <Empty title={state.data?.length ? tr('No webhook matches') : tr('No webhook yet')} icon={state.data?.length ? 'search' : 'external'} />
            </div>
          )
        }
      </Loader>
      {creating && (
        <HookForm
          onClose={() => setCreating(false)}
          onSaved={(h) => {
            justMade = h;
            navigate(pageOf(h.id));
          }}
        />
      )}
    </div>
  );
}

function HookStatus({ h }) {
  if (!h.enabled) return <StatusBadge status="revoked" label={h.disabled_reason ? tr('off: {0}', [h.disabled_reason]) : tr('off')} />;
  if (h.failing_since) return <StatusBadge status="failed" label={tr('failing since {0}', [fmtRelative(h.failing_since)])} />;
  return <StatusBadge status="enabled" label={tr('on')} />;
}

// what a webhook is made of: its name, its url, the events it takes, on or off
const formOf = (hook) => ({ name: hook?.name || '', url: hook?.url || '', types: hook?.types || ['*'], enabled: hook ? hook.enabled : true });

function HookFields({ f, setF }) {
  const { wapi } = useWs();
  const types = useLoad(() => wapi.get('/webhook-types'), []);
  return (
    <>
      <Field label={tr('Name')}>
        <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} autoFocus placeholder={tr('e.g. CRM')} />
      </Field>
      <Field label={tr('URL')} hint={tr('where the events are posted; an address of a private network only when the installation allows it')}>
        <Input value={f.url} onChange={(v) => setF({ ...f, url: v })} mono placeholder="https://example.com/webhooks/apim" />
      </Field>
      <Field label={tr('Events')} hint={tr('* for every write of the trail; a family, as subscription.*; or an action, as api.announcement.publish. A read (credential.read) only when named.')}>
        <TagsInput value={f.types} onChange={(v) => setF({ ...f, types: v })} placeholder={tr('add and press enter')} />
        {types.data?.length > 0 && (
          <div className="row wrap gap-4 mt-8">
            {types.data
              // the ones it does not take already, by name or by family
              .filter((t) => !f.types.some((x) => x === t || (x.endsWith('.*') && t.startsWith(x.slice(0, -1)))))
              .slice(0, 24)
              .map((t) => (
                <button key={t} type="button" className="btn sm ghost" onClick={() => setF({ ...f, types: [...f.types.filter((x) => x !== '*'), t] })}>
                  + {t}
                </button>
              ))}
          </div>
        )}
      </Field>
      <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label={tr('On')} />
    </>
  );
}

// a new webhook
function HookForm({ onClose, onSaved }) {
  const { wapi } = useWs();
  const toast = useToast();
  const [f, setF] = useState(formOf(null));
  const save = async () => {
    try {
      const saved = await wapi.post('/webhooks', f);
      toast(tr('Webhook created'));
      onSaved(saved);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <Modal
      title={tr('New webhook')}
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!f.url || !f.types.length} onClick={save}>
          {tr('Create')}
        </button>
      }
    >
      <HookFields f={f} setF={setF} />
    </Modal>
  );
}

// a webhook on a page of its own: its endpoint, its secret, a test, its deliveries — searched, paged,
// each unfolded in place and replayed —, the failed since a date; Edit turns the page into its form
export function WebhookPage({ id }) {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const state = useLoad(() => wapi.get(`/webhooks/${id}`), [id]);
  const [form, setForm] = useState(null);
  // its secret shown once when it was just created, then on demand
  const [made] = useState(() => {
    const m = justMade?.id === id ? justMade : null;
    justMade = null;
    return m;
  });
  const [secret, setSecret] = useState(made?.secret || null);
  const [since, setSince] = useState('');
  const page = usePaging({ prefix: 'dlv', size: 10 });
  const [params, setParams] = useQuery();
  const status = params.get('dlv_status') || '';
  const [open, setOpen] = useState(null);
  const list = useLoad(() => wapi.get(`/webhooks/${id}/deliveries?${page.query}${status ? `&status=${status}` : ''}`), [id, page.key, status]);
  const settings = `/ws/${slug}/settings/webhooks`;
  const act = async (fn, done) => {
    try {
      const r = await fn();
      if (done) toast(typeof done === 'function' ? done(r) : done);
      list.reload();
      state.reload();
      return r;
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="page">
      <Loader state={state}>
        {(hook) => {
          const remove = async () => {
            if (!(await confirm({ title: tr('Delete the webhook {0}?', [hook.name]), message: tr('Its endpoint gets no event any more; its deliveries go with it.'), danger: true, confirmLabel: tr('Delete') }))) return;
            try {
              await wapi.del(`/webhooks/${hook.id}`);
              toast(tr('Webhook deleted'));
              navigate(settings);
            } catch (e) {
              toast(errorMessage(e), 'error');
            }
          };
          const rotate = async () => {
            if (!(await confirm({ title: tr('A new secret for {0}?', [hook.name]), message: tr('The previous one still signs beside it for a day: the time for the receiver to take the new one.'), confirmLabel: tr('Rotate') }))) return;
            const r = await act(() => wapi.post(`/webhooks/${hook.id}/rotate`), tr('Secret rotated: the previous one signs for a day more'));
            if (r) setSecret(r.secret);
          };
          return (
            <>
              <PageHead
                crumbs={[{ label: tr('Workspace settings'), to: `/ws/${slug}/settings` }, { label: tr('Webhooks'), to: settings }, { label: hook.name }]}
                title={form ? tr('Edit {0}', [hook.name]) : hook.name}
                sub={
                  <span className="row wrap gap-6">
                    <HookStatus h={hook} />
                    <span className="mono small">{hook.url}</span>
                  </span>
                }
                actions={
                  !form && (
                    <>
                      <button className="btn ghost danger" onClick={remove}>
                        <Icon name="trash" /> {tr('Delete')}
                      </button>
                      <button className="btn" onClick={() => act(() => wapi.put(`/webhooks/${hook.id}`, { enabled: !hook.enabled }), hook.enabled ? tr('Webhook turned off') : tr('Webhook turned on'))}>
                        {hook.enabled ? tr('Turn off') : tr('Turn on')}
                      </button>
                      <button className="btn primary" onClick={() => setForm(formOf(hook))}>
                        <Icon name="edit" /> {tr('Edit')}
                      </button>
                    </>
                  )
                }
              />
              {form ? (
                <div className="card card-body col gap-12">
                  <HookFields f={form} setF={setForm} />
                  <div className="row">
                    <span className="spacer" />
                    <button className="btn" onClick={() => setForm(null)}>
                      {tr('Cancel')}
                    </button>
                    <button
                      className="btn primary"
                      disabled={!form.url || !form.types.length}
                      onClick={async () => {
                        if (await act(() => wapi.put(`/webhooks/${hook.id}`, form), tr('Webhook saved'))) setForm(null);
                      }}
                    >
                      {tr('Save')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="col gap-16">
                  {made && (
                    <Callout kind="positive" title={tr('Webhook {0} created: its secret', [made.name])}>
                      <div className="small">{tr('Its receiver verifies each request with it. It can be read again from the webhook.')}</div>
                    </Callout>
                  )}
                  <div className="card card-body">
                    <Setting label={tr('Events')}>
                      <div className="small">{hook.types.join(', ')}</div>
                    </Setting>
                    <Setting label={tr('Secret')} help={tr('whsec_…: its receiver verifies the webhook-signature of each request with it (Standard Webhooks)')}>
                      <div className="row wrap">
                        <code className="mono small">{secret || hook.secret}</code>
                        {secret ? (
                          <CopyButton text={secret} label={tr('Copy')} />
                        ) : (
                          <button className="btn sm" onClick={async () => setSecret((await act(() => wapi.post(`/webhooks/${hook.id}/secret`)))?.secret || null)}>
                            <Icon name="eye" /> {tr('Reveal')}
                          </button>
                        )}
                        <button className="btn sm" onClick={rotate}>
                          <Icon name="refresh" /> {tr('Rotate')}
                        </button>
                        {hook.rotating && <Badge kind="info">{tr('the previous one signs until {0}', [fmtDate(hook.previous_until)])}</Badge>}
                      </div>
                    </Setting>
                    <Setting label={tr('Test')} help={tr('an event webhook.test, sent at once, tried once')}>
                      <div className="row">
                        <button className="btn sm" onClick={() => act(() => wapi.post(`/webhooks/${hook.id}/test`), (d) => (d.status === 'succeeded' ? tr('The endpoint answered {0}', [d.last_status]) : tr('Not delivered: {0}', [d.last_error])))}>
                          <Icon name="play" /> {tr('Send a test')}
                        </button>
                      </div>
                    </Setting>
                  </div>
                  <div className="col gap-8">
                    <h3 style={{ margin: 0 }}>{tr('Deliveries')}</h3>
                    <ListToolbar paging={page} placeholder={tr('search types, ids, errors')} onReload={list.reload} loading={list.loading}>
                      <Select
                        value={status}
                        onChange={(v) => setParams({ dlv_status: v || null, dlv_page: null })}
                        options={[
                          { value: '', label: tr('All statuses') },
                          { value: 'pending', label: tr('pending') },
                          { value: 'succeeded', label: tr('succeeded') },
                          { value: 'failed', label: tr('failed') },
                        ]}
                        style={{ width: 160 }}
                        aria-label={tr('filter by status')}
                      />
                    </ListToolbar>
                    <div className="row wrap">
                      <input className="input" type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} aria-label={tr('since')} style={{ width: 220 }} />
                      <button className="btn sm" disabled={!since} onClick={() => act(() => wapi.post(`/webhooks/${hook.id}/recover`, { since: new Date(since).toISOString() }), (r) => tr('{0} failed delivery(ies) replayed', [r.replayed]))}>
                        {tr('Replay the failed since this date')}
                      </button>
                    </div>
                    <Loader state={list}>
                      {(l) =>
                        l.items.length ? (
                          <div className="card">
                            <div className="table-wrap">
                              <table className="table">
                                <thead>
                                  <tr>
                                    <th>{tr('Event')}</th>
                                    <th>{tr('Status')}</th>
                                    <th className="right">{tr('Attempts')}</th>
                                    <th>{tr('Last answer')}</th>
                                    <th>{tr('When')}</th>
                                    <th />
                                  </tr>
                                </thead>
                                <tbody>
                                  {l.items.map((d) => (
                                    <React.Fragment key={d.id}>
                                      <tr className="clickable" onClick={() => setOpen(open === d.id ? null : d.id)}>
                                        <td>
                                          <div>{d.type}</div>
                                          <div className="faint tiny mono">{d.id}</div>
                                        </td>
                                        <td>
                                          <StatusBadge status={d.status} />
                                          {d.status === 'pending' && d.attempts > 0 && <div className="faint tiny">{tr('next {0}', [fmtRelative(d.next_at)])}</div>}
                                        </td>
                                        <td className="right">{d.attempts}</td>
                                        <td className="small">
                                          {d.last_status ?? '—'}
                                          {d.last_error && <div className="faint tiny">{d.last_error}</div>}
                                        </td>
                                        <td className="small muted">{fmtDate(d.created_at)}</td>
                                        <td className="right">
                                          {d.status !== 'pending' && (
                                            <button
                                              className="btn sm"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                act(() => wapi.post(`/webhooks/${hook.id}/deliveries/${d.id}/redeliver`), (r) => (r.status === 'succeeded' ? tr('Delivered') : tr('Not delivered: {0}', [r.last_error])));
                                              }}
                                            >
                                              {tr('Replay')}
                                            </button>
                                          )}
                                        </td>
                                      </tr>
                                      {open === d.id && (
                                        <tr>
                                          <td colSpan={6}>
                                            <DeliveryDetail hook={hook} id={d.id} />
                                          </td>
                                        </tr>
                                      )}
                                    </React.Fragment>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <Pager paging={page} total={l.total} />
                          </div>
                        ) : (
                          <div className="card">
                            <Empty title={page.q || status ? tr('No delivery matches') : tr('No delivery yet')} icon="inbox" />
                          </div>
                        )
                      }
                    </Loader>
                  </div>
                </div>
              )}
            </>
          );
        }}
      </Loader>
    </div>
  );
}

// what was sent, and what the endpoint answered last
function DeliveryDetail({ hook, id }) {
  const { wapi } = useWs();
  const d = useLoad(() => wapi.get(`/webhooks/${hook.id}/deliveries/${id}`), [id]);
  return (
    <Loader state={d}>
      {(x) => (
        <div className="col gap-8">
          <CodeView value={JSON.stringify(x.payload, null, 2)} language="json" maxHeight={300} />
          {x.last_response && (
            <div className="small">
              <span className="faint">{tr('Answer')}: </span>
              <code className="mono">{x.last_response}</code>
            </div>
          )}
        </div>
      )}
    </Loader>
  );
}
