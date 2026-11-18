import React, { useState } from 'react';
import { Link, useRouter } from '../../shared/router.jsx';
import { fmtRelative } from '../../shared/lib.js';
import { Callout, Empty, Field, Icon, Input, Loader, Modal, Select, Setting, TextArea, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { api, useWs, useMetadataFields } from '../context.jsx';
import { CertificateList } from '../../shared/certificates.jsx';
import { MetadataForm } from '../../shared/metadata.jsx';
import { PageHead } from '../layout.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../shared/lists.jsx';
import { SubscriptionsTable } from './Subscriptions.jsx';
import { AnalyticsDashboard } from './Observability.jsx';

function CreateAppModal({ onClose, onCreated }) {
  const { wapi, slug } = useWs();
  const toast = useToast();
  const teams = useLoad(() => wapi.get('/teams'), [slug]);
  const [form, setForm] = useState({ name: '', description: '', team_id: '', client_id: '' });
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      title="New application"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!form.name}
            onClick={async () => {
              try {
                onCreated(await wapi.post('/applications', { ...form, team_id: form.team_id || teams.data?.[0]?.id }));
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            Create
          </button>
        </>
      }
    >
      <p className="muted small">An application groups the subscriptions and the technical identity of a consumer. It groups identity, never counters.</p>
      <Field label="Name">
        <Input value={form.name} onChange={set('name')} autoFocus />
      </Field>
      <Field label="Description">
        <Input value={form.description} onChange={set('description')} />
      </Field>
      <Field label="Owning team">
        <Select value={form.team_id || teams.data?.[0]?.id || ''} onChange={set('team_id')} options={(teams.data || []).map((t) => ({ value: t.id, label: t.personal ? `${t.name} (personal)` : t.name }))} />
      </Field>
      <Field label="Expected client_id" hint="for oauth2 and mtls plans: how the gateway's consumer is reconciled with this application">
        <Input value={form.client_id} onChange={set('client_id')} mono />
      </Field>
    </Modal>
  );
}

export function ApplicationsPage() {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const state = useLoad(() => wapi.get('/applications'), [slug]);
  const page = useLocalPaging(state.data, { size: 25, text: (a) => `${a.name} ${a.description || ''} ${a.team_name || ''} ${a.client_id || ''} ${a.id}` });
  const [creating, setCreating] = useState(false);
  return (
    <div className="page">
      <PageHead
        title="Applications"
        sub="The consumers of the catalogue. Whoever can see an application can see its credentials."
        actions={
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> New application
          </button>
        }
      />
      <ListToolbar paging={page} placeholder="search applications, teams, client ids" onReload={state.reload} loading={state.loading} />
      <Loader state={state}>
        {() =>
          page.items.length ? (
            <div className="card">
              <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Application</th>
                    <th>Team</th>
                    <th>Expected client_id</th>
                    <th className="right">Subscriptions</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((a) => (
                    <tr key={a.id} className="clickable" onClick={() => navigate(`/ws/${slug}/applications/${a.id}`)}>
                      <td>
                        <div className="bold">{a.name}</div>
                        <div className="faint tiny">{a.description}</div>
                      </td>
                      <td className="small">
                        {a.team_name} {a.team_personal && <span className="faint">(personal)</span>}
                      </td>
                      <td className="mono small">{a.client_id || '—'}</td>
                      <td className="right">
                        {a.active_subscriptions}
                        {a.pending_subscriptions > 0 && (
                          <span className="badge warning" style={{ marginLeft: 6 }}>
                            {a.pending_subscriptions} pending
                          </span>
                        )}
                      </td>
                      <td className="muted small">{fmtRelative(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <Pager paging={page} total={page.total} />
            </div>
          ) : (
            <div className="card">
              <Empty title={page.q ? 'No application matches' : 'No application'} icon="apps">
                {page.q ? null : 'Consumers usually create their applications from the developer portal.'}
              </Empty>
            </div>
          )
        }
      </Loader>
      {creating && <CreateAppModal onClose={() => setCreating(false)} onCreated={(a) => navigate(`/ws/${slug}/applications/${a.id}`)} />}
    </div>
  );
}

export function ApplicationPage({ id }) {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const state = useLoad(() => wapi.get(`/applications/${id}`), [id]);
  const metaFields = useMetadataFields('application');
  const [form, setForm] = useState(null);
  const [tab, setTab] = useState('subscriptions');
  return (
    <div className="page">
      <Loader state={state}>
        {(app) => {
          const f = form || app;
          const set = (k) => (v) => setForm({ ...f, [k]: v });
          return (
            <>
              <PageHead crumbs={[{ label: 'Applications', to: `/ws/${slug}/applications` }, { label: app.name }]} title={app.name} sub={`team ${app.team_name} · ${app.id}`} />
              <div className="tabs mb-16">
                {['subscriptions', 'identity', 'usage'].map((t) => (
                  <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
              {tab === 'subscriptions' && <SubscriptionsTable query={`application=${app.id}`} showApp={false} onChanged={state.reload} />}
              {tab === 'usage' && <AnalyticsDashboard fixed={{ application: app.id }} />}
              {tab === 'identity' && (
                <div className="card">
                  {!app.can_see_credentials && (
                    <div className="card-body" style={{ paddingBottom: 0 }}>
                      <Callout kind="info">Read only: the team of the application and the administrators of the workspace change it.</Callout>
                    </div>
                  )}
                  <fieldset disabled={!app.can_see_credentials} className="ro-fieldset card-body">
                    <Setting label="Name">
                      <Input value={f.name} onChange={set('name')} />
                    </Setting>
                    <Setting label="Description">
                      <TextArea value={f.description} onChange={set('description')} rows={2} />
                    </Setting>
                    <Setting label="Expected client_id" help="On oauth2, jwt and mtls plans the gateway identifies the consumer by the client_id of the token or the certificate. Declaring it here is what reconciles what the gateway sees with this application.">
                      <Input value={f.client_id || ''} onChange={set('client_id')} mono />
                    </Setting>
                    {metaFields.length > 0 && (
                      <Setting label="Metadata" help="typed fields of the workspace's applications; the ones marked for the portal are filled by the consumer">
                        <MetadataForm fields={metaFields} values={f.metadata} onChange={set('metadata')} />
                      </Setting>
                    )}
                    <CertificateList
                      value={f.certificates || []}
                      onChange={set('certificates')}
                      inspect={(pem) => api.post('/certificates/inspect', { pem })}
                      mode="client"
                      label="Client certificates"
                      help={`presented on the mtls plans: derived as certificates of the gateway while the application has an active subscription to an mtls plan, so that the TLS handshake accepts them — ${
                        app.certificates_on_gateway ? 'they are on the gateway now' : 'not on the gateway now'
                      }`}
                      addLabel="Add a certificate"
                      addTitle="Add a client certificate"
                      addHelp="The certificate (PEM) the application presents on mtls plans. Only the certificate: never its private key."
                      clientId={f.client_id}
                      onClientId={set('client_id')}
                      readOnly={!app.can_see_credentials}
                    />
                    <div className="row mt-16">
                      <button
                        className="btn primary"
                        disabled={!form}
                        onClick={async () => {
                          try {
                            await wapi.put(`/applications/${app.id}`, form);
                            setForm(null);
                            toast('Application saved');
                            state.reload();
                          } catch (e) {
                            toast(errorMessage(e), 'error');
                          }
                        }}
                      >
                        Save
                      </button>
                      <span className="spacer" />
                      <button
                        className="btn danger"
                        onClick={async () => {
                          if (!(await confirm({ title: `Delete ${app.name}?`, danger: true, confirmLabel: 'Delete', message: 'Only possible once its subscriptions are closed.' }))) return;
                          try {
                            await wapi.del(`/applications/${app.id}`);
                            navigate(`/ws/${slug}/applications`);
                          } catch (e) {
                            toast(errorMessage(e), 'error');
                          }
                        }}
                      >
                        Delete application
                      </button>
                    </div>
                  </fieldset>
                </div>
              )}
            </>
          );
        }}
      </Loader>
    </div>
  );
}
