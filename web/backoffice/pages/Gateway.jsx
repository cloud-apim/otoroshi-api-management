import React, { useState } from 'react';
import { Link, useQuery, useRouter } from '../../shared/router.jsx';
import { fmtDate, fmtNumber, fmtRelative } from '../../shared/lib.js';
import { Callout, DiffView, Empty, Icon, Input, Loader, NumberInput, Seg, Select, Setting, StatusBadge, Switch, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { ListToolbar, Pager, useLocalPaging, usePaging } from '../../shared/lists.jsx';
import { StatTile } from '../../shared/charts.jsx';
import { api, useSession } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';

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
            <StatTile label={tr('Gateway')} value={s.health.ok ? 'Reachable' : 'Unreachable'} hint={s.health.ok ? tr('{0} · {1} ms', [s.health.url, s.health.latencyMs]) : s.health.error} />
            <StatTile label={tr('Projections waiting')} value={(s.queue.pending || 0) + (s.queue.running || 0)} hint={tr('{0} failed · {1} done', [s.queue.failed || 0, s.queue.done || 0])} />
            <StatTile label={tr('Drift')} value={(s.drift?.drifted || 0) + (s.drift?.missing || 0)} hint={s.drift ? tr('checked {0}', [fmtRelative(s.drift.at)]) : tr('not checked yet')} />
            <StatTile label={tr('Ingested calls')} value={fmtNumber(s.ingest?.calls)} hint={s.ingest?.last_at ? tr('last {0}', [fmtRelative(s.ingest.last_at)]) : tr('nothing received yet')} />
          </div>
          <Callout kind="info">
            {tr('The product is never in the request path: if it is down, traffic still flows. Its operations are asynchronous and replayable — a projection that cannot reach the gateway waits in this queue and runs when the gateway is back.')}
          </Callout>
          {s.queue.failed > 0 && (
            <Callout kind="negative" title={tr('{0} projection{1} failed', [s.queue.failed, s.queue.failed > 1 ? tr('s') : ''])}>
              <div className="col gap-6">
                <span>
                  <Tr text={'The gateway refused {0}, or {1} failed too many times: a failed projection does not run again by itself. Read its error, fix the cause — often in the object it projects — and retry it, or dismiss it if it no longer applies.'} args={[s.queue.failed > 1 ? tr('them') : tr('it'), s.queue.failed > 1 ? tr('they') : tr('it')]} />
                </span>
                {status !== 'failed' && (
                  <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setParams({ tasks_status: 'failed', tasks_page: null })}>
                    <Tr text={'Show {0}'} args={[s.queue.failed > 1 ? tr('them') : tr('it')]} />
                  </button>
                )}
              </div>
            </Callout>
          )}
          <div className="card">
            <div className="card-head">
              <h3 className="grow">{tr('Projection queue')}</h3>
            </div>
            <div className="card-body" style={{ paddingBottom: 0 }}>
              <ListToolbar paging={paging} placeholder={tr('search kinds, payloads, errors')} onReload={tasks.reload} loading={tasks.loading}>
                <Select
                  value={status}
                  onChange={(v) => setParams({ tasks_status: v, tasks_page: null })}
                  options={[{ value: '', label: tr('every status') }, 'pending', 'running', 'failed', 'dismissed', 'done']}
                  style={{ width: 160 }}
                  aria-label={tr('filter by status')}
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
                            <td>
                              <div className="mono">{t.kind}</div>
                              {t.target &&
                                (t.target.link ? (
                                  <Link to={t.target.link} className="link tiny">
                                    {t.target.label}
                                  </Link>
                                ) : (
                                  <span className="faint tiny">{t.target.label}</span>
                                ))}
                            </td>
                            <td>
                              <StatusBadge status={t.status} />
                            </td>
                            <td className="muted">
                              <Tr text={'{0} attempt(s) · {1}'} args={[t.attempts, fmtRelative(t.updated_at)]} />
                            </td>
                            <td>
                              {t.last_error && <div className="negative-text">{t.last_error}</div>}
                              {t.payload?.dismissed && <div className="faint tiny"><Tr text={'dismissed: {0}'} args={[t.payload.dismissed]} /></div>}
                            </td>
                            <td className="actions">
                              {t.status !== 'done' && t.status !== 'running' && user.is_admin && (
                                <button
                                  className="btn xs"
                                  onClick={async () => {
                                    await api.post(`/gateway/tasks/${t.id}/retry`);
                                    toast(tr('Task queued again'));
                                    tasks.reload();
                                    st.reload();
                                  }}
                                >
                                  {tr('Retry')}
                                </button>
                              )}
                              {t.status === 'failed' && user.is_admin && (
                                <button
                                  className="btn xs ghost"
                                  title={tr('it no longer counts as something to do')}
                                  onClick={async () => {
                                    try {
                                      await api.post(`/gateway/tasks/${t.id}/dismiss`, {});
                                      toast(tr('Task dismissed'));
                                      tasks.reload();
                                      st.reload();
                                    } catch (e) {
                                      toast(errorMessage(e), 'error');
                                    }
                                  }}
                                >
                                  {tr('Dismiss')}
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
                  <Empty title={paging.q || status ? tr('No task matches') : tr('Nothing queued')} icon="check" />
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
        <p className="muted small grow">{tr('Both sides are administrable, so drift is certain, not probable. It is detected periodically, object by object, against the snapshot that should run.')}</p>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.post('/gateway/drift');
              toast(tr('Checked {0} apis and {1} subscriptions in {2} ms', [r.apis, r.subscriptions, r.durationMs]));
              reports.reload();
            } catch (e) {
              toast(errorMessage(e), 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="refresh" /> {tr('Run detection now')}
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
      <ListToolbar paging={page} placeholder={tr('search apis, subscriptions, ids, changes')} onReload={reports.reload} loading={reports.loading}>
        <Select
          value={status}
          onChange={(v) => setParams({ drift_status: v, drift_page: null })}
          options={[{ value: '', label: tr('every status') }, 'drifted', 'missing', 'unmanaged', 'in_sync']}
          style={{ width: 160 }}
          aria-label={tr('filter by status')}
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
                    {r.status === 'unmanaged' && <div className="muted small">{tr('Not managed by the product: it can be adopted from the APIs page.')}</div>}
                  </div>
                  <span className="faint small nowrap">{fmtRelative(r.checked_at)}</span>
                </div>
              ))}
              <Pager paging={page} total={page.total} />
            </div>
          ) : (
            <div className="card">
              <Empty title={page.q || status ? tr('No report matches') : tr('No report yet')} icon="gateway" />
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
  if (!user.is_admin) return <Callout kind="info">{tr('Installation administrators only.')}</Callout>;
  return (
    <Loader state={st}>
      {(s) => {
        const f = form || s.gateway;
        const set = (k) => (v) => setForm({ ...f, [k]: v });
        return (
          <div className="col gap-16">
            <div className="card">
              <div className="card-head">
                <h3>{tr('Otoroshi Admin API')}</h3>
              </div>
              <div className="card-body">
                <Setting label={tr('Admin API url')} help={tr("how the product reaches the cluster's leader")}>
                  <Input value={f.url} onChange={set('url')} mono />
                </Setting>
                <Setting label={tr('Admin API host')} help={tr('the Host header of the admin api')}>
                  <Input value={f.host} onChange={set('host')} mono />
                </Setting>
                <Setting label={tr('Administration key')} help={tr('client id and secret of an Otoroshi admin apikey')}>
                  <Input value={f.clientId} onChange={set('clientId')} mono />
                  <Input value={f.clientSecret} onChange={set('clientSecret')} mono type="password" />
                </Setting>
                <Setting label={tr('Public exposure')} help={tr('how consumers reach the apis: <scheme>://<api domain>:<port>')}>
                  <div className="row">
                    <Input value={f.publicScheme} onChange={set('publicScheme')} mono />
                    <Input value={f.publicPort} onChange={set('publicPort')} mono />
                  </div>
                </Setting>
                <Setting label={tr('Otoroshi backoffice url')} help={tr('used to link a projected entity — the escape hatch')}>
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
                        toast(tr('Gateway settings saved'));
                        st.reload();
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }}
                  >
                    {tr('Save')}
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
        <h3>{tr('Events → ingester')}</h3>
      </div>
      <div className="card-body">
        <Setting label={tr('Data exporter')} help={tr('An Otoroshi data exporter sends GatewayEvent, LLMUsageAudit and McpAudit to /ingest. An exporter is gateway infrastructure: this helper creates one, marked as managed, and touches no other.')}>
          <Input value={url} onChange={setUrl} mono />
          <button
            className="btn"
            style={{ alignSelf: 'flex-start' }}
            onClick={async () => {
              try {
                const r = await api.post('/gateway/exporter', { url });
                toast(tr('Exporter {0} installed', [r.id]));
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            {tr('Install / update the exporter')}
          </button>
        </Setting>
        <Setting label={tr('What is kept')} help={tr('the sampling of the raw path, the pseudonymisation of personal data and the retention of each path')}>
          <Link to="/gateway/ingestion" className="btn sm" style={{ alignSelf: 'flex-start' }}>
            {tr('Ingestion policy')}
          </Link>
        </Setting>
      </div>
    </div>
  );
}

// what the ingester keeps of the events of the gateway, and how long: the computed path counts every
// call; the raw path keeps a share of them; personal data are pseudonymised before anything is stored
const since = (at, more) => (at ? tr('since {0} · {1}', [fmtDate(at), more]) : more);

function Ingestion() {
  const toast = useToast();
  const confirm = useConfirm();
  const settings = useLoad(() => api.get('/settings'), []);
  const status = useLoad(() => api.get('/gateway/status'), []);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const current = form || settings.data?.ingest;
  const set = (section, key) => (v) => setForm({ ...current, [section]: { ...current[section], [key]: v } });
  const save = async (extra = {}) => {
    setBusy(true);
    try {
      const { ingest } = await api.put('/settings/ingest', { storeRaw: current.storeRaw, raw: current.raw, privacy: current.privacy, retention: current.retention, ...extra });
      setForm(null);
      settings.reload();
      toast(extra.rotateKey ? tr('A new key: the pseudonyms made from now on do not match the former ones') : tr('Ingestion policy saved'));
      return ingest;
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const rotate = async () => {
    if (!(await confirm({ title: tr('Rotate the key of the pseudonyms?'), message: tr('A caller keeps one pseudonym per key: after the rotation, its calls before and after can no longer be linked. The key is never shown.'), confirmLabel: tr('Rotate') }))) return;
    await save({ rotateKey: true });
  };
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post('/settings/ingest/run');
      toast(r.skipped ? tr('Another ingester is running it') : tr('{0} call(s) rolled up, {1} deleted', [r.rolled.calls, r.deleted.calls + r.deleted.raw + r.deleted.ai + r.deleted.rollups]));
      status.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const pct = (v) => Math.round((v ?? 1) * 1000) / 10;
  return (
    <Loader state={settings}>
      {() => (
        <div className="col gap-16">
          <Callout kind="info">
            {tr('The computed path counts every call — the dashboards, the consumption of a subscription, the attribution to a plan — and is never sampled. The raw path keeps the events themselves, for diagnosis: optional, sampled, lightened. Both are pseudonymised before anything is stored. A change applies to what is received from now on.')}
          </Callout>
          {status.data?.ingest && (
            <div className="grid-4">
              <StatTile label={tr('Calls kept')} value={fmtNumber(status.data.ingest.calls)} hint={since(status.data.ingest.oldest_at, tr('{0} not rolled up yet', [fmtNumber(status.data.ingest.rollup_pending)]))} />
              <StatTile label={tr('Hourly rollups')} value={fmtNumber(status.data.ingest.rollups)} hint={since(status.data.ingest.rollups_oldest_at, tr('the dashboards beyond the calls'))} />
              <StatTile label={tr('Raw events')} value={fmtNumber(status.data.ingest.raw)} hint={since(status.data.ingest.raw_oldest_at, current.storeRaw ? tr('{0} % of the requests, their errors always', [pct(current.raw.sampleRate)]) : tr('the raw path is off'))} />
              <StatTile
                label={tr('Last run')}
                value={status.data.ingest.last_run ? fmtRelative(status.data.ingest.last_run.at) : tr('never')}
                hint={status.data.ingest.last_run ? tr('{0} rolled up, {1} deleted', [fmtNumber(status.data.ingest.last_run.rolled?.calls || 0), fmtNumber(Object.values(status.data.ingest.last_run.deleted || {}).reduce((a, b) => a + b, 0))]) : tr('every 5 minutes')}
              />
            </div>
          )}
          <div className="card">
            <div className="card-head">
              <Icon name="box" />
              <h3 className="grow">{tr('Raw path')}</h3>
            </div>
            <div className="card-body">
              <Setting label={tr('Raw events')} help={tr('the events as Otoroshi sends them, minus the embedded configurations, their url secrets masked: the path of the diagnosis and of the export')}>
                <Switch checked={current.storeRaw} onChange={(v) => setForm({ ...current, storeRaw: v })} label={current.storeRaw ? tr('stored') : tr('not stored')} />
              </Setting>
              <Setting label={tr('Sampling')} help={tr('the share of the requests kept, decided by request: the events of one request are kept together')}>
                <div className="row gap-6">
                  <NumberInput value={pct(current.raw.sampleRate)} min={0} max={100} step={1} style={{ width: 100 }} onChange={(v) => set('raw', 'sampleRate')(v === null ? 1 : Math.max(0, Math.min(100, v)) / 100)} />
                  <span className="muted">%</span>
                </div>
                <Switch checked={current.raw.keepErrors} onChange={set('raw', 'keepErrors')} label={tr('keep every error (status ≥ 400), whatever the share')} />
              </Setting>
              <Setting label={tr('Headers')} help={tr('Otoroshi masks the credential headers; the others can be left out')}>
                <div style={{ alignSelf: 'flex-start' }}>
                  <Seg value={current.raw.headers} onChange={set('raw', 'headers')} options={[{ value: 'keep', label: tr('kept') }, { value: 'drop', label: tr('left out') }]} />
                </div>
              </Setting>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <Icon name="lock" />
              <h3 className="grow">{tr('Personal data')}</h3>
            </div>
            <div className="card-body">
              <Setting label={tr('Address of the caller')} help={tr('its ip, and the headers that carry it (x-forwarded-for…); a hash is a pseudonym: one caller, one token, never the address back without the key')}>
                <Select
                  style={{ maxWidth: 360 }}
                  value={current.privacy.ip}
                  onChange={set('privacy', 'ip')}
                  options={[
                    { value: 'keep', label: tr('kept') },
                    { value: 'truncate', label: tr('truncated to its network (/24, /48)') },
                    { value: 'hash', label: tr('replaced by a pseudonym') },
                    { value: 'drop', label: tr('left out') },
                  ]}
                />
              </Setting>
              <Setting label={tr('Signed-in user')} help={tr('the email and the name of a user signed in on the gateway (a private app): the client id of an application is not personal and stays')}>
                <Select
                  style={{ maxWidth: 360 }}
                  value={current.privacy.user}
                  onChange={set('privacy', 'user')}
                  options={[
                    { value: 'keep', label: tr('kept') },
                    { value: 'hash', label: tr('replaced by a pseudonym') },
                    { value: 'drop', label: tr('left out') },
                  ]}
                />
              </Setting>
              <Setting label={tr('User agent')}>
                <div style={{ alignSelf: 'flex-start' }}>
                  <Seg value={current.privacy.userAgent} onChange={set('privacy', 'userAgent')} options={[{ value: 'keep', label: tr('kept') }, { value: 'drop', label: tr('left out') }]} />
                </div>
              </Setting>
              <Setting label={tr('Paths')} help={tr('a path can name someone: /users/jane@example.com/orders/42. Templated, it is kept as /users/{email}/orders/{n}, and the values of the query are left out. The rollups always group by the template')}>
                <div style={{ alignSelf: 'flex-start' }}>
                  <Seg value={current.privacy.paths} onChange={set('privacy', 'paths')} options={[{ value: 'keep', label: tr('kept') }, { value: 'template', label: tr('templated') }]} />
                </div>
              </Setting>
              <Setting label={tr('Key of the pseudonyms')} help={tr('made by the product, kept by it, never shown nor exported')}>
                <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={rotate}>
                  <Icon name="refresh" /> {tr('Rotate the key')}
                </button>
              </Setting>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <Icon name="layers" />
              <h3 className="grow">{tr('Retention')}</h3>
            </div>
            <div className="card-body">
              {[
                ['callsDays', tr('Calls'), tr('each call: the request log, the exact dashboards. Deleted once rolled up')],
                ['rollupsDays', tr('Hourly rollups'), tr('the calls counted by hour, api, plan, subscription, application, path and status class: the dashboards beyond the calls')],
                ['aiDays', tr('AI and MCP usage'), tr('each audit of the AI gateway and of MCP; its tokens are rolled up by the hour too')],
                ['rawDays', tr('Raw events'), tr('the path of the diagnosis')],
              ].map(([key, label, help]) => (
                <Setting key={key} label={label} help={help}>
                  <div className="row gap-6">
                    <NumberInput value={current.retention[key]} min={1} max={3650} style={{ width: 100 }} onChange={set('retention', key)} />
                    <span className="muted">{tr('days')}</span>
                  </div>
                </Setting>
              ))}
            </div>
          </div>
          <div className="row gap-6" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" disabled={busy} onClick={run}>
              <Icon name="refresh" /> {tr('Roll up and purge now')}
            </button>
            <button className="btn primary" disabled={busy || !form} onClick={() => save()}>
              {tr('Save')}
            </button>
          </div>
        </div>
      )}
    </Loader>
  );
}

export function GatewayPage({ tab }) {
  const { navigate } = useRouter();
  return (
    <div className="page">
      <PageHead title={tr('Gateway')} sub={tr("The Otoroshi cluster this installation drives. One installation per environment; geography is carried by Otoroshi's own leader/worker cluster.")} />
      <div className="tabs mb-16">
        {[
          ['status', tr('Status & queue')],
          ['drift', tr('Drift')],
          ['connection', tr('Connection & events')],
          ['ingestion', tr('Ingestion')],
        ].map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => navigate(`/gateway/${id}`)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'status' && <Status />}
      {tab === 'drift' && <Drift />}
      {tab === 'connection' && <Connection />}
      {tab === 'ingestion' && <Ingestion />}
    </div>
  );
}
