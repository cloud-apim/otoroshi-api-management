import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '../../shared/router.jsx';
import { Icon, Input, Loader, Modal, Select, StatusBadge, useLoad } from '../../shared/ui.jsx';
import { TimeSeries, BarList, StatTile, StackedColumns, OTHER_COLOR } from '../../shared/charts.jsx';
import { ListToolbar, Pager, usePaging } from '../../shared/lists.jsx';
import { fmtBytes, fmtDate, fmtNumber } from '../../shared/lib.js';
import { api, runtime } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { PageHeader, RequireUser } from '../common.jsx';

// the timeframes of the analytics of the portal: presets first, then a custom range
const RANGES = { '5m': 5 * 60e3, '30m': 30 * 60e3, '1h': 3600e3, '3h': 3 * 3600e3, '6h': 6 * 3600e3, '12h': 12 * 3600e3, '24h': 86400e3, '3d': 3 * 86400e3, '7d': 7 * 86400e3, '14d': 14 * 86400e3, '30d': 30 * 86400e3, '90d': 90 * 86400e3 };
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const fmtMs = (v) => (v === null || v === undefined ? '—' : `${fmtNumber(Math.round(v * 10) / 10)} ms`);
const perSecond = (v) => (v >= 10 ? fmtNumber(Math.round(v)) : v >= 0.01 ? String(Math.round(v * 100) / 100) : v > 0 ? '< 0.01' : '0');
const localInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
};

export function Usage() {
  return (
    <RequireUser>
      <UsageView />
    </RequireUser>
  );
}

// the filters of the page, from the url: shared by its two views, so that going from one to the
// other keeps the slice
function useFilters() {
  const [params, setParams] = useQuery();
  const range = params.get('range') === 'custom' && params.get('from') ? 'custom' : RANGES[params.get('range')] ? params.get('range') : '24h';
  const f = { application: params.get('application') || '', api: params.get('api') || '', status: params.get('status') || '' };
  // a preset is resolved once per selection, so that a refetch keeps the same window
  const from = useMemo(() => (range === 'custom' ? params.get('from') : new Date(Date.now() - RANGES[range]).toISOString()), [range, params.get('from')]);
  const to = range === 'custom' ? params.get('to') || '' : '';
  const query = (extra = {}) => {
    const q = new URLSearchParams({ from });
    if (to) q.set('to', to);
    for (const k of ['application', 'api', 'status']) if (f[k]) q.set(k, f[k]);
    for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
    return q.toString();
  };
  return { params, setParams, range, from, to, f, query, key: [from, to, f.application, f.api, f.status].join('|') };
}

function UsageView() {
  const { t } = useI18n();
  const filters = useFilters();
  const view = filters.params.get('view') === 'logs' ? 'logs' : 'analytics';
  return (
    <div className="pt-container pt-section">
      <PageHeader title={t('usage.title')} subtitle={t('usage.subtitle')} />
      <nav className="tabs mb-16" aria-label={t('usage.title')}>
        {['analytics', 'logs'].map((v) => (
          <button key={v} className={view === v ? 'on' : ''} aria-current={view === v ? 'page' : undefined} onClick={() => filters.setParams({ view: v === 'analytics' ? null : v })}>
            {t(`usage.view.${v}`)}
          </button>
        ))}
      </nav>
      {view === 'logs' ? <Logs filters={filters} /> : <Analytics filters={filters} />}
    </div>
  );
}

function FilterBar({ filters, reset = {}, children }) {
  const { t } = useI18n();
  const { params, setParams, range, f } = filters;
  const apps = useLoad(() => api.get('/applications'), []);
  const apis = useLoad(() => api.get('/apis'), []);
  const [from, setFrom] = useState(localInput(params.get('from')));
  const [to, setTo] = useState(localInput(params.get('to')));
  const latest = Object.values((apis.data || []).reduce((acc, a) => ({ ...acc, [a.id]: a }), {}));
  return (
    <div className="row wrap gap-6 mb-16" role="group" aria-label={t('usage.filters')}>
      <div style={{ minWidth: 190 }}>
        <Select
          value={range}
          onChange={(v) => setParams({ range: v, ...(v === 'custom' ? {} : { from: null, to: null }), ...reset })}
          aria-label={t('usage.timeframe')}
          options={[...Object.keys(RANGES).map((k) => ({ value: k, label: t(`usage.range.${k}`) })), { value: 'custom', label: t('usage.range.custom') }]}
        />
      </div>
      {range === 'custom' && (
        <span className="row gap-6">
          <input className="input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t('usage.from')} style={{ width: 200 }} />
          <span className="muted">→</span>
          <input className="input" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t('usage.to')} style={{ width: 200 }} />
          <button className="btn sm" disabled={!from} onClick={() => setParams({ range: 'custom', from: new Date(from).toISOString(), to: to ? new Date(to).toISOString() : null, ...reset })}>
            {t('usage.apply')}
          </button>
        </span>
      )}
      <div style={{ minWidth: 200 }}>
        <Select
          value={f.application}
          onChange={(v) => setParams({ application: v || null, ...reset })}
          aria-label={t('apps.title')}
          options={[{ value: '', label: t('usage.allapps') }, ...(apps.data || []).map((a) => ({ value: a.id, label: a.name }))]}
        />
      </div>
      <div style={{ minWidth: 200 }}>
        <Select
          value={f.api}
          onChange={(v) => setParams({ api: v || null, ...reset })}
          aria-label={t('usage.api')}
          options={[{ value: '', label: t('usage.allapis') }, ...latest.map((a) => ({ value: a.id, label: `${a.name} ${a.version}` }))]}
        />
      </div>
      <div style={{ minWidth: 140 }}>
        <Select
          value={f.status}
          onChange={(v) => setParams({ status: v || null, ...reset })}
          aria-label={t('usage.status')}
          options={[{ value: '', label: t('usage.allstatuses') }, ...STATUS_CLASSES.map((c) => ({ value: c, label: c }))]}
        />
      </div>
      {children}
    </div>
  );
}

function Card({ title, sub, span, children }) {
  return (
    <div className="card" style={span ? { gridColumn: `span ${span}` } : undefined}>
      <div className="card-head">
        <h3 className="grow">{title}</h3>
        {sub && <span className="faint small">{sub}</span>}
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

// the hits of the first entities over time, the others folded into one gray series
function entitySeries(block, names, other) {
  const series = (block?.ids || []).map((id) => ({ key: id, label: names(id) }));
  if ((block?.points || []).some((p) => p.__other)) series.push({ key: '__other', label: other, color: OTHER_COLOR });
  return series;
}

function Analytics({ filters }) {
  const { t } = useI18n();
  const state = useLoad(() => api.get(`/analytics?${filters.query()}`), [filters.key]);
  return (
    <>
      <FilterBar filters={filters}>
        <span className="spacer" />
        <button className="btn sm" onClick={() => filters.setParams({ view: 'logs' })}>
          <Icon name="doc" />
          {t('usage.viewLogs')}
        </button>
      </FilterBar>
      <Loader state={state}>{(d) => <Dashboard d={d} oneApp={!!filters.f.application} loading={state.loading} />}</Loader>
    </>
  );
}

function Dashboard({ d, oneApp, loading }) {
  const { t } = useI18n();
  const tt = d.totals;
  const rollups = d.source === 'rollups';
  const errRate = tt.calls ? (100 * tt.errors) / tt.calls : 0;
  const apiName = (id) => d.byApi.find((r) => r.api_id === id)?.name || id;
  const appName = (id) => d.byApplication.find((r) => r.application_id === id)?.name || id;
  const failed = d.byApi.filter((r) => r.server_errors > 0).sort((a, b) => b.server_errors - a.server_errors);
  const slow = [...d.byApi].filter((r) => r.calls > 0).sort((a, b) => b.avg_ms - a.avg_ms);
  return (
    <div className="col gap-16" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
      <div className="grid-3">
        <StatTile label={t('usage.calls')} value={fmtNumber(tt.calls)} hint={t('usage.rps', { n: perSecond(tt.rps) })} />
        <StatTile label={t('usage.errorRate')} value={`${errRate.toFixed(errRate && errRate < 10 ? 1 : 0)}%`} hint={t('usage.errorsHint', { errors: fmtNumber(tt.errors), server: fmtNumber(tt.server_errors) })} />
        <StatTile label={t('usage.latency')} value={fmtMs(tt.avg_ms)} hint={rollups ? t('usage.noExtremes') : t('usage.minmax', { min: fmtMs(tt.min_ms), max: fmtMs(tt.max_ms) })} />
        <StatTile label={t('usage.p95')} value={`${rollups ? '≈ ' : ''}${fmtMs(tt.p95_ms)}`} hint={t('usage.overhead', { v: fmtMs(tt.avg_overhead_ms) })} />
        <StatTile label={t('usage.data')} value={fmtBytes(tt.bytes_out)} hint={t('usage.dataHint', { v: fmtBytes(tt.bytes_in) })} />
        <StatTile label={t('usage.apis')} value={fmtNumber(d.byApi.filter((r) => r.api_id).length)} hint={t('usage.apisHint', { n: fmtNumber(d.byPlan.length) })} />
      </div>
      {!tt.calls ? (
        <div className="card">
          <div className="empty small">{t('usage.empty')}</div>
        </div>
      ) : (
        <>
          {rollups && <div className="muted small">{t('usage.rollups', { date: fmtDate(d.retention.from) })}</div>}
          <Card title={t('usage.responses')}>
            <StackedColumns
              data={d.series}
              bucket={d.range.bucket}
              series={[
                { key: 'success', label: t('usage.success') },
                { key: 'client_errors', label: t('usage.clientErrors') },
                { key: 'server_errors', label: t('usage.serverErrors') },
              ]}
            />
          </Card>
          <div className="grid-2">
            <Card title={t('usage.latencyOverTime')}>
              <TimeSeries
                data={d.series}
                bucket={d.range.bucket}
                formatValue={fmtMs}
                series={[{ key: 'avg_ms', label: t('usage.avg') }, ...(rollups ? [] : [{ key: 'p95_ms', label: t('usage.p95short') }])]}
              />
            </Card>
            <Card title={t('usage.hitsByApi')}>
              <TimeSeries data={d.seriesByApi.points} bucket={d.range.bucket} series={entitySeries(d.seriesByApi, apiName, t('usage.other'))} />
            </Card>
          </div>
          {!oneApp && (
            <Card title={t('usage.hitsByApp')}>
              <TimeSeries data={d.seriesByApplication.points} bucket={d.range.bucket} series={entitySeries(d.seriesByApplication, appName, t('usage.other'))} />
            </Card>
          )}
          <div className="grid-3">
            <Card title={t('usage.topApis')} sub={t('usage.byCalls')}>
              <BarList items={d.byApi.map((x) => ({ label: x.name, value: x.calls }))} empty={t('usage.empty')} />
            </Card>
            <Card title={t('usage.failedApis')} sub={t('usage.byServerErrors')}>
              <BarList items={failed.map((x) => ({ label: x.name, value: x.server_errors }))} empty={t('usage.noServerError')} />
            </Card>
            <Card title={t('usage.slowApis')} sub={t('usage.byLatency')}>
              <BarList items={slow.map((x) => ({ label: x.name, value: x.avg_ms }))} formatValue={fmtMs} empty={t('usage.empty')} />
            </Card>
            <Card title={t('usage.endpoints')} sub={t('usage.templated')} span={2}>
              <BarList items={d.byPath.map((r) => ({ label: `${r.method || ''} ${r.path || ''}`.trim(), value: r.calls, sub: fmtMs(r.avg_ms) }))} empty={t('usage.empty')} />
            </Card>
            <Card title={t('usage.statuses')}>
              <BarList items={d.statuses.map((r) => ({ label: r.class ? `${r.class / 100}xx` : '—', value: r.calls }))} empty={t('usage.empty')} />
            </Card>
            <Card title={t('usage.byPlan')}>
              <BarList items={d.byPlan.map((x) => ({ label: x.plan_name, sub: x.api_name, value: x.calls }))} empty={t('usage.empty')} />
            </Card>
            {!oneApp && (
              <Card title={t('usage.byApp')}>
                <BarList items={d.byApplication.map((x) => ({ label: x.name, value: x.calls }))} empty={t('usage.empty')} />
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// the calls of the consumer's applications, filtered like the analytics, exported as CSV
function Logs({ filters }) {
  const { t } = useI18n();
  const { params, setParams } = filters;
  const method = params.get('method') || '';
  const [path, setPath] = useState(params.get('path') || '');
  useEffect(() => setPath(params.get('path') || ''), [params.get('path')]);
  const paging = usePaging({ prefix: 'calls', size: 50 });
  const own = { method, path: params.get('path') || '' };
  const calls = useLoad(() => api.get(`/analytics/calls?${filters.query(own)}&${paging.query}`), [filters.key, method, own.path, paging.key]);
  const [open, setOpen] = useState(null);
  const reset = { calls_page: null };
  return (
    <>
      <FilterBar filters={filters} reset={reset}>
        <div style={{ minWidth: 140 }}>
          <Select value={method} onChange={(v) => setParams({ method: v || null, ...reset })} aria-label={t('usage.method')} options={[{ value: '', label: t('usage.allmethods') }, ...METHODS.map((m) => ({ value: m, label: m }))]} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setParams({ path: path || null, ...reset });
          }}
        >
          <Input value={path} onChange={setPath} placeholder={t('usage.path')} aria-label={t('usage.path')} mono style={{ width: 200 }} />
        </form>
        <span className="spacer" />
        <a className="btn sm" href={`${runtime.base}/front/api/analytics/calls/export?${filters.query({ ...own, q: paging.q })}`} download>
          <Icon name="download" />
          {t('usage.export')}
        </a>
      </FilterBar>
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{t('usage.logs')}</h3>
          {calls.data?.retention && <span className="faint small">{t('usage.logsHint', { n: calls.data.retention.callsDays })}</span>}
        </div>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <ListToolbar paging={paging} placeholder={t('usage.search')} onReload={calls.reload} loading={calls.loading} />
        </div>
        <Loader state={calls}>
          {({ items: rows, total }) =>
            rows.length ? (
              <>
                <div className="table-wrap" style={{ opacity: calls.loading ? 0.6 : 1 }}>
                  <table className="table small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    <thead>
                      <tr>
                        <th>{t('usage.col.time')}</th>
                        <th>{t('usage.col.request')}</th>
                        <th>{t('usage.col.status')}</th>
                        <th className="right">{t('usage.col.duration')}</th>
                        <th>{t('usage.col.api')}</th>
                        <th>{t('usage.col.app')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} className="clickable" onClick={() => setOpen(r)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(r)}>
                          <td className="nowrap muted">{fmtDate(r.at)}</td>
                          <td className="mono">
                            {r.method} {r.path}
                          </td>
                          <td>
                            <StatusBadge status={r.status >= 500 || r.err ? 'error' : r.status >= 400 ? 'pending' : 'active'} label={String(r.status ?? '—')} />
                          </td>
                          <td className="right">{fmtMs(r.duration_ms)}</td>
                          <td>{r.api_name || '—'}</td>
                          <td>{r.application_name || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager paging={paging} total={total} />
              </>
            ) : (
              <div className="card-body empty small">{paging.q || method || own.path || filters.f.status ? t('usage.nomatch') : t('usage.empty')}</div>
            )
          }
        </Loader>
      </div>
      {open && (
        <Modal title={`${open.method} ${open.path} — ${open.status ?? '—'}`} onClose={() => setOpen(null)}>
          <dl className="kv">
            {[
              [t('usage.col.time'), fmtDate(open.at)],
              [t('usage.detail.requestId'), open.req_id ? <code>{open.req_id}</code> : '—'],
              [t('usage.detail.host'), open.host || '—'],
              [t('usage.col.api'), open.api_name || '—'],
              [t('usage.detail.plan'), open.plan_name || '—'],
              [t('usage.col.app'), open.application_name || '—'],
              [t('usage.detail.client'), open.client_id ? <code>{open.client_id}</code> : '—'],
              [t('usage.col.duration'), fmtMs(open.duration_ms)],
              [t('usage.detail.backend'), fmtMs(open.backend_duration_ms)],
              [t('usage.detail.overhead'), fmtMs(open.overhead_ms)],
            ].map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </React.Fragment>
            ))}
          </dl>
          {open.req_id && <p className="muted small mt-16">{t('usage.detail.requestIdHint')}</p>}
        </Modal>
      )}
    </>
  );
}
