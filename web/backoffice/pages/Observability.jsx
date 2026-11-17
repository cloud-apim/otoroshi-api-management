import React from 'react';
import { useQuery } from '../../shared/router.jsx';
import { fmtBytes, fmtDate, fmtNumber } from '../../shared/lib.js';
import { Loader, Seg, Select, StatusBadge, useLoad } from '../../shared/ui.jsx';
import { BarList, StatTile, TimeSeries } from '../../shared/charts.jsx';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';

const RANGES = [
  { value: '1h', label: '1h', ms: 3600e3 },
  { value: '24h', label: '24h', ms: 86400e3 },
  { value: '7d', label: '7 days', ms: 7 * 86400e3 },
  { value: '30d', label: '30 days', ms: 30 * 86400e3 },
];

// dashboards speak the catalogue's vocabulary: apis, plans, applications — not routes (PX-08).
// Filters live in the url, so a filtered view is a bookmark.
export function AnalyticsDashboard({ fixed = {} }) {
  const { wapi, slug } = useWs();
  const [params, setParams] = useQuery();
  const range = params.get('range') || '24h';
  const apiFilter = fixed.api || params.get('api') || '';
  const appFilter = fixed.application || params.get('application') || '';
  const ms = RANGES.find((r) => r.value === range)?.ms || 86400e3;
  const qs = () => {
    const q = new URLSearchParams({ from: new Date(Date.now() - ms).toISOString() });
    if (apiFilter) q.set('api', apiFilter);
    if (appFilter) q.set('application', appFilter);
    return q.toString();
  };
  const state = useLoad(() => wapi.get(`/analytics?${qs()}`), [slug, range, apiFilter, appFilter]);
  const calls = useLoad(() => wapi.get(`/analytics/calls?${qs()}&limit=50`), [slug, range, apiFilter, appFilter]);
  const apis = useLoad(() => (fixed.api ? Promise.resolve([]) : wapi.get('/apis')), [slug]);
  const apps = useLoad(() => (fixed.application ? Promise.resolve([]) : wapi.get('/applications')), [slug]);
  return (
    <div className="col gap-16">
      <div className="row wrap">
        <Seg value={range} onChange={(v) => setParams({ range: v })} options={RANGES} />
        {!fixed.api && (
          <Select
            value={apiFilter}
            onChange={(v) => setParams({ api: v })}
            options={[{ value: '', label: 'All APIs' }, ...(apis.data || []).map((a) => ({ value: a.id, label: `${a.name} ${a.version}` }))]}
            style={{ width: 220 }}
            aria-label="filter by api"
          />
        )}
        {!fixed.application && (
          <Select
            value={appFilter}
            onChange={(v) => setParams({ application: v })}
            options={[{ value: '', label: 'All applications' }, ...(apps.data || []).map((a) => ({ value: a.id, label: a.name }))]}
            style={{ width: 220 }}
            aria-label="filter by application"
          />
        )}
      </div>
      <Loader state={state}>
        {(d) => (
          <div className="col gap-16" style={{ opacity: state.loading ? 0.6 : 1 }}>
            <div className="grid-4">
              <StatTile label="Calls" value={fmtNumber(d.totals.calls)} hint={`${d.totals.applications} consuming applications`} />
              <StatTile label="Errors" value={fmtNumber(d.totals.errors)} hint={d.totals.calls ? `${((100 * d.totals.errors) / d.totals.calls).toFixed(1)} % of calls` : ''} />
              <StatTile label="Latency" value={`${fmtNumber(d.totals.avg_ms)} ms`} hint={`p95 ${fmtNumber(d.totals.p95_ms)} ms · gateway overhead ${fmtNumber(d.totals.avg_overhead_ms)} ms`} />
              <StatTile label="Data" value={fmtBytes(d.totals.bytes_out)} hint={`out · ${fmtBytes(d.totals.bytes_in)} in`} />
            </div>
            <div className="card">
              <div className="card-head">
                <h3 className="grow">Traffic</h3>
              </div>
              <div className="card-body">
                <TimeSeries data={d.series} bucket={d.range.bucket} series={[{ key: 'calls', label: 'Calls' }, { key: 'errors', label: 'Errors' }]} />
              </div>
            </div>
            <div className="grid-3">
              {!fixed.api && (
                <div className="card">
                  <div className="card-head">
                    <h3>By API</h3>
                  </div>
                  <div className="card-body">
                    <BarList items={d.byApi.map((r) => ({ label: r.name, value: r.calls, sub: r.errors ? `${r.errors} err` : '' }))} />
                  </div>
                </div>
              )}
              <div className="card">
                <div className="card-head">
                  <h3>By plan</h3>
                </div>
                <div className="card-body">
                  <BarList items={d.byPlan.map((r) => ({ label: fixed.api ? r.plan_name : `${r.api_name} · ${r.plan_name}`, value: r.calls }))} />
                </div>
              </div>
              {!fixed.application && (
                <div className="card">
                  <div className="card-head">
                    <h3>By application</h3>
                  </div>
                  <div className="card-body">
                    <BarList items={d.byApplication.map((r) => ({ label: r.name, value: r.calls, sub: r.errors ? `${r.errors} err` : '' }))} />
                  </div>
                </div>
              )}
              <div className="card">
                <div className="card-head">
                  <h3>Status codes</h3>
                </div>
                <div className="card-body">
                  <BarList items={d.statuses.map((r) => ({ label: `${r.class / 100}xx`, value: r.calls }))} />
                </div>
              </div>
              <div className="card" style={{ gridColumn: 'span 2' }}>
                <div className="card-head">
                  <h3>Top endpoints</h3>
                </div>
                <div className="card-body">
                  <BarList items={d.byPath.map((r) => ({ label: `${r.method} ${r.path}`, value: r.calls, sub: `${fmtNumber(r.avg_ms)} ms` }))} />
                </div>
              </div>
            </div>
          </div>
        )}
      </Loader>
      <div className="card">
        <div className="card-head">
          <h3 className="grow">Recent calls</h3>
          <span className="faint small">reading request logs is traced in the audit trail</span>
        </div>
        <Loader state={calls}>
          {(rows) =>
            rows.length ? (
              <div className="table-wrap">
                <table className="table small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Request</th>
                      <th>Status</th>
                      <th className="right">Duration</th>
                      <th>Consumer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td className="nowrap muted">{fmtDate(r.at)}</td>
                        <td className="mono">
                          {r.method} {r.path}
                        </td>
                        <td>
                          <StatusBadge status={r.status >= 500 ? 'error' : r.status >= 400 ? 'pending' : 'active'} label={String(r.status)} />
                        </td>
                        <td className="right">{r.duration_ms} ms</td>
                        <td className="mono faint">{r.client_id || r.from_ip}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="card-body muted small">No call in this period. Install the data exporter from the Gateway page to feed the ingester.</div>
            )
          }
        </Loader>
      </div>
    </div>
  );
}

export function ObservabilityPage() {
  return (
    <div className="page">
      <PageHead title="Observability" sub="Usage of the catalogue, from the ingester's computed path — exhaustive, attributed to apis, plans and applications at ingestion." />
      <AnalyticsDashboard />
    </div>
  );
}
