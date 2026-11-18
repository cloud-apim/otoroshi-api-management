import React, { useState } from 'react';
import { useQuery, Link } from '../../shared/router.jsx';
import { AUTH_LABELS, fmtDate, fmtRelative } from '../../shared/lib.js';
import { Badge, Callout, DiffView, Drawer, Empty, Field, Icon, Loader, Secret, Select, StatusBadge, TextArea, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { useWs, useMetadataFields } from '../context.jsx';
import { MetadataForm } from '../../shared/metadata.jsx';
import { PageHead } from '../layout.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../shared/lists.jsx';

export function SubscriptionsTable({ query = '', showApi = true, showApp = true, onChanged }) {
  const { wapi } = useWs();
  const [params, setParams] = useQuery();
  const status = params.get('status') || '';
  const open = params.get('open');
  const state = useLoad(() => wapi.get(`/subscriptions?${query}${status ? `&status=${status}` : ''}`), [query, status]);
  const page = useLocalPaging(state.data, {
    prefix: 'subs',
    size: 25,
    text: (x) => `${x.application_name} ${x.team_name} ${x.api_name} ${x.api_version} ${x.request?.plan_name || x.plan_id} ${x.status} ${x.requested_by_email} ${x.id}`,
  });
  return (
    <div className="col gap-16">
      <ListToolbar paging={page} placeholder="search applications, teams, apis, plans, people" onReload={state.reload} loading={state.loading}>
        <Select
          value={status}
          onChange={(v) => setParams({ status: v, subs_page: null })}
          options={[
            { value: '', label: 'All statuses' },
            ...['pending', 'pending_payment', 'active', 'suspended', 'rejected', 'closed'].map((s) => ({ value: s, label: s.replace('_', ' ') })),
          ]}
          aria-label="filter by status"
          style={{ width: 200 }}
        />
      </ListToolbar>
      <Loader state={state}>
        {() =>
          page.items.length ? (
            <div className="card">
              <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {showApp && <th>Application</th>}
                    {showApi && <th>API</th>}
                    <th>Plan</th>
                    <th>Status</th>
                    <th>Gateway</th>
                    <th>Requested</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((s) => (
                    <tr key={s.id} className="clickable" onClick={() => setParams({ open: s.id })}>
                      {showApp && (
                        <td>
                          <div className="bold">{s.application_name}</div>
                          <div className="faint tiny">{s.team_name}</div>
                        </td>
                      )}
                      {showApi && (
                        <td>
                          {s.api_name} <span className="faint">{s.api_version}</span>
                        </td>
                      )}
                      <td>
                        <div>{s.request?.plan_name || s.plan_id}</div>
                        <div className="faint tiny">{AUTH_LABELS[s.auth_kind]}</div>
                      </td>
                      <td>
                        <StatusBadge status={s.status} />
                      </td>
                      <td>
                        <StatusBadge status={s.projection?.status || 'none'} />
                      </td>
                      <td className="muted small">
                        <div>{fmtRelative(s.created_at)}</div>
                        <div className="faint tiny">{s.requested_by_email}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <Pager paging={page} total={page.total} />
            </div>
          ) : (
            <div className="card">
              <Empty title={page.q ? 'No subscription matches' : 'No subscription'} icon="inbox">
                {page.q ? null : 'Consumers subscribe to the published plans from the developer portal.'}
              </Empty>
            </div>
          )
        }
      </Loader>
      {open && (
        <SubscriptionDrawer
          id={open}
          onClose={() => setParams({ open: null })}
          onChanged={() => {
            state.reload();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

export function SubscriptionDrawer({ id, onClose, onChanged }) {
  const { wapi, slug } = useWs();
  const toast = useToast();
  const confirm = useConfirm();
  const state = useLoad(() => wapi.get(`/subscriptions/${id}`), [id]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState(null);
  const metaFields = useMetadataFields('subscription');
  const [meta, setMeta] = useState(null);

  const act = async (action, body = {}, label) => {
    setBusy(true);
    try {
      await wapi.post(`/subscriptions/${id}/${action}`, body);
      toast(label || `Subscription ${action}ed`);
      setMessage('');
      state.reload();
      onChanged?.();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title="Subscription" subtitle={id} onClose={onClose}>
      <Loader state={state}>
        {(s) => (
          <>
            <div className="row wrap">
              <StatusBadge status={s.status} />
              <Badge>{AUTH_LABELS[s.auth_kind]}</Badge>
              <span className="muted small">gateway: </span>
              <StatusBadge status={s.projection?.status || 'none'} />
            </div>
            {s.projection?.error && <Callout kind="warning" title="Projection">{s.projection.error}</Callout>}
            <dl className="kv">
              <dt>Application</dt>
              <dd>
                <Link to={`/ws/${slug}/applications/${s.application_id}`} className="link">
                  {s.application_name}
                </Link>
              </dd>
              <dt>API</dt>
              <dd>
                <Link to={`/ws/${slug}/apis/${s.api_id}/subscriptions`} className="link">
                  {s.api_name} {s.api_version}
                </Link>
              </dd>
              <dt>Plan</dt>
              <dd>
                {s.request?.plan_name} <span className="faint mono">{s.plan_id}</span>
              </dd>
              <dt>Requested</dt>
              <dd>{fmtDate(s.created_at)}</dd>
              {s.dates?.processed_at && (
                <>
                  <dt>Processed</dt>
                  <dd>{fmtDate(s.dates.processed_at)}</dd>
                </>
              )}
              {s.dates?.suspended_at && (
                <>
                  <dt>Suspended</dt>
                  <dd>{fmtDate(s.dates.suspended_at)}</dd>
                </>
              )}
              {s.review?.decision && (
                <>
                  <dt>Review</dt>
                  <dd>
                    {s.review.decision} by {s.review.by} {s.review.message ? `— “${s.review.message}”` : ''}
                  </dd>
                </>
              )}
            </dl>
            {/* portal-only information, never projected */}
            <div className="panel col gap-6">
              <div className="label">Request</div>
              {s.request?.usage ? <p style={{ whiteSpace: 'pre-wrap' }}>{s.request.usage}</p> : <p className="faint small">No usage statement.</p>}
              {s.request?.terms_accepted && (
                <p className="small positive-text">
                  <Icon name="check" size={13} /> Terms accepted {s.request.terms_url ? `(${s.request.terms_url})` : ''} on {fmtDate(s.request.accepted_at)}
                </p>
              )}
            </div>

            {metaFields.length > 0 && (
              <div className="panel col gap-6">
                <div className="label">Metadata</div>
                <p className="faint small">The fields marked for the portal form the request form of the plans; the others are filled here.</p>
                <MetadataForm fields={metaFields} values={meta || s.metadata} onChange={setMeta} />
                {meta && (
                  <button
                    className="btn sm primary"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={async () => {
                      try {
                        await wapi.put(`/subscriptions/${id}/metadata`, meta);
                        setMeta(null);
                        toast('Metadata saved');
                        state.reload();
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }}
                  >
                    Save metadata
                  </button>
                )}
              </div>
            )}

            {s.status === 'pending' && (
              <div className="card flat">
                <div className="card-body col">
                  <Field label="Message to the requester" hint="optional, sent with the decision">
                    <TextArea value={message} onChange={setMessage} rows={2} />
                  </Field>
                  <div className="row">
                    <button className="btn primary" disabled={busy} onClick={() => act('accept', { message }, 'Subscription accepted')}>
                      <Icon name="check" /> Accept
                    </button>
                    <button className="btn danger" disabled={busy} onClick={() => act('reject', { message }, 'Subscription rejected')}>
                      <Icon name="x" /> Reject
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="col gap-6">
              <div className="label">Credentials</div>
              {s.credentials.length ? (
                s.credentials.map((c) => (
                  <div key={c.id} className="panel col gap-6">
                    <div className="row">
                      <Badge kind="accent">{c.kind}</Badge>
                      <StatusBadge status={c.status} />
                      <span className="spacer" />
                      {c.status === 'active' && (
                        <button
                          className="btn xs"
                          onClick={async () => {
                            if (!(await confirm({ title: 'Rotate the secret?', message: 'The current secret stops working immediately on the gateway.', confirmLabel: 'Rotate' }))) return;
                            try {
                              await wapi.post(`/subscriptions/${id}/credentials/${c.id}/rotate`);
                              toast('Secret rotated');
                              state.reload();
                            } catch (e) {
                              toast(errorMessage(e), 'error');
                            }
                          }}
                        >
                          <Icon name="refresh" /> Rotate secret
                        </button>
                      )}
                    </div>
                    <dl className="kv">
                      <dt>Client id</dt>
                      <dd className="mono">{c.client_id}</dd>
                      <dt>Client secret</dt>
                      <dd>
                        <Secret value={c.client_secret} />
                      </dd>
                    </dl>
                  </div>
                ))
              ) : (
                <p className="faint small">
                  {['apikey', 'oauth2-local'].includes(s.auth_kind)
                    ? 'The key is minted on the gateway when the subscription becomes active.'
                    : 'On this plan the consumer calls with its own token or certificate; the gateway identifies it by the client_id declared on the application.'}
                </p>
              )}
            </div>

            {s.pending_transfer && (
              <Callout kind={s.pending_transfer.status === 'requested' ? 'info' : 'warning'} title={`Move to ${s.pending_transfer.to.plan_name} — ${s.pending_transfer.status === 'requested' ? 'asked by the consumer' : "waiting for the consumer's consent"}`}>
                {s.pending_transfer.reasons?.length > 0 && <div>The target plan brings {s.pending_transfer.reasons.join(', ')} (a change of contract needs the consumer's agreement).</div>}
                {s.pending_transfer.status === 'requested' && (
                  <div className="row mt-8">
                    <button className="btn sm primary" disabled={busy} onClick={() => act('transfer/decision', { accept: true }, 'Subscription transferred — the key does not change')}>
                      Apply the move
                    </button>
                    <button className="btn sm" disabled={busy} onClick={() => act('transfer/decision', { accept: false }, 'Request declined')}>
                      Decline
                    </button>
                  </div>
                )}
              </Callout>
            )}

            {s.history?.length > 0 && (
              <div className="col gap-6">
                <div className="label">Transfers</div>
                {s.history.map((h, i) => (
                  <div key={i} className="small muted">
                    {fmtDate(h.at)} — {h.from.plan_name} → {h.to.plan_name} by {h.by}
                  </div>
                ))}
              </div>
            )}

            {s.drift && s.drift.status !== 'in_sync' && (
              <Callout kind="warning" title={`Gateway drift: ${s.drift.status}`}>
                <DiffView changes={s.drift.diff} />
              </Callout>
            )}

            <hr />
            <div className="row wrap">
              {s.status === 'active' && (
                <button className="btn" disabled={busy} onClick={() => act('suspend', {}, 'Subscription suspended')}>
                  <Icon name="pause" /> Suspend
                </button>
              )}
              {s.status === 'suspended' && (
                <button className="btn" disabled={busy} onClick={() => act('resume', {}, 'Subscription resumed')}>
                  <Icon name="play" /> Resume
                </button>
              )}
              {['active', 'suspended'].includes(s.status) && (
                <button className="btn" disabled={busy} onClick={() => setTransfer(true)}>
                  <Icon name="swap" /> Transfer to another plan
                </button>
              )}
              {s.status === 'pending_payment' && (
                <button className="btn" disabled={busy} onClick={() => act('payment', {}, 'Payment confirmed (test connector)')}>
                  Confirm payment (test)
                </button>
              )}
              <button className="btn ghost" disabled={busy} onClick={() => act('resync', {}, 'Projection replayed')}>
                <Icon name="refresh" /> Replay projection
              </button>
              <span className="spacer" />
              {['pending', 'pending_payment', 'active', 'suspended'].includes(s.status) && (
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: 'Close this subscription?',
                        message: 'Its keys are deleted from the gateway: the consumer gets 401 from now on.',
                        danger: true,
                        confirmLabel: 'Close subscription',
                      })
                    )
                      act('close', {}, 'Subscription closed');
                  }}
                >
                  Close
                </button>
              )}
            </div>
            {transfer && <TransferPanel sub={s} onDone={() => { setTransfer(null); state.reload(); onChanged?.(); }} onCancel={() => setTransfer(null)} />}
          </>
        )}
      </Loader>
    </Drawer>
  );
}

// only towards an equivalent plan (same auth mechanism), on this api or another version
function TransferPanel({ sub, onDone, onCancel }) {
  const { wapi } = useWs();
  const toast = useToast();
  const [target, setTarget] = useState('');
  const state = useLoad(async () => {
    const apis = await wapi.get('/apis');
    const current = apis.find((a) => a.id === sub.api_id);
    const versions = apis.filter((a) => a.slug === current?.slug);
    const out = [];
    for (const a of versions) {
      const { plans } = await wapi.get(`/apis/${a.id}/plans`);
      plans.forEach((p) => out.push({ api: a, plan: p }));
    }
    return out;
  }, [sub.id]);
  return (
    <div className="card flat">
      <div className="card-body col">
        <h3>Transfer</h3>
        <p className="muted small">
          The key does not change; the subscription keeps its identity and history. Only plans with the same auth mechanism ({AUTH_LABELS[sub.auth_kind]}) are eligible. A move that degrades the
          conditions — lower limits, a higher price, other terms, fewer resources — waits for the consumer's consent.
        </p>
        <Loader state={state}>
          {(options) => {
            const eligible = options.filter((o) => o.plan.auth.kind === sub.auth_kind && o.plan.status === 'published' && !(o.api.id === sub.api_id && o.plan.id === sub.plan_id));
            return eligible.length ? (
              <>
                <Select
                  value={target}
                  onChange={setTarget}
                  options={[{ value: '', label: 'Choose a target plan…' }, ...eligible.map((o) => ({ value: `${o.api.id}|${o.plan.id}`, label: `${o.api.name} ${o.api.version} — ${o.plan.name}` }))]}
                />
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={!target}
                    onClick={async () => {
                      const [api_id, plan_id] = target.split('|');
                      try {
                        const r = await wapi.post(`/subscriptions/${sub.id}/transfer`, { api_id, plan_id });
                        toast(r.pending_transfer ? `Proposed: it degrades the conditions (${r.pending_transfer.reasons.join(', ')}), so it waits for the consumer's consent` : 'Subscription transferred — the key does not change');
                        onDone();
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }}
                  >
                    Transfer
                  </button>
                  <button className="btn" onClick={onCancel}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <p className="faint small">No equivalent published plan is deployed.</p>
            );
          }}
        </Loader>
      </div>
    </div>
  );
}

export function SubscriptionsPage() {
  return (
    <div className="page">
      <PageHead title="Subscriptions" sub="Every request on the plans of this workspace. The approval workflow belongs to the product: Otoroshi only enforces what is accepted." />
      <SubscriptionsTable />
    </div>
  );
}
