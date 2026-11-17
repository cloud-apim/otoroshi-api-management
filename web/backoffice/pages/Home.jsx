import React from 'react';
import { Link } from '../../shared/router.jsx';
import { fmtNumber, fmtRelative } from '../../shared/lib.js';
import { Empty, Icon, Loader, StatusBadge, useLoad } from '../../shared/ui.jsx';
import { StatTile, TimeSeries } from '../../shared/charts.jsx';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';

export function Home() {
  const { wapi, slug, ws, session } = useWs();
  const state = useLoad(() => wapi.get('/home'), [slug]);
  const traffic = useLoad(() => wapi.get('/analytics'), [slug]);
  return (
    <div className="page">
      <PageHead title={`Welcome, ${session.user.name}`} sub={`${ws.name} — what needs your attention, and how the catalogue is doing.`} />
      <Loader state={state}>
        {(h) => (
          <div className="col gap-24">
            <div className="grid-4">
              <StatTile label="APIs" value={h.counts.apis} hint={`${h.counts.published_apis} published`} />
              <StatTile label="Active subscriptions" value={h.counts.active_subscriptions} hint={`${h.counts.applications} applications`} />
              <StatTile label="Waiting for review" value={h.counts.pending_subscriptions} />
              <StatTile label="Calls, last 24h" value={traffic.data ? fmtNumber(traffic.data.totals.calls) : '…'} hint={traffic.data ? `${fmtNumber(traffic.data.totals.errors)} errors · p95 ${fmtNumber(traffic.data.totals.p95_ms)} ms` : ''} />
            </div>
            <div className="grid-2">
              <div className="card">
                <div className="card-head">
                  <Icon name="inbox" />
                  <h3 className="grow">To review</h3>
                  <Link className="link small" to={`/ws/${slug}/subscriptions?status=pending`}>
                    All subscriptions
                  </Link>
                </div>
                {h.pending.length ? (
                  h.pending.map((s) => (
                    <Link key={s.id} to={`/ws/${slug}/subscriptions?status=pending&open=${s.id}`} className="list-item" style={{ display: 'flex' }}>
                      <div className="grow">
                        <div className="bold">{s.application_name}</div>
                        <div className="muted small">
                          {s.api_name} {s.api_version} · {s.request?.plan_name}
                        </div>
                      </div>
                      <span className="faint small">{fmtRelative(s.created_at)}</span>
                    </Link>
                  ))
                ) : (
                  <Empty title="Nothing to review" icon="check" />
                )}
              </div>
              <div className="card">
                <div className="card-head">
                  <Icon name="rocket" />
                  <h3 className="grow">Out of sync</h3>
                </div>
                {h.out_of_sync.length ? (
                  h.out_of_sync.map((a) => (
                    <Link key={a.id} to={`/ws/${slug}/apis/${a.id}/deployment`} className="list-item" style={{ display: 'flex' }}>
                      <div className="grow bold">
                        {a.name} <span className="faint">{a.version}</span>
                      </div>
                      <span className="badge warning">published, not deployed</span>
                    </Link>
                  ))
                ) : (
                  <Empty title="Everything published is deployed" icon="check" />
                )}
                {h.counts.drifted > 0 && (
                  <Link to="/gateway/drift" className="list-item" style={{ display: 'flex' }}>
                    <Icon name="alert" />
                    <span className="grow">{h.counts.drifted} projected objects drifted on the gateway</span>
                    <Icon name="chevronRight" />
                  </Link>
                )}
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <Icon name="chart" />
                <h3 className="grow">Traffic, last 24 hours</h3>
                <Link className="link small" to={`/ws/${slug}/observability`}>
                  Observability
                </Link>
              </div>
              <div className="card-body">
                <Loader state={traffic}>
                  {(t) => (
                    <TimeSeries
                      data={t.series}
                      bucket={t.range.bucket}
                      series={[
                        { key: 'calls', label: 'Calls' },
                        { key: 'errors', label: 'Errors' },
                      ]}
                    />
                  )}
                </Loader>
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <Icon name="audit" />
                <h3 className="grow">Recent activity</h3>
                <Link className="link small" to={`/ws/${slug}/audit`}>
                  Audit
                </Link>
              </div>
              {h.recent.map((e) => (
                <div key={e.id} className="list-item">
                  <span className="badge">{e.action}</span>
                  <span className="grow ellipsis">{e.summary}</span>
                  <span className="faint small nowrap">
                    {e.actor?.email} · {fmtRelative(e.at)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Loader>
    </div>
  );
}
