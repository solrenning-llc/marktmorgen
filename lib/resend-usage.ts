/**
 * Read-only Resend send metrics for an exact UTC window; never admission.
 * Official contract: resend/resend-openapi, resend.yaml /emails/metrics
 * (checked November 1, 2026). Unlike /emails.created_at, sent measures sends
 * in the requested range, including sends scheduled from older records.
 */
import { RESEND_BASE } from "@/lib/email";
import { RESEND_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";

export type ResendUsage =
  | { ok: true; basis: "provider_sent_metric"; sent: number; from: string; through: string }
  | { ok: false; reason: "not_configured" | "unauthorized" | "provider" | "unknown" };

function dataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function ownArray(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
    copy.push(descriptor.value);
  }
  return copy;
}

/**
 * Requests one aggregate sent total, without dimensions or record pagination.
 * The provider must echo the exact window: clamping or changing it is unknown.
 * This is the provider's sent metric, not proven billing units or recipients.
 * Neither this metric nor account usage grants permission to send.
 */
export async function resendUsageSince(fromMs: number, throughMs = Date.now()): Promise<ResendUsage> {
  const key = process.env.RESEND_READ_API_KEY?.trim() || process.env.RESEND_API_KEY?.trim();
  if (!key) return { ok: false, reason: "not_configured" };
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(throughMs) ||
      fromMs < 0 || throughMs < fromMs || throughMs > 8_640_000_000_000_000) return { ok: false, reason: "unknown" };

  const from = new Date(fromMs).toISOString();
  const through = new Date(throughMs).toISOString();
  const query = new URLSearchParams({
    start_date: from, end_date: through, metrics: "sent", timezone: "UTC",
  });
  let result: { status: number; ok: boolean; raw: unknown; malformed: boolean };
  try {
    result = await timed(RESEND_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`${RESEND_BASE}/emails/metrics?${query}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        cache: "no-store",
        signal,
      });
      let raw: unknown = null;
      let malformed = false;
      if (response.ok) {
        try { raw = await response.json(); } catch { malformed = true; }
      }
      return { status: response.status, ok: response.ok, raw, malformed };
    });
  } catch {
    return { ok: false, reason: "provider" };
  }
  if (result.status === 401 || result.status === 403) return { ok: false, reason: "unauthorized" };
  if (!result.ok) return { ok: false, reason: "provider" };
  if (result.malformed) return { ok: false, reason: "unknown" };
  try {
    const metrics = dataRecord(result.raw);
    const requested = ownArray(metrics?.metrics, 1);
    const dimensions = ownArray(metrics?.dimensions, 0);
    const totals = dataRecord(metrics?.totals);
    const sent = whole(totals?.sent);
    if (!metrics || metrics.object !== "metrics" || metrics.start_date !== from ||
        metrics.end_date !== through || !requested || requested.length !== 1 ||
        requested[0] !== "sent" || !dimensions || !totals ||
        Object.keys(totals).length !== 1 || sent === null || "data" in metrics) {
      return { ok: false, reason: "unknown" };
    }
    return { ok: true, basis: "provider_sent_metric", sent, from, through };
  } catch {
    return { ok: false, reason: "unknown" };
  }
}

export type ResendUsageWindow = {
  used: number;
  limit: number | null;
  sent: number;
  received: number;
  resetsAt: string;
};

export type ResendAccountUsage =
  | { ok: true; daily: ResendUsageWindow; monthly: ResendUsageWindow }
  | { ok: false; reason: "not_configured" | "unauthorized" | "provider" | "unknown" };

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageWindow(value: unknown): ResendUsageWindow | null {
  const row = dataRecord(value);
  const used = whole(row?.used);
  const sent = whole(row?.sent);
  const received = whole(row?.received);
  const limit = row?.limit === null ? null : whole(row?.limit);
  const resetsAt = row?.resets_at;
  if (!row || used === null || sent === null || received === null || limit === null && row.limit !== null ||
      used !== sent + received || typeof resetsAt !== "string" || resetsAt.length > 64) return null;
  const reset = Date.parse(resetsAt);
  if (!Number.isSafeInteger(reset) || reset < 0 || new Date(reset).toISOString() !== resetsAt) return null;
  return { used, limit, sent, received, resetsAt };
}

/**
 * Reads Resend's authoritative daily and billing-period monthly account usage.
 * Monthly is not assumed to be a calendar month; used includes sent + received.
 * This is a comparison signal only: it requires a full-access read key and never grants
 * permission to send. The local atomic pre-send ceiling remains independent.
 */
export async function resendAccountUsage(): Promise<ResendAccountUsage> {
  const key = process.env.RESEND_READ_API_KEY?.trim() || process.env.RESEND_API_KEY?.trim();
  if (!key) return { ok: false, reason: "not_configured" };
  let result: { status: number; ok: boolean; raw: unknown; malformed: boolean };
  try {
    result = await timed(RESEND_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`${RESEND_BASE}/usage`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        cache: "no-store",
        signal,
      });
      let raw: unknown = null;
      let malformed = false;
      if (response.ok) {
        try { raw = await response.json(); } catch { malformed = true; }
      }
      return { status: response.status, ok: response.ok, raw, malformed };
    });
  } catch {
    return { ok: false, reason: "provider" };
  }
  if (result.status === 401 || result.status === 403) return { ok: false, reason: "unauthorized" };
  if (!result.ok) return { ok: false, reason: "provider" };
  if (result.malformed) return { ok: false, reason: "unknown" };
  try {
    const account = dataRecord(result.raw);
    const emails = dataRecord(account?.emails);
    const daily = usageWindow(emails?.daily);
    const monthly = usageWindow(emails?.monthly);
    if (!account || account.object !== "usage" || !emails || !daily || !monthly) {
      return { ok: false, reason: "unknown" };
    }
    return { ok: true, daily, monthly };
  } catch {
    return { ok: false, reason: "unknown" };
  }
}
