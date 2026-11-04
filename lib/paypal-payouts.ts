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
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { canSeal, seal, unseal } from "@/lib/secret-box";
import { type Book, addPayout, payAddress, readBook } from "@/lib/affiliates";
import { type BatchLine, batchTotal, owedLines, payoutNote } from "@/lib/affiliate-payouts";
import { plainAmount } from "@/lib/money";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { readPendingPayoutBatches, type PendingPayoutBatch } from "@/lib/pending-payouts";
import { type Store, storeForId } from "@/lib/store";

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
  ) {
    super(`PayPal ${status} ${code}`);
  }
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
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const name = typeof data.name === "string" ? data.name : typeof data.error === "string" ? data.error : "UNKNOWN";
      throw new PayPalError(response.status, name);
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
      receiver: payAddress(line.affiliate).slice(0, 127),
      note,
      sender_item_id: line.affiliate.id.slice(0, 63),
    })),
  });
}

export type PayResult =
  | { ok: true; batch: string; people: number; cents: number }
  | { ok: false; reason: "not-connected" | "reconnect" | "nothing" | "refunds" | "funds" | "refused" | "busy" | "error" };

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
      let made: Record<string, unknown>;
      try {
        made = await call("POST", "/v1/payments/payouts", auth, batchBody(store, lines, senderBatchId), senderBatchId);
      } catch (error) {
        if (error instanceof PayPalError && error.code === "INSUFFICIENT_FUNDS") return { ok: false, reason: "funds" };
        if (error instanceof PayPalError && (error.status === 401 || error.status === 403)) return { ok: false, reason: "refused" };
        throw error;
      }
      const header = (made.batch_header ?? {}) as { payout_batch_id?: unknown };
      const batch = typeof header.payout_batch_id === "string" ? header.payout_batch_id : "";
      if (!BATCH_ID.test(batch)) return { ok: false, reason: "error" };
      const open: OpenBatch = { at: Date.now(), currency: store.currency, lines: lines.map((l) => ({ a: l.affiliate.id, c: l.cents })) };
      await redisPipeline([
        ["HSET", openKey(statsId), batch, JSON.stringify(open)],
        ["SADD", STORES, store.sid],
      ]);
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
  const auth = await bearer(store).catch(() => null);
  if (!auth) return { ...out, waiting: [...open.values()].reduce((n, b) => n + b.lines.length, 0) };
  const day = new Date().toISOString().slice(0, 10);
  for (const [batch, sent] of open) {
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

/** The daily job: every store with a batch still open. */
export async function settleAllPayPal(deadline: number): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const [sids] = await redisPipeline([["SMEMBERS", STORES]]);
  let done = 0;
  for (const sid of Array.isArray(sids) ? (sids as string[]) : []) {
    if (Date.now() >= deadline) break;
    const store = await storeForId(sid).catch(() => null);
    if (!store) {
      await redisPipeline([["SREM", STORES, sid]]);
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
