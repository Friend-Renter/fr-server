/**
 * Money helpers — store money as integer cents.
 * Never store floats in Mongo. Convert at the edges.
 */

export type MoneyCents = number;

/** Parse "$1,234.56" | "1234.56" | 1234.56 into integer cents. */
export function toCents(input: string | number): MoneyCents {
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.round(input * 100);
  }
  if (typeof input === "string") {
    const s = input.trim();
    // strip currency symbols and commas
    const normalized = s.replace(/[^0-9.-]/g, "");
    const n = Number(normalized);
    if (!Number.isFinite(n)) throw new Error(`Invalid money input: ${input}`);
    return Math.round(n * 100);
  }
  throw new Error(`Invalid money input type: ${typeof input}`);
}

/** Convert integer cents to decimal dollars (number). */
export function fromCents(cents: MoneyCents): number {
  return Math.round(cents) / 100;
}

/** Format integer cents for display. */
export function formatCurrency(cents: MoneyCents, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(fromCents(cents));
}

/** Add cents, safe integer math. */
export function addCents(...parts: MoneyCents[]): MoneyCents {
  let total = 0;
  for (const p of parts) total += Math.round(p);
  return total;
}

/** Multiply cents by a scalar (e.g., tax rate 0.085). */
export function mulCents(cents: MoneyCents, factor: number): MoneyCents {
  if (!Number.isFinite(factor)) throw new Error("Invalid factor");
  return Math.round(Math.round(cents) * factor);
}

/** Compute a percentage of a cent amount. */
export function percentOf(cents: MoneyCents, pct: number): MoneyCents {
  return mulCents(cents, pct / 100);
}

/** Guard helpers for business rules. */
export function assertNonNegativeCents(cents: MoneyCents, label = "amount") {
  if (Math.round(cents) < 0) throw new Error(`${label} cannot be negative`);
}
