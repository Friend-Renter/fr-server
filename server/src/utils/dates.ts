/**
 * Date helpers — operate in UTC to avoid TZ weirdness.
 * Buckets:
 *  - hour bucket: "YYYY-MM-DDTHH" (e.g., 2025-09-01T06)
 *  - day bucket:  "YYYY-MM-DD"   (e.g., 2025-09-01)
 */

function pad2(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

export function toDate(d: Date | string | number): Date {
  return d instanceof Date ? d : new Date(d);
}

/** ISO UTC (without milliseconds) for logs/debug. */
export function isoUTC(d: Date | string | number): string {
  const dt = toDate(d);
  return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

/** Hour bucket (UTC): "YYYY-MM-DDTHH" */
export function hourBucket(d: Date | string | number): string {
  const dt = toDate(d);
  const y = dt.getUTCFullYear();
  const m = pad2(dt.getUTCMonth() + 1);
  const day = pad2(dt.getUTCDate());
  const h = pad2(dt.getUTCHours());
  return `${y}-${m}-${day}T${h}`;
}

/** Day bucket (UTC): "YYYY-MM-DD" */
export function dayBucket(d: Date | string | number): string {
  const dt = toDate(d);
  const y = dt.getUTCFullYear();
  const m = pad2(dt.getUTCMonth() + 1);
  const day = pad2(dt.getUTCDate());
  return `${y}-${m}-${day}`;
}

/** Enumerate buckets between two instants, inclusive of start, exclusive of end. */
export function enumerateBuckets(
  start: Date | string | number,
  end: Date | string | number,
  granularity: "hour" | "day"
): string[] {
  const s = toDate(start).getTime();
  const e = toDate(end).getTime();
  if (!(e > s)) return [];

  const out: string[] = [];
  if (granularity === "hour") {
    // align to hour
    let t = Math.floor(s / 3600000) * 3600000;
    while (t < e) {
      out.push(hourBucket(t));
      t += 3600000;
    }
  } else {
    // align to day (UTC)
    const d0 = new Date(s);
    const startUTC = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate());
    let t = startUTC;
    while (t < e) {
      out.push(dayBucket(t));
      t += 86400000;
    }
  }
  return out;
}

export function toUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
