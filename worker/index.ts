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
  /** upstream ticker actually used, e.g. BTC -> BTC-USD, JEPG -> JEPG.L */
  resolved?: string;
  /** quote currency of the upstream data; cleared once converted to USD */
  currency?: string;
  /** set when prices were converted, e.g. "CAD" for a Toronto listing */
  convertedFrom?: string;
}

/**
 * Yahoo has no bare crypto tickers: the coin lives at `<SYM>-USD`. Worse, several bare
 * codes now belong to *funds* — "BTC" and "ETH" are the 2024 Grayscale mini trusts — so
 * asking for BTC quietly returned three years of a closed-end fund instead of bitcoin's
 * full history. These majors therefore resolve to their USD pair.
 *
 * Tickers that are also prominent U.S. listings (TRX, APT, SUI, SAND, STX, AXS) are left
 * alone; any coin can always be requested explicitly as `<SYM>-USD`.
 */
const CRYPTO = new Set([
  "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LTC", "BCH", "DOT", "AVAX",
  "MATIC", "SHIB", "XLM", "ATOM", "UNI", "LINK", "AAVE", "NEAR", "ARB", "OP",
  "ICP", "FIL", "ETC", "HBAR", "ALGO", "VET", "INJ", "GRT", "MANA", "XTZ",
  "EOS", "THETA", "RUNE", "KAS", "PEPE", "WIF", "BONK", "JUP", "SEI", "TIA",
  "ONDO", "ENA", "TON", "IMX",
]);

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

interface RawSeries {
  dates: string[];
  close: number[];
  currency: string;
}

async function yahooRaw(symbol: string): Promise<RawSeries | null> {
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
    const currency = typeof result?.meta?.currency === "string" ? result.meta.currency : "USD";
    return { dates, close, currency };
  } catch {
    return null;
  }
}

/**
 * Yahoo search, used only when the exact ticker has no chart: plenty of funds are
 * listed outside the US (JEPG is London, QQQL is Toronto) and their bare code means
 * nothing to the chart API. Only same-root listings are accepted, so searching a
 * typo cannot silently substitute an unrelated company.
 */
async function yahooListings(symbol: string): Promise<string[]> {
  const url =
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}` +
    `&quotesCount=10&newsCount=0&listsCount=0&enableFuzzyQuery=false`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as any;
    const quotes: any[] = Array.isArray(payload?.quotes) ? payload.quotes : [];
    const wanted = new Set(["EQUITY", "ETF", "MUTUALFUND", "INDEX", "CRYPTOCURRENCY"]);
    return [
      ...new Set(
        quotes
          .filter((q) => typeof q?.symbol === "string" && wanted.has(q?.quoteType))
          .map((q) => String(q.symbol).toUpperCase())
          .filter((s) => s === symbol || s.startsWith(`${symbol}.`)),
      ),
    ].slice(0, 4);
  } catch {
    return [];
  }
}

const fxMem = new Map<string, { expires: number; dates: string[]; close: number[] }>();

/** Daily USD-per-unit rates for a currency, cached like a price series. */
async function loadFx(
  pair: string,
  ctx: ExecutionContext,
): Promise<{ dates: string[]; close: number[] } | null> {
  const hit = fxMem.get(pair);
  if (hit && hit.expires > Date.now()) return hit;
  const key = `https://ppc-cache.internal/fx/v1/${encodeURIComponent(pair)}`;
  if (typeof caches !== "undefined") {
    try {
      const cached = await caches.default.match(key);
      if (cached) {
        const data = (await cached.json()) as { dates: string[]; close: number[] };
        fxMem.set(pair, { expires: Date.now() + TTL, ...data });
        return data;
      }
    } catch {
      /* cache is best effort */
    }
  }
  const raw = await yahooRaw(pair);
  if (!raw) return null;
  const data = { dates: raw.dates, close: raw.close };
  fxMem.set(pair, { expires: Date.now() + TTL, ...data });
  if (typeof caches !== "undefined" && ctx?.waitUntil) {
    ctx.waitUntil(
      caches.default
        .put(
          key,
          new Response(JSON.stringify(data), {
            headers: { "content-type": "application/json", "cache-control": `max-age=${TTL / 1000}` },
          }),
        )
        .catch(() => undefined),
    );
  }
  return data;
}

/**
 * The whole app is a USD backtest, so a foreign listing is converted at the daily FX
 * rate rather than mixed into the portfolio at face value. London quotes in pence
 * (GBp) are scaled by 1/100 before the GBP rate is applied.
 */
async function toUsd(series: Series, ctx: ExecutionContext): Promise<Series | null> {
  const quote = series.currency ?? "USD";
  const code = quote.toUpperCase();
  if (code === "USD") {
    const { currency: _drop, ...rest } = series;
    return rest;
  }
  const pence = quote === "GBp" || code === "GBX";
  const fx = await loadFx(`${pence ? "GBP" : code}USD=X`, ctx);
  if (!fx) return null;

  const dates: string[] = [];
  const close: number[] = [];
  let j = -1;
  for (let i = 0; i < series.dates.length; i += 1) {
    const day = series.dates[i];
    // carry the last known rate forward, so a foreign holiday is not a gap
    while (j + 1 < fx.dates.length && fx.dates[j + 1] <= day) j += 1;
    if (j < 0) continue;
    const rate = fx.close[j];
    if (!(rate > 0)) continue;
    dates.push(day);
    close.push(series.close[i] * (pence ? 0.01 : 1) * rate);
  }
  if (dates.length < 2) return null;
  const { currency: _drop, ...rest } = series;
  return { ...rest, dates, close, convertedFrom: quote };
}

/** Wrap a raw Yahoo series with the requested symbol so the UI can show the mapping. */
function asSeries(symbol: string, candidate: string, raw: RawSeries): Series {
  return {
    symbol,
    dates: raw.dates,
    close: raw.close,
    source: "yahoo",
    adjusted: true,
    resolved: candidate,
    currency: raw.currency,
  };
}

/**
 * Yahoo writes share classes with a dash (BRK-B) while index files use a dot
 * (BRK.B), so try both spellings before giving up. Crypto majors are rewritten to
 * their USD pair, which is what "BTC"/"ETH" are meant to mean in a backtest.
 */
async function fromYahoo(symbol: string): Promise<Series | null> {
  const pair = CRYPTO.has(symbol) ? `${symbol}-USD` : null;
  // never fall back to the bare crypto code: that is the fund we are avoiding
  const direct = pair
    ? [pair]
    : [...new Set([symbol, symbol.replace(/\./g, "-")])];
  for (const candidate of direct) {
    const raw = await yahooRaw(candidate);
    if (raw) return asSeries(symbol, candidate, raw);
  }
  if (pair) return null;
  for (const candidate of await yahooListings(symbol)) {
    if (direct.includes(candidate)) continue;
    const raw = await yahooRaw(candidate);
    if (raw) return asSeries(symbol, candidate, raw);
  }
  return null;
}

function stooqSymbol(symbol: string): string {
  const s = symbol.toLowerCase();
  if (CRYPTO.has(symbol) || /^[A-Z]{2,6}-USD$/.test(symbol)) {
    return `${symbol.replace(/-USD$/, "").toLowerCase()}usd`;
  }
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
    return { symbol, dates, close, source: "stooq", adjusted: false, resolved: stooqSymbol(symbol) };
  } catch {
    return null;
  }
}

async function loadSeries(symbol: string, ctx: ExecutionContext): Promise<Series | null> {
  const hit = mem.get(symbol);
  if (hit && hit.expires > Date.now()) return hit.data;

  // v2: crypto aliases changed what these keys resolve to, so v1 entries must not be served
  // v3: listings resolve through search and foreign quotes are converted to USD
  const key = `https://ppc-cache.internal/series/v3/${encodeURIComponent(symbol)}`;
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

  const yahoo = await fromYahoo(symbol);
  const data = (yahoo ? await toUsd(yahoo, ctx) : null) ?? (await fromStooq(symbol));
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
  const unknown: string[] = [];
  const outOfRange: string[] = [];
  loaded.forEach((s, i) => {
    if (!s) {
      unknown.push(symbols[i]);
      return;
    }
    const cut = slice(s, start, end);
    // a real ticker with no overlap is a different problem from a ticker nobody has
    if (cut.dates.length < 2) outOfRange.push(symbols[i]);
    else series.push(cut);
  });

  return json(
    { series, errors: [...unknown, ...outOfRange], unknown, outOfRange, asOf: new Date().toISOString() },
    200,
    600,
  );
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
