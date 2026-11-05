/**
 * A physical order marked as shipped (lib/shipping.ts): the creator presses
 * "Mark as shipped" on the sale in the studio, with a tracking link if they
 * have one, and the buyer gets one email saying it is on its way.
 *
 * The order is read from the creator's own Stripe account before anything is
 * written, so only a paid checkout of this store that was shipped can be
 * marked, and the email goes to the address that paid, not one the studio
 * sends. Marking it twice sends nothing more.
 *
 *   nl:ship:done:<session>   mark+tracking JSON: no expiry with pending mail,
 *                            400 days after a confirmed terminal outcome
 *                            (never-activated legacy mark: original 400 days)
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { onAccount } from "@/lib/stripe-account";
import { oneAddress, sendEmail, sendQueuedShipmentMail } from "@/lib/email";
import { CURRENT_SHIPMENT_MAIL_POLICY, enqueueShipmentMail, runShipmentMail, shipmentMailId, shipmentMailPolicy, shipmentMailStatus, type ShipmentMailRuntime, type ShipmentMailView } from "@/lib/shipment-mail-outbox";
import { fromCreator } from "@/lib/purchase-email";
import { saleHandles, type Store } from "@/lib/store";
import { isSettled } from "@/lib/instant-pay";
import { shippingWords } from "@/lib/buyer-words/shipping";
import { speech } from "@/lib/buyer-words";
import { shippingAddressOf, wasShipped } from "@/lib/shipping-address";

import { CURRENT_SHIPMENT_MAIL_LIFECYCLE, readTracking, readShippedRecord, type Shipped } from "@/lib/shipment-record";
export { readTracking };
export type { Shipped };

const SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const KEEP_SECONDS = 400 * 86_400;
export const doneKey = (session: string) => `nl:ship:done:${session}`;

/** When each of these orders was marked as shipped, by session id. */
export async function readShipped(sessions: string[]): Promise<Map<string, Shipped>> {
  const out = new Map<string, Shipped>();
  const ids = sessions.filter((id) => SESSION.test(id));
  if (!ids.length) return out;
  if (!isRedisConfigured()) throw new Error("Shipment status is unavailable");
  const rows = await redisPipeline(ids.map((id) => ["GET", doneKey(id)]));
  if (!Array.isArray(rows) || rows.length !== ids.length) {
    throw new Error("Shipment status reply is incomplete");
  }
  for (let i = 0; i < ids.length; i++) {
    const raw = rows[i];
    // Only an explicit missing key means the order has no shipment mark.
    if (raw === null) continue;
    if (typeof raw !== "string") throw new Error("Shipment status is unreadable");
    let value: Shipped | null;
    try {
      value = readShippedRecord(JSON.parse(raw));
    } catch {
      throw new Error("Shipment status is unreadable");
    }
    if (!value) throw new Error("Shipment status is unreadable");
    out.set(ids[i], value);
  }
  return out;
}

export type MarkResult = { ok: true; shipped: Shipped; emailed: boolean; mail?: ShipmentMailView } | { ok: false; reason: "unknown" | "tracking" | "stripe" | "mail_unavailable" };

function shipmentMessage(store: Store, row: Record<string, unknown>, tracking: string, email: string) {
  const meta = (row.metadata ?? {}) as Record<string, string>;
  const sw = shippingWords(store.language);
  const name = store.mail?.fromName || store.name;
  const title = (meta.title || "your order").slice(0, 200);
  const to = shippingAddressOf(row, speech(store).lang.locale);
  const text = [
    sw.shippedLead(title, name),
    ...(tracking ? ["", sw.track, tracking] : []),
    ...(to ? ["", sw.shippedTo, ...[to.name, ...to.lines].filter(Boolean)] : []),
    "",
    sw.shippedWhy(name),
  ].join("\n");
  return { from: fromCreator(store), to: email, subject: sw.shippedSubject(title).slice(0, 200), text, replyTo: store.email };
}

/** The pre-existing one-shot path only. This is not a durable email source. */
async function markNeverActivated(store: Store, session: string, row: Record<string, unknown>, shipped: Shipped): Promise<MarkResult> {
  let receipt: unknown;
  try { receipt = await redisPipeline([["SET", doneKey(session), JSON.stringify(shipped), "NX", "EX", KEEP_SECONDS]]); }
  catch { return { ok: false, reason: "unknown" }; }
  if (!Array.isArray(receipt) || receipt.length !== 1) return { ok: false, reason: "unknown" };
  if (receipt[0] === null) {
    try {
      const kept = (await readShipped([session])).get(session);
      return kept ? { ok: true, shipped: kept, emailed: false, mail: { state: "not_recorded", delayed: false } } : { ok: false, reason: "unknown" };
    } catch { return { ok: false, reason: "unknown" }; }
  }
  if (receipt[0] !== "OK") return { ok: false, reason: "unknown" };
  const email = (row.customer_details as { email?: unknown } | null | undefined)?.email;
  if (typeof email !== "string" || !oneAddress(email)) return { ok: true, shipped, emailed: false, mail: { state: "not_recorded", delayed: false } };
  const emailed = await sendEmail({ meter: { by: "order" }, ...shipmentMessage(store, row, shipped.tracking, email), idempotencyKey: `nimbus-shipped:${session}` }).catch(() => false);
  return { ok: true, shipped, emailed, mail: { state: emailed ? "accepted" : "not_recorded", delayed: false } };
}

/** Marks a shipped order as sent and tells its buyer, once. */
export async function markShipped(store: Store, session: string, rawTracking: unknown, nowSeconds = Math.floor(Date.now() / 1000), runtime: ShipmentMailRuntime = {}): Promise<MarkResult> {
  const lifecycle = runtime.lifecycle ?? CURRENT_SHIPMENT_MAIL_LIFECYCLE;
  if (!["never_activated", "active", "retired"].includes(lifecycle)) return { ok: false, reason: "unknown" };
  const authorizedAt = lifecycle === "active" ? (runtime.now ?? Date.now)() : 0;
  if (!SESSION.test(session) || !store.stripeAccountId || !isRedisConfigured()) return { ok: false, reason: "unknown" };
  const tracking = readTracking(rawTracking);
  if (tracking === null) return { ok: false, reason: "tracking" };
  let row: Record<string, unknown>;
  try {
    row = await onAccount("GET", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(session)}`);
  } catch {
    return { ok: false, reason: "stripe" };
  }
  const meta = (row.metadata ?? {}) as Record<string, string>;
  if (!saleHandles(store).has(meta.store ?? "") || !wasShipped(row) || !isSettled(row as never)) return { ok: false, reason: "unknown" };
  const shipped: Shipped = { at: nowSeconds, tracking };
  if (lifecycle === "never_activated") return markNeverActivated(store, session, row, shipped);
  // Existing marks never authorize another message, including legacy marks
  // whose earlier provider outcome was not recorded in the new outbox.
  try {
    const prior = (await readShipped([session])).get(session);
    if (prior) return { ok: true, shipped: prior, emailed: false,
      mail: await shipmentMailStatus(store.statsId, session, runtime) ?? { state: "acceptance_unknown", delayed: false } };
  } catch { return { ok: false, reason: "unknown" }; }
  if (lifecycle !== "active" || !shipmentMailPolicy(runtime.policy === undefined ? CURRENT_SHIPMENT_MAIL_POLICY : runtime.policy, (runtime.now ?? Date.now)())) return { ok: false, reason: "mail_unavailable" };
  const email = (row.customer_details as { email?: unknown } | null | undefined)?.email;
  if (typeof email !== "string" || !oneAddress(email)) {
    let receipt: unknown;
    try { receipt = await redisPipeline([["SET", doneKey(session), JSON.stringify(shipped), "NX", "EX", KEEP_SECONDS]]); }
    catch { return { ok: false, reason: "unknown" }; }
    if (!Array.isArray(receipt) || receipt.length !== 1 || receipt[0] !== "OK") return { ok: false, reason: "unknown" };
    return { ok: true, shipped, emailed: false, mail: { state: "not_recorded", delayed: false } };
  }
  const queued = await enqueueShipmentMail({ statsId: store.statsId, session, authorizedAt, shipped, message: shipmentMessage(store, row, tracking, email) }, runtime);
  if (!queued.ok) return { ok: false, reason: queued.reason === "full" ? "mail_unavailable" : "unknown" };
  // A simultaneous creator may have won with different tracking. Return the
  // actual immutable shipment, never this losing caller's proposed values.
  let kept: Shipped | undefined;
  try { kept = (await readShipped([session])).get(session); }
  catch { return { ok: false, reason: "unknown" }; }
  if (!kept) return { ok: false, reason: "unknown" };
  const current = (runtime.now ?? Date.now)();
  const sent = await runShipmentMail(current + 20_000, sendQueuedShipmentMail, runtime, shipmentMailId(store.statsId!, session));
  return { ok: true, shipped: kept, emailed: sent.accepted === 1,
    mail: sent.accepted === 1 ? { state: "accepted", delayed: false } : await shipmentMailStatus(store.statsId, session, runtime) ?? { state: "acceptance_unknown", delayed: false } };
}
