import type { Panel } from "./engine";

export interface SeriesPayload {
  symbol: string;
  dates: string[];
  close: number[];
  source: "yahoo" | "stooq";
  adjusted: boolean;
}

export interface LoadResult {
  panel: Panel;
  sources: Record<string, string>;
  errors: string[];
}

interface RawResponse {
  series: SeriesPayload[];
  errors: string[];
}

async function fetchSymbol(
  symbol: string,
  start: string,
  end: string,
): Promise<SeriesPayload | null> {
  const qs = new URLSearchParams({ symbols: symbol, start, end });
  try {
    const res = await fetch(`/api/prices?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as RawResponse;
    const hit = body.series?.[0];
    if (hit) return hit;
    return null;
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
            ...fx,
            symbol,
            dates: keep.map(([d]) => d),
            close: keep.map(([, c]) => c),
            source: "yahoo",
          };
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}

/** Load every symbol, then intersect the calendars so the panel has no gaps. */
export async function loadPrices(
  symbols: string[],
  start: string,
  end: string,
  onProgress?: (done: number, total: number, symbol: string) => void,
): Promise<LoadResult> {
  const series: SeriesPayload[] = [];
  const errors: string[] = [];
  const sources: Record<string, string> = {};

  // A cold symbol costs a full-history round trip, so fetch a few at a time rather
  // than one after another; the progress bar still advances per completed symbol.
  const queue = [...symbols];
  let done = 0;
  const worker = async () => {
    for (let sym = queue.shift(); sym; sym = queue.shift()) {
      const got = await fetchSymbol(sym, start, end);
      done += 1;
      onProgress?.(done, symbols.length, sym);
      if (got && got.dates.length > 1) {
        series.push(got);
        sources[sym] = got.source;
      } else {
        errors.push(sym);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, symbols.length) }, worker),
  );
  onProgress?.(symbols.length, symbols.length, "");

  if (!series.length) return { panel: { dates: [], prices: {} }, sources, errors };

  // intersection of trading days across every symbol
  let common = new Set(series[0].dates);
  for (const s of series.slice(1)) common = new Set(s.dates.filter((d) => common.has(d)));
  const dates = [...common].sort();
  if (dates.length < 2) return { panel: { dates: [], prices: {} }, sources, errors };

  const prices: Record<string, number[]> = {};
  for (const s of series) {
    const map = new Map(s.dates.map((d, i) => [d, s.close[i]]));
    prices[s.symbol] = dates.map((d) => map.get(d) as number);
  }

  return { panel: { dates, prices }, sources, errors };
}
