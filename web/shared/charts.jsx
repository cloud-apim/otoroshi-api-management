// Hand-drawn svg charts. Specs from the dataviz method: 2px lines, ~10% area wash, recessive
// hairline grid, crosshair + one tooltip listing every series, legend for >= 2 series, text in ink
// tokens (never in the series color), a table view behind every chart.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmtNumber } from './lib.js';
import { MiniPager } from './lists.jsx';

const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'];

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * p;
}

function fmtTick(t, bucket) {
  const d = new Date(t);
  if (bucket === 'day') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// series: [{ key, label }]; data: [{ t, [key]: number }]
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => setW(Math.max(200, Math.round(entries[0].contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function TimeSeries({ data = [], series, bucket = 'hour', height = 220, formatValue = (v) => fmtNumber(v) }) {
  const ref = useRef(null);
  const [wrapRef, W] = useWidth();
  const [hover, setHover] = useState(null);
  const [showTable, setShowTable] = useState(false);
  const H = height;
  const pad = { l: 44, r: 12, t: 10, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const points = useMemo(() => data.map((d) => ({ ...d, ts: new Date(d.t).getTime() })), [data]);
  const max = niceMax(Math.max(1, ...points.flatMap((p) => series.map((s) => Number(p[s.key]) || 0))));
  const minT = points.length ? points[0].ts : 0;
  const maxT = points.length ? points[points.length - 1].ts : 1;
  const x = (ts) => pad.l + (maxT === minT ? iw / 2 : ((ts - minT) / (maxT - minT)) * iw);
  const y = (v) => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const xTicks = points.length > 1 ? [0, 0.25, 0.5, 0.75, 1].map((f) => minT + f * (maxT - minT)) : points.map((p) => p.ts);

  const onMove = (e) => {
    if (!points.length) return;
    const rect = ref.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.ts) - px) < Math.abs(x(points[best].ts) - px)) best = i;
    });
    setHover(best);
  };

  if (!points.length) return <div className="empty small">No traffic in this period</div>;
  const hp = hover !== null ? points[hover] : null;
  return (
    <div className="col gap-6">
      {series.length > 1 && (
        <div className="row gap-16 small muted" aria-label="legend">
          {series.map((s, i) => (
            <span key={s.key} className="row gap-6">
              <svg width="16" height="4" aria-hidden="true">
                <line x1="0" y1="2" x2="16" y2="2" stroke={SERIES[i]} strokeWidth="2" strokeLinecap="round" />
              </svg>
              {s.label}
            </span>
          ))}
          <span className="spacer" />
          <button className="btn ghost xs" onClick={() => setShowTable(!showTable)}>
            {showTable ? 'Chart' : 'Table'}
          </button>
        </div>
      )}
      {showTable ? (
        <div className="table-wrap" style={{ maxHeight: height + 40, overflow: 'auto' }}>
          <table className="table small" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr>
                <th>Time</th>
                {series.map((s) => (
                  <th key={s.key} className="right">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.ts}>
                  <td>{new Date(p.ts).toLocaleString()}</td>
                  {series.map((s) => (
                    <td key={s.key} className="right">
                      {formatValue(p[s.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ position: 'relative' }} ref={wrapRef}>
          <svg
            ref={ref}
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            height={H}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            role="img"
            aria-label={`${series.map((s) => s.label).join(' and ')} over time`}
            style={{ display: 'block', overflow: 'visible' }}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--faint)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {fmtNumber(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t, i) => (
              <text key={i} x={x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'} fontSize="11" fill="var(--faint)">
                {fmtTick(t, bucket)}
              </text>
            ))}
            {series.map((s, i) => {
              const line = points.map((p, j) => `${j ? 'L' : 'M'}${x(p.ts)},${y(Number(p[s.key]) || 0)}`).join(' ');
              const area = `${line} L${x(points[points.length - 1].ts)},${y(0)} L${x(points[0].ts)},${y(0)} Z`;
              return (
                <g key={s.key}>
                  {i === 0 && <path d={area} fill={SERIES[i]} opacity="0.1" />}
                  <path d={line} fill="none" stroke={SERIES[i]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                </g>
              );
            })}
            {hp && (
              <g>
                <line x1={x(hp.ts)} x2={x(hp.ts)} y1={pad.t} y2={pad.t + ih} stroke="var(--border-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              </g>
            )}
          </svg>
          {hp &&
            series.map((s, i) => (
              <span
                key={s.key}
                style={{
                  position: 'absolute',
                  left: `${(x(hp.ts) / W) * 100}%`,
                  top: y(Number(hp[s.key]) || 0),
                  width: 9,
                  height: 9,
                  marginLeft: -4.5,
                  marginTop: -4.5,
                  borderRadius: '50%',
                  background: SERIES[i],
                  boxShadow: '0 0 0 2px var(--surface)',
                  pointerEvents: 'none',
                }}
              />
            ))}
          {hp && (
            <div
              className="card small"
              style={{
                position: 'absolute',
                top: 4,
                left: `${(x(hp.ts) / W) * 100}%`,
                transform: x(hp.ts) > W * 0.65 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
                padding: '8px 10px',
                pointerEvents: 'none',
                minWidth: 140,
                boxShadow: 'var(--shadow-lg)',
              }}
            >
              <div className="faint tiny">{new Date(hp.ts).toLocaleString()}</div>
              {series.map((s, i) => (
                <div key={s.key} className="row gap-6" style={{ marginTop: 4 }}>
                  <svg width="12" height="4" aria-hidden="true">
                    <line x1="0" y1="2" x2="12" y2="2" stroke={SERIES[i]} strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <span className="bold">{formatValue(hp[s.key])}</span>
                  <span className="muted">{s.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// a single-hue horizontal bar list, value at the tip
// a ranked list of bars, ten per page (the bars keep the scale of the whole list)
export function BarList({ items = [], formatValue = (v) => fmtNumber(v), empty = 'No data', pageSize = 10 }) {
  const [page, setPage] = useState(1);
  const max = Math.max(1, ...items.map((i) => i.value || 0));
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  const shown = items.slice((current - 1) * pageSize, current * pageSize);
  if (!items.length) return <div className="muted small">{empty}</div>;
  return (
    <div className="col" style={{ gap: 10 }}>
      {shown.map((it, i) => (
        <div key={i} title={`${it.label}: ${formatValue(it.value)}`}>
          <div className="row small" style={{ marginBottom: 4 }}>
            <span className="grow ellipsis">{it.label}</span>
            {it.sub && <span className="faint tiny">{it.sub}</span>}
            <span className="bold" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatValue(it.value)}
            </span>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-2)' }}>
            <div style={{ width: `${Math.max(1, (100 * (it.value || 0)) / max)}%`, height: '100%', borderRadius: 4, background: 'var(--chart-1)' }} />
          </div>
        </div>
      ))}
      <MiniPager page={current} pages={pages} onPage={setPage} from={(current - 1) * pageSize + 1} to={Math.min(current * pageSize, items.length)} total={items.length} />
    </div>
  );
}

export function StatTile({ label, value, hint }) {
  return (
    <div className="card stat">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {hint && <div className="faint tiny mt-8">{hint}</div>}
    </div>
  );
}

export function Sparkline({ values = [], width = 120, height = 28 }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 2 - (v / max) * (height - 4)}`).join(' ');
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
