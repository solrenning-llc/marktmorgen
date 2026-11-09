/**
 * Paying affiliates from the creator's own PayPal, in one press or by itself
 * on payday, without the money ever passing through Marktmorgen.
 *
 *   nl:pp:<statsId>          the creator's PayPal app: its Client ID, its Secret sealed, auto-pay on or off
 *   nl:pp:open:<statsId>     batches sent and not yet settled: what each affiliate was sent
 *   nl:pp:item:<item>        a PayPal payout item already written into the book (once)
 *   nl:pp:stores             the stores with a batch still open, for the daily job
 *
 * How it works, and why this way. PayPal's Payouts API only ever sends money
 * from the balance of the account whose app makes the call. So the creator
 * makes the app, in their own PayPal Business account, with Payouts switched
 * on, and gives us its Client ID and Secret — the way FirstPromoter, Rewardful
 * and Affiliatly connect to a merchant's PayPal. Every payment then leaves the
 * creator's PayPal for the affiliate's, and nothing is held, pooled or moved
 * by us: we tell PayPal what the book says is owed, and PayPal does the rest
 * under the creator's own account and PayPal's own rules.
 *
 * The Secret is sealed before it is written (lib/secret-box.ts), never shown
 * again, and taken away with one press. The app can be made with Payouts and
 * nothing else, which is what the studio asks for.
 *
 * The book only says "paid" once PayPal does. A batch is sent; each affiliate
 * in it is "on its way" until PayPal reports the item: SUCCESS writes the
 * payout into the book, once; FAILED, RETURNED, BLOCKED, REFUNDED or REVERSED
 * leaves the commission owed, to be paid again; PENDING, UNCLAIMED and ONHOLD
 * stay on their way. An affiliate on their way is left out of every new batch
 * and file, so nobody is paid twice. Request bodies follow PayPal's published
 * OpenAPI description (payments_payouts_batch_v1).
 */
import { createHmac } from "node:crypto";
import { types } from "node:util";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { canSeal, deriveKey, seal, unseal } from "@/lib/secret-box";
import { type Book, addPayout, payAddress, readBook } from "@/lib/affiliates";
import { type BatchLine, batchTotal, owedLines, payoutNote } from "@/lib/affiliate-payouts";
import { plainAmount } from "@/lib/money";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { readPendingPayoutBatches, type PendingPayoutBatch } from "@/lib/pending-payouts";
import { repliesFor } from "@/lib/redis-reply";
import { type Store, storeForId, storeIdGone } from "@/lib/store";

/** Local tests may point this at a stand-in on 127.0.0.1; nothing else is taken. */
const PAYPAL_API = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.PAYPAL_API_BASE ?? "")
  ? (process.env.PAYPAL_API_BASE as string)
  : "https://api-m.paypal.com";

/** The scope PayPal grants an app with Payouts switched on (its OpenAPI description). */
export const PAYOUTS_SCOPE = "https://uri.paypal.com/payments/payouts";
const CLIENT_ID = /^[A-Za-z0-9_-]{20,128}$/;
const SECRET = /^[A-Za-z0-9_-]{20,128}$/;
const BATCH_ID = /^[A-Z0-9]{6,30}$/;
/** Statuses after which a payout item never changes again, for our purposes. */
const PAID = "SUCCESS";
const NOT_PAID = new Set(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED"]);
const TIMEOUT_MS = 20_000;

const linkKey = (statsId: string) => `nl:pp:${statsId}`;
const openKey = (statsId: string) => `nl:pp:open:${statsId}`;
const itemKey = (item: string) => `nl:pp:item:${item}`;
const STORES = "nl:pp:stores";
const context = (statsId: string) => `paypal-payouts|${statsId}`;

type Link = { client: string; secret: string; at: number; auto: boolean };
export type PayPalView = { client: string; at: number; auto: boolean; broken: boolean };
type OpenBatch = PendingPayoutBatch;
type Sent = OpenBatch["lines"][number];

async function readLink(store: Store): Promise<Link | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", linkKey(store.statsId)]]);
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Link;
    return typeof v.client === "string" && typeof v.secret === "string" ? v : null;
  } catch {
    return null;
  }
}

/** What the studio shows: never the Secret. */
export async function readPayPal(store: Store): Promise<PayPalView | null> {
  const link = await readLink(store);
  if (!link || !store.statsId) return null;
  const opened = unseal(link.secret, context(store.statsId));
  return { client: `${link.client.slice(0, 6)}…${link.client.slice(-4)}`, at: link.at, auto: link.auto, broken: !opened.ok };
}

class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** PayPal refused a sender_batch_id it already has (400, the batch exists). */
    readonly duplicate = false,
    /** The id of the batch PayPal's refusal links to, when it gives one and only one. */
    readonly original = "",
  ) {
    super(`PayPal ${status} ${code}`);
  }
}

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * PayPal's refusal of a sender_batch_id used in the last 30 days: a 400
 * whose details name the sender_batch_id as already there (PayPal's pages,
 * read through search on 05/11/2026; the developer pages themselves were not
 * reachable from this session).
 */
function duplicateOf(status: number, data: Record<string, unknown>): boolean {
  if (status !== 400 || !Array.isArray(data.details)) return false;
  return data.details.some((d) => record(d) &&
    (d.field === "sender_batch_id" || /sender_batch_id/i.test(String(d.issue ?? ""))) &&
    /already|duplicate/i.test(`${String(d.issue ?? "")} ${String(d.description ?? "")}`));
}

/** The one payout batch an answer links to (its links, or each detail's link), or "" when none or more than one. */
function linkedBatch(data: Record<string, unknown>): string {
  const hrefs: unknown[] = [];
  const take = (v: unknown) => {
    if (typeof v === "string") hrefs.push(v);
    else if (record(v)) hrefs.push(v.href);
    else if (Array.isArray(v)) v.forEach(take);
  };
  take(data.links);
  if (Array.isArray(data.details)) for (const d of data.details) if (record(d)) { take(d.link); take(d.links); }
  const ids = new Set<string>();
  for (const href of hrefs) {
    if (typeof href !== "string") continue;
    try {
      const id = /^\/v1\/payments\/payouts\/([A-Z0-9]{6,30})$/.exec(new URL(href).pathname)?.[1];
      if (id) ids.add(id);
    } catch {
      // Not a link: left out.
    }
  }
  return ids.size === 1 ? [...ids][0] : "";
}

async function call(method: "GET" | "POST", path: string, auth: string, body?: string | URLSearchParams, requestId?: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${PAYPAL_API}${path}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...(typeof body === "string" ? { "Content-Type": "application/json" } : body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      },
      body,
      cache: "no-store",
      signal: controller.signal,
    });
    const parsed: unknown = await response.json().catch(() => undefined);
    const object = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    const data = (object ? parsed : {}) as Record<string, unknown>;
    // A success whose answer is not a JSON object is not known (CX-123 rule 24): never read as an empty answer.
    if (response.ok && !object) throw new PayPalError(response.status, "UNREADABLE");
    if (!response.ok) {
      // PayPal's own error name, trimmed; an empty or blank one is no name (review of Codex G on #2681).
      const named = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
      const name = named(data.name) || named(data.error) || "UNKNOWN";
      throw new PayPalError(response.status, name, duplicateOf(response.status, data), linkedBatch(data));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function tokenFor(client: string, secret: string): Promise<{ token: string; scope: string }> {
  const basic = `Basic ${Buffer.from(`${client}:${secret}`).toString("base64")}`;
  const data = await call("POST", "/v1/oauth2/token", basic, new URLSearchParams({ grant_type: "client_credentials" }));
  return { token: typeof data.access_token === "string" ? data.access_token : "", scope: typeof data.scope === "string" ? data.scope : "" };
}

async function bearer(store: Store): Promise<string | null> {
  const link = await readLink(store);
  if (!link || !store.statsId) return null;
  const opened = unseal(link.secret, context(store.statsId));
  if (!opened.ok) return null;
  const { token } = await tokenFor(link.client, opened.value);
  return token ? `Bearer ${token}` : null;
}

export type ConnectResult = { ok: true } | { ok: false; reason: "format" | "refused" | "no-payouts" | "seal" | "error" };

/** Checks the app with PayPal — a live app, with Payouts on — and keeps it, the Secret sealed. */
export async function connectPayPal(store: Store, client: string, secret: string): Promise<ConnectResult> {
  if (!store.statsId || !isRedisConfigured()) return { ok: false, reason: "error" };
  if (!CLIENT_ID.test(client) || !SECRET.test(secret)) return { ok: false, reason: "format" };
  if (!canSeal()) return { ok: false, reason: "seal" };
  try {
    const { token, scope } = await tokenFor(client, secret);
    if (!token) return { ok: false, reason: "refused" };
    if (!scope.split(/\s+/).includes(PAYOUTS_SCOPE)) return { ok: false, reason: "no-payouts" };
  } catch (error) {
    if (error instanceof PayPalError && (error.status === 401 || error.status === 400)) return { ok: false, reason: "refused" };
    console.error("checking a PayPal app failed", error);
    return { ok: false, reason: "error" };
  }
  const before = await readLink(store);
  const link: Link = { client, secret: seal(secret, context(store.statsId)), at: Date.now(), auto: before?.auto ?? false };
  await redisPipeline([["SET", linkKey(store.statsId), JSON.stringify(link)]]);
  return { ok: true };
}

export async function disconnectPayPal(store: Store): Promise<void> {
  if (!store.statsId) return;
  await redisPipeline([["DEL", linkKey(store.statsId)]]);
}

export async function setAutoPay(store: Store, on: boolean): Promise<boolean> {
  const link = await readLink(store);
  if (!link || !store.statsId) return false;
  await redisPipeline([["SET", linkKey(store.statsId), JSON.stringify({ ...link, auto: on })]]);
  return true;
}

async function readOpen(statsId: string): Promise<Map<string, OpenBatch>> {
  return readPendingPayoutBatches(await redisPipeline([["HGETALL", openKey(statsId)]]));
}

/** The affiliates with a PayPal payment on its way, left out of every new batch and file. */
export async function onTheirWay(store: Store): Promise<Set<string>> {
  if (!store.statsId || !isRedisConfigured()) throw new Error("Pending payout records are unavailable");
  const open = await readOpen(store.statsId);
  return new Set([...open.values()].flatMap((b) => b.lines.map((l) => l.a)));
}

/** Who can be paid now: owed, cleared, and not already on their way through PayPal. */
export function payableLines(book: Book, away: Set<string>): BatchLine[] {
  return owedLines(book).filter((line) => !away.has(line.affiliate.id));
}

/** The address a line is paid to, as the body sends it. */
const receiverOf = (line: BatchLine) => payAddress(line.affiliate).slice(0, 127);
/**
 * Its fingerprint, kept with a batch on its way instead of the address (review of Codex H2 on #2681): an HMAC
 * under a key derived from the server's own secret, so it cannot be turned back by guessing addresses (Revisor 2's
 * privacy note). Empty when there is no secret: then the batch keeps none and a retry is left for a manual check.
 */
const RECEIVER_PRINT_LABEL = "paypal-payout-receiver/v1";
function receiverPrint(address: string): string {
  const key = deriveKey(RECEIVER_PRINT_LABEL);
  return key ? createHmac("sha256", key).update(address).digest("hex") : "";
}

/** The body PayPal is sent for one batch (payments_payouts_batch_v1, create_payout_request). */
export function batchBody(store: Store, lines: BatchLine[], senderBatchId: string): string {
  const note = payoutNote(store);
  return JSON.stringify({
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      recipient_type: "EMAIL",
      email_subject: `You have a payment from ${store.name}`.slice(0, 255),
      email_message: note,
    },
    items: lines.map((line) => ({
      recipient_type: "EMAIL",
      amount: { currency: store.currency.toUpperCase(), value: plainAmount(line.cents, store.currency) },
      // The PayPal address the affiliate chose on their page, or the one they joined with.
      receiver: receiverOf(line),
      note,
      sender_item_id: line.affiliate.id.slice(0, 63),
    })),
  });
}

export type PayResult =
  | { ok: true; batch: string; people: number; cents: number }
  /**
   * "unknown": the batch was sent and PayPal's answer is not known, so it may have been paid; nobody in it is sent again.
   * "pending": nothing was paid now (not sent, or refused by PayPal), but the batch's "?" entry could not be confirmed
   * removed, so the settling may still send it (settleUnknown); its people stay on their way. "error" and PayPal's own
   * refusals ("funds", "refused") are said only once nothing will be sent.
   */
  | { ok: false; reason: "not-connected" | "reconnect" | "nothing" | "refunds" | "funds" | "refused" | "busy" | "error" | "unknown" | "pending" };

/**
 * Whether PayPal's answer to a batch says it was not made: a 4xx (other than
 * a timeout) is the request refused. Anything else (no answer, the line
 * dropped, the wait run out, a 5xx, a success that cannot be read or names
 * no batch) may have made it.
 */
function refusedBeforeMade(error: unknown): boolean {
  // Only PayPal's own refusal: a 4xx that names its error. One without a name (or unreadable) is not known.
  return error instanceof PayPalError && error.status >= 400 && error.status < 500 && error.status !== 408 && !error.duplicate &&
    error.code !== "UNKNOWN" && error.code !== "UNREADABLE";
}

/**
 * Writes a batch PayPal named under its id, then, only once Redis said it
 * holds it, takes the "?" field away (review of Codex G on #2681, GRAVE).
 * If the first write is not confirmed, the "?" field stays: its people stay
 * on their way, and the settling sends the same request again, which PayPal
 * answers with this same batch. If only the second fails, both stay; the
 * settling then finds the "?" one, gets the same batch back and writes it
 * again, and an item already written into the book is never written twice
 * (nl:pp:item). True when the batch is held under its id.
 *
 * The batch is held with the sender_batch_id it was sent under (`s`), and the
 * "?" entry is taken away only on Redis's exact word (CX-123 rule 24, Claude 5
 * on 09/11/2026). A removal that fails or answers in another shape is logged
 * and leaves the "?" entry beside the batch: the settling then knows it by `s`
 * and drops it without sending PayPal the money request again (heldUnknowns),
 * and nobody in it is counted twice meanwhile.
 */
async function promoteBatch(statsId: string, field: string, batch: string, entry: OpenBatch): Promise<boolean> {
  const sender = field.slice(UNKNOWN_BATCH_PREFIX.length);
  const held: unknown = await redisPipeline([["HSET", openKey(statsId), batch, JSON.stringify({ at: entry.at, currency: entry.currency, lines: entry.lines, s: sender })]]).catch(() => null);
  if (!Array.isArray(held) || held.length !== 1 || (held[0] !== 0 && held[0] !== 1)) return false;
  if (!(await removedExactly(statsId, field))) {
    console.error("a PayPal batch is held under its id, but its '?' entry could not be confirmed removed; the settling drops it", batch);
  }
  return true;
}

/** Takes one open-batch entry away: true only when Redis answers the HDEL with exactly 0 or 1 (rule 24). */
async function removedExactly(statsId: string, field: string): Promise<boolean> {
  const gone = repliesFor(await redisPipeline([["HDEL", openKey(statsId), field]]).catch(() => null), 1);
  return gone !== null && (gone[0] === 0 || gone[0] === 1);
}

/**
 * The "?" entries whose own request PayPal named and which are held under that batch's id (`s`): left behind by a
 * removal that was not confirmed (promoteBatch). They are that batch, never another payment: never sent again, never
 * counted twice.
 */
function heldUnknowns(open: Map<string, OpenBatch>): Set<string> {
  const senders = new Set<string>();
  for (const [id, batch] of open) if (!id.startsWith(UNKNOWN_BATCH_PREFIX) && batch.s) senders.add(`${UNKNOWN_BATCH_PREFIX}${batch.s}`);
  return new Set([...open.keys()].filter((id) => senders.has(id)));
}

/** At most one try a day at a batch whose answer was not known. */
export const UNKNOWN_RETRY_EVERY_MS = 86_400_000;
/** After this long without PayPal's word, it needs the creator's own check and is not tried again. */
export const UNKNOWN_MANUAL_AFTER_MS = 7 * 86_400_000;
const unknownMonthKey = (month: string) => `nl:pp:unk:month:${month}`;
const MONTH_SECONDS = 400 * 86_400;
type UnknownCount = "unknown" | "settled" | "manual";

/** One of the month's counts for the owner's report: numbers only, no store, no person. Never throws. */
async function countUnknown(what: UnknownCount, now = Date.now()): Promise<void> {
  const key = unknownMonthKey(new Date(now).toISOString().slice(0, 7));
  await redisPipeline([["HINCRBY", key, what, 1], ["EXPIRE", key, MONTH_SECONDS]]).catch(() => undefined);
}

/**
 * The month's counts of PayPal payout batches whose answer was not known, for
 * the owner's monthly report (lib/company-margin-report.ts, 465 [MR2], wired
 * by its owner): sent with no known answer, settled by sending the same
 * request again, and left for the creator's own check. Null when not read.
 */
export async function payoutUnknownMonth(month: string): Promise<Record<UnknownCount, number> | null> {
  if (!/^\d{4}-\d{2}$/.test(month) || !isRedisConfigured()) return null;
  try {
    // One answer, to the one command sent, of exactly three counts (review of Codex G on #2681), each read only as
    // the reply's own data: an inherited slot or a getter is not known and is never run (Codex H2 on #2681).
    const own = (list: unknown, length: number): unknown[] | null => {
      // A Proxy is refused before anything is asked of it, so none of its traps runs (Codex G on #2681).
      if (types.isProxy(list) || !Array.isArray(list) || list.length !== length) return null;
      const out: unknown[] = [];
      for (let i = 0; i < length; i += 1) {
        const slot = Object.getOwnPropertyDescriptor(list, String(i));
        if (!slot || !Object.hasOwn(slot, "value")) return null;
        out.push(slot.value);
      }
      return out;
    };
    const reply = own(await redisPipeline([["HMGET", unknownMonthKey(month), "unknown", "settled", "manual"]]), 1);
    const raw = reply ? own(reply[0], 3) : null;
    if (!raw) return null;
    const [unknown, settled, manual] = raw.map((v) => (v === null ? 0 : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : NaN));
    return [unknown, settled, manual].every(Number.isSafeInteger) ? { unknown, settled, manual } : null;
  } catch {
    return null;
  }
}

/** People in batches whose answer is not known: being asked again, or left for the creator's own check. */
export async function paypalChecks(store: Store): Promise<{ checking: number; manual: number }> {
  if (!store.statsId || !isRedisConfigured()) throw new Error("Pending payout records are unavailable");
  const out = { checking: 0, manual: 0 };
  const open = await readOpen(store.statsId);
  // A "?" entry left beside the batch PayPal named for it is that known batch, not one being checked.
  const known = heldUnknowns(open);
  for (const [id, batch] of open) {
    if (!id.startsWith(UNKNOWN_BATCH_PREFIX) || known.has(id)) continue;
    if (batch.m === 1) out.manual += batch.lines.length;
    else out.checking += batch.lines.length;
  }
  return out;
}

/** The open batch's field for a batch sent whose answer is not known yet: "?" and our own sender_batch_id. */
export const UNKNOWN_BATCH_PREFIX = "?";

/**
 * Sends everyone owed and cleared, from the creator's PayPal, as one batch.
 * The book is read again here, so a refund made a moment ago is counted.
 */
export async function payWithPayPal(store: Store): Promise<PayResult> {
  if (!store.statsId || !isRedisConfigured()) return { ok: false, reason: "error" };
  const statsId = store.statsId;
  const link = await readLink(store);
  if (!link) return { ok: false, reason: "not-connected" };
  try {
    return await withLock(`nl:pp:${statsId}:lock`, 120, 5_000, async (): Promise<PayResult> => {
      const book = await readBook(store);
      // What is owed is not known while refunds could not be read from Stripe.
      if (!book.refundsChecked) return { ok: false, reason: "refunds" };
      const lines = payableLines(book, await onTheirWay(store));
      if (!lines.length) return { ok: false, reason: "nothing" };
      const auth = await bearer(store);
      if (!auth) return { ok: false, reason: "reconnect" };
      const senderBatchId = `nl-${statsId.slice(0, 12)}-${Date.now().toString(36)}`;
      const open: OpenBatch = { at: Date.now(), currency: store.currency, lines: lines.map((l) => {
        const r = receiverPrint(receiverOf(l));
        return { a: l.affiliate.id, c: l.cents, ...(r ? { r } : {}) };
      }) };
      // Written down as on its way BEFORE the creator's money is asked for (CX-123 rule 24): whatever PayPal answers,
      // or if it never answers, nobody in it can be put in another batch or payout file. Redis must say it holds it.
      const unknownField = `${UNKNOWN_BATCH_PREFIX}${senderBatchId}`;
      let held: unknown = null;
      try {
        held = await redisPipeline([
          ["HSET", openKey(statsId), unknownField, JSON.stringify(open)],
          ["SADD", STORES, store.sid],
        ]);
      } catch (error) {
        // No answer is not "not written": Redis may have applied it before the answer was lost.
        console.error("writing a PayPal batch down before sending it got no answer", error);
      }
      if (!Array.isArray(held) || held.length !== 2 || held[0] !== 1 || (held[1] !== 0 && held[1] !== 1)) {
        // Not known to be held: nothing is sent now. The field is taken out again if it was written, and "nothing was
        // sent" is said only once Redis confirms that (rule 24): a "?" entry still there would be sent by the settling
        // (settleUnknown), so the creator is told the batch may still go and not to pay its people another way.
        if (await removedExactly(statsId, unknownField)) return { ok: false, reason: "error" };
        console.error("a PayPal batch's '?' entry could be confirmed neither written nor removed; the settling may still send it");
        return { ok: false, reason: "pending" };
      }
      let made: Record<string, unknown>;
      try {
        made = await call("POST", "/v1/payments/payouts", auth, batchBody(store, lines, senderBatchId), senderBatchId);
      } catch (error) {
        if (!refusedBeforeMade(error)) {
          console.error("a PayPal batch was sent and its answer is not known; kept on its way", error);
          await countUnknown("unknown");
          return { ok: false, reason: "unknown" };
        }
        // PayPal refused it: nothing was made, so its people are owed again, but only once Redis confirms the "?" entry
        // gone (rule 24). While it may still be there, the settling sends the same request again (settleUnknown), which
        // PayPal may pay, so the creator is never told nothing will go (pre-review of 09/11/2026).
        if (!(await removedExactly(statsId, unknownField))) {
          console.error("PayPal refused a batch, but its '?' entry could not be confirmed removed; the settling may still send it");
          return { ok: false, reason: "pending" };
        }
        if (error instanceof PayPalError && error.code === "INSUFFICIENT_FUNDS") return { ok: false, reason: "funds" };
        if (error instanceof PayPalError && (error.status === 401 || error.status === 403)) return { ok: false, reason: "refused" };
        throw error;
      }
      const header = (made.batch_header ?? {}) as { payout_batch_id?: unknown };
      const batch = typeof header.payout_batch_id === "string" ? header.payout_batch_id : "";
      // Made, but which batch is not said: kept on its way under our own id, never sent again.
      if (!BATCH_ID.test(batch)) {
        await countUnknown("unknown");
        return { ok: false, reason: "unknown" };
      }
      // PayPal named the batch: it is made. Held under its id, or, if Redis did not confirm that, still under "?",
      // which the settling sends again with the same key (PayPal gives this batch back).
      await promoteBatch(statsId, unknownField, batch, open);
      return { ok: true, batch, people: lines.length, cents: batchTotal(lines) };
    });
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, reason: "busy" };
    console.error("paying affiliates with PayPal failed", error);
    return { ok: false, reason: "error" };
  }
}

export type Settled = { paid: number; released: number; waiting: number };

/**
 * Reads every open batch from PayPal and writes into the book what PayPal
 * says was paid — once per item, whoever asks first. Items PayPal could not
 * pay go back to owed; the rest stay on their way.
 */
export async function settlePayPal(store: Store): Promise<Settled> {
  const out: Settled = { paid: 0, released: 0, waiting: 0 };
  if (!store.statsId || !isRedisConfigured()) return out;
  const statsId = store.statsId;
  const open = await readOpen(statsId);
  if (!open.size) {
    await redisPipeline([["SREM", STORES, store.sid]]);
    return out;
  }
  // A "?" entry left beside the batch PayPal named for it (promoteBatch's removal not confirmed) is dropped here, with
  // nothing asked of PayPal: the batch itself is read below. Until Redis confirms the removal, its people stay on their
  // way, the store stays in the daily job, and the batch is not settled either, so its id (`s`) still names the entry
  // on the next run and it is never taken for a batch whose answer is not known.
  const undropped = new Set<string>();
  for (const field of heldUnknowns(open)) {
    const people = open.get(field)?.lines.length ?? 0;
    open.delete(field);
    if (!(await removedExactly(statsId, field))) {
      console.error("a PayPal '?' entry already held under its batch id could not be confirmed removed; tried again next run", field);
      undropped.add(field);
      out.waiting += people;
    }
  }
  const auth = await bearer(store).catch(() => null);
  if (!auth) return { ...out, waiting: out.waiting + [...open.values()].reduce((n, b) => n + b.lines.length, 0) };
  const day = new Date().toISOString().slice(0, 10);
  for (const [batch, sent] of open) {
    // A batch whose answer is not known has no PayPal id to read: the same request is sent again, at most once a
    // day, and its people stay on their way whatever comes back (decision C1-20261105-1830-C5-1, option A).
    if (batch.startsWith(UNKNOWN_BATCH_PREFIX)) {
      await settleUnknown(store, batch, sent, auth).catch((error) => console.error("sending an unknown PayPal batch again failed", error));
      out.waiting += sent.lines.length;
      continue;
    }
    if (sent.s && undropped.has(`${UNKNOWN_BATCH_PREFIX}${sent.s}`)) {
      out.waiting += sent.lines.length;
      continue;
    }
    const statusOf = new Map<string, { status: string; item: string }>();
    let batchStatus = "";
    try {
      for (let page = 1; page <= 10; page += 1) {
        const data = await call("GET", `/v1/payments/payouts/${encodeURIComponent(batch)}?page=${page}&page_size=1000&total_required=true`, auth);
        batchStatus = String((data.batch_header as { batch_status?: unknown } | undefined)?.batch_status ?? "");
        const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
        for (const item of items) {
          const detail = (item.payout_item ?? {}) as { sender_item_id?: unknown };
          const aff = typeof detail.sender_item_id === "string" ? detail.sender_item_id : "";
          if (aff) statusOf.set(aff, { status: String(item.transaction_status ?? ""), item: String(item.payout_item_id ?? "") });
        }
        const pages = Number(data.total_pages) || 1;
        if (page >= pages) break;
      }
    } catch (error) {
      console.error("reading a PayPal batch failed", error);
      out.waiting += sent.lines.length;
      continue;
    }
    const still: Sent[] = [];
    for (const line of sent.lines) {
      const got = statusOf.get(line.a);
      const status = batchStatus === "DENIED" || batchStatus === "CANCELED" ? "FAILED" : got?.status ?? "PENDING";
      if (status === PAID && got?.item) {
        const [fresh] = await redisPipeline([["SET", itemKey(got.item), batch, "NX", "EX", 400 * 86_400]]);
        if (fresh !== null) {
          await addPayout(store, { aff: line.a, cents: line.c, currency: sent.currency, date: day, reference: `PayPal ${got.item}` });
          out.paid += 1;
        }
      } else if (NOT_PAID.has(status)) {
        out.released += 1;
      } else {
        still.push(line);
      }
    }
    if (still.length) {
      await redisPipeline([["HSET", openKey(statsId), batch, JSON.stringify({ ...sent, lines: still })]]);
      out.waiting += still.length;
    } else {
      await redisPipeline([["HDEL", openKey(statsId), batch]]);
    }
  }
  if (!out.waiting) await redisPipeline([["SREM", STORES, store.sid]]);
  return out;
}

/** Marks a batch whose answer is not known for the creator's own check, once, and counts it. */
async function needsManualCheck(statsId: string, field: string, sent: OpenBatch): Promise<"manual"> {
  if (sent.m === 1) return "manual";
  await redisPipeline([["HSET", openKey(statsId), field, JSON.stringify({ ...sent, m: 1 })]]);
  await countUnknown("manual");
  return "manual";
}

/**
 * One batch whose answer was not known, sent again with the SAME
 * sender_batch_id and PayPal-Request-Id. PayPal gives back the batch the
 * first request made, or makes it now if the first never reached it; either
 * way there is one. A refusal that the sender_batch_id already exists is a
 * batch sent: its id is kept when PayPal links it, and otherwise it is left
 * for the creator's own check. Anything else leaves it on its way, to be
 * tried again tomorrow; after UNKNOWN_MANUAL_AFTER_MS it is not tried again.
 * Never sent under a new key, never paid twice.
 */
async function settleUnknown(store: Store, field: string, seen: OpenBatch, auth: string): Promise<"settled" | "waiting" | "manual"> {
  const statsId = store.statsId as string;
  const now = Date.now();
  if (seen.m === 1) return "manual";
  if (now - seen.at >= UNKNOWN_MANUAL_AFTER_MS) return needsManualCheck(statsId, field, seen);
  if (seen.t !== undefined && now - seen.t < UNKNOWN_RETRY_EVERY_MS) return "waiting";
  return withLock(`nl:pp:${statsId}:lock`, 120, 5_000, async () => {
    // Read again under the payment's own lock: a press or another settling may have moved it.
    const fresh = await readOpen(statsId);
    const sent = fresh.get(field);
    if (!sent || sent.m === 1) return sent ? "manual" : "waiting";
    // Held under PayPal's id since the settling read it (its "?" removal not confirmed): never sent again; the next
    // run drops the entry (heldUnknowns).
    if (heldUnknowns(fresh).has(field)) return "waiting";
    if (sent.t !== undefined && now - sent.t < UNKNOWN_RETRY_EVERY_MS) return "waiting";
    // The same request may make the batch now, if the first never reached PayPal, so it is sent only while the book
    // still owes every line in it (review of Codex G on #2681, second GRAVE). Refunds that cannot be read: not known,
    // wait (no try counted). A line no longer owed in full (refunded since, or the affiliate gone or no longer
    // approved), or a store whose currency changed: it cannot be told whether the first request paid it, so it is
    // left for the creator's own check and never sent.
    const book = await readBook(store);
    if (!book.refundsChecked) return "waiting";
    const rows = new Map(book.rows.map((row) => [row.affiliate.id, row]));
    const lines: BatchLine[] = [];
    for (const line of sent.lines) {
      const row = rows.get(line.a);
      if (!row || row.affiliate.status !== "approved" || row.payable < line.c || sent.currency !== store.currency) return needsManualCheck(statsId, field, sent);
      const again: BatchLine = { affiliate: row.affiliate, cents: line.c };
      // The same recipient or none (review of Codex H2 on #2681, GRAVE): if the affiliate's PayPal address changed
      // since the first request, or the batch kept no fingerprint of it, the retry could pay someone else.
      if (!line.r || receiverPrint(receiverOf(again)) !== line.r) return needsManualCheck(statsId, field, sent);
      lines.push(again);
    }
    // The try is counted before it is made, so a run that stops halfway never tries twice in a day.
    const tried: unknown = await redisPipeline([["HSET", openKey(statsId), field, JSON.stringify({ ...sent, t: now })]]);
    // HSET answers 0 for a field it changed (1 only if it was gone, which the read under the lock just ruled out).
    if (!Array.isArray(tried) || tried.length !== 1 || (tried[0] !== 0 && tried[0] !== 1)) return "waiting";
    const senderBatchId = field.slice(UNKNOWN_BATCH_PREFIX.length);
    let batch = "";
    try {
      const made = await call("POST", "/v1/payments/payouts", auth, batchBody(store, lines, senderBatchId), senderBatchId);
      const header = (made.batch_header ?? {}) as { payout_batch_id?: unknown };
      batch = typeof header.payout_batch_id === "string" ? header.payout_batch_id : "";
    } catch (error) {
      if (!(error instanceof PayPalError && error.duplicate)) return "waiting";
      // PayPal already has it: sent. Its id when the refusal links it; otherwise the creator's own check.
      if (!BATCH_ID.test(error.original)) return needsManualCheck(statsId, field, { ...sent, t: now });
      batch = error.original;
    }
    if (!BATCH_ID.test(batch)) return "waiting";
    if (!(await promoteBatch(statsId, field, batch, sent))) return "waiting";
    await countUnknown("settled");
    return "settled";
  });
}

/** The daily job: every store with a batch still open. */
export async function settleAllPayPal(deadline: number): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const [sids] = await redisPipeline([["SMEMBERS", STORES]]);
  let done = 0;
  for (const sid of Array.isArray(sids) ? (sids as string[]) : []) {
    if (Date.now() >= deadline) break;
    let store: Store | null;
    try {
      store = await storeForId(sid);
    } catch (error) {
      // Not read (rule 24): never "gone". A store with a batch still open stays in the daily job, and its affiliates
      // are settled on a later day; only a store whose id key is gone leaves the set.
      console.error("a PayPal store's record could not be read; it is tried again next run", error);
      continue;
    }
    if (!store) {
      // storeForId also answers null for an id key of another shape or an owner record that came back cut, so null alone
      // is not "gone": only an EXISTS of the id key that is exactly 0 (storeIdGone) takes the store off the daily job.
      if (await storeIdGone(sid).catch(() => false)) await redisPipeline([["SREM", STORES, sid]]);
      continue;
    }
    await settlePayPal(store).catch((error) => console.error("settling PayPal payouts failed", error));
    done += 1;
  }
  return done;
}

/** Whether this store pays by itself on payday. */
export async function paysAutomatically(store: Store): Promise<boolean> {
  return Boolean((await readLink(store))?.auto);
}
