import React, { useEffect, useState } from 'react';
import { Link } from '../../shared/router.jsx';
import { Callout, Field, Input, Modal, Secret, Select, TextArea, errorMessage, useLoad, Loading } from '../../shared/ui.jsx';
import { api } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { authLabel, priceLabel } from '../common.jsx';
import { MetadataForm } from '../../shared/metadata.jsx';

const TOKEN_KINDS = ['jwt', 'mtls', 'oauth2-remote'];

async function credentialsFor(appId, subId, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const app = await api.get(`/applications/${appId}`);
    const sub = (app.subscriptions || []).find((s) => s.id === subId);
    const creds = (sub?.credentials || []).filter((c) => c.status === 'active');
    if (creds.length || !sub || sub.status !== 'active') return { sub, creds };
    await new Promise((r) => setTimeout(r, 800));
  }
  return { sub: null, creds: [] };
}

export function SubscribeModal({ api: a, plan, onClose }) {
  const { t, lang } = useI18n();
  const apps = useLoad(() => api.get('/applications'), []);
  const [appId, setAppId] = useState('');
  const [newName, setNewName] = useState('');
  const [clientId, setClientId] = useState('');
  const [usage, setUsage] = useState('');
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { sub, app, creds }
  // the request form of the plans: subscription fields the workspace asks requesters
  const [formFields, setFormFields] = useState([]);
  const [answers, setAnswers] = useState({});
  useEffect(() => {
    api.get('/metadata-fields').then((f) => setFormFields(f.filter((x) => x.scope === 'subscription'))).catch(() => {});
  }, []);

  useEffect(() => {
    if (apps.data && !appId) setAppId(apps.data[0]?.id || '__new__');
  }, [apps.data]);

  const isNew = appId === '__new__';
  const selected = (apps.data || []).find((x) => x.id === appId);
  const needsClientId = TOKEN_KINDS.includes(plan.auth_kind) && (isNew || !selected?.client_id);
  const usageRequired = plan.usage_statement?.required;
  const canSubmit =
    !busy &&
    (isNew ? newName.trim() : !!appId) &&
    (!needsClientId || clientId.trim()) &&
    (!usageRequired || usage.trim()) &&
    (!plan.terms || terms) &&
    formFields.every((f) => !f.required || (answers[f.key] !== undefined && answers[f.key] !== ''));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let app = selected;
      if (isNew) app = await api.post('/applications', { name: newName.trim(), client_id: needsClientId ? clientId.trim() : undefined });
      else if (needsClientId) app = await api.put(`/applications/${app.id}`, { client_id: clientId.trim() });
      const sub = await api.post('/subscriptions', { api_id: a.id, plan_id: plan.id, application_id: app.id, usage, terms_accepted: terms, metadata: answers });
      let creds = [];
      if (sub.status === 'active' && !TOKEN_KINDS.includes(sub.auth_kind) && sub.auth_kind !== 'keyless') creds = (await credentialsFor(app.id, sub.id)).creds;
      setResult({ sub, app, creds });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  // the payment is taken by Stripe, on a page of its own: back on the application once paid
  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      window.location.href = (await api.post(`/subscriptions/${result.sub.id}/checkout`)).url;
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (result) {
    const s = result.sub.status;
    return (
      <Modal
        title={t('sub.title', { plan: plan.name })}
        onClose={onClose}
        footer={
          <>
            <button className="btn" onClick={onClose}>
              {t('sub.close')}
            </button>
            <Link to={`/apps/${result.app.id}`} className="btn primary">
              {t('sub.goApp')}
            </Link>
          </>
        }
      >
        {error && <Callout kind="negative">{errorMessage(error)}</Callout>}
        {s === 'active' && <Callout kind="positive">{t('sub.done.active')}</Callout>}
        {s === 'pending' && <Callout kind="info">{t('sub.done.pending')}</Callout>}
        {s === 'pending_payment' && (
          <>
            <Callout kind="warning">{t('sub.done.pending_payment')}</Callout>
            <p className="muted small">{t('sub.pay.hint')}</p>
            <button className="btn primary" onClick={pay} disabled={busy}>
              {t('sub.pay')}
              {plan.pricing ? ` · ${priceLabel(t, plan.pricing)}` : ''}
            </button>
          </>
        )}
        {s === 'active' && TOKEN_KINDS.includes(result.sub.auth_kind) && <p className="muted small">{t('subs.noCreds.token', { kind: authLabel(result.sub.auth_kind) })}</p>}
        {s === 'active' && result.creds.length > 0 && (
          <div className="col gap-6">
            {result.creds.map((c) => (
              <dl key={c.id} className="kv">
                <dt>{t('subs.clientId')}</dt>
                <dd>
                  <Secret value={c.client_id} reveal />
                </dd>
                <dt>{t('subs.clientSecret')}</dt>
                <dd>
                  <Secret value={c.client_secret} />
                </dd>
              </dl>
            ))}
          </div>
        )}
        {s === 'active' && !result.creds.length && !TOKEN_KINDS.includes(result.sub.auth_kind) && result.sub.auth_kind !== 'keyless' && <p className="muted small">{t('sub.waiting')}</p>}
      </Modal>
    );
  }

  return (
    <Modal
      title={t('sub.title', { plan: plan.name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('sub.cancel')}
          </button>
          <button className="btn primary" type="submit" form="subscribe-form" disabled={!canSubmit}>
            {busy ? <span className="spinner" /> : t('sub.submit')}
          </button>
        </>
      }
    >
      {apps.loading && !apps.data ? (
        <Loading />
      ) : (
        <form id="subscribe-form" className="col gap-16" onSubmit={submit}>
          <div className="panel small">
            <div className="row gap-6">
              <span className="bold grow">
                {a.name} v{a.version} · {plan.name}
              </span>
              <span className="tag">{authLabel(plan.auth_kind)}</span>
            </div>
            {plan.validation === 'manual' && <div className="muted mt-8">{t('plan.validation.manual')}</div>}
          </div>
          <Field label={t('sub.app')} hint={t('sub.app.hint')}>
            <Select
              value={appId}
              onChange={setAppId}
              aria-label={t('sub.app')}
              options={[...(apps.data || []).map((x) => ({ value: x.id, label: `${x.name}${x.team_personal ? '' : ` · ${x.team_name}`}` })), { value: '__new__', label: t('sub.app.new') }]}
            />
          </Field>
          {isNew && (
            <Field label={t('sub.app.name')}>
              <Input value={newName} onChange={setNewName} placeholder={t('sub.app.namePlaceholder')} autoFocus aria-label={t('sub.app.name')} />
            </Field>
          )}
          {needsClientId && (
            <>
              <Callout kind="info">{t('sub.clientIdNeeded', { kind: authLabel(plan.auth_kind) })}</Callout>
              <Field label={t('sub.setClientId')}>
                <Input value={clientId} onChange={setClientId} mono aria-label={t('sub.setClientId')} />
              </Field>
            </>
          )}
          {plan.usage_statement && (
            <Field label={`${t('sub.usage')}${usageRequired ? ` (${t('sub.usage.required')})` : ''}`} hint={plan.usage_statement.prompt}>
              <TextArea value={usage} onChange={setUsage} rows={4} aria-label={t('sub.usage')} required={usageRequired} />
            </Field>
          )}
          {formFields.length > 0 && <MetadataForm fields={formFields} values={answers} onChange={setAnswers} lang={lang} />}
          {plan.terms && (
            <label className="checkbox">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
              <span>
                {t('sub.terms')}{' '}
                {plan.terms.url && (
                  <a className="link" href={plan.terms.url} target="_blank" rel="noreferrer">
                    ({t('sub.terms.read')})
                  </a>
                )}
              </span>
            </label>
          )}
          {error && <Callout kind="negative">{errorMessage(error)}</Callout>}
        </form>
      )}
    </Modal>
  );
}
