/**
 * Pages worker (advanced mode).
 *
 * GET /api/prices?symbols=AAPL,SPY&start=2015-01-01&end=2026-10-20
 *   -> { series: [{ symbol, dates[], close[], source, adjusted }], errors: [] }
 *
 * Prices are split- and dividend-adjusted (total return). Yahoo is tried first because
 * it needs no key and covers arbitrary tickers; Stooq is the fallback when Yahoo
 * rate-limits or blocks the request. Full history is cached per symbol for 12 hours so
 * repeat visitors never touch upstream.
 */

interface Env {
  ASSETS: Fetcher;
}

interface Series {
  symbol: string;
  dates: string[];
  close: number[];
  source: "yahoo" | "stooq";
  adjusted: boolean;
}

const HOUR = 3_600_000;
const TTL = 12 * HOUR;
const MAX_SYMBOLS = 15;
const SYMBOL_RE = /^[A-Z0-9.^-]{1,12}$/;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const mem = new Map<string, { expires: number; data: Series }>();

function json(body: unknown, status = 200, maxAge = 300): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
    },
  });
}

async function yahooSymbol(symbol: string): Promise<Series | null> {
  const now = Math.floor(Date.now() / 1000) + 86_400;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=315532800&period2=${now}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as any;
    const result = payload?.chart?.result?.[0];
    const ts: number[] | undefined = result?.timestamp;
    if (!ts?.length) return null;
    const quote = result?.indicators?.quote?.[0] ?? {};
    const adj: (number | null)[] | undefined =
      result?.indicators?.adjclose?.[0]?.adjclose;
    const dates: string[] = [];
    const close: number[] = [];
    for (let i = 0; i < ts.length; i += 1) {
      const v = adj?.[i] ?? quote?.close?.[i];
      if (typeof v !== "number" || !isFinite(v) || v <= 0) continue;
      dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
      close.push(v);
    }
    if (dates.length < 2) return null;
    return { symbol, dates, close, source: "yahoo", adjusted: true };
  } catch {
    return null;
  }
}

/**
 * Yahoo writes share classes with a dash (BRK-B) while index files use a dot
 * (BRK.B), so try both spellings before giving up.
 */
async function fromYahoo(symbol: string): Promise<Series | null> {
  const candidates = [...new Set([symbol, symbol.replace(/\./g, "-")])];
  for (const candidate of candidates) {
    const hit = await yahooSymbol(candidate);
    if (hit) return { ...hit, symbol };
  }
  return null;
}

function stooqSymbol(symbol: string): string {
  const s = symbol.toLowerCase();
  if (s.startsWith("^")) {
    if (s === "^gspc" || s === "^spx") return "^spx";
    if (s === "^ndx") return "^ndx";
    if (s === "^dji") return "^dji";
    return s;
  }
  return `${s.replace(/\./g, "-")}.us`;
}

async function fromStooq(symbol: string): Promise<Series | null> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol(symbol))}&i=d`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.startsWith("Date,")) return null;
    const lines = text.trim().split("\n").slice(1);
    const dates: string[] = [];
    const close: number[] = [];
    for (const line of lines) {
      const cells = line.split(",");
      const d = cells[0];
      const c = Number(cells[4]);
      if (!d || !isFinite(c) || c <= 0) continue;
      dates.push(d);
      close.push(c);
    }
    if (dates.length < 2) return null;
    // Stooq's CSV close carries dividend adjustments for most US symbols, but it is
    // not documented, so the flag is conservative and the UI labels the source.
    return { symbol, dates, close, source: "stooq", adjusted: false };
  } catch {
    return null;
  }
}

async function loadSeries(symbol: string, ctx: ExecutionContext): Promise<Series | null> {
  const hit = mem.get(symbol);
  if (hit && hit.expires > Date.now()) return hit.data;

  const key = `https://ppc-cache.internal/series/v1/${encodeURIComponent(symbol)}`;
  if (typeof caches !== "undefined") {
    try {
      const cached = await caches.default.match(key);
      if (cached) {
        const data = (await cached.json()) as Series;
        mem.set(symbol, { expires: Date.now() + TTL, data });
        return data;
      }
    } catch {
      /* cache is best effort */
    }
  }

  const data = (await fromYahoo(symbol)) ?? (await fromStooq(symbol));
  if (!data) return null;
  mem.set(symbol, { expires: Date.now() + TTL, data });
  if (typeof caches !== "undefined") {
    const put = caches.default.put(
      key,
      new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${TTL / 1000}` },
      }),
    );
    if (ctx?.waitUntil) ctx.waitUntil(put.catch(() => undefined));
  }
  return data;
}

function slice(series: Series, start: string, end: string): Series {
  const from = series.dates.findIndex((d) => d >= start);
  if (from === -1) return { ...series, dates: [], close: [] };
  let to = series.dates.length - 1;
  while (to > from && series.dates[to] > end) to -= 1;
  return {
    ...series,
    dates: series.dates.slice(from, to + 1),
    close: series.close.slice(from, to + 1),
  };
}

async function handlePrices(url: URL, ctx: ExecutionContext): Promise<Response> {
  const raw = (url.searchParams.get("symbols") ?? "").toUpperCase();
  const start = url.searchParams.get("start") ?? "2000-01-01";
  const end = url.searchParams.get("end") ?? new Date().toISOString().slice(0, 10);

  const symbols = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!symbols.length) return json({ error: "no symbols requested" }, 400);
  if (symbols.length > MAX_SYMBOLS) return json({ error: `at most ${MAX_SYMBOLS} symbols` }, 400);
  const bad = symbols.filter((s) => !SYMBOL_RE.test(s));
  if (bad.length) return json({ error: `invalid symbols: ${bad.join(", ")}` }, 400);

  const loaded = await Promise.all(symbols.map((s) => loadSeries(s, ctx)));
  const series: Series[] = [];
  const errors: string[] = [];
  loaded.forEach((s, i) => {
    if (!s) {
      errors.push(symbols[i]);
      return;
    }
    const cut = slice(s, start, end);
    if (cut.dates.length < 2) errors.push(symbols[i]);
    else series.push(cut);
  });

  return json({ series, errors, asOf: new Date().toISOString() }, 200, 600);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, time: new Date().toISOString() }, 200, 0);
    }
    if (url.pathname === "/api/prices") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      return handlePrices(url, ctx);
    }
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
