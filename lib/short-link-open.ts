/**
 * What it takes to open a short link (app/l/[code]/route.ts), so that what
 * an open costs always has a ceiling (Claude 5, 7 November 2026). The CDN
 * keeps an answer for one exact address only: a code nobody has, or a link
 * with a query of its own each time, reaches the function and the database.
 *
 *   - Before anything is read: one address may make this instance answer
 *     SHORT_LINK_OPENS_PER_ADDRESS opens in SHORT_LINK_ADDRESS_WINDOW_MS
 *     (lib/local-limit.ts, which costs nothing), and the open is counted in
 *     its hour for the whole site (SHORT_LINK_COUNT_COMMANDS). Past
 *     SHORT_LINK_UNPAID_PER_HOUR the open is refused, and this instance sends
 *     nothing more to the database until the hour turns. A count that cannot
 *     be read is not room to read: refused, and this instance waits
 *     SHORT_LINK_UNKNOWN_PAUSE_MS before counting again.
 *   - Once its store is found: the open is one of the store's public
 *     requests (lib/traffic.ts, takePublicRequest), so its plan pays for it,
 *     and it is taken off the hour's count (one DECR): only opens no store
 *     pays for use the hour. A store that cannot take one more request sends
 *     nobody on, and this instance answers that link from memory for
 *     SHORT_LINK_TIRED_MS without reading it again.
 *
 * So the opens that read and that no store pays for are at most
 * SHORT_LINK_UNPAID_PER_HOUR an hour for the whole site: each read follows a
 * count that was within it, and only a paid open is taken off. A refund that
 * fails leaves the open counted, never the other way. Every refusal says so
 * in plain words, sends nobody anywhere and is never kept by the CDN: it is
 * never shown as "this link ended". The company's month is priced in
 * tests/short-link-open-cap.test.ts and held there as a company cost that is
 * unknown, never zero (SHORT_LINK_UNPAID_COMPANY_COST, tests/plan-cost-registry.ts);
 * it is not a line of lib/llc-fixed-costs.ts, which feeds CURRENT_COMMERCIAL_TERMS.
 *
 *   nl:slink:open:<hour>   string   the hour's opens not paid by a store, kept two hours
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withinLocalLimit } from "@/lib/local-limit";
import { takePublicRequest } from "@/lib/traffic";
import { statusTime } from "@/lib/status-page";
import type { Store } from "@/lib/store";
import {
  HOUR_MS, SHORT_LINK_ADDRESS_WINDOW_MS, SHORT_LINK_OPEN_UNITS, SHORT_LINK_OPENS_PER_ADDRESS, SHORT_LINK_TIRED_KEPT,
  SHORT_LINK_TIRED_MS, SHORT_LINK_UNKNOWN_PAUSE_MS, SHORT_LINK_UNPAID_KEY_SECONDS, SHORT_LINK_UNPAID_PER_HOUR, hourOf, shortLinkUnpaidKey,
} from "@/lib/short-link-open-rules";

/** Room to read, with the hour's key the open was counted in; or why not. */
export type ShortLinkAdmission = { state: "open"; key: string } | { state: "address" | "hour" | "unknown" | "tired"; now: number };

/** This instance's memory: the hour it found used up, when it may count again after an unreadable count, and the links whose store was tired. */
let usedUpHour = -1;
let unknownUntil = 0;
const tired = new Map<string, number>();

/** Forgets this instance's memory (the tests, between cases). */
export function forgetShortLinkOpenMemory(): void {
  usedUpHour = -1;
  unknownUntil = 0;
  tired.clear();
}

/** Exactly the two answers asked for: the count, a whole number of at least 1, and EXPIRE's 1; null for anything else. */
function countOf(reply: unknown): number | null {
  if (!Array.isArray(reply)) return null;
  const length = Object.getOwnPropertyDescriptor(reply, "length");
  if (!length || !Object.hasOwn(length, "value") || length.value !== 2) return null;
  const count = Object.getOwnPropertyDescriptor(reply, "0");
  const expire = Object.getOwnPropertyDescriptor(reply, "1");
  if (!count || !Object.hasOwn(count, "value") || !Number.isSafeInteger(count.value) || count.value < 1) return null;
  if (!expire || !Object.hasOwn(expire, "value") || expire.value !== 1) return null;
  return count.value as number;
}

/** Whether this open may read the database, decided before anything is read. */
export async function admitShortLinkOpen(code: string, { address, now = Date.now() }: { address: string; now?: number }): Promise<ShortLinkAdmission> {
  const until = tired.get(code);
  if (until !== undefined) {
    if (until > now) return { state: "tired", now };
    tired.delete(code);
  }
  if (!withinLocalLimit("short-link-open", address, SHORT_LINK_OPENS_PER_ADDRESS, SHORT_LINK_ADDRESS_WINDOW_MS, now)) return { state: "address", now };
  if (usedUpHour === hourOf(now)) return { state: "hour", now };
  if (now < unknownUntil || !isRedisConfigured()) return { state: "unknown", now };
  const key = shortLinkUnpaidKey(now);
  let seen: number | null = null;
  try {
    seen = countOf(await redisPipeline([["INCR", key], ["EXPIRE", key, SHORT_LINK_UNPAID_KEY_SECONDS]]));
  } catch {
    seen = null;
  }
  if (seen === null) {
    unknownUntil = now + SHORT_LINK_UNKNOWN_PAUSE_MS;
    return { state: "unknown", now };
  }
  if (seen > SHORT_LINK_UNPAID_PER_HOUR) {
    usedUpHour = hourOf(now);
    return { state: "hour", now };
  }
  return { state: "open", key };
}

/**
 * The store pays for its link's open, as one of its public requests, and the
 * open comes off the hour's unpaid count. False when the store cannot take
 * it: the link is then answered from this instance's memory for a while.
 */
export async function payShortLinkOpen(store: Store, code: string, admission: { key: string }, now = Date.now()): Promise<boolean> {
  const paid = await takePublicRequest(store, "public", now, SHORT_LINK_OPEN_UNITS).catch(() => false);
  if (!paid) {
    if (tired.size >= SHORT_LINK_TIRED_KEPT) tired.delete(tired.keys().next().value as string);
    tired.set(code, now + SHORT_LINK_TIRED_MS);
    return false;
  }
  // Paid by the store: off the company's hour. A refund that fails leaves it counted.
  await redisPipeline([["DECR", admission.key]]).catch(() => undefined);
  return true;
}

const refusal = (status: number, text: string, retrySeconds: number) =>
  new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(Math.max(1, Math.ceil(retrySeconds))) },
  });

/** What a refused open says: never a redirect, never kept by the CDN. */
export function shortLinkRefusal(admission: Exclude<ShortLinkAdmission, { state: "open" }>): Response {
  if (admission.state === "address") {
    return refusal(429, "Too many links were opened from your network in the last few minutes. Try this link again in 10 minutes.", SHORT_LINK_ADDRESS_WINDOW_MS / 1000);
  }
  if (admission.state === "hour") {
    const next = (hourOf(admission.now) + 1) * HOUR_MS;
    return refusal(503, `Short links on this site were asked for too often this hour, so they are paused until ${statusTime(next)}. Try this link again then.`, (next - admission.now) / 1000);
  }
  if (admission.state === "tired") {
    return refusal(503, "The page this link leads to cannot be opened right now. Try this link again later.", SHORT_LINK_TIRED_MS / 1000);
  }
  return refusal(503, "This link could not be opened right now. Try again in a minute.", SHORT_LINK_UNKNOWN_PAUSE_MS / 1000);
}
