/**
 * Sending an endpoint's failed deliveries of an interval again, through the
 * API (POST /api/v1/hooks/resend with { endpoint, from, to }; 378 [TB4]
 * complement WG (b)). Each one is sent again by the same resendDelivery as
 * one asked for by id (lib/webhooks.ts): once, the same message with the same
 * event id, signed afresh, never one that was delivered, never a copy, never
 * one whose last copy was delivered or is still being tried, so a second
 * identical call sends nothing twice.
 *
 * What it costs, each part before it is done:
 *   - the deliveries are read as GET /api/v1/hooks/deliveries is (measured,
 *     their most set aside, settled at what was read: lib/api-read.ts,
 *     recentDeliveries), never their messages;
 *   - each one sent again takes its reads at their most (RESEND_WORK) from the
 *     store's API requests before it is read, and its try is one of the
 *     store's webhook deliveries for the month, taken before the endpoint is
 *     called;
 *   - at most RANGE_MAX_SENT a request, within the tests' ten a minute.
 * It stops, with the reason, at the first refusal that would refuse the rest
 * too (the month's API requests or deliveries, the minute's ten, the pause)
 * and at anything it cannot confirm; what was sent before stays sent and is
 * said. An interval longer than RANGE_MAX_DAYS, or one that ends before it
 * starts, is refused before anything is read.
 */
import { apiReadUnits, RESEND_WORK } from "@/lib/api-read-rules";
import { recentDeliveries } from "@/lib/api-read";
import { holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import type { Store } from "@/lib/store";
import { type DeliveryRow, resendDelivery, webhooksView } from "@/lib/webhooks";

/** The longest interval one call may send again: the log keeps deliveries up to seven days. */
export const RANGE_MAX_DAYS = 7;
/** The most deliveries one call sends again: the tests' and resends' limit a minute (lib/webhooks.ts, TESTS_PER_MINUTE). */
export const RANGE_MAX_SENT = 10;

export type RangeAsk = { endpoint: string; from: number; to: number };

/** The interval asked, read exactly: an endpoint id and two ISO times, `to` after `from`, at most RANGE_MAX_DAYS apart. */
export function readRange(body: Record<string, unknown>): RangeAsk | { error: string; message: string } {
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  if (!/^we_[0-9a-f]{16}$/.test(endpoint)) return { error: "invalid_id", message: "Send the endpoint's id as endpoint, such as we_0123456789abcdef." };
  const at = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN);
  const from = at(body.from);
  const to = at(body.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { error: "invalid_interval", message: "Send from and to as times, such as 2026-11-14T00:00:00Z." };
  if (to <= from) return { error: "invalid_interval", message: "to must be after from." };
  if (to - from > RANGE_MAX_DAYS * 86_400_000) return { error: "invalid_interval", message: `At most ${RANGE_MAX_DAYS} days at a time: deliveries are kept for seven days.` };
  return { endpoint, from, to };
}

export type RangeSent = { delivery: string; resent_from: string; event: string; delivered: boolean; status: number; error: string | null };
export type RangeAnswer = {
  sent: RangeSent[];
  /** Failed deliveries of the interval not sent again, each with why (one already sent again, one no longer heard, ...). */
  skipped: { delivery: string; reason: string }[];
  /** Why it stopped before the end, or null when it went through every one. */
  stopped: { error: string; message: string } | null;
  /** Failed deliveries of the interval not reached, past RANGE_MAX_SENT or after it stopped. */
  left: number;
  /** Deliveries of the log that could not be read (only when there are any): some of the interval may be among them. */
  unreadable?: number;
};

const SKIP_WORDS: Record<string, string> = {
  missing: "not_found",
  not_failed: "not_failed",
  not_heard: "not_heard",
  resent: "resent",
  too_large: "too_large",
};

/** The endpoint's failed deliveries of the interval, sent again, oldest first; a Response when the reading itself is refused. */
export async function resendRange(store: Store, ask: RangeAsk): Promise<RangeAnswer | Response | "no_endpoint"> {
  // A store without that endpoint reads nothing more and sends nothing.
  const view = await webhooksView(store, { log: false });
  if (!view.endpoints.some((e) => e.id === ask.endpoint)) return "no_endpoint";
  const listed = await recentDeliveries(store, ask.endpoint, (most) => holdMoreApi(store, most));
  if (listed instanceof Response) return listed;
  const due = listed.data
    .filter((row: DeliveryRow) => row.state === "failed" && row.endpoint === ask.endpoint && within(row.created_at, ask))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : 1));
  const answer: RangeAnswer = { sent: [], skipped: [], stopped: null, left: 0, ...(listed.unreadable ? { unreadable: listed.unreadable } : {}) };
  let i = 0;
  for (; i < due.length; i += 1) {
    if (answer.sent.length >= RANGE_MAX_SENT) break;
    const row = due[i];
    const refused = await takeMoreApi(store, apiReadUnits(RESEND_WORK));
    if (refused) {
      const said = (await refused.clone().json().catch(() => null)) as { error?: string; message?: string } | null;
      answer.stopped = { error: said?.error ?? "unavailable", message: said?.message ?? "It could not go on just now." };
      break;
    }
    const result = await resendDelivery(store, row.id, Date.now(), { view: false });
    if (result.ok) {
      const d = result.delivery;
      // A try by hand is delivered or failed; any other state cannot be said, so it stops here (rule 24).
      if (d.state !== "delivered" && d.state !== "failed") {
        answer.stopped = { error: "unavailable", message: `Whether ${row.id} reached the address could not be confirmed, so nothing after it was sent.` };
        i += 1;
        break;
      }
      answer.sent.push({ delivery: d.id, resent_from: row.id, event: d.eventId, delivered: d.state === "delivered", status: d.lastStatus, error: d.state === "delivered" ? null : d.lastError || null });
      continue;
    }
    const skip = SKIP_WORDS[result.reason];
    if (skip) {
      answer.skipped.push({ delivery: row.id, reason: skip });
      continue;
    }
    // A refusal that would refuse the rest too, or one that cannot be confirmed: nothing more is tried.
    answer.stopped =
      result.reason === "used" ? { error: "monthly_limit", message: result.message }
      : result.reason === "paused" ? { error: "paused", message: result.message }
      : result.reason === "limited" ? { error: "rate_limited", message: "At most ten tests and deliveries sent again a minute for a store. Send the rest in a minute." }
      : { error: "unavailable", message: "It could not go on just now. What was sent is listed; try the rest again in a moment." };
    break;
  }
  answer.left = due.length - i;
  return answer;
}

function within(createdAt: string, ask: RangeAsk): boolean {
  const at = Date.parse(createdAt);
  return Number.isFinite(at) && at >= ask.from && at <= ask.to;
}
