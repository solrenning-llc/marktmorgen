/**
 * Pre-orders, kept and handed over (the rules are in lib/preorder-rules.ts).
 *
 *   nl:wl:<store>:pre             hash    product → the day it is expected, while it takes pre-orders
 *   nl:pre:<store>:<product>      hash    checkout → Preorder: who paid, and what became of it; 400 days after its last change
 *   nl:pre:pi:<payment>           string  "<store>|<product>|<checkout>", so a refund finds its pre-order
 *   nl:pre:<store>:any            string  present once the store has taken a pre-order
 *   nl:pre:<store>:refunds        string  how far the refunds were read for pre-orders
 *   nl:pre:<store>:seen           set     refunds already handled
 *   nl:pre:jobs                   set     "<store>|<product>|<handle>": products put on sale with pre-orders to hand over
 *
 * <store> is the store's statsId, which stays through a change of handle.
 *
 * A pre-order's checkout hands over nothing by itself (lib/bundle-rules.ts,
 * deliveredIds). The day the product goes on sale it is handed over as a
 * gift is (lib/gifts.ts): written down under the buyer's address
 * (lib/imported-purchases.ts), so the list of purchases and the course open
 * it, and its buyer is emailed the way in. A refund in full, before or after,
 * takes it back.
 */
import { consentEmailLines } from "@/lib/digital-consent-email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { sendEmail } from "@/lib/email";
import { grantImported, importedKey } from "@/lib/imported-purchases";
import { onAccount } from "@/lib/stripe-account";
import { refundedInFull } from "@/lib/refunds";
import { canSell } from "@/lib/store-checkout";
import { type Listing, type Store, saleHandles, setPastBuyers, storeRef } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import { preorderWords } from "@/lib/buyer-words/preorder";
import { isSettled } from "@/lib/instant-pay";
import { formatMoney } from "@/lib/money";
import { type Preorder, keptDay, parsePreorder, preorderCounts, preorderOpen, preorderProblem } from "@/lib/preorder-rules";

const soonKey = (sid: string) => `nl:wl:${sid}:soon`;
const dayKey = (sid: string) => `nl:wl:${sid}:pre`;
const entriesKey = (sid: string, product: string) => `nl:pre:${sid}:${product}`;
export const piKey = (pi: string) => `nl:pre:pi:${pi}`;
const anyKey = (sid: string) => `nl:pre:${sid}:any`;
const anchorKey = (sid: string) => `nl:pre:${sid}:refunds`;
const seenKey = (sid: string) => `nl:pre:${sid}:seen`;
const giveKey = (session: string) => `nl:pre:give:${session}`;
const JOBS = "nl:pre:jobs";
/** How long a pre-order is kept after it was last changed: past any refund window, as a gift is. */
const KEPT_SECONDS = 400 * 86_400;
const keep = (sid: string, product: string): (string | number)[] => ["EXPIRE", entriesKey(sid, product), KEPT_SECONDS];
const now = () => Math.floor(Date.now() / 1000);

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const INTENT_ID = /^pi_[A-Za-z0-9]{8,255}$/;

// ------------------------------------------------------------------ the pages

export type SoonState = { soon: Set<string>; days: Map<string, string> };

/** The products coming soon, and the day each pre-ordered one is expected: one request, for the store page. */
export async function soonState(store: Store): Promise<SoonState> {
  if (!store.statsId || !isRedisConfigured()) return { soon: new Set(), days: new Map() };
  const [members, raw] = await redisPipeline([["SMEMBERS", soonKey(store.statsId)], ["HGETALL", dayKey(store.statsId)]]);
  return { soon: new Set(Array.isArray(members) ? (members as string[]) : []), days: daysOf(raw) };
}

/** One product: coming soon or not, and the day it is expected when it takes pre-orders. One request. */
export async function soonOne(store: Store, productId: string): Promise<{ soon: boolean; day: string | null }> {
  if (!store.statsId || !isRedisConfigured()) return { soon: false, day: null };
  const [member, day] = await redisPipeline([["SISMEMBER", soonKey(store.statsId), productId], ["HGET", dayKey(store.statsId), productId]]);
  return { soon: member === 1 || member === "1", day: keptDay(day) };
}

function daysOf(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const pairs: [string, unknown][] = [];
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([String(raw[i]), raw[i + 1]]);
  else if (raw && typeof raw === "object") pairs.push(...Object.entries(raw as Record<string, unknown>));
  for (const [product, value] of pairs) {
    const day = keptDay(value);
    if (day) out.set(product, day);
  }
  return out;
}

/**
 * The day a product's page offers a pre-order for, or null: coming soon,
 * expected on a day that has not passed, a product a pre-order can be, a
 * published one, on a store that can take a payment.
 */
export function preorderDay(store: Store, product: Listing, soon: boolean, day: string | null, nowMs = Date.now()): string | null {
  if (!soon || !day || !preorderOpen(day, nowMs)) return null;
  if (product.hidden || preorderProblem(product) !== null || !canSell(store)) return null;
  return day;
}

// ------------------------------------------------------------------ the studio

/** Sets the day a coming-soon product is expected, so it takes pre-orders; null stops taking them. */
export async function setExpectedDay(store: Store, productId: string, day: string | null): Promise<void> {
  if (!store.statsId) return;
  await redisPipeline([day ? ["HSET", dayKey(store.statsId), productId, day] : ["HDEL", dayKey(store.statsId), productId]]);
}

export type PreorderView = { day: string | null; waiting: number; given: number; refunded: number };

/** What the studio shows of each product's pre-orders. */
export async function preorderViews(store: Store, productIds: string[]): Promise<Record<string, PreorderView>> {
  const out: Record<string, PreorderView> = {};
  if (!store.statsId || !isRedisConfigured() || !productIds.length) return out;
  const sid = store.statsId;
  const rows = await redisPipeline([["HGETALL", dayKey(sid)], ...productIds.map((p) => ["HVALS", entriesKey(sid, p)])]);
  const days = daysOf(rows[0]);
  productIds.forEach((p, i) => {
    const raw = rows[i + 1];
    const entries = (Array.isArray(raw) ? raw : []).map(parsePreorder).filter((e): e is Preorder => e !== null);
    const day = days.get(p) ?? null;
    if (!day && entries.length === 0) return;
    out[p] = { day, ...preorderCounts(entries) };
  });
  return out;
}

/** How many of a product's pre-orders wait to be handed over. */
export async function waitingCount(store: Store, productId: string): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const [raw] = await redisPipeline([["HVALS", entriesKey(store.statsId, productId)]]);
  return preorderCounts((Array.isArray(raw) ? raw : []).map(parsePreorder).filter((e): e is Preorder => e !== null)).waiting;
}

/**
 * The product went on sale: its expected day is let go, and its pre-orders
 * still waiting are queued for the five-minute job to hand over
 * (runPreorderReleases).
 */
export async function queueRelease(store: Store, productId: string): Promise<void> {
  if (!store.statsId || !isRedisConfigured()) return;
  const waiting = await waitingCount(store, productId);
  await redisPipeline([
    ["HDEL", dayKey(store.statsId), productId],
    ...(waiting > 0 ? [["SADD", JOBS, `${store.statsId}|${productId}|${store.handle}`]] : []),
  ]);
}

// ------------------------------------------------------------------ one pre-order

export async function readPreorder(store: Store, productId: string, sessionId: string): Promise<Preorder | null> {
  if (!store.statsId || !isRedisConfigured() || !SESSION_ID.test(sessionId)) return null;
  const [raw] = await redisPipeline([["HGET", entriesKey(store.statsId, productId), sessionId]]);
  return parsePreorder(raw);
}

/** A person's pre-orders of these products and what became of them, for the copy of their data (619 [SZ3]). Only reads. */
export async function preordersOf(store: Store, productIds: string[], email: string): Promise<(Preorder & { product: string; checkout: string })[]> {
  if (!store.statsId || !productIds.length || !isRedisConfigured()) return [];
  const address = email.trim().toLowerCase();
  const replies = await redisPipeline(productIds.map((p) => ["HGETALL", entriesKey(store.statsId as string, p)]));
  return productIds.flatMap((product, i) => {
    const flat = Array.isArray(replies[i]) ? (replies[i] as unknown[]) : [];
    const out: (Preorder & { product: string; checkout: string })[] = [];
    for (let k = 0; k + 1 < flat.length; k += 2) {
      const entry = parsePreorder(flat[k + 1]);
      if (entry && entry.to.trim().toLowerCase() === address) out.push({ ...entry, product, checkout: String(flat[k]) });
    }
    return out;
  });
}

type Session = {
  id?: unknown;
  created?: unknown;
  status?: unknown;
  payment_status?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  payment_intent?: unknown;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: unknown } | null;
};

/** What a paid pre-order checkout says: its product, buyer and payment. Null for anything else. */
function readSession(store: Store, session: Session): { id: string; productId: string; email: string; at: number; pi: string } | null {
  const meta = session.metadata ?? {};
  if (meta.preorder !== "yes" || !saleHandles(store).has(meta.store ?? "")) return null;
  if (!isSettled(session)) return null;
  const id = typeof session.id === "string" ? session.id : "";
  const email = typeof session.customer_details?.email === "string" ? session.customer_details.email.trim() : "";
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent as { id?: unknown } | null)?.id;
  if (!SESSION_ID.test(id) || !email || !meta.product) return null;
  return { id, productId: meta.product, email, at: typeof session.created === "number" ? session.created : now(), pi: typeof pi === "string" && INTENT_ID.test(pi) ? pi : "" };
}

/** Writes a paid pre-order down, once. Returns it as it is kept. */
async function recordPreorder(store: Store, read: NonNullable<ReturnType<typeof readSession>>): Promise<Preorder> {
  const sid = store.statsId as string;
  const entry: Preorder = { to: read.email, at: read.at, pi: read.pi };
  const [, kept] = await redisPipeline([
    ["HSETNX", entriesKey(sid, read.productId), read.id, JSON.stringify(entry)],
    ["HGET", entriesKey(sid, read.productId), read.id],
    keep(sid, read.productId),
    ...(read.pi ? [["SET", piKey(read.pi), `${sid}|${read.productId}|${read.id}`, "EX", KEPT_SECONDS]] : []),
    ["SET", anyKey(sid), "1"],
  ]);
  return parsePreorder(kept) ?? entry;
}

/** What hands a pre-order over needs from the pages around it, passed in so this file imports none of them. */
export type HandOverDeps = {
  /** Where the store lives, for the links in the email (lib/purchase-email.ts storeBase). */
  base: string;
  from: string;
  ordersLink: (email: string) => Promise<string | null>;
  recordStart: (email: string, courseProductId: string, startSeconds: number) => Promise<void>;
};

export type HandOverOutcome = "given" | "already" | "skip";

/**
 * Hands one pre-order over, once: writes the product down under its buyer's
 * address (and a course's start, so its modules open on time for them),
 * marks it given, and emails the buyer the way in.
 */
export async function handOverPreorder(store: Store, product: Listing, sessionId: string, deps: HandOverDeps): Promise<HandOverOutcome> {
  if (!store.statsId || !isRedisConfigured()) return "skip";
  const sid = store.statsId;
  const [claimed] = await redisPipeline([["SET", giveKey(sessionId), "1", "NX", "EX", 300]]);
  if (claimed === null) return "already";
  try {
    const entry = await readPreorder(store, product.id, sessionId);
    if (!entry || entry.revoked) return "skip";
    if (entry.given) return "already";
    await grantImported(sid, `pre:${sessionId}`, [{ email: entry.to, productId: product.id, items: null }], entry.at, store.sid);
    if (!store.pastBuyers) await setPastBuyers(storeRef(store));
    if (product.course) await deps.recordStart(entry.to, product.id, now());
    await redisPipeline([["HSET", entriesKey(sid, product.id), sessionId, JSON.stringify({ ...entry, given: now() } satisfies Preorder)], keep(sid, product.id)]);

    await sendOut(store, product, entry.to, deps, `nimbus-preorder-out:${sessionId}`);
    return "given";
  } finally {
    await redisPipeline([["DEL", giveKey(sessionId)]]).catch(() => {});
  }
}

/** The email the day it comes out: it is theirs, and the way in. */
async function sendOut(store: Store, product: Listing, to: string, deps: HandOverDeps, idempotencyKey?: string): Promise<boolean> {
  const p = preorderWords(store.language);
  const g = givingWords(store.language);
  const link = product.course ? `${deps.base}/course/${product.id}` : ((await deps.ordersLink(to)) ?? `${deps.base}/orders`);
  return sendEmail({ meter: { by: "order" },
    from: deps.from,
    to,
    subject: p.outSubject(product.title).slice(0, 200),
    text: [
      p.outLead(product.title, store.name),
      "",
      ...(product.course ? [p.outCourse(link)] : [p.outOpen, link, "", g.link24(`${deps.base}/orders`)]),
      "",
      p.outQuestions(store.name),
    ].join("\n"),
    replyTo: store.email,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  }).catch((error) => {
    console.error("a pre-order's email failed", error);
    return false;
  });
}

/** The receipt: what was pre-ordered, what it cost, and the day it is expected. */
async function sendReceipt(store: Store, product: Listing, session: Session, to: string, reference: string, day: string | null, deps: HandOverDeps, idempotencyKey?: string): Promise<boolean> {
  const p = preorderWords(store.language);
  const amount = typeof session.amount_total === "number" ? session.amount_total : product.priceCents;
  const currency = typeof session.currency === "string" && session.currency ? session.currency : store.currency;
  const said = speech(store);
  return sendEmail({ meter: { by: "order" },
    from: deps.from,
    to,
    subject: p.receiptSubject(product.title).slice(0, 200),
    text: [
      p.receiptLead(store.name),
      "",
      p.receiptWhat(product.title),
      p.receiptPaid(formatMoney(amount, currency, said.lang.locale)),
      p.receiptRef(reference),
      ...consentEmailLines(store, session.metadata),
      "",
      day ? p.receiptWhen(said.date(Date.parse(`${day}T00:00:00Z`))) : p.receiptLater,
      "",
      p.receiptRefund(store.name),
    ].join("\n"),
    replyTo: store.email,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  }).catch((error) => {
    console.error("a pre-order's receipt failed", error);
    return false;
  });
}

export type PreorderConfirm = "sent" | "given" | "skip" | "failed";

/**
 * A paid pre-order, confirmed once (lib/purchase-email.ts, confirmPurchase):
 * written down, and its buyer sent a receipt with the day it is expected. A
 * product already on sale by then is handed over at once instead.
 */
export async function confirmPreorder(store: Store, session: Session, product: Listing, deps: HandOverDeps): Promise<PreorderConfirm> {
  if (!store.statsId || !isRedisConfigured()) return "skip";
  const read = readSession(store, session);
  if (!read || read.productId !== product.id) return "skip";
  await recordPreorder(store, read);
  const { soon, day } = await soonOne(store, product.id);
  if (!soon) {
    const outcome = await handOverPreorder(store, product, read.id, deps);
    return outcome === "skip" ? "skip" : "given";
  }
  const sent = await sendReceipt(store, product, session, read.email, read.id, day, deps, `nimbus-preorder:${read.id}`);
  return sent ? "sent" : "failed";
}

/**
 * Sends a pre-order's buyer their email again, when the creator asks from the
 * studio's list of sales: the receipt while it waits, the way in once it was
 * handed over. "refunded" once it was given back.
 */
export async function resendPreorder(store: Store, session: Session, product: Listing, deps: HandOverDeps): Promise<"sent" | "refunded" | "unknown" | "failed"> {
  const read = readSession(store, session);
  if (!read || read.productId !== product.id) return "unknown";
  const entry = (await readPreorder(store, product.id, read.id)) ?? (await recordPreorder(store, read));
  if (entry.revoked) return "refunded";
  if (entry.given) return (await sendOut(store, product, entry.to, deps)) ? "sent" : "failed";
  const { day } = await soonOne(store, product.id);
  return (await sendReceipt(store, product, session, read.email, read.id, day, deps)) ? "sent" : "failed";
}

// ------------------------------------------------------------------ the five-minute job

/**
 * Hands over what products put on sale still owe their pre-orders, until
 * `deadline`. Each pre-order's payment is read from Stripe first: one given
 * back in full is marked refunded and never handed over. Returns how many
 * were handed over.
 */
export async function runPreorderReleases(
  load: (handle: string) => Promise<Store | null>,
  readProduct: (store: Store, id: string) => Promise<Listing | null>,
  depsFor: (store: Store) => HandOverDeps,
  deadline: number,
): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const [members] = await redisPipeline([["SMEMBERS", JOBS]]);
  let given = 0;
  for (const member of Array.isArray(members) ? (members as string[]) : []) {
    if (Date.now() > deadline) break;
    const [sid, pid, handle] = member.split("|");
    const store = handle ? await load(handle) : null;
    const product = store && store.statsId === sid ? await readProduct(store, pid) : null;
    if (!store || !product || !store.stripeAccountId) {
      await redisPipeline([["SREM", JOBS, member]]);
      continue;
    }
    // Put back to "coming soon" since: it waits for its next release.
    const { soon } = await soonOne(store, pid);
    if (soon) {
      await redisPipeline([["SREM", JOBS, member]]);
      continue;
    }
    const [raw] = await redisPipeline([["HGETALL", entriesKey(sid, pid)]]);
    const pairs: [string, Preorder][] = [];
    if (Array.isArray(raw)) {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const entry = parsePreorder(raw[i + 1]);
        if (entry) pairs.push([String(raw[i]), entry]);
      }
    }
    const waiting = pairs.filter(([, e]) => !e.given && !e.revoked);
    const deps = depsFor(store);
    let left = 0;
    for (const [session, entry] of waiting) {
      if (Date.now() > deadline) {
        left += 1;
        continue;
      }
      try {
        if (entry.pi) {
          const payment = await onAccount("GET", store.stripeAccountId, `/payment_intents/${encodeURIComponent(entry.pi)}?expand[]=latest_charge`);
          if (refundedInFull(payment)) {
            await redisPipeline([["HSET", entriesKey(sid, pid), session, JSON.stringify({ ...entry, revoked: now() } satisfies Preorder)], keep(sid, pid)]);
            continue;
          }
        }
        const outcome = await handOverPreorder(store, product, session, deps);
        if (outcome === "given") given += 1;
        else if (outcome === "already") left += 1;
      } catch (error) {
        console.error("handing over a pre-order failed", store.handle, error);
        left += 1;
      }
    }
    if (left === 0) await redisPipeline([["SREM", JOBS, member]]);
  }
  return given;
}

/**
 * Takes back pre-orders whose payment was refunded in full: one already
 * handed over leaves its buyer's purchases and course; one still waiting is
 * marked so it never is. Reads the store's refunds since it last looked.
 * Returns how many changed.
 */
export async function revokeRefundedPreorders(
  store: Store,
  deadline: number,
  dropStart: (email: string, courseProductId: string) => Promise<void>,
): Promise<number> {
  if (!store.statsId || !store.stripeAccountId || !isRedisConfigured()) return 0;
  const sid = store.statsId;
  const [any, anchorRaw] = await redisPipeline([["GET", anyKey(sid)], ["GET", anchorKey(sid)]]);
  if (!any) return 0;
  const since = Math.max(0, (Number(anchorRaw) || now() - 7 * 86_400) - 300);
  let newest = Number(anchorRaw) || since;
  let revoked = 0;
  const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
  query.append("expand[]", "data.charge");
  const listed = await onAccount("GET", store.stripeAccountId, `/refunds?${query}`);
  const rows = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
  for (const refund of rows) {
    if (Date.now() >= deadline) return revoked;
    const id = typeof refund.id === "string" ? refund.id : "";
    const created = typeof refund.created === "number" ? refund.created : 0;
    const pi = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
    const charge = refund.charge as { refunded?: unknown } | null;
    newest = Math.max(newest, created);
    if (!id || !pi || refund.status !== "succeeded" || charge?.refunded !== true) continue;
    const [fresh, found] = await redisPipeline([["SADD", seenKey(sid), id], ["GET", piKey(pi)]]);
    if (Number(fresh) !== 1 || typeof found !== "string") continue;
    const [foundSid, productId, session] = found.split("|");
    if (foundSid !== sid || !productId || !session) continue;
    const [raw] = await redisPipeline([["HGET", entriesKey(sid, productId), session]]);
    const entry = parsePreorder(raw);
    if (!entry || entry.revoked) continue;
    if (entry.given) {
      // Only what this pre-order gave: a purchase of the same product given another way stays.
      const [rawGiven] = await redisPipeline([["HGET", importedKey(sid, entry.to), productId]]);
      const job = (() => {
        try {
          return String((JSON.parse(String(rawGiven)) as { job?: unknown }).job ?? "");
        } catch {
          return "";
        }
      })();
      if (job === `pre:${session}`) {
        await redisPipeline([["HDEL", importedKey(sid, entry.to), productId]]);
        await dropStart(entry.to, productId);
      }
    }
    await redisPipeline([["HSET", entriesKey(sid, productId), session, JSON.stringify({ ...entry, revoked: now() } satisfies Preorder)], keep(sid, productId)]);
    revoked += 1;
  }
  await redisPipeline([["SET", anchorKey(sid), String(newest)]]);
  return revoked;
}
