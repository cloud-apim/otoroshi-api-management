import React, { useState } from 'react';
import { useQuery, Link } from '../../shared/router.jsx';
import { AUTH_LABELS, fmtDate, fmtRelative } from '../../shared/lib.js';
import { Badge, Callout, DiffView, Drawer, Empty, Field, Icon, Loader, Secret, Select, StatusBadge, TextArea, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { useWs, useMetadataFields } from '../context.jsx';
import { MetadataForm } from '../../shared/metadata.jsx';
import { PageHead } from '../layout.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../shared/lists.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';

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
      <ListToolbar paging={page} placeholder={tr('search applications, teams, apis, plans, people')} onReload={state.reload} loading={state.loading}>
        <Select
          value={status}
          onChange={(v) => setParams({ status: v, subs_page: null })}
          options={[
            { value: '', label: tr('All statuses') },
            ...['pending', 'pending_payment', 'active', 'suspended', 'expired', 'rejected', 'closed'].map((s) => ({ value: s, label: tr(s.replace('_', ' ')) })),
          ]}
          aria-label={tr('filter by status')}
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
                    {showApp && <th>{tr('Application')}</th>}
                    {showApi && <th>{tr('API')}</th>}
                    <th>{tr('Plan')}</th>
                    <th>{tr('Status')}</th>
                    <th>{tr('Gateway')}</th>
                    <th>{tr('Requested')}</th>
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
                        <div className="faint tiny">{tr(AUTH_LABELS[s.auth_kind])}</div>
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
              <Empty title={page.q ? tr('No subscription matches') : tr('No subscription')} icon="inbox">
                {page.q ? null : tr('Consumers subscribe to the published plans from the developer portal.')}
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

// the end of a subscription: past it, its keys are disabled on the gateway; a later date, or none,
// renews it with the same keys. A paid subscription ends with its subscription at the provider.
function EndDate({ s, busy, act }) {
  const [at, setAt] = useState(s.dates?.ending_at ? s.dates.ending_at.slice(0, 10) : '');
  const editable = s.can_manage && !s.managed_by && !s.payment?.provider && ['pending', 'active', 'suspended', 'expired'].includes(s.status);
  if (!editable && !s.dates?.ending_at) return null;
  return (
    <div className="col gap-6">
      <div className="label">{tr('End date')}</div>
      {s.status === 'expired' && <Callout kind="warning">{tr('Expired: its keys are disabled on the gateway. A later end date, or none, renews it with the same keys.')}</Callout>}
      {editable && (
        <div className="row">
          <input type="date" className="input" value={at} onChange={(e) => setAt(e.target.value)} aria-label={tr('end date')} style={{ width: 180 }} />
          <button className="btn sm" disabled={busy || !at} onClick={() => act('ending', { at: new Date(`${at}T00:00:00`).toISOString() }, tr('End date set'))}>
            {tr('Set')}
          </button>
          {s.dates?.ending_at && (
            <button className="btn sm ghost" disabled={busy} onClick={() => act('ending', { at: null }, tr('End date removed'))}>
              {tr('No end date')}
            </button>
          )}
        </div>
      )}
      <p className="hint">{tr('From that day on, the subscription expires: its keys are disabled on the gateway.')}</p>
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
      toast(label || tr('Subscription updated'));
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
    <Drawer title={tr('Subscription')} subtitle={id} onClose={onClose}>
      <Loader state={state}>
        {(s) => (
          <>
            <div className="row wrap">
              <StatusBadge status={s.status} />
              <Badge>{tr(AUTH_LABELS[s.auth_kind])}</Badge>
              <span className="muted small">{tr('gateway:')} </span>
              <StatusBadge status={s.projection?.status || 'none'} />
            </div>
            {s.projection?.error && <Callout kind="warning" title={tr('Projection')}>{s.projection.error}</Callout>}
            <dl className="kv">
              <dt>{tr('Application')}</dt>
              <dd>
                <Link to={`/ws/${slug}/applications/${s.application_id}`} className="link">
                  {s.application_name}
                </Link>
              </dd>
              <dt>{tr('API')}</dt>
              <dd>
                <Link to={`/ws/${slug}/apis/${s.api_id}/subscriptions`} className="link">
                  {s.api_name} {s.api_version}
                </Link>
              </dd>
              <dt>{tr('Plan')}</dt>
              <dd>
                {s.request?.plan_name} <span className="faint mono">{s.plan_id}</span>
              </dd>
              <dt>{tr('Requested')}</dt>
              <dd>{fmtDate(s.created_at)}</dd>
              {s.dates?.processed_at && (
                <>
                  <dt>{tr('Processed')}</dt>
                  <dd>{fmtDate(s.dates.processed_at)}</dd>
                </>
              )}
              {s.dates?.suspended_at && (
                <>
                  <dt>{tr('Suspended')}</dt>
                  <dd>{fmtDate(s.dates.suspended_at)}</dd>
                </>
              )}
              {s.dates?.ending_at && (
                <>
                  <dt>{s.status === 'expired' ? tr('Expired') : tr('Ends')}</dt>
                  <dd>{fmtDate(s.dates.ending_at)}</dd>
                </>
              )}
              {s.review?.decision && (
                <>
                  <dt>{tr('Review')}</dt>
                  <dd>
                    <Tr text={'{0} by {1} {2}'} args={[s.review.decision, s.review.by, s.review.message ? `— “${s.review.message}”` : '']} />
                  </dd>
                </>
              )}
              {s.payment?.provider && (
                <>
                  <dt>{tr('Payment')}</dt>
                  <dd>
                    <div className="row gap-6 wrap">
                      <StatusBadge status={s.payment.status === 'paid' ? 'active' : s.payment.status === 'past_due' ? 'drifted' : s.payment.status === 'canceled' ? 'closed' : 'pending'} label={tr(s.payment.status || 'awaiting_payment')} />
                      {s.payment.stripe_status && <span className="faint small">{tr('Stripe: {0}', [s.payment.stripe_status])}</span>}
                      {s.payment.current_period_end && <span className="faint small">{tr('paid until {0}', [fmtDate(s.payment.current_period_end)])}</span>}
                      {s.payment.past_due_since && (
                        <span className="warning-text small">{tr('past due since {0}, grace of {1} days', [fmtDate(s.payment.past_due_since), s.payment.grace_days ?? 7])}</span>
                      )}
                    </div>
                    <div className="faint tiny mono">
                      {[s.payment.account, s.payment.customer, s.payment.provider_subscription].filter(Boolean).join(' · ')}
                    </div>
                  </dd>
                </>
              )}
            </dl>
            {/* portal-only information, never projected */}
            <div className="panel col gap-6">
              <div className="label">{tr('Request')}</div>
              {s.request?.usage ? <p style={{ whiteSpace: 'pre-wrap' }}>{s.request.usage}</p> : <p className="faint small">{tr('No usage statement.')}</p>}
              {s.request?.terms_accepted && (
                <p className="small positive-text">
                  <Icon name="check" size={13} /> <Tr text={'Terms accepted {0} on {1}'} args={[s.request.terms_url ? `(${s.request.terms_url})` : '', fmtDate(s.request.accepted_at)]} />
                </p>
              )}
            </div>

            {!s.can_manage && <Callout kind="info">{tr('Read only: the team of the API decides on its subscriptions.')}</Callout>}
            <fieldset disabled={!s.can_manage} className="ro-fieldset col gap-16">
            {metaFields.length > 0 && (
              <div className="panel col gap-6">
                <div className="label">{tr('Metadata')}</div>
                <p className="faint small">{tr('The fields marked for the portal form the request form of the plans; the others are filled here.')}</p>
                <MetadataForm fields={metaFields} values={meta || s.metadata} onChange={setMeta} />
                {meta && (
                  <button
                    className="btn sm primary"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={async () => {
                      try {
                        await wapi.put(`/subscriptions/${id}/metadata`, meta);
                        setMeta(null);
                        toast(tr('Metadata saved'));
                        state.reload();
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }}
                  >
                    {tr('Save metadata')}
                  </button>
                )}
              </div>
            )}

            {s.status === 'pending' && (
              <div className="card flat">
                <div className="card-body col">
                  <Field label={tr('Message to the requester')} hint={tr('optional, sent with the decision')}>
                    <TextArea value={message} onChange={setMessage} rows={2} />
                  </Field>
                  <div className="row">
                    <button className="btn primary" disabled={busy} onClick={() => act('accept', { message }, tr('Subscription accepted'))}>
                      <Icon name="check" /> {tr('Accept')}
                    </button>
                    <button className="btn danger" disabled={busy} onClick={() => act('reject', { message }, tr('Subscription rejected'))}>
                      <Icon name="x" /> {tr('Reject')}
                    </button>
                  </div>
                </div>
              </div>
            )}
            </fieldset>

            <div className="col gap-6">
              <div className="label">{tr('Credentials')}</div>
              {s.credentials.length ? (
                s.credentials.map((c) => (
                  <div key={c.id} className="panel col gap-6">
                    <div className="row">
                      <Badge kind="accent">{c.kind}</Badge>
                      <StatusBadge status={c.status} />
                      <span className="spacer" />
                      {c.status === 'active' && s.can_see_credentials && (
                        <button
                          className="btn xs"
                          onClick={async () => {
                            if (!(await confirm({ title: tr('Rotate the secret?'), message: tr('The current secret stops working immediately on the gateway.'), confirmLabel: tr('Rotate') }))) return;
                            try {
                              await wapi.post(`/subscriptions/${id}/credentials/${c.id}/rotate`);
                              toast(tr('Secret rotated'));
                              state.reload();
                            } catch (e) {
                              toast(errorMessage(e), 'error');
                            }
                          }}
                        >
                          <Icon name="refresh" /> {tr('Rotate secret')}
                        </button>
                      )}
                    </div>
                    <dl className="kv">
                      <dt>{tr('Client id')}</dt>
                      <dd className="mono">{c.client_id}</dd>
                      <dt>{tr('Client secret')}</dt>
                      <dd>
                        <Secret value={c.client_secret} />
                      </dd>
                    </dl>
                  </div>
                ))
              ) : (
                <p className="faint small">
                  {['apikey', 'oauth2-local'].includes(s.auth_kind)
                    ? tr('The key is minted on the gateway when the subscription becomes active.')
                    : tr('On this plan the consumer calls with its own token or certificate; the gateway identifies it by the client_id declared on the application.')}
                </p>
              )}
            </div>

            {s.pending_transfer && (
              <Callout kind={s.pending_transfer.status === 'requested' ? 'info' : 'warning'} title={tr('Move to {0} — {1}', [s.pending_transfer.to.plan_name, s.pending_transfer.status === 'requested' ? tr('asked by the consumer') : tr("waiting for the consumer's consent")])}>
                {s.pending_transfer.reasons?.length > 0 && <div><Tr text={"The target plan brings {0} (a change of contract needs the consumer's agreement)."} args={[s.pending_transfer.reasons.join(', ')]} /></div>}
                {s.pending_transfer.status === 'requested' && s.can_manage && (
                  <div className="row mt-8">
                    <button className="btn sm primary" disabled={busy} onClick={() => act('transfer/decision', { accept: true }, tr('Subscription transferred — the key does not change'))}>
                      {tr('Apply the move')}
                    </button>
                    <button className="btn sm" disabled={busy} onClick={() => act('transfer/decision', { accept: false }, tr('Request declined'))}>
                      {tr('Decline')}
                    </button>
                  </div>
                )}
              </Callout>
            )}

            {s.history?.length > 0 && (
              <div className="col gap-6">
                <div className="label">{tr('Transfers')}</div>
                {s.history.map((h, i) => (
                  <div key={i} className="small muted">
                    <Tr text={'{0} — {1} → {2} by {3}'} args={[fmtDate(h.at), h.from.plan_name, h.to.plan_name, h.by]} />
                  </div>
                ))}
              </div>
            )}

            {s.drift && s.drift.status !== 'in_sync' && (
              <Callout kind="warning" title={tr('Gateway drift: {0}', [s.drift.status])}>
                <DiffView changes={s.drift.diff} />
              </Callout>
            )}

            <EndDate s={s} busy={busy} act={act} />

            <hr />
            <fieldset disabled={!s.can_manage} className="ro-fieldset row wrap">
              {s.status === 'active' && (
                <button className="btn" disabled={busy} onClick={() => act('suspend', {}, tr('Subscription suspended'))}>
                  <Icon name="pause" /> {tr('Suspend')}
                </button>
              )}
              {s.status === 'suspended' && (
                <button className="btn" disabled={busy} onClick={() => act('resume', {}, tr('Subscription resumed'))}>
                  <Icon name="play" /> {tr('Resume')}
                </button>
              )}
              {['active', 'suspended'].includes(s.status) && !s.managed_by && (
                <button className="btn" disabled={busy} onClick={() => setTransfer(true)}>
                  <Icon name="swap" /> {tr('Transfer to another plan')}
                </button>
              )}
              <button className="btn ghost" disabled={busy} onClick={() => act('resync', {}, tr('Projection replayed'))}>
                <Icon name="refresh" /> {tr('Replay projection')}
              </button>
              <span className="spacer" />
              {s.managed_by && <span className="faint small">{tr('Its plan and its closing belong to {0}.', [s.managed_by])}</span>}
              {['pending', 'pending_payment', 'active', 'suspended', 'expired'].includes(s.status) && !s.managed_by && (
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: tr('Close this subscription?'),
                        message: tr('Its keys are deleted from the gateway: the consumer gets 401 from now on.'),
                        danger: true,
                        confirmLabel: tr('Close subscription'),
                      })
                    )
                      act('close', {}, tr('Subscription closed'));
                  }}
                >
                  {tr('Close')}
                </button>
              )}
            </fieldset>
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
        <h3>{tr('Transfer')}</h3>
        <p className="muted small">
          <Tr text={"The key does not change; the subscription keeps its identity and history. Only plans with the same auth mechanism ({0}) are eligible. A move that degrades the conditions — lower limits, a higher price, other terms, fewer resources — waits for the consumer's consent."} args={[tr(AUTH_LABELS[sub.auth_kind])]} />
        </p>
        <Loader state={state}>
          {(options) => {
            const eligible = options.filter((o) => o.plan.auth.kind === sub.auth_kind && o.plan.status === 'published' && !(o.api.id === sub.api_id && o.plan.id === sub.plan_id));
            return eligible.length ? (
              <>
                <Select
                  value={target}
                  onChange={setTarget}
                  options={[{ value: '', label: tr('Choose a target plan…') }, ...eligible.map((o) => ({ value: `${o.api.id}|${o.plan.id}`, label: `${o.api.name} ${o.api.version} — ${o.plan.name}` }))]}
                />
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={!target}
                    onClick={async () => {
                      const [api_id, plan_id] = target.split('|');
                      try {
                        const r = await wapi.post(`/subscriptions/${sub.id}/transfer`, { api_id, plan_id });
                        toast(r.pending_transfer ? tr("Proposed: it degrades the conditions ({0}), so it waits for the consumer's consent", [r.pending_transfer.reasons.join(', ')]) : tr('Subscription transferred — the key does not change'));
                        onDone();
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }}
                  >
                    {tr('Transfer')}
                  </button>
                  <button className="btn" onClick={onCancel}>
                    {tr('Cancel')}
                  </button>
                </div>
              </>
            ) : (
              <p className="faint small">{tr('No equivalent published plan is deployed.')}</p>
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
      <PageHead title={tr('Subscriptions')} sub={tr('Every request on the plans of this workspace. The approval workflow belongs to the product: Otoroshi only enforces what is accepted.')} />
      <SubscriptionsTable />
    </div>
  );
}
