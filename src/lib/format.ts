export const money = (v: number, digits = 0): string =>
  Number.isFinite(v)
    ? v.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : "—";

export const signedMoney = (v: number): string =>
  Number.isFinite(v) ? `${v < 0 ? "−" : "+"}${money(Math.abs(v))}` : "—";

export const pct = (v: number, digits = 1): string =>
  Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : "—";

export const signedPct = (v: number, digits = 1): string =>
  Number.isFinite(v) ? `${v < 0 ? "−" : "+"}${(Math.abs(v) * 100).toFixed(digits)}%` : "—";

export const num = (v: number, digits = 2): string =>
  Number.isFinite(v) ? v.toFixed(digits) : "—";

export const shortDate = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

export const monthYear = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
};

export const compactMoney = (v: number): string => {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `$${v.toFixed(0)}`;
};
