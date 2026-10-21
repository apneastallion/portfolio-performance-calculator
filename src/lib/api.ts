import type { Panel } from "./engine";

export interface SeriesPayload {
  symbol: string;
  dates: string[];
  close: number[];
  source: "yahoo" | "stooq";
  adjusted: boolean;
  /** upstream ticker actually used, e.g. BTC -> BTC-USD, JEPG -> JEPG.L */
  resolved?: string;
  /** set when a foreign quote had to be converted, e.g. "CAD" */
  convertedFrom?: string;
}

export interface LoadResult {
  panel: Panel;
  sources: Record<string, string>;
  /** display notes for symbols that were mapped or converted, e.g. "→ JEPG.L (GBp→USD)" */
  resolved: Record<string, string>;
  /** no such symbol anywhere */
  unknown: string[];
  /** a real symbol, but it has no prices inside the requested window */
  outOfRange: string[];
  errors: string[];
}

interface RawResponse {
  series: SeriesPayload[];
  errors: string[];
  unknown?: string[];
  outOfRange?: string[];
}

type FetchResult =
  | { hit: SeriesPayload; reason?: undefined }
  | { hit: null; reason: "unknown" | "range" };

async function fetchSymbol(symbol: string, start: string, end: string): Promise<FetchResult> {
  const qs = new URLSearchParams({ symbols: symbol, start, end });
  try {
    const res = await fetch(`/api/prices?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as RawResponse;
    const hit = body.series?.[0];
    if (hit) return { hit };
    return { hit: null, reason: body.outOfRange?.includes(symbol) ? "range" : "unknown" };
  } catch {
    // Local development without the worker: fall back to bundled fixtures so the UI
    // and the maths can still be exercised offline.
    if (import.meta.env.DEV) {
      try {
        const f = await fetch(`/fixtures/${symbol.replace(/[^A-Z0-9-]/gi, "_")}.json`);
        if (f.ok) {
          const fx = (await f.json()) as SeriesPayload;
          const keep = fx.dates
            .map((d, i) => [d, fx.close[i]] as const)
            .filter(([d]) => d >= start && d <= end);
          return {
            hit: {
              ...fx,
              symbol,
              dates: keep.map(([d]) => d),
              close: keep.map(([, c]) => c),
              source: "yahoo",
            },
          };
        }
      } catch {
        /* ignore */
      }
    }
    return { hit: null, reason: "unknown" };
  }
}

/**
 * Drop the sessions before the first holding has a price. The benchmark is fetched on the
 * same calendar, so without this a 1993 SPY quote would open a portfolio whose first fund
 * only listed in 2000 and leave seven years of idle cash on the chart.
 */
export function trimToFirstHolding(panel: Panel, symbols: string[]): Panel {
  let start = panel.dates.length;
  for (const s of symbols) {
    const i = (panel.prices[s] ?? []).findIndex((v) => v != null);
    if (i >= 0) start = Math.min(start, i);
  }
  if (start <= 0 || start >= panel.dates.length) return panel;
  const prices: Record<string, (number | null)[]> = {};
  for (const [s, arr] of Object.entries(panel.prices)) prices[s] = arr.slice(start);
  return { dates: panel.dates.slice(start), prices };
}

/** Load every symbol, then align the calendars into one ragged panel. */
export async function loadPrices(
  symbols: string[],
  start: string,
  end: string,
  onProgress?: (done: number, total: number, symbol: string) => void,
): Promise<LoadResult> {
  const series: SeriesPayload[] = [];
  const unknown: string[] = [];
  const outOfRange: string[] = [];
  const sources: Record<string, string> = {};
  const resolved: Record<string, string> = {};

  // A cold symbol costs a full-history round trip, so fetch a few at a time rather
  // than one after another; the progress bar still advances per completed symbol.
  const queue = [...symbols];
  let done = 0;
  const worker = async () => {
    for (let sym = queue.shift(); sym; sym = queue.shift()) {
      const got = await fetchSymbol(sym, start, end);
      done += 1;
      onProgress?.(done, symbols.length, sym);
      if (got.hit && got.hit.dates.length > 1) {
        series.push(got.hit);
        sources[sym] = got.hit.source;
        // tell the user when the ticker they typed was mapped or converted
        const notes: string[] = [];
        if (got.hit.resolved && got.hit.resolved !== sym) notes.push(`→ ${got.hit.resolved}`);
        if (got.hit.convertedFrom) notes.push(`(${got.hit.convertedFrom}→USD)`);
        if (notes.length) resolved[sym] = notes.join(" ");
      } else if (got.reason === "range") {
        outOfRange.push(sym);
      } else {
        unknown.push(sym);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, symbols.length) }, worker));
  onProgress?.(symbols.length, symbols.length, "");

  const errors = [...unknown, ...outOfRange];
  const empty = { panel: { dates: [], prices: {} }, sources, resolved, unknown, outOfRange, errors };

  if (!series.length) return empty;

  // Union of sessions, not an intersection: a fund that listed in 2024 should join a
  // portfolio that has been running since 1993 rather than truncate it. Different
  // market calendars (a London holiday, a crypto weekend) still line up because each
  // symbol is carried forward from its last known close.
  const union = new Set<string>();
  for (const s of series) for (const d of s.dates) union.add(d);
  const dates = [...union].sort();
  if (dates.length < 2) return empty;

  const prices: Record<string, (number | null)[]> = {};
  for (const s of series) {
    const map = new Map(s.dates.map((d, i) => [d, s.close[i]]));
    let last: number | null = null;
    prices[s.symbol] = dates.map((d) => {
      const v = map.get(d);
      if (v != null) last = v;
      // null only before the first quote; after that a stale price beats a hole
      return last;
    });
  }

  return { panel: { dates, prices }, sources, resolved, unknown, outOfRange, errors };
}
