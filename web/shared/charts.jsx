// Hand-drawn svg charts. Specs from the dataviz method: 2px lines, ~10% area wash, recessive
// hairline grid, crosshair + one tooltip listing every series, legend for >= 2 series, text in ink
// tokens (never in the series color), a table view behind every chart.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmtDate, fmtNumber } from './lib.js';
import { MiniPager } from './lists.jsx';
import { language, tr } from './i18n.jsx';

// the categorical slots, in their fixed order (validated as a set, light and dark); a tail past
// them is folded into "other", in the de-emphasis gray — never a generated hue
export const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];
export const OTHER_COLOR = 'var(--chart-other)';
const colorOf = (series, i) => series[i]?.color || SERIES[i] || OTHER_COLOR;

// the graduations of a value axis: a step of 1, 2 or 5 times a power of ten, five of them at most,
// so that every graduation is a round number
function niceTicks(v) {
  const top = Math.max(1, v);
  const p = Math.pow(10, Math.floor(Math.log10(top / 5)));
  const step = [1, 2, 5, 10].map((m) => m * p).find((st) => Math.ceil(top / st) <= 5);
  const k = Math.ceil(top / step);
  return { max: step * k, ticks: Array.from({ length: k + 1 }, (_, i) => i * step) };
}

function fmtTick(t, bucket) {
  const d = new Date(t);
  if (bucket === 'day')
    return d.toLocaleDateString(language() === 'fr' ? 'fr-FR' : undefined, {
      month: 'short',
      day: 'numeric',
    });
  return d.toLocaleTimeString(language() === 'fr' ? 'fr-FR' : undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
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
  const { max, ticks } = niceTicks(Math.max(1, ...points.flatMap((p) => series.map((s) => Number(p[s.key]) || 0))));
  const minT = points.length ? points[0].ts : 0;
  const maxT = points.length ? points[points.length - 1].ts : 1;
  const x = (ts) => pad.l + (maxT === minT ? iw / 2 : ((ts - minT) / (maxT - minT)) * iw);
  const y = (v) => pad.t + ih - (v / max) * ih;

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

  if (!points.length) return <div className="empty small">{tr('No traffic in this period')}</div>;
  const hp = hover !== null ? points[hover] : null;
  return (
    <div className="col gap-6">
      {series.length > 1 && (
        <div className="row gap-16 small muted" aria-label={tr('legend')}>
          {series.map((s, i) => (
            <span key={s.key} className="row gap-6">
              <svg width="16" height="4" aria-hidden="true">
                <line x1="0" y1="2" x2="16" y2="2" stroke={colorOf(series, i)} strokeWidth="2" strokeLinecap="round" />
              </svg>
              {s.label}
            </span>
          ))}
          <span className="spacer" />
          <button className="btn ghost xs" onClick={() => setShowTable(!showTable)}>
            {showTable ? tr('Chart') : tr('Table')}
          </button>
        </div>
      )}
      {showTable ? (
        <div className="table-wrap" style={{ maxHeight: height + 40, overflow: 'auto' }}>
          <table className="table small" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr>
                <th>{tr('Time')}</th>
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
                  <td>{fmtDate(p.ts)}</td>
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
            aria-label={tr('{0} over time', [series.map((s) => s.label).join(' and ')])}
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
            {xTicks.map((t, i) =>
              // a label that repeats the one before it says nothing: it is left out
              i > 0 && fmtTick(t, bucket) === fmtTick(xTicks[i - 1], bucket) ? null : (
                <text key={i} x={x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'} fontSize="11" fill="var(--faint)">
                  {fmtTick(t, bucket)}
                </text>
              ),
            )}
            {series.map((s, i) => {
              // a value that is not known (null: a bucket without calls has no latency) breaks the line
              const runs = [];
              points.forEach((p) => {
                const v = p[s.key];
                if (v === null || v === undefined) runs.push(null);
                else {
                  if (!runs.length || runs[runs.length - 1] === null) runs.push([]);
                  runs[runs.length - 1].push(p);
                }
              });
              const segments = runs.filter(Boolean);
              return (
                <g key={s.key}>
                  {segments.map((run, r) => {
                    const line = run.map((p, j) => `${j ? 'L' : 'M'}${x(p.ts)},${y(Number(p[s.key]) || 0)}`).join(' ');
                    const area = `${line} L${x(run[run.length - 1].ts)},${y(0)} L${x(run[0].ts)},${y(0)} Z`;
                    return (
                      <g key={r}>
                        {i === 0 && <path d={area} fill={colorOf(series, i)} opacity="0.1" />}
                        {run.length === 1 ? (
                          <circle cx={x(run[0].ts)} cy={y(Number(run[0][s.key]) || 0)} r="3" fill={colorOf(series, i)} />
                        ) : (
                          <path d={line} fill="none" stroke={colorOf(series, i)} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                        )}
                      </g>
                    );
                  })}
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
            series.map((s, i) =>
              hp[s.key] === null || hp[s.key] === undefined ? null : (
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
                    background: colorOf(series, i),
                    boxShadow: '0 0 0 2px var(--surface)',
                    pointerEvents: 'none',
                  }}
                />
              ),
            )}
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
              <div className="faint tiny">{fmtDate(hp.ts)}</div>
              {series.map((s, i) => (
                <div key={s.key} className="row gap-6" style={{ marginTop: 4 }}>
                  <svg width="12" height="4" aria-hidden="true">
                    <line x1="0" y1="2" x2="12" y2="2" stroke={colorOf(series, i)} strokeWidth="2" strokeLinecap="round" />
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
export function BarList({ items = [], formatValue = (v) => fmtNumber(v), empty = tr('No data'), pageSize = 10 }) {
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
          <div
            style={{
              height: 8,
              borderRadius: 4,
              background: 'var(--surface-2)',
            }}
          >
            <div
              style={{
                width: `${Math.max(1, (100 * (it.value || 0)) / max)}%`,
                height: '100%',
                borderRadius: 4,
                background: 'var(--chart-1)',
              }}
            />
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

// the legend of a chart of two series or more, and the switch to its table view
function LegendRow({ series, showTable, setShowTable, swatch = 'line' }) {
  return (
    <div className="row wrap gap-16 small muted" aria-label={tr('legend')}>
      {series.map((s, i) => (
        <span key={s.key} className="row gap-6">
          <svg width={swatch === 'line' ? 16 : 10} height={swatch === 'line' ? 4 : 10} aria-hidden="true">
            {swatch === 'line' ? (
              <line x1="0" y1="2" x2="16" y2="2" stroke={colorOf(series, i)} strokeWidth="2" strokeLinecap="round" />
            ) : (
              <rect width="10" height="10" rx="2" fill={colorOf(series, i)} />
            )}
          </svg>
          {s.label}
        </span>
      ))}
      <span className="spacer" />
      <button className="btn ghost xs" onClick={() => setShowTable(!showTable)}>
        {showTable ? tr('Chart') : tr('Table')}
      </button>
    </div>
  );
}

function SeriesTable({ points, series, formatValue, height }) {
  return (
    <div className="table-wrap" style={{ maxHeight: height + 40, overflow: 'auto' }}>
      <table className="table small" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <thead>
          <tr>
            <th>{tr('Time')}</th>
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
              <td>{fmtDate(p.ts)}</td>
              {series.map((s) => (
                <td key={s.key} className="right">
                  {formatValue(p[s.key] || 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A split that changes over time: one column per bucket, its parts stacked from the baseline, a 2px
// surface gap between them, the end away from the baseline rounded. One tooltip per column lists
// every part; the legend names them, the table view lists them.
export function StackedColumns({ data = [], series, bucket = 'hour', height = 220, formatValue = (v) => fmtNumber(v) }) {
  const ref = useRef(null);
  const [wrapRef, W] = useWidth();
  const [hover, setHover] = useState(null);
  const [showTable, setShowTable] = useState(false);
  const H = height;
  const pad = { l: 44, r: 12, t: 10, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const points = useMemo(() => data.map((d) => ({ ...d, ts: new Date(d.t).getTime() })), [data]);
  const total = (p) => series.reduce((n, s) => n + (Number(p[s.key]) || 0), 0);
  const { max, ticks } = niceTicks(Math.max(1, ...points.map(total)));
  const n = Math.max(1, points.length);
  const slot = iw / n;
  const bw = Math.max(2, Math.min(28, slot * 0.7));
  const cx = (i) => pad.l + slot * (i + 0.5);
  const y = (v) => pad.t + ih - (v / max) * ih;

  const labelEvery = Math.max(1, Math.ceil(n / 5));
  if (!points.length) return <div className="empty small">{tr('No traffic in this period')}</div>;
  const onMove = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.floor((px - pad.l) / slot))));
  };
  const hp = hover !== null ? points[hover] : null;
  return (
    <div className="col gap-6">
      {series.length > 1 && <LegendRow series={series} showTable={showTable} setShowTable={setShowTable} swatch="block" />}
      {showTable ? (
        <SeriesTable points={points} series={series} formatValue={formatValue} height={height} />
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
            aria-label={tr('{0} over time', [series.map((s) => s.label).join(', ')])}
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
            {points.map((p, i) =>
              i % labelEvery === 0 && (i === 0 || fmtTick(p.ts, bucket) !== fmtTick(points[i - labelEvery].ts, bucket)) ? (
                <text key={`x${i}`} x={cx(i)} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--faint)">
                  {fmtTick(p.ts, bucket)}
                </text>
              ) : null,
            )}
            {hp && <rect x={cx(hover) - slot / 2} y={pad.t} width={slot} height={ih} fill="var(--hover)" />}
            {points.map((p, i) => {
              let base = 0;
              const parts = series.map((s, k) => ({ k, v: Number(p[s.key]) || 0 })).filter((x) => x.v > 0);
              return (
                <g key={p.ts}>
                  {parts.map((part, j) => {
                    const y0 = y(base);
                    base += part.v;
                    const y1 = y(base);
                    const top = j === parts.length - 1;
                    // the gap: each part but the top one gives 2px of its height back to the surface
                    const h = Math.max(0, y0 - y1 - (top ? 0 : 2));
                    const x0 = cx(i) - bw / 2;
                    if (!top) return <rect key={part.k} x={x0} y={y1 + 2} width={bw} height={h} fill={colorOf(series, part.k)} />;
                    const r = Math.min(4, bw / 2, h);
                    const d = `M${x0},${y0} L${x0},${y1 + r} Q${x0},${y1} ${x0 + r},${y1} L${x0 + bw - r},${y1} Q${x0 + bw},${y1} ${x0 + bw},${y1 + r} L${x0 + bw},${y0} Z`;
                    return <path key={part.k} d={d} fill={colorOf(series, part.k)} />;
                  })}
                </g>
              );
            })}
          </svg>
          {hp && (
            <div
              className="card small"
              style={{
                position: 'absolute',
                top: 4,
                left: `${(cx(hover) / W) * 100}%`,
                transform: cx(hover) > W * 0.65 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
                padding: '8px 10px',
                pointerEvents: 'none',
                minWidth: 150,
                boxShadow: 'var(--shadow-lg)',
              }}
            >
              <div className="faint tiny">{fmtDate(hp.ts)}</div>
              {series.map((s, i) => (
                <div key={s.key} className="row gap-6" style={{ marginTop: 4 }}>
                  <svg width="10" height="10" aria-hidden="true">
                    <rect width="10" height="10" rx="2" fill={colorOf(series, i)} />
                  </svg>
                  <span className="bold">{formatValue(hp[s.key] || 0)}</span>
                  <span className="muted">{s.label}</span>
                </div>
              ))}
              <div className="row gap-6 faint tiny" style={{ marginTop: 4 }}>
                {tr('total {0}', [formatValue(total(hp))])}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
