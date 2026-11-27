import React, { useEffect, useState } from 'react';
import { Link, useRouter } from '../../shared/router.jsx';
import { Callout, Code, Empty, Field, Icon, Input, Loader, Modal, Secret, Select, Switch, TextArea, errorMessage, useConfirm, useLoad, useToast, Badge } from '../../shared/ui.jsx';
import { fmtDate, fmtNumber } from '../../shared/lib.js';
import { ListToolbar, Pager, useLocalPaging, usePaging } from '../../shared/lists.jsx';
import { api } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { PageHeader, RequireUser, SmallPager, SmallSearch, SubStatus, authLabel, snippets } from '../common.jsx';
import { CertificateList } from '../../shared/certificates.jsx';

const TOKEN_KINDS = ['jwt', 'mtls', 'oauth2-remote'];
const MAX = 10000000;

export function Apps() {
  return (
    <RequireUser>
      <AppsList />
    </RequireUser>
  );
}

function NewAppModal({ onClose, onCreated }) {
  const { t } = useI18n();
  const teams = useLoad(() => api.get('/teams'), []);
  const [form, setForm] = useState({ name: '', description: '', team_id: '', shared_credential: false });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const app = await api.post('/applications', { ...form, team_id: form.team_id || undefined });
      onCreated(app);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t('apps.new')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" type="submit" form="new-app" disabled={busy || !form.name.trim()}>
            {t('apps.create')}
          </button>
        </>
      }
    >
      <form id="new-app" className="col gap-16" onSubmit={submit}>
        <Field label={t('sub.app.name')}>
          <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder={t('sub.app.namePlaceholder')} autoFocus aria-label={t('sub.app.name')} />
        </Field>
        <Field label={t('apps.description')}>
          <TextArea value={form.description} onChange={(v) => setForm({ ...form, description: v })} rows={3} aria-label={t('apps.description')} />
        </Field>
        {(teams.data || []).length > 1 && (
          <Field label={t('apps.team')}>
            <Select
              value={form.team_id}
              onChange={(v) => setForm({ ...form, team_id: v })}
              aria-label={t('apps.team')}
              options={[{ value: '', label: `${t('teams.personal')}` }, ...teams.data.filter((x) => !x.personal).map((x) => ({ value: x.id, label: x.name }))]}
            />
          </Field>
        )}
        <Field hint={t('apps.sharedKey.help')}>
          <Switch checked={form.shared_credential} onChange={(v) => setForm({ ...form, shared_credential: v })} label={t('apps.sharedKey')} />
        </Field>
        {error && <Callout kind="negative">{errorMessage(error)}</Callout>}
      </form>
    </Modal>
  );
}

function AppsList() {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const state = useLoad(() => api.get('/applications'), []);
  const page = useLocalPaging(state.data, { size: 25, text: (a) => `${a.name} ${a.description || ''} ${a.team_personal ? t('teams.personal') : a.team_name}` });
  const [creating, setCreating] = useState(false);
  return (
    <div className="pt-container pt-section">
      <PageHeader
        title={t('apps.title')}
        subtitle={t('apps.subtitle')}
        actions={
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {t('apps.new')}
          </button>
        }
      />
      <Loader state={state}>
        {(apps) =>
          !apps.length ? (
            <div className="card">
              <Empty
                title={t('apps.empty')}
                icon="apps"
                action={
                  <div className="row gap-6" style={{ justifyContent: 'center' }}>
                    <button className="btn primary" onClick={() => setCreating(true)}>
                      {t('apps.new')}
                    </button>
                    <Link to="/apis" className="btn">
                      {t('apps.browse')}
                    </Link>
                  </div>
                }
              >
                {t('apps.empty.text')}
              </Empty>
            </div>
          ) : (
            <>
              <ListToolbar paging={page} placeholder={t('apps.search')} onReload={state.reload} loading={state.loading} />
              {page.items.length ? (
                <>
                  <div className="pt-grid">
                    {page.items.map((a) => (
                      <Link key={a.id} to={`/apps/${a.id}`} className="card pt-api-card">
                        <div className="row gap-6">
                          <span className="pt-api-icon" aria-hidden="true">
                            <Icon name="apps" />
                          </span>
                          <div className="grow">
                            <h3 className="ellipsis">{a.name}</h3>
                            <div className="faint tiny">
                              {t('apps.team')}: {a.team_personal ? t('teams.personal') : a.team_name}
                            </div>
                          </div>
                        </div>
                        {a.description && <p className="muted small mt-8 pt-clamp">{a.description}</p>}
                        <div className="row wrap gap-6 mt-16">
                          <Badge kind={a.active_subscriptions ? 'positive' : ''} dot>
                            {t('apps.subs', { n: a.active_subscriptions })}
                          </Badge>
                          {a.pending_subscriptions > 0 && <Badge kind="warning">{t('apps.pending', { n: a.pending_subscriptions })}</Badge>}
                        </div>
                      </Link>
                    ))}
                  </div>
                  <div className="mt-16">
                    <Pager paging={page} total={page.total} />
                  </div>
                </>
              ) : (
                <div className="card">
                  <Empty title={t('apps.nomatch')} icon="search" />
                </div>
              )}
            </>
          )
        }
      </Loader>
      {creating && (
        <NewAppModal
          onClose={() => setCreating(false)}
          onCreated={(app) => {
            setCreating(false);
            navigate(`/apps/${app.id}`);
          }}
        />
      )}
    </div>
  );
}

export function AppDetail({ id }) {
  return (
    <RequireUser>
      <AppDetailView id={id} />
    </RequireUser>
  );
}

function AppDetailView({ id }) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { navigate } = useRouter();
  const state = useLoad(() => api.get(`/applications/${id}`), [id]);
  const subs = useLocalPaging(state.data?.subscriptions, {
    prefix: 'subs',
    size: 10,
    text: (s) => `${s.api_name} v${s.api_version} ${s.request?.plan_name || s.plan_id} ${authLabel(s.auth_kind)} ${t(`status.${s.status}`)} ${(s.credentials || []).map((c) => c.client_id).join(' ')}`,
  });
  const [form, setForm] = useState(null);
  // back from the Checkout of Stripe
  const checkout = new URLSearchParams(window.location.search).get('checkout');
  useEffect(() => {
    if (state.data) setForm({ name: state.data.name, description: state.data.description, client_id: state.data.client_id || '', certificates: state.data.certificates || [], shared_credential: !!state.data.shared_credential });
  }, [state.data]);
  const save = async () => {
    try {
      await api.put(`/applications/${id}`, form);
      toast(t('apps.saved'));
      state.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: t('apps.delete'), message: t('apps.delete.confirm', { name: state.data.name }), danger: true, confirmLabel: t('common.delete') }))) return;
    try {
      await api.del(`/applications/${id}`);
      navigate('/apps');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="pt-container pt-section">
      <Loader state={state}>
        {(app) => (
          <>
            <PageHeader
              back={{ to: '/apps', label: t('apps.back') }}
              title={app.name}
              subtitle={app.description}
              actions={
                <div className="row gap-6">
                  <Link to={`/usage?application=${app.id}`} className="btn">
                    <Icon name="chart" />
                    {t('apps.usage')}
                  </Link>
                  <Link to={`/usage?view=logs&application=${app.id}`} className="btn">
                    <Icon name="doc" />
                    {t('apps.logs')}
                  </Link>
                </div>
              }
            />
            <div className="pt-two-col">
              <div className="col gap-16">
                {checkout === 'success' && <Callout kind="positive">{t('apps.checkout.success')}</Callout>}
                {checkout === 'canceled' && <Callout kind="info">{t('apps.checkout.canceled')}</Callout>}
                <div className="row">
                  <h2 className="grow">{t('apps.subscriptions')}</h2>
                  <Link to="/apis" className="btn sm">
                    <Icon name="plus" />
                    {t('apps.browse')}
                  </Link>
                </div>
                {!app.subscriptions.length ? (
                  <div className="card">
                    <Empty title={t('apps.noSubs')} icon="key" />
                  </div>
                ) : (
                  <>
                    <ListToolbar paging={subs} placeholder={t('apps.subs.search')} />
                    {subs.items.length ? (
                      subs.items.map((s) => <SubscriptionCard key={s.id} sub={s} app={app} onChange={state.reload} />)
                    ) : (
                      <div className="card">
                        <Empty title={t('apps.subs.nomatch')} icon="search" />
                      </div>
                    )}
                    {subs.total > 0 && <Pager paging={subs} total={subs.total} />}
                  </>
                )}
              </div>
              <aside className="col gap-16">
                {form && (
                  <div className="card">
                    <div className="card-head">
                      <h3>{t('apps.settings')}</h3>
                    </div>
                    <div className="card-body col gap-16">
                      <Field label={t('sub.app.name')}>
                        <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} aria-label={t('sub.app.name')} />
                      </Field>
                      <Field label={t('apps.description')}>
                        <TextArea value={form.description} onChange={(v) => setForm({ ...form, description: v })} rows={3} aria-label={t('apps.description')} />
                      </Field>
                      <Field hint={t('apps.sharedKey.help')}>
                        <Switch checked={form.shared_credential} onChange={(v) => setForm({ ...form, shared_credential: v })} label={t('apps.sharedKey')} />
                        {app.shared_key && <div className="faint tiny mt-8">{t('apps.sharedKey.current', { id: app.shared_key.client_id, n: app.shared_key.shared_with })}</div>}
                      </Field>
                      <Field label={t('apps.clientId')} hint={t('apps.clientId.help')}>
                        <Input value={form.client_id} onChange={(v) => setForm({ ...form, client_id: v })} mono aria-label={t('apps.clientId')} />
                      </Field>
                      <CertificateList
                        layout="field"
                        mode="client"
                        value={form.certificates}
                        onChange={(v) => setForm({ ...form, certificates: v })}
                        inspect={(pem) => api.post('/certificates/inspect', { pem })}
                        label={t('apps.certs')}
                        help={t('apps.certs.help')}
                        addLabel={t('apps.certs.add')}
                        addTitle={t('apps.certs.addTitle')}
                        addHelp={t('apps.certs.addHelp')}
                        labels={Object.fromEntries(['selfSigned', 'validUntil', 'identifiedAs', 'useAsClientId', 'issuedBy', 'remove', 'cancel', 'add', 'incomplete', 'search', 'nomatch'].map((k) => [k, t(`certs.${k}`)]))}
                        clientId={form.client_id}
                        onClientId={(v) => setForm({ ...form, client_id: v })}
                      />
                      <div className="faint tiny">
                        {t('apps.team')}: {app.team_name}
                      </div>
                      <div className="row">
                        <button className="btn ghost danger sm" onClick={remove}>
                          <Icon name="trash" />
                          {t('apps.delete')}
                        </button>
                        <span className="spacer" />
                        <button className="btn primary sm" onClick={save}>
                          {t('apps.save')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </Loader>
    </div>
  );
}

function QuotaRow({ label, current, total, remaining }) {
  const { t } = useI18n();
  if (!total || total >= MAX) return null;
  const pct = Math.min(100, (100 * (current || 0)) / total);
  const tone = pct > 90 ? 'var(--negative)' : pct > 70 ? 'var(--warning)' : 'var(--accent)';
  return (
    <div>
      <div className="row small" style={{ marginBottom: 4 }}>
        <span className="grow">{label}</span>
        <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {t('subs.quotas.remaining', { remaining: fmtNumber(remaining), total: fmtNumber(total) })}
        </span>
      </div>
      <div className="pt-meter" role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={current} aria-label={label}>
        <div style={{ width: `${pct}%`, background: tone }} />
      </div>
    </div>
  );
}

// the calls a subscription to a plan with a usage price is billed for, batch by batch as reported to
// the billing: searched and paged on the server, the batches of a long subscription are many
function UsageBilled({ sub }) {
  const { t } = useI18n();
  const page = usePaging({ local: true, size: 10 });
  const state = useLoad(() => api.get(`/subscriptions/${sub.id}/usage?${page.query}`).catch(() => null), [sub.id, page.key]);
  if (!state.data || (!state.data.total && !page.q)) return null;
  const u = state.data;
  return (
    <div className="col gap-6">
      <span className="label">{t('subs.usage.title')}</span>
      <div className="muted small">{t('subs.usage', { sent: fmtNumber(u.sent), pending: fmtNumber(u.pending) })}</div>
      <ListToolbar paging={page} placeholder={t('subs.usage.search')} onReload={state.reload} loading={state.loading} />
      {u.reports.length ? (
        <div className="table-wrap" style={{ opacity: state.loading ? 0.6 : 1 }}>
          <table className="table small" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr>
                <th>{t('subs.usage.batch')}</th>
                <th className="right">{t('subs.usage.calls')}</th>
                <th>{t('subs.usage.status')}</th>
              </tr>
            </thead>
            <tbody>
              {u.reports.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap muted">{fmtDate(r.created_at)}</td>
                  <td className="right">{fmtNumber(r.value)}</td>
                  <td>
                    <Badge kind={r.status === 'sent' ? 'positive' : 'warning'} dot>
                      {t(r.status === 'sent' ? 'subs.usage.sent' : 'subs.usage.pending')}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="faint small">{t('subs.usage.nomatch')}</p>
      )}
      <Pager paging={page} total={u.total} />
    </div>
  );
}

function Quotas({ sub }) {
  const { t } = useI18n();
  const [state, setState] = useState(null);
  const load = async () => {
    setState({ loading: true });
    try {
      setState({ data: await api.get(`/subscriptions/${sub.id}/quotas`) });
    } catch (e) {
      setState({ error: e });
    }
  };
  if (!state)
    return (
      <button className="btn sm ghost" onClick={load}>
        <Icon name="refresh" />
        {t('subs.quotas.load')}
      </button>
    );
  if (state.loading) return <span className="spinner" />;
  if (state.error) return <div className="muted small">{errorMessage(state.error)}</div>;
  return (
    <div className="col gap-6">
      <div className="row">
        <span className="label grow">{t('subs.quotas')}</span>
        <button className="btn ghost xs icon" onClick={load} aria-label="refresh">
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {state.data.map((q) =>
        q.error ? (
          <div key={q.client_id} className="muted small">
            {t('subs.quotas.error')}
          </div>
        ) : (
          <div key={q.client_id} className="col gap-6">
            <QuotaRow label={t('subs.quotas.window')} current={q.quotas.throttlingCallsPerWindow} total={q.quotas.authorizedCallsPerWindow} remaining={q.quotas.remainingCallsPerWindow} />
            <QuotaRow label={t('subs.quotas.day')} current={q.quotas.currentCallsPerDay} total={q.quotas.authorizedCallsPerDay} remaining={q.quotas.remainingCallsPerDay} />
            <QuotaRow label={t('subs.quotas.month')} current={q.quotas.currentCallsPerMonth} total={q.quotas.authorizedCallsPerMonth} remaining={q.quotas.remainingCallsPerMonth} />
          </div>
        )
      )}
    </div>
  );
}

function ExampleCall({ sub, cred }) {
  const state = useLoad(() => api.get(`/apis/${sub.api_id}`).catch(() => null), [sub.api_id]);
  const url = state.data?.base_url ? `${state.data.base_url}/` : '<base url>';
  return <Code>{snippets({ kind: sub.auth_kind, url, clientId: cred.client_id, clientSecret: cred.client_secret }).curl}</Code>;
}

// from the consumer's side: ask to move to an equivalent plan
function ChangePlanModal({ sub, onClose, onDone }) {
  const { t } = useI18n();
  const toast = useToast();
  const [target, setTarget] = useState('');
  const options = useLoad(async () => {
    const view = await api.get(`/apis/${sub.api_id}`);
    const out = [];
    for (const v of view.versions || [{ id: view.id, version: view.version }]) {
      const av = v.id === view.id ? view : await api.get(`/apis/${v.id}`);
      for (const p of av.plans || []) {
        if (p.auth_kind === sub.auth_kind && p.status === 'published' && p.subscribable && !(av.id === sub.api_id && p.id === sub.plan_id))
          out.push({ value: `${av.id}|${p.id}`, label: `${av.name} ${av.version} — ${p.name}` });
      }
    }
    return out;
  }, [sub.id]);
  return (
    <Modal
      title={t('transfer.title')}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!target}
          onClick={async () => {
            const [api_id, plan_id] = target.split('|');
            try {
              await api.post(`/subscriptions/${sub.id}/transfer`, { api_id, plan_id });
              toast(t('transfer.asked'));
              onDone();
            } catch (e) {
              toast(errorMessage(e), 'error');
            }
          }}
        >
          {t('transfer.ask')}
        </button>
      }
    >
      <p className="muted small">{t('transfer.help')}</p>
      <Loader state={options}>{(opts) => (opts.length ? <Select value={target} onChange={setTarget} options={[{ value: '', label: '—' }, ...opts]} /> : <Callout kind="info">{t('transfer.none')}</Callout>)}</Loader>
    </Modal>
  );
}

function PendingTransfer({ sub, onChange }) {
  const { t } = useI18n();
  const toast = useToast();
  const pt = sub.pending_transfer;
  if (!pt) return null;
  if (pt.status === 'requested') return <Callout kind="info">{t('transfer.requested', { plan: pt.to.plan_name })}</Callout>;
  // a move to a paid plan, agreed: paid through a Checkout, on a page of its own
  if (pt.status === 'awaiting_payment') {
    const pay = async () => {
      try {
        window.location.href = (await api.post(`/subscriptions/${sub.id}/checkout`)).url;
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    };
    const drop = async () => {
      try {
        await api.post(`/subscriptions/${sub.id}/transfer/consent`, { accept: false });
        toast(t('transfer.dropped'));
        onChange();
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    };
    return (
      <Callout kind="info" title={t('transfer.payment.title', { plan: pt.to.plan_name })}>
        <div>{t('transfer.payment.body')}</div>
        <div className="row mt-8">
          <button className="btn primary sm" onClick={pay}>
            {t('sub.pay')}
          </button>
          <button className="btn sm" onClick={drop}>
            {t('transfer.payment.drop')}
          </button>
        </div>
      </Callout>
    );
  }
  const answer = async (accept) => {
    try {
      await api.post(`/subscriptions/${sub.id}/transfer/consent`, { accept });
      toast(t('transfer.done'));
      onChange();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <Callout kind="warning" title={t('transfer.consent.title', { plan: pt.to.plan_name })}>
      <div>{t('transfer.consent.body', { reasons: (pt.reason_codes ? pt.reason_codes.map((c) => t(`reason.${c}`)) : pt.reasons || []).join(', ') })}</div>
      <div className="row mt-8">
        <button className="btn primary sm" onClick={() => answer(true)}>
          {t('transfer.consent.accept')}
        </button>
        <button className="btn sm" onClick={() => answer(false)}>
          {t('transfer.consent.decline')}
        </button>
      </div>
    </Callout>
  );
}

function SubscriptionCard({ sub, app, onChange }) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const creds = (sub.credentials || []).filter((c) => c.status === 'active');
  const credsPage = useLocalPaging(creds, { local: true, size: 10, text: (c) => `${c.client_id} ${c.kind || ''}` });
  const closable = ['active', 'pending', 'pending_payment', 'suspended', 'expired'].includes(sub.status);
  // a subscription that had a key has a usage of its own
  const used = ['active', 'suspended', 'expired', 'closed'].includes(sub.status);
  const [pay, setPay] = useState(false);
  const [changing, setChanging] = useState(false);
  const rotate = async (c) => {
    if (!(await confirm({ title: t('subs.rotate'), message: t(c.shared ? 'subs.rotate.confirmShared' : 'subs.rotate.confirm', { id: c.client_id }), confirmLabel: t('subs.rotate') }))) return;
    try {
      await api.post(`/subscriptions/${sub.id}/credentials/${c.id}/rotate`);
      toast(t('subs.rotated'));
      onChange();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const close = async () => {
    if (!(await confirm({ title: t('subs.close'), message: t('subs.close.confirm'), danger: true, confirmLabel: t('subs.close') }))) return;
    try {
      await api.post(`/subscriptions/${sub.id}/close`);
      toast(t('subs.closed'));
      onChange();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  // the payment is taken by Stripe, on a page of its own; the key is made once Stripe says it is paid
  const doPay = async () => {
    setPay(true);
    try {
      window.location.href = (await api.post(`/subscriptions/${sub.id}/checkout`)).url;
    } catch (e) {
      toast(errorMessage(e), 'error');
      setPay(false);
    }
  };
  const billing = async () => {
    try {
      window.location.href = (await api.post(`/subscriptions/${sub.id}/billing`)).url;
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <div className="grow">
          <div className="row wrap gap-6">
            <Link to={`/apis/${sub.api_id}`} className="bold link">
              {sub.api_name} v{sub.api_version}
            </Link>
            <span className="muted">·</span>
            <span>{sub.request?.plan_name || sub.plan_id}</span>
            <span className="tag">{authLabel(sub.auth_kind)}</span>
          </div>
          <div className="faint tiny mt-8">{t('common.since', { date: fmtDate(sub.created_at) })}</div>
        </div>
        <SubStatus status={sub.status} />
      </div>
      <div className="card-body col gap-16">
        {sub.review?.message && (
          <Callout kind={sub.status === 'rejected' ? 'negative' : 'info'} title={t('subs.review')}>
            {sub.review.message}
          </Callout>
        )}
        {sub.status === 'pending' && <div className="muted small">{t('subs.noCreds.pending')}</div>}
        {sub.status === 'expired' && <Callout kind="warning">{t('subs.expired', { date: fmtDate(sub.dates?.ending_at) })}</Callout>}
        {sub.dates?.ending_at && ['active', 'suspended'].includes(sub.status) && <div className="muted small">{t('subs.ending', { date: fmtDate(sub.dates.ending_at) })}</div>}
        {sub.status === 'pending_payment' && (
          <div className="col gap-6">
            <div className="muted small">{t('subs.noCreds.payment')}</div>
            <div className="faint tiny">{t('sub.pay.hint')}</div>
            <div>
              <button className="btn primary sm" onClick={doPay} disabled={pay}>
                {t('sub.pay')}
              </button>
            </div>
          </div>
        )}
        {['active', 'suspended'].includes(sub.status) && TOKEN_KINDS.includes(sub.auth_kind) && (
          <div className="muted small">
            {t('subs.noCreds.token', { kind: authLabel(sub.auth_kind) })} {app.client_id && <code>{app.client_id}</code>}
          </div>
        )}
        {['active', 'suspended'].includes(sub.status) && !TOKEN_KINDS.includes(sub.auth_kind) && sub.auth_kind !== 'keyless' && !creds.length && (
          <div className="muted small">{t('subs.noCreds.sync')}</div>
        )}
        <SmallSearch paging={credsPage} count={creds.length} placeholder={t('subs.creds.search')} />
        {credsPage.q && !credsPage.items.length && <div className="muted small">{t('subs.creds.nomatch')}</div>}
        {credsPage.items.map((c) => (
          <div key={c.id} className="col gap-16">
            {c.shared && <div className="muted small">{t('subs.sharedKey')}</div>}
            <dl className="kv">
              <dt>{t('subs.clientId')}</dt>
              <dd>
                <Secret value={c.client_id} reveal />
              </dd>
              <dt>{t('subs.clientSecret')}</dt>
              <dd className="row gap-6 wrap">
                <Secret value={c.client_secret} />
                <button className="btn ghost xs" onClick={() => rotate(c)}>
                  <Icon name="refresh" size={14} />
                  {t('subs.rotate')}
                </button>
              </dd>
            </dl>
            <details className="pt-details">
              <summary>{t('subs.example')}</summary>
              <div className="mt-8">
                <ExampleCall sub={sub} cred={c} />
              </div>
            </details>
          </div>
        ))}
        <SmallPager paging={credsPage} />
        {sub.status === 'active' && creds.length > 0 && <Quotas sub={sub} />}
        {sub.payment?.provider_subscription && <UsageBilled sub={sub} />}
        {sub.payment?.status === 'past_due' && <Callout kind="warning">{t('subs.pastDue', { days: sub.payment.grace_days ?? 7 })}</Callout>}
        {sub.payment?.suspended_for_payment && sub.status === 'suspended' && <Callout kind="negative">{t('subs.unpaid')}</Callout>}
        {sub.payment?.customer && ['active', 'suspended'].includes(sub.status) && (
          <div className="row gap-6 wrap">
            <span className="muted small grow">
              {t('subs.paid')}
              {sub.payment.current_period_end ? ` · ${t('subs.paidUntil', { date: fmtDate(sub.payment.current_period_end) })}` : ''}
            </span>
            <button className="btn sm" onClick={billing}>
              <Icon name="external" /> {t('subs.billing')}
            </button>
          </div>
        )}
        <PendingTransfer sub={sub} onChange={onChange} />
        {(closable || used) && (
          <div className="row">
            {used && (
              <Link to={`/usage?application=${app.id}&subscription=${sub.id}`} className="btn sm">
                <Icon name="chart" /> {t('subs.keyUsage')}
              </Link>
            )}
            {used && (
              <Link to={`/messages/new?about=subscription:${sub.id}`} className="btn sm">
                <Icon name="inbox" /> {t('messages.askSub')}
              </Link>
            )}
            {['active', 'suspended'].includes(sub.status) && !sub.pending_transfer && (
              <button className="btn sm" onClick={() => setChanging(true)}>
                <Icon name="swap" /> {t('transfer.change')}
              </button>
            )}
            <span className="spacer" />
            {closable && (
              <button className="btn ghost danger sm" onClick={close}>
                {t('subs.close')}
              </button>
            )}
          </div>
        )}
        {changing && (
          <ChangePlanModal
            sub={sub}
            onClose={() => setChanging(false)}
            onDone={() => {
              setChanging(false);
              onChange();
            }}
          />
        )}
      </div>
    </div>
  );
}
