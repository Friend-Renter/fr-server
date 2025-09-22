// server/src/modules/pricing/calc.ts
import {
  getEnvPromos,
  getTaxExemptStates,
  getTaxRateDefault,
  getTaxRateMap,
  getTaxableFee,
  type PromoDef,
} from "../../config/env.js"; // <-- fixed path
import { logger } from "../../config/logger.js";
import { Listing, type ListingDoc } from "../listings/model.js";

export type Granularity = "hour" | "day";

export type QuoteInput = {
  listing: ListingDoc;
  start: Date;
  end: Date;
  promoCode?: string | null;
};

export type LineItem = {
  code: "BASE" | "FEE" | "PROMO" | "TAX";
  label: string;
  amountCents: number; // negative for discounts
};

export type QuoteResult = {
  currency: string;
  granularity: Granularity;
  nUnits: number; // billing units (days when hour-cats; days when day-cats)
  baseCents: number;
  feeCents: number;
  discountCents: number;
  taxCents: number;
  depositCents: number;
  totalCents: number;
  lineItems: LineItem[];
};

// Match your categories used elsewhere
const HOUR_CATS = new Set<string>(["car", "boat", "jetski"]);

function pickGranularity(category?: string | null): Granularity {
  if (category && HOUR_CATS.has(category)) return "hour";
  return "day";
}

function ceilUnits(ms: number, unitMs: number): number {
  const raw = Math.ceil(ms / unitMs);
  return Math.max(1, raw);
}

function applyPromo(
  subtotalCents: number,
  promo?: PromoDef | null
): { discountCents: number; label?: string } {
  if (!promo) return { discountCents: 0 };
  if (promo.kind === "percent") {
    const calc = Math.floor((subtotalCents * promo.value) / 100);
    return {
      discountCents: Math.min(calc, subtotalCents),
      label: promo.label ?? `${promo.code} (-${promo.value}%)`,
    };
  }
  const calc = Math.floor(promo.value);
  return {
    discountCents: Math.min(calc, subtotalCents),
    label: promo.label ?? `${promo.code} (-$${(promo.value / 100).toFixed(2)})`,
  };
}

function findPromo(code?: string | null): PromoDef | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  if (!upper) return null;
  const found = getEnvPromos().find((p) => p.code === upper && p.enabled);
  return found ?? null;
}

function resolveTaxRateForListing(listing: ListingDoc): number {
  const map = getTaxRateMap();
  const def = getTaxRateDefault();
  const exempt = getTaxExemptStates();
  const state = (listing as any)?.location?.state?.toUpperCase?.();
  if (state && exempt.has(state)) return 0;
  if (state && state in map) return map[state];
  return def || 0;
}

export async function computeQuote(input: QuoteInput): Promise<QuoteResult> {
  const { listing, start, end, promoCode } = input;

  if (!listing) throw new Error("LISTING_NOT_FOUND");
  if (!start || !end || !(start instanceof Date) || !(end instanceof Date) || end <= start) {
    throw new Error("INVALID_WINDOW");
  }

  const granularity = pickGranularity((listing as any).category);
  const dayMs = 24 * 60 * 60 * 1000;
  const durationMs = end.getTime() - start.getTime();

  // Your pricing model: baseDailyCents OR (baseHourlyCents * 24)
  const p: any = (listing as any).pricing || {};
  const daily =
    (p.baseDailyCents as number | undefined) ??
    ((p.baseHourlyCents as number | undefined) ?? 0) * 24;
  if (!daily || daily < 0) throw new Error("NO_PRICING");

  let nUnits = 0;
  let baseCents = 0;

  if (granularity === "hour") {
    // selection is hourly, billing is full days (ceil)
    nUnits = Math.max(1, Math.ceil(durationMs / dayMs)); // billableDays
    baseCents = nUnits * daily;
  } else {
    // day-based selection and billing (ceil to days)
    nUnits = Math.max(1, Math.ceil(durationMs / dayMs));
    baseCents = nUnits * daily;
  }

  const feeCents = Math.max(0, Math.floor(p.feeCents ?? 0));
  const depositCents = Math.max(0, Math.floor(p.depositCents ?? 0));
  const currency = p.currency ?? "usd";

  const promo = findPromo(promoCode);
  const promoBase = baseCents + feeCents;
  const { discountCents, label: promoLabel } = applyPromo(promoBase, promo);

  const taxableFee = getTaxableFee();
  const taxableSubtotalCents = baseCents + (taxableFee ? feeCents : 0) - discountCents;
  const taxRate = resolveTaxRateForListing(listing);
  const taxCents = Math.max(0, Math.round(taxableSubtotalCents * taxRate));

  const totalCents = baseCents + feeCents - discountCents + taxCents;

  const lineItems: LineItem[] = [
    { code: "BASE", label: `Base (${nUnits} day${nUnits > 1 ? "s" : ""})`, amountCents: baseCents },
  ];
  if (feeCents > 0) lineItems.push({ code: "FEE", label: "Platform fee", amountCents: feeCents });
  if (discountCents > 0)
    lineItems.push({ code: "PROMO", label: promoLabel ?? "Promo", amountCents: -discountCents });
  if (taxCents > 0)
    lineItems.push({
      code: "TAX",
      label: `Tax (${(taxRate * 100).toFixed(2)}%)`,
      amountCents: taxCents,
    });

  logger.info("pricing.computeQuote", {
    listingId: (listing as any)._id?.toString?.(),
    state: (listing as any)?.location?.state,
    granularity,
    nUnits,
    promoCode: promoCode ?? null,
    subtotalCents: baseCents + feeCents - discountCents,
    taxCents,
    totalCents,
  });

  return {
    currency,
    granularity,
    nUnits,
    baseCents,
    feeCents,
    discountCents,
    taxCents,
    depositCents,
    totalCents,
    lineItems,
  };
}
