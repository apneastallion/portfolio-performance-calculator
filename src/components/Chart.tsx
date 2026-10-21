import { useMemo, useRef, useState } from "react";
import { compactMoney, monthYear, money } from "../lib/format";

export interface ChartSeries {
  label: string;
  values: number[];
  color: string;
  dashed?: boolean;
  fill?: boolean;
}

interface Props {
  dates: string[];
  series: ChartSeries[];
  height?: number;
}

const PAD = { top: 16, right: 16, bottom: 28, left: 64 };

function ticks(min: number, max: number, count = 5): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const raw = span / (count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = first; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

export function Chart({ dates, series, height = 340 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const width = 900;

  const { lo, hi, paths, xTicks } = useMemo(() => {
    const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || hi * 0.1;
    const yMin = Math.max(0, lo - pad);
    const yMax = hi + pad;
    const x = (i: number) =>
      PAD.left + (i / Math.max(1, dates.length - 1)) * (width - PAD.left - PAD.right);
    const y = (v: number) =>
      height - PAD.bottom - ((v - yMin) / (yMax - yMin || 1)) * (height - PAD.top - PAD.bottom);

    const step = Math.max(1, Math.ceil(dates.length / 1400));
    const paths = series.map((s) => {
      let d = "";
      for (let i = 0; i < s.values.length; i += step) {
        d += `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(s.values[i]).toFixed(2)}`;
      }
      const last = s.values.length - 1;
      if (last % step !== 0) d += `L${x(last).toFixed(2)},${y(s.values[last]).toFixed(2)}`;
      const area =
        s.fill && d
          ? `${d}L${x(last).toFixed(2)},${(height - PAD.bottom).toFixed(2)}L${PAD.left},${(
              height - PAD.bottom
            ).toFixed(2)}Z`
          : "";
      return { d, area };
    });

    // label year boundaries, thinning evenly so labels never collide
    const boundaries: { i: number; label: string }[] = [];
    dates.forEach((d, i) => {
      if (i > 0 && d.slice(0, 4) !== dates[i - 1].slice(0, 4)) {
        boundaries.push({ i, label: d.slice(0, 4) });
      }
    });
    const plotWidth = width - PAD.left - PAD.right;
    const maxTicks = Math.max(2, Math.floor(plotWidth / 92));
    const skip = Math.max(1, Math.ceil(boundaries.length / maxTicks));
    const xTicks = boundaries
      .filter((_, k) => k % skip === 0)
      .map((b) => ({ x: x(b.i), label: b.label }));
    return { lo: yMin, hi: yMax, paths, xTicks };
  }, [dates, series, height]);

  const yTicks = ticks(lo, hi);
  const y = (v: number) =>
    height - PAD.bottom - ((v - lo) / (hi - lo || 1)) * (height - PAD.top - PAD.bottom);
  const xAt = (i: number) =>
    PAD.left + (i / Math.max(1, dates.length - 1)) * (width - PAD.left - PAD.right);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * width;
    const ratio = (rel - PAD.left) / (width - PAD.left - PAD.right);
    const i = Math.round(ratio * (dates.length - 1));
    setHover(i >= 0 && i < dates.length ? i : null);
  };

  const hoverX = hover !== null ? xAt(hover) : 0;

  return (
    <div className="chart" ref={wrap}>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.label} className="chart-key">
            <i style={{ background: s.color, opacity: s.dashed ? 0.75 : 1 }} />
            {s.label}
          </span>
        ))}
        {hover !== null && (
          <span className="chart-readout">
            <strong>{monthYear(dates[hover])}</strong>
            {series.map((s) => (
              <span key={s.label}>
                {s.label}: <b>{money(s.values[hover] ?? 0)}</b>
              </span>
            ))}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="chart-svg"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="Portfolio balance over time"
      >
        <defs>
          <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#2563eb" stopOpacity="0" />
          </linearGradient>
        </defs>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
            <text x={PAD.left - 10} y={y(t) + 4} className="axis-label" textAnchor="end">
              {compactMoney(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t.label + t.x} x={t.x} y={height - 8} className="axis-label" textAnchor="middle">
            {t.label}
          </text>
        ))}
        {paths.map((p, i) =>
          series[i].fill ? <path key={`a${i}`} d={p.area} fill="url(#area)" /> : null,
        )}
        {paths.map((p, i) => (
          <path
            key={`l${i}`}
            d={p.d}
            fill="none"
            stroke={series[i].color}
            strokeWidth={series[i].label.startsWith("Your") ? 2.4 : 1.5}
            strokeDasharray={series[i].dashed ? "5 4" : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {hover !== null && (
          <g>
            <line x1={hoverX} x2={hoverX} y1={PAD.top} y2={height - PAD.bottom} className="crosshair" />
            {series.map((s) => (
              <circle
                key={s.label}
                cx={hoverX}
                cy={y(s.values[hover] ?? 0)}
                r={3.5}
                fill={s.color}
                stroke="#fff"
                strokeWidth={1.5}
              />
            ))}
          </g>
        )}
      </svg>
    </div>
  );
}
