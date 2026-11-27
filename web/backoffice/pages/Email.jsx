import React, { useState } from 'react';
import { Badge, Callout, Empty, Input, Loader, NumberInput, Select, Setting, Switch, errorMessage, useLoad, useToast } from '../../shared/ui.jsx';
import { ListToolbar, Pager, usePaging } from '../../shared/lists.jsx';
import { fmtDate } from '../../shared/lib.js';
import { api, useSession, useWs } from '../context.jsx';
import { tr } from '../../shared/i18n.jsx';

const TRANSPORTS = () => [
  { value: 'none', label: tr('None: no email is sent') },
  { value: 'smtp', label: tr('SMTP') },
  { value: 'mailgun', label: 'Mailgun' },
  { value: 'mailjet', label: 'Mailjet' },
  { value: 'sendgrid', label: 'SendGrid' },
  { value: 'log', label: tr('Log: written to the log of the product (development)') },
];

// what each kind of notification says, for the people it goes to
export const KIND_LABELS = () => ({
  'subscription.accept': tr('a request accepted'),
  'subscription.reject': tr('a request rejected'),
  'subscription.suspend': tr('a subscription suspended'),
  'subscription.resume': tr('a subscription resumed'),
  'subscription.close': tr('a subscription closed'),
  'subscription.expire': tr('a subscription expired, past its end date'),
  'subscription.renew': tr('a subscription renewed'),
  'subscription.ending': tr('an end date set or taken off'),
  'subscription.payment': tr('a subscription paid'),
  'subscription.payment.suspended': tr('a subscription suspended for want of payment'),
  'subscription.payment.resumed': tr('a subscription resumed once paid'),
  'subscription.payment.canceled': tr('a paid subscription canceled'),
  'subscription.transfer': tr('a subscription moved to another plan'),
  'subscription.transfer.payment': tr('a move to pay'),
  'subscription.transfer.consent': tr('a move to agree to'),
  'subscription.transfer.decline': tr('a move declined'),
  'subscription.transfer.request': tr('a move asked by a consumer'),
  'subscription.request': tr('a request to review'),
  'api.announcement': tr('an announcement of an API'),
  'api.deprecated': tr('a version deprecated'),
  'api.archived': tr('a version archived'),
  'pin.behind': tr('a shared group or resource published, an API behind'),
  'webhook.failing': tr('a webhook failing'),
  'webhook.disabled': tr('a webhook turned off'),
});

// ---------------------------------------------------------------- the transport of the installation

export function EmailTransport() {
  const st = useLoad(() => api.get('/settings'), []);
  const toast = useToast();
  const { user } = useSession();
  const [form, setForm] = useState(null);
  const [to, setTo] = useState(user.email || '');
  const [testing, setTesting] = useState(false);
  const page = usePaging({ prefix: 'mails', size: 25 });
  const [status, setStatus] = useState('');
  const log = useLoad(() => api.get(`/settings/email/deliveries?${page.query}${status ? `&status=${status}` : ''}`), [page.key, status]);
  const save = async (f) => {
    const { problems, ready, ...value } = f;
    try {
      await api.put('/settings/email', value);
      toast(tr('Email settings saved'));
      setForm(null);
      st.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      const r = await api.post('/settings/email/test', { to });
      toast(r.sent ? tr('Test email sent to {0}', [to]) : tr('Not sent: {0}', [r.error]), r.sent ? 'info' : 'error');
      log.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setTesting(false);
    }
  };
  return (
    <Loader state={st}>
      {(s) => {
        const f = form || s.email;
        const set = (patch) => setForm({ ...f, ...patch });
        const setSmtp = (patch) => setForm({ ...f, smtp: { ...f.smtp, ...patch } });
        const t = f.transport;
        return (
          <div className="col gap-16">
            <p className="muted small" style={{ margin: 0 }}>
              {tr('How this installation sends email: the notifications a workspace sends by email, when its administrators turn them on (Workspace settings › Email). The APIM_EMAIL_* variables give the values not set here.')}
            </p>
            <div className="card">
              <div className="card-body">
                <Setting label={tr('Transport')}>
                  <Select value={t} onChange={(v) => set({ transport: v })} options={TRANSPORTS()} style={{ maxWidth: 420 }} />
                </Setting>
                {t !== 'none' && (
                  <Setting label={tr('From')} help={tr('the sender of every email, e.g. API portal <no-reply@example.com>; an address the transport is allowed to send from')}>
                    <Input value={f.from} onChange={(v) => set({ from: v })} placeholder="API portal <no-reply@example.com>" />
                  </Setting>
                )}
                {t === 'smtp' && (
                  <>
                    <Setting label={tr('Server')} help={tr('STARTTLS required on 587, TLS from the start on 465; none only for a relay of a local network')}>
                      <div className="row wrap">
                        <Input value={f.smtp.host} onChange={(v) => setSmtp({ host: v })} mono placeholder={tr('host')} />
                        <NumberInput value={f.smtp.port} onChange={(v) => setSmtp({ port: v })} placeholder="587" style={{ width: 110 }} aria-label={tr('port')} />
                        <Select
                          value={f.smtp.security}
                          onChange={(v) => setSmtp({ security: v })}
                          options={[
                            { value: 'starttls', label: 'STARTTLS' },
                            { value: 'tls', label: 'TLS' },
                            { value: 'none', label: tr('none') },
                          ]}
                          style={{ width: 140 }}
                          aria-label={tr('security')}
                        />
                      </div>
                    </Setting>
                    <Setting label={tr('Account')} help={tr('empty when the server takes no authentication')}>
                      <div className="row wrap">
                        <Input value={f.smtp.user} onChange={(v) => setSmtp({ user: v })} mono placeholder={tr('user')} />
                        <Input value={f.smtp.password} onChange={(v) => setSmtp({ password: v })} mono type="password" placeholder={tr('password')} />
                      </div>
                    </Setting>
                  </>
                )}
                {t === 'mailgun' && (
                  <Setting label={tr('Sending domain')}>
                    <div className="row wrap">
                      <Input value={f.domain} onChange={(v) => set({ domain: v })} mono placeholder="mg.example.com" />
                      <Select value={f.region} onChange={(v) => set({ region: v })} options={[{ value: 'us', label: tr('US region') }, { value: 'eu', label: tr('EU region') }]} style={{ width: 140 }} aria-label={tr('region')} />
                    </div>
                  </Setting>
                )}
                {['mailgun', 'mailjet', 'sendgrid'].includes(t) && (
                  <>
                    <Setting label={tr('API key')} help={t === 'mailjet' ? tr('the API key and its secret key') : tr('sealed at rest, never shown again')}>
                      <div className="row wrap">
                        <Input value={f.apiKey} onChange={(v) => set({ apiKey: v })} mono type="password" placeholder={tr('API key')} />
                        {t === 'mailjet' && <Input value={f.apiSecret} onChange={(v) => set({ apiSecret: v })} mono type="password" placeholder={tr('secret key')} />}
                      </div>
                    </Setting>
                    <Setting label={tr('API address')} help={tr('empty: the address of the provider; another one for a proxy or a region of its own')}>
                      <Input value={f.apiBase} onChange={(v) => set({ apiBase: v })} mono placeholder={tr('default address of the provider')} />
                    </Setting>
                  </>
                )}
                {!form && t !== 'none' && (s.email.ready ? <Callout kind="positive">{tr('The transport is ready to send.')}</Callout> : <Callout kind="warning">{s.email.problems.join(' ')}</Callout>)}
                <div className="row mt-8">
                  <button className="btn primary" disabled={!form} onClick={() => save(f)}>
                    {tr('Save')}
                  </button>
                  {form && (
                    <button className="btn" onClick={() => setForm(null)}>
                      {tr('Cancel')}
                    </button>
                  )}
                </div>
              </div>
            </div>
            {s.email.ready && !form && (
              <div className="card">
                <div className="card-head">
                  <h3>{tr('Send a test email')}</h3>
                </div>
                <div className="card-body row wrap">
                  <Input value={to} onChange={setTo} placeholder={tr('an email address')} style={{ maxWidth: 320 }} />
                  <button className="btn" disabled={!to || testing} onClick={test}>
                    {tr('Send')}
                  </button>
                </div>
              </div>
            )}
            <div className="card">
              <div className="card-head">
                <h3>{tr('Emails')}</h3>
                <span className="faint small">{tr('sent, or not, the most recent first')}</span>
              </div>
              <div className="card-body col gap-8">
                <ListToolbar paging={page} placeholder={tr('search addresses, subjects, kinds, workspaces')} onReload={log.reload} loading={log.loading}>
                  <Select
                    value={status}
                    onChange={(v) => (setStatus(v), page.setPage(1))}
                    options={[
                      { value: '', label: tr('All statuses') },
                      { value: 'sent', label: tr('sent') },
                      { value: 'failed', label: tr('failed') },
                    ]}
                    style={{ width: 160 }}
                    aria-label={tr('filter by status')}
                  />
                </ListToolbar>
                <Loader state={log}>
                  {(l) =>
                    l.items.length ? (
                      <>
                        <div className="table-wrap">
                          <table className="table">
                            <thead>
                              <tr>
                                <th>{tr('When')}</th>
                                <th>{tr('To')}</th>
                                <th>{tr('Subject')}</th>
                                <th>{tr('Kind')}</th>
                                <th>{tr('Status')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {l.items.map((d) => (
                                <tr key={d.id}>
                                  <td className="small muted">{fmtDate(d.updated_at || d.created_at)}</td>
                                  <td className="mono small">{d.address}</td>
                                  <td>
                                    {d.subject}
                                    {d.workspace && <div className="faint tiny">{d.workspace}</div>}
                                  </td>
                                  <td className="small">{d.kind === 'test' ? tr('test') : KIND_LABELS()[d.kind] || d.kind}</td>
                                  <td>
                                    <Badge kind={d.status === 'sent' ? 'positive' : 'negative'}>{tr(d.status)}</Badge>
                                    {d.error && <div className="faint tiny" style={{ maxWidth: 320 }}>{d.error}</div>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <Pager paging={page} total={l.total} />
                      </>
                    ) : (
                      <Empty title={tr('No email yet')} icon="inbox" />
                    )
                  }
                </Loader>
              </div>
            </div>
          </div>
        );
      }}
    </Loader>
  );
}

// ---------------------------------------------------------------- what a workspace sends by email

const FACES = () => [
  { id: 'portal', title: tr('To the people of the portal'), help: tr('the consumers, about their subscriptions and the APIs they use; they do not choose: what is turned on here is sent to them') },
  { id: 'console', title: tr('To the producers'), help: tr('the teams of the APIs, about what they have to decide') },
];

export function WorkspaceEmail() {
  const { wapi, isAdmin } = useWs();
  const toast = useToast();
  const st = useLoad(() => wapi.get('/email'), []);
  const save = async (next) => {
    try {
      await wapi.put('/email', next);
      toast(tr('Email settings saved'));
      st.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const labels = KIND_LABELS();
  return (
    <Loader state={st}>
      {(s) => (
        <div className="col gap-16">
          <p className="muted small" style={{ margin: 0 }}>
            {tr('The notifications of this workspace, sent by email too: turned on for a face, then kind by kind. Nothing is sent until a face is on.')}
          </p>
          {!s.transport.ready && (
            <Callout kind="warning" title={tr('No email can be sent yet')}>
              {tr('The installation has no email transport ready: an installation administrator sets it in Global settings › Email.')}
            </Callout>
          )}
          {FACES().map((face) => {
            const cur = s[face.id];
            const setFace = (patch) => save({ [face.id]: { ...cur, ...patch } });
            return (
              <div key={face.id} className="card">
                <div className="card-head">
                  <h3 className="grow">{face.title}</h3>
                  <Switch checked={cur.enabled} onChange={(v) => setFace({ enabled: v })} disabled={!isAdmin} label={cur.enabled ? tr('on') : tr('off')} />
                </div>
                <div className="card-body col gap-8">
                  <p className="muted small" style={{ margin: 0 }}>
                    {face.help}
                  </p>
                  {cur.enabled &&
                    s.kinds[face.id].map((k) => (
                      <Switch
                        key={k}
                        checked={cur.kinds[k] !== false}
                        disabled={!isAdmin}
                        onChange={(v) => {
                          const kinds = { ...cur.kinds };
                          if (v) delete kinds[k];
                          else kinds[k] = false;
                          setFace({ kinds });
                        }}
                        label={labels[k] || k}
                      />
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Loader>
  );
}
