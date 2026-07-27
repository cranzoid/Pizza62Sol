"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/domain";

// Chart colours live in one place. The single-series hue, the three-slot
// categorical set and the ordinal ramp were each checked with the data-viz
// validator against this dashboard's white panel surface (lightness band, chroma
// floor, protan/deutan separation, normal-vision floor, WCAG contrast).
const SERIES = "var(--viz-series-1)";

export type Analytics = {
  range: { days: number; start: number; end: number; timeZone: string };
  totals: { orders: number; salesCents: number; averageCents: number; tipCents: number; discountCents: number; deliveryCents: number; taxCents: number };
  previous: { orders: number; salesCents: number };
  daily: Array<{ date: string; orders: number; salesCents: number }>;
  hourly: Array<{ hour: number; orders: number; salesCents: number }>;
  weekday: Array<{ weekday: number; orders: number; salesCents: number }>;
  fulfilment: Array<{ fulfilment: string; orders: number; salesCents: number }>;
  payment: Array<{ method: string; orders: number }>;
  schedule: Array<{ type: string; orders: number }>;
  statuses: Array<{ status: string; orders: number }>;
  topProducts: Array<{ name: string; quantity: number; salesCents: number }>;
  funnel: Array<{ step: string; sessions: number }>;
  conversionBps: number;
  ratings: { count: number; average: number; distribution: Array<{ rating: number; responses: number }> };
  customers: { total: number; returning: number };
};

const RANGES = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
] as const;

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const compact = (value: number) => (value >= 10_000 ? `${(value / 1000).toFixed(1)}K` : String(value));
const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "0%");

function delta(current: number, previous: number): { label: string; direction: "up" | "down" | "flat" } {
  if (!previous) return { label: current ? "New in this period" : "No change", direction: current ? "up" : "flat" };
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return { label: "Level with the period before", direction: "flat" };
  return { label: `${change > 0 ? "+" : ""}${change}% vs the period before`, direction: change > 0 ? "up" : "down" };
}

export function AdminAnalyticsPanel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    const response = await fetch(`/api/admin/analytics?days=${days}`);
    const result = await response.json() as Analytics & { error?: string };
    if (!response.ok) { setError(result.error ?? "Analytics could not be loaded."); return; }
    setData(result);
  }, [days]);
  // Deferred like the rest of the portal so the fetch is not started inside the
  // render/effect boundary.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (error) return <div className="staff-panel"><div className="form-error" role="alert">{error}</div></div>;
  if (!data) return <div className="staff-panel" role="status">Loading your numbers…</div>;

  const salesDelta = delta(data.totals.salesCents, data.previous.salesCents);
  const orderDelta = delta(data.totals.orders, data.previous.orders);
  const busiestHour = [...data.hourly].sort((a, b) => b.orders - a.orders)[0];
  const busiestDay = [...data.weekday].sort((a, b) => b.orders - a.orders)[0];
  const visits = data.funnel[0]?.sessions ?? 0;

  return <div className="admin-stack viz">
    <div className="viz-toolbar">
      <div className="segmented-range" role="group" aria-label="Reporting period">
        {RANGES.map(([value, label]) => <button key={value} className={days === value ? "active" : ""} aria-pressed={days === value} onClick={() => setDays(value)}>{label}</button>)}
      </div>
      <span className="live-chip"><i /> Paid orders · Hamilton time</span>
    </div>

    <section className="stats-grid">
      <StatTile label="Sales" value={formatMoney(data.totals.salesCents)} delta={salesDelta} />
      <StatTile label="Orders" value={compact(data.totals.orders)} delta={orderDelta} />
      <StatTile label="Average order" value={formatMoney(data.totals.averageCents)} note={`${formatMoney(data.totals.tipCents)} in tips`} />
      <StatTile label="Visitors who ordered" value={`${(data.conversionBps / 100).toFixed(1)}%`} note={`${compact(visits)} website visits`} />
    </section>

    <section className="staff-panel">
      <div className="staff-panel-head"><h2>Sales, day by day</h2><span className="live-chip">{data.range.days} days</span></div>
      <DailyTrend rows={data.daily} />
    </section>

    <div className="staff-grid viz-pair">
      <section className="staff-panel">
        <div className="staff-panel-head"><h2>When your orders come in</h2>{busiestHour?.orders ? <span className="live-chip">Busiest {formatHour(busiestHour.hour)}</span> : null}</div>
        <Columns
          rows={data.hourly.map((row) => ({ key: String(row.hour), label: formatHour(row.hour), value: row.orders, hint: `${row.orders} orders · ${formatMoney(row.salesCents)}` }))}
          everyNthLabel={3}
          valueLabel="orders"
        />
      </section>
      <section className="staff-panel">
        <div className="staff-panel-head"><h2>Busiest days</h2>{busiestDay?.orders ? <span className="live-chip">{WEEKDAY_NAMES[busiestDay.weekday]}</span> : null}</div>
        <Columns
          rows={data.weekday.map((row) => ({ key: String(row.weekday), label: WEEKDAY_NAMES[row.weekday], value: row.orders, hint: `${row.orders} orders · ${formatMoney(row.salesCents)}` }))}
          valueLabel="orders"
        />
      </section>
    </div>

    <div className="staff-grid viz-pair">
      <section className="staff-panel">
        <div className="staff-panel-head"><h2>From visit to order</h2><span className="live-chip">Website sessions</span></div>
        <Funnel steps={data.funnel} />
      </section>
      <section className="staff-panel">
        <div className="staff-panel-head"><h2>How people order</h2></div>
        <SplitBar
          title="Pickup and delivery"
          segments={data.fulfilment.map((row) => ({ key: row.fulfilment, label: titleCase(row.fulfilment), value: row.orders }))}
        />
        <SplitBar
          title="Paying"
          segments={data.payment.map((row) => ({ key: row.method, label: titleCase(row.method), value: row.orders }))}
        />
        <SplitBar
          title="Now or later"
          segments={data.schedule.map((row) => ({ key: row.type, label: row.type === "asap" ? "As soon as possible" : "Scheduled", value: row.orders }))}
        />
        <dl className="viz-facts">
          <div><dt>Customers who ordered</dt><dd>{data.customers.total}</dd></div>
          <div><dt>Ordered more than once</dt><dd>{data.customers.returning} · {percent(data.customers.returning, data.customers.total)}</dd></div>
          <div><dt>Cancelled</dt><dd>{data.statuses.find((row) => row.status === "cancelled")?.orders ?? 0}</dd></div>
        </dl>
      </section>
    </div>

    <div className="staff-grid viz-pair">
      <section className="staff-panel">
        <div className="staff-panel-head"><h2>What sells</h2><span className="live-chip">Top {data.topProducts.length}</span></div>
        <RankedTable rows={data.topProducts} />
      </section>
      <section className="staff-panel">
        <div className="staff-panel-head"><h2>What people think</h2>{data.ratings.count ? <span className="live-chip">{data.ratings.average.toFixed(1)} / 5</span> : null}</div>
        {data.ratings.count
          ? <Ratings distribution={data.ratings.distribution} total={data.ratings.count} />
          : <div className="staff-empty">No feedback yet in this period.</div>}
      </section>
    </div>
  </div>;
}

function formatHour(hour: number) {
  const period = hour < 12 ? "AM" : "PM";
  return `${hour % 12 || 12}${period}`;
}

const titleCase = (value: string) => value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());

function StatTile({ label, value, delta: change, note }: { label: string; value: string; delta?: ReturnType<typeof delta>; note?: string }) {
  return <article className="stat-card">
    <span>{label}</span>
    <strong className="viz-figure">{value}</strong>
    {change ? <small className={`viz-delta viz-delta--${change.direction}`}>{change.label}</small> : null}
    {note ? <small>{note}</small> : null}
  </article>;
}

// Trend over time is a line with a 10% wash; the crosshair and tooltip carry the
// per-day values so the plot itself stays free of a number on every point.
function DailyTrend({ rows }: { rows: Analytics["daily"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const height = 210;
  const padding = { top: 16, right: 16, bottom: 26, left: 54 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const max = Math.max(100, ...rows.map((row) => row.salesCents));
  const ceiling = Math.ceil(max / 5000) * 5000 || 5000;
  const stepX = rows.length > 1 ? plotWidth / (rows.length - 1) : 0;
  const pointAt = (index: number, value: number) => ({
    x: padding.left + index * stepX,
    y: padding.top + plotHeight - (value / ceiling) * plotHeight,
  });
  const points = rows.map((row, index) => pointAt(index, row.salesCents));
  const line = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const area = points.length
    ? `${line} L${points[points.length - 1].x.toFixed(1)} ${padding.top + plotHeight} L${points[0].x.toFixed(1)} ${padding.top + plotHeight} Z`
    : "";
  const ticks = [0, 0.5, 1].map((fraction) => ({ value: ceiling * fraction, y: padding.top + plotHeight - fraction * plotHeight }));
  const peak = rows.reduce((best, row, index) => (row.salesCents > (rows[best]?.salesCents ?? -1) ? index : best), 0);
  const active = hover ?? (rows[peak]?.salesCents ? peak : null);
  if (!rows.some((row) => row.orders)) return <div className="staff-empty">No paid orders in this period yet.</div>;
  return <figure className="viz-figure-block">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Sales for each day in the selected period" onMouseLeave={() => setHover(null)}>
      {ticks.map((tick) => <g key={tick.value}>
        <line className="viz-gridline" x1={padding.left} x2={width - padding.right} y1={tick.y} y2={tick.y} />
        <text className="viz-axis" x={padding.left - 8} y={tick.y + 3} textAnchor="end">{formatMoney(tick.value)}</text>
      </g>)}
      <path d={area} fill={SERIES} opacity=".1" />
      <path d={line} fill="none" stroke={SERIES} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {active !== null && points[active] ? <>
        <line className="viz-crosshair" x1={points[active].x} x2={points[active].x} y1={padding.top} y2={padding.top + plotHeight} />
        <circle cx={points[active].x} cy={points[active].y} r="5" fill={SERIES} stroke="var(--viz-surface)" strokeWidth="2" />
      </> : null}
      {rows.map((row, index) => <rect
        key={row.date}
        x={points[index].x - stepX / 2}
        y={padding.top}
        width={Math.max(stepX, 6)}
        height={plotHeight}
        fill="transparent"
        onMouseEnter={() => setHover(index)}
      ><title>{`${row.date}: ${formatMoney(row.salesCents)} · ${row.orders} orders`}</title></rect>)}
      {rows.map((row, index) => index === 0 || index === rows.length - 1 || index === Math.floor(rows.length / 2)
        ? <text key={`label-${row.date}`} className="viz-axis" x={points[index].x} y={height - 8} textAnchor={index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle"}>{row.date.slice(5)}</text>
        : null)}
    </svg>
    <figcaption>{active !== null && rows[active]
      ? <><strong>{rows[active].date}</strong> · {formatMoney(rows[active].salesCents)} from {rows[active].orders} order{rows[active].orders === 1 ? "" : "s"}</>
      : "Hover a day for its total."}</figcaption>
  </figure>;
}

function Columns({ rows, everyNthLabel = 1, valueLabel }: { rows: Array<{ key: string; label: string; value: number; hint: string }>; everyNthLabel?: number; valueLabel: string }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  const peak = rows.reduce((best, row, index) => (row.value > rows[best].value ? index : best), 0);
  if (!rows.some((row) => row.value)) return <div className="staff-empty">Nothing to show yet.</div>;
  return <div className="viz-columns" role="img" aria-label={`Orders by ${valueLabel}`}>
    {rows.map((row, index) => <div className="viz-column" key={row.key} title={row.hint}>
      <span className="viz-column-value">{index === peak && row.value ? row.value : ""}</span>
      <i style={{ height: `${Math.max(2, (row.value / max) * 100)}%`, background: SERIES, opacity: row.value ? 1 : .18 }} />
      <span className="viz-column-label">{index % everyNthLabel === 0 ? row.label : ""}</span>
    </div>)}
  </div>;
}

// Funnel stages are an ordered scale, so they take the ordinal ramp rather than
// one colour per stage.
function Funnel({ steps }: { steps: Analytics["funnel"] }) {
  const top = steps[0]?.sessions ?? 0;
  if (!top) return <div className="staff-empty">No website activity recorded in this period.</div>;
  return <div className="viz-funnel">
    {steps.map((step, index) => <div className="viz-funnel-row" key={step.step}>
      <span>{step.step}</span>
      <div className="viz-funnel-track"><i style={{ width: `${Math.max(1, (step.sessions / top) * 100)}%`, background: `var(--viz-ordinal-${index + 1})` }} /></div>
      <b>{compact(step.sessions)} <small>{percent(step.sessions, top)}</small></b>
    </div>)}
  </div>;
}

function SplitBar({ title, segments }: { title: string; segments: Array<{ key: string; label: string; value: number }> }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (!total) return null;
  return <div className="viz-split">
    <div className="viz-split-head"><span>{title}</span><small>{total} orders</small></div>
    <div className="viz-split-track">
      {segments.map((segment, index) => <i key={segment.key} style={{ width: `${(segment.value / total) * 100}%`, background: `var(--viz-series-${(index % 3) + 1})` }} title={`${segment.label}: ${segment.value}`} />)}
    </div>
    <div className="viz-legend">
      {segments.map((segment, index) => <span key={segment.key}><i style={{ background: `var(--viz-series-${(index % 3) + 1})` }} />{segment.label} · {percent(segment.value, total)}</span>)}
    </div>
  </div>;
}

function RankedTable({ rows }: { rows: Analytics["topProducts"] }) {
  const max = Math.max(1, ...rows.map((row) => row.quantity));
  if (!rows.length) return <div className="staff-empty">No items sold in this period yet.</div>;
  return <table className="viz-table">
    <thead><tr><th scope="col">Item</th><th scope="col">Sold</th><th scope="col">Sales</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.name}>
      <th scope="row"><span className="viz-bar-cell"><i style={{ width: `${(row.quantity / max) * 100}%`, background: SERIES }} /></span>{row.name}</th>
      <td>{row.quantity}</td>
      <td>{formatMoney(row.salesCents)}</td>
    </tr>)}</tbody>
  </table>;
}

function Ratings({ distribution, total }: { distribution: Analytics["ratings"]["distribution"]; total: number }) {
  return <div className="viz-funnel">
    {[...distribution].reverse().map((row) => <div className="viz-funnel-row" key={row.rating}>
      <span>{row.rating} star{row.rating === 1 ? "" : "s"}</span>
      <div className="viz-funnel-track"><i style={{ width: `${Math.max(row.responses ? 1 : 0, (row.responses / total) * 100)}%`, background: `var(--viz-ordinal-${row.rating})` }} /></div>
      <b>{row.responses} <small>{percent(row.responses, total)}</small></b>
    </div>)}
  </div>;
}
