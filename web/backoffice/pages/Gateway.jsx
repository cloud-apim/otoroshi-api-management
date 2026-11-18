import React, { useState } from 'react';
import { useQuery, useRouter } from '../../shared/router.jsx';
import { fmtDate, fmtNumber, fmtRelative } from '../../shared/lib.js';
import { Callout, DiffView, Empty, Icon, Input, Loader, Select, Setting, StatusBadge, errorMessage, useLoad, useToast } from '../../shared/ui.jsx';
import { ListToolbar, Pager, useLocalPaging, usePaging } from '../../shared/lists.jsx';
import { StatTile } from '../../shared/charts.jsx';
import { api, useSession } from '../context.jsx';
import { PageHead } from '../layout.jsx';

// one installation drives one Otoroshi cluster: its health, the projection queue and the
// drift live here, not in a "clusters" list
function Status() {
  const { user } = useSession();
  const st = useLoad(() => api.get('/gateway/status'), []);
  const paging = usePaging({ prefix: 'tasks', size: 25 });
  const [params, setParams] = useQuery();
  const status = params.get('tasks_status') || '';
  const tasks = useLoad(() => api.get(`/gateway/tasks?${paging.query}${status ? `&status=${status}` : ''}`), [paging.key, status]);
  const toast = useToast();
  return (
    <Loader state={st}>
      {(s) => (
        <div className="col gap-16">
          <div className="grid-4">
            <StatTile label="Gateway" value={s.health.ok ? 'Reachable' : 'Unreachable'} hint={s.health.ok ? `${s.health.url} · ${s.health.latencyMs} ms` : s.health.error} />
            <StatTile label="Projections waiting" value={(s.queue.pending || 0) + (s.queue.running || 0)} hint={`${s.queue.failed || 0} failed · ${s.queue.done || 0} done`} />
            <StatTile label="Drift" value={(s.drift?.drifted || 0) + (s.drift?.missing || 0)} hint={s.drift ? `checked ${fmtRelative(s.drift.at)}` : 'not checked yet'} />
            <StatTile label="Ingested calls" value={fmtNumber(s.ingest?.calls)} hint={s.ingest?.last_at ? `last ${fmtRelative(s.ingest.last_at)}` : 'nothing received yet'} />
          </div>
          <Callout kind="info">
            The product is never in the request path: if it is down, traffic still flows. Its operations are asynchronous and replayable — a projection that cannot reach the gateway waits in this
            queue and runs when the gateway is back.
          </Callout>
          <div className="card">
            <div className="card-head">
              <h3 className="grow">Projection queue</h3>
            </div>
            <div className="card-body" style={{ paddingBottom: 0 }}>
              <ListToolbar paging={paging} placeholder="search kinds, payloads, errors" onReload={tasks.reload} loading={tasks.loading}>
                <Select
                  value={status}
                  onChange={(v) => setParams({ tasks_status: v, tasks_page: null })}
                  options={[{ value: '', label: 'every status' }, 'pending', 'running', 'failed', 'done']}
                  style={{ width: 160 }}
                  aria-label="filter by status"
                />
              </ListToolbar>
            </div>
            <Loader state={tasks}>
              {({ items: list, total }) =>
                list.length ? (
                  <>
                  <div className="table-wrap">
                    <table className="table small">
                      <tbody>
                        {list.map((t) => (
                          <tr key={t.id}>
                            <td className="mono">{t.kind}</td>
                            <td>
                              <StatusBadge status={t.status} />
                            </td>
                            <td className="muted">
                              {t.attempts} attempt(s) · {fmtRelative(t.updated_at)}
                            </td>
                            <td className="negative-text">{t.last_error}</td>
                            <td className="actions">
                              {t.status !== 'done' && user.is_admin && (
                                <button
                                  className="btn xs"
                                  onClick={async () => {
                                    await api.post(`/gateway/tasks/${t.id}/retry`);
                                    toast('Task queued again');
                                    tasks.reload();
                                  }}
                                >
                                  Retry
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager paging={paging} total={total} />
                  </>
                ) : (
                  <Empty title={paging.q || status ? 'No task matches' : 'Nothing queued'} icon="check" />
                )
              }
            </Loader>
          </div>
        </div>
      )}
    </Loader>
  );
}

function Drift() {
  const reports = useLoad(() => api.get('/gateway/drift-reports'), []);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className="col gap-16">
      <div className="row">
        <p className="muted small grow">Both sides are administrable, so drift is certain, not probable. It is detected periodically, object by object, against the snapshot that should run.</p>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.post('/gateway/drift');
              toast(`Checked ${r.apis} apis and ${r.subscriptions} subscriptions in ${r.durationMs} ms`);
              reports.reload();
            } catch (e) {
              toast(errorMessage(e), 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="refresh" /> Run detection now
        </button>
      </div>
      <Loader state={reports}>{(list) => <DriftList list={list} reports={reports} />}</Loader>
    </div>
  );
}

// the reports of the installation, searched and paged here (the server sends them all)
function DriftList({ list, reports }) {
  const [params, setParams] = useQuery();
  const status = params.get('drift_status') || '';
  const page = useLocalPaging(
    list.filter((r) => !status || r.status === status),
    { prefix: 'drift', size: 25, text: (r) => `${r.label} ${r.entity_id} ${r.otoroshi_kind} ${r.otoroshi_id} ${r.status} ${JSON.stringify(r.diff || [])}` },
  );
  return (
    <>
      <ListToolbar paging={page} placeholder="search apis, subscriptions, ids, changes" onReload={reports.reload} loading={reports.loading}>
        <Select
          value={status}
          onChange={(v) => setParams({ drift_status: v, drift_page: null })}
          options={[{ value: '', label: 'every status' }, 'drifted', 'missing', 'unmanaged', 'in_sync']}
          style={{ width: 160 }}
          aria-label="filter by status"
        />
      </ListToolbar>
      {page.items.length ? (
            <div className="card">
              {page.items.map((r) => (
                <div key={r.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <StatusBadge status={r.status} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="bold">
                      {r.label || r.entity_id} <span className="faint small">{r.otoroshi_kind}</span>
                    </div>
                    <div className="faint tiny mono">{r.otoroshi_id}</div>
                    {r.status === 'drifted' && (
                      <div className="mt-8">
                        <DiffView changes={r.diff} />
                      </div>
                    )}
                    {r.status === 'unmanaged' && <div className="muted small">Not managed by the product: it can be adopted from the APIs page.</div>}
                  </div>
                  <span className="faint small nowrap">{fmtRelative(r.checked_at)}</span>
                </div>
              ))}
              <Pager paging={page} total={page.total} />
            </div>
          ) : (
            <div className="card">
              <Empty title={page.q || status ? 'No report matches' : 'No report yet'} icon="gateway" />
            </div>
          )}
    </>
  );
}

function Connection() {
  const { user } = useSession();
  const st = useLoad(() => api.get('/settings'), []);
  const toast = useToast();
  const [form, setForm] = useState(null);
  if (!user.is_admin) return <Callout kind="info">Installation administrators only.</Callout>;
  return (
    <Loader state={st}>
      {(s) => {
        const f = form || s.gateway;
        const set = (k) => (v) => setForm({ ...f, [k]: v });
        return (
          <div className="col gap-16">
            <div className="card">
              <div className="card-head">
                <h3>Otoroshi Admin API</h3>
              </div>
              <div className="card-body">
                <Setting label="Admin API url" help="how the product reaches the cluster's leader">
                  <Input value={f.url} onChange={set('url')} mono />
                </Setting>
                <Setting label="Admin API host" help="the Host header of the admin api">
                  <Input value={f.host} onChange={set('host')} mono />
                </Setting>
                <Setting label="Administration key" help="client id and secret of an Otoroshi admin apikey">
                  <Input value={f.clientId} onChange={set('clientId')} mono />
                  <Input value={f.clientSecret} onChange={set('clientSecret')} mono type="password" />
                </Setting>
                <Setting label="Public exposure" help="how consumers reach the apis: <scheme>://<api domain>:<port>">
                  <div className="row">
                    <Input value={f.publicScheme} onChange={set('publicScheme')} mono />
                    <Input value={f.publicPort} onChange={set('publicPort')} mono />
                  </div>
                </Setting>
                <Setting label="Otoroshi backoffice url" help="used to link a projected entity — the escape hatch">
                  <Input value={f.backofficeUrl} onChange={set('backofficeUrl')} mono />
                </Setting>
                <div className="row mt-16">
                  <button
                    className="btn primary"
                    disabled={!form}
                    onClick={async () => {
                      try {
                        await api.put('/settings/gateway', form);
                        setForm(null);
                        toast('Gateway settings saved');
                        st.reload();
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
            <Exporter ingest={s.ingest} />
          </div>
        );
      }}
    </Loader>
  );
}

function Exporter({ ingest }) {
  const toast = useToast();
  const [url, setUrl] = useState(ingest.url.replace('localhost', 'host.docker.internal'));
  return (
    <div className="card">
      <div className="card-head">
        <h3>Events → ingester</h3>
      </div>
      <div className="card-body">
        <Setting label="Data exporter" help="An Otoroshi data exporter sends GatewayEvent, LLMUsageAudit and McpAudit to /ingest. An exporter is gateway infrastructure: this helper creates one, marked as managed, and touches no other.">
          <Input value={url} onChange={setUrl} mono />
          <button
            className="btn"
            style={{ alignSelf: 'flex-start' }}
            onClick={async () => {
              try {
                const r = await api.post('/gateway/exporter', { url });
                toast(`Exporter ${r.id} installed`);
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            Install / update the exporter
          </button>
        </Setting>
        <Setting label="Raw path" help="computed path: mandatory and exhaustive. Raw path: optional, where lightening and masking of url secrets belong.">
          <div className="muted small">{ingest.storeRaw ? 'raw events are stored (lightened, url secrets masked)' : 'raw events are not stored'}</div>
          <button
            className="btn sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={async () => {
              await api.put('/settings/ingest', { storeRaw: !ingest.storeRaw });
              toast(`Raw path ${ingest.storeRaw ? 'disabled' : 'enabled'}`);
            }}
          >
            {ingest.storeRaw ? 'Disable' : 'Enable'} the raw path
          </button>
        </Setting>
      </div>
    </div>
  );
}

export function GatewayPage({ tab }) {
  const { navigate } = useRouter();
  return (
    <div className="page">
      <PageHead title="Gateway" sub="The Otoroshi cluster this installation drives. One installation per environment; geography is carried by Otoroshi's own leader/worker cluster." />
      <div className="tabs mb-16">
        {[
          ['status', 'Status & queue'],
          ['drift', 'Drift'],
          ['connection', 'Connection & events'],
        ].map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => navigate(`/gateway/${id}`)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'status' && <Status />}
      {tab === 'drift' && <Drift />}
      {tab === 'connection' && <Connection />}
    </div>
  );
}
