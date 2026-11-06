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
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { confirmLostRead, givenBack, lostCursorKey, lostDisputesOrRetry, refundRowKnown, rowGivesBack } from "@/lib/refunds";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
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
/** A write of one item (HDEL, HSET, EXPIRE or SADD of one field, member or key) answers 0 or 1; anything else is unknown (Codex Z). */
const oneWrite = (reply: unknown): boolean => reply === 0 || reply === 1;
/** Marks a row of the refunds job read; true only when Redis answered the SADD of one member with 0 or 1. */
const markRead = async (sid: string, id: string): Promise<boolean> => oneWrite(repliesFor(await redisPipeline([["SADD", seenKey(sid), id]]), 1)?.[0]);
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

/**
 * A product's pre-orders as kept, read exactly (CX-123 rule 24): one reply, a list of texts, each one a pre-order.
 * Anything else (no reply, a number, text, a member that is not text or not a pre-order) is unknown and throws,
 * never "nobody waits": a removal, a release of an empty product and the hand-over job decide on it.
 */
function exactPreorders(replies: unknown): Preorder[] {
  const values = stringList(repliesFor(replies, 1)?.[0]);
  if (!values) throw new UnknownReplyError("a product's pre-orders");
  return values.map((value) => {
    const entry = parsePreorder(value);
    if (!entry) throw new UnknownReplyError("a product's pre-orders");
    return entry;
  });
}

/**
 * How many of a product's pre-orders wait to be handed over. An unknown read throws UnknownReplyError: the product
 * route keeps the product (503), the waitlist route keeps an empty product coming soon (sweep APP3).
 */
export async function waitingCount(store: Store, productId: string): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  return preorderCounts(exactPreorders(await redisPipeline([["HVALS", entriesKey(store.statsId, productId)]]))).waiting;
}

/**
 * The product went on sale: its expected day is let go, and its pre-orders
 * still waiting are queued for the five-minute job to hand over
 * (runPreorderReleases). A count that cannot be read queues the job all the
 * same, never "nobody waits": the job reads the pre-orders again and keeps
 * itself in line until it can (sweep APP3). The job's SADD answered in
 * another shape throws, so the caller says it was not done.
 */
export async function queueRelease(store: Store, productId: string): Promise<void> {
  if (!store.statsId || !isRedisConfigured()) return;
  let waiting: number;
  try {
    waiting = await waitingCount(store, productId);
  } catch (error) {
    if (!(error instanceof UnknownReplyError)) throw error;
    console.error("could not read a product's pre-orders going on sale; its hand-over job is queued to read them again", error);
    waiting = Number.POSITIVE_INFINITY;
  }
  const queue = waiting > 0;
  const replies = await redisPipeline([
    ["HDEL", dayKey(store.statsId), productId],
    ...(queue ? [["SADD", JOBS, `${store.statsId}|${productId}|${store.handle}`]] : []),
  ]);
  if (queue && !oneWrite(repliesFor(replies, 2)?.[1])) throw new UnknownReplyError("a pre-order hand-over job");
}

// ------------------------------------------------------------------ one pre-order

export async function readPreorder(store: Store, productId: string, sessionId: string): Promise<Preorder | null> {
  if (!store.statsId || !isRedisConfigured() || !SESSION_ID.test(sessionId)) return null;
  const [raw] = await redisPipeline([["HGET", entriesKey(store.statsId, productId), sessionId]]);
  return parsePreorder(raw);
}

/**
 * Whether a pre-order is given, read exactly, for a run that found another
 * run's mark (Codex CX1 on #2726; CX-123 rule 24): one reply, the entry as
 * text, JSON with its buyer's address, and `given` a positive whole number of
 * seconds (true) or absent (false). Anything else is unknown and throws.
 */
async function givenExactly(sid: string, productId: string, sessionId: string): Promise<boolean> {
  const raw = repliesFor(await redisPipeline([["HGET", entriesKey(sid, productId), sessionId]]), 1)?.[0];
  let entry: unknown = null;
  try {
    entry = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    entry = null;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as { to?: unknown }).to !== "string" || !(entry as { to: string }).to) {
    throw new UnknownReplyError("a pre-order's entry");
  }
  const given = (entry as { given?: unknown }).given;
  if (given === undefined) return false;
  if (typeof given === "number" && Number.isSafeInteger(given) && given > 0) return true;
  throw new UnknownReplyError("a pre-order's entry");
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
  // The mark read exactly (lib/claim-mark.ts; CX-123 rules 24 and 25): somebody else's is "already"; an unknown one
  // hands nothing over and says so, as when Redis does not answer, and the next run tries again.
  const value = claimValue();
  const claimed = await claimMark(giveKey(sessionId), 300, value);
  if (claimed === "taken") {
    // Another run holds the mark: "already" only once the pre-order is given, as for a gift (lib/gifts.ts):
    // confirmPreorder answers "given" for it, so said while the other run may still fail, nothing would hand it over.
    if (await givenExactly(sid, product.id, sessionId)) return "already";
    throw new Error("another run is handing this pre-order over right now");
  }
  if (claimed === "unknown") throw new UnknownReplyError("a pre-order's giving mark");
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
    // Let go only while it still holds this run's value (releaseMark never throws).
    await releaseMark(giveKey(sessionId), value);
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
    // Read exactly (sweep APP3): an unknown reply hands nothing over and keeps the job in line for the next run,
    // never "nobody waits", which would take the job out of line with buyers who paid still waiting.
    const fields = stringList(repliesFor(await redisPipeline([["HGETALL", entriesKey(sid, pid)]]), 1)?.[0]);
    const pairs: [string, Preorder][] = [];
    let known = fields !== null && fields.length % 2 === 0;
    for (let i = 0; known && fields && i < fields.length; i += 2) {
      const entry = parsePreorder(fields[i + 1]);
      if (entry) pairs.push([fields[i], entry]);
      else known = false;
    }
    if (!known) {
      console.error("could not read a product's pre-orders to hand over; the job stays in line", store.handle);
      continue;
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
          // Refunded in full or lost to a dispute (lib/refunds.ts): never handed over.
          if (await givenBack(store.stripeAccountId, payment)) {
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
  // The refunds in their exact shape (Codex Q on #2724; CX-123 rule 24): a list of rows each as refundRowKnown()
  // reads it, with every field that decides whether money went back. Anything else leaves the read unsure, so the
  // anchor does not move past refunds that could not be read.
  const refundsKnown = Array.isArray(listed.data) && (listed.data as unknown[]).every(refundRowKnown);
  const refunds = refundsKnown ? (listed.data as Record<string, unknown>[]) : [];
  // A dispute closed as lost takes a pre-order back as a full refund does, whatever its amount (lib/refunds.ts, the
  // owner's rule of 4 November 2026; queue 388 [TB14]): read from Stripe's closing events, as lib/call-meetings.ts
  // does. A read that fails or does not reach the end keeps the place, so it is read again next run.
  const lost = await lostDisputesOrRetry(store.stripeAccountId, since, deadline, lostCursorKey("pre", sid));
  let unsure = !lost.complete || !refundsKnown;
  for (const refund of [...lost.rows, ...refunds]) {
    if (Date.now() >= deadline) return revoked;
    const id = typeof refund.id === "string" ? refund.id : "";
    const created = typeof refund.created === "number" ? refund.created : 0;
    const pi = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
    const charge = refund.charge as { refunded?: unknown } | null;
    const dispute = refund.object === "dispute";
    newest = Math.max(newest, created);
    if (dispute && id && !pi) {
      // No payment to look up: nothing of this store can be told from it, so it is read, and never holds the place back.
      if (!(await markRead(sid, id))) unsure = true;
      continue;
    }
    if (!id || !pi || !(dispute ? rowGivesBack(refund) : refund.status === "succeeded" && charge?.refunded === true)) continue;
    // Read before anything is marked (Codex Z on #2724; CX-123 rule 24): whether this row was handled, the payment's
    // pre-order and the pre-order itself, each in its exact shape. Unknown leaves the row unread and the read unsure,
    // and the next run asks again; nothing is marked read until it was handled.
    const looked = repliesFor(await redisPipeline([["SISMEMBER", seenKey(sid), id], ["GET", piKey(pi)]]), 2);
    const handled = countOf(looked?.[0]);
    const found = looked?.[1];
    if (!looked || handled === null || handled > 1 || (found !== null && typeof found !== "string")) {
      unsure = true;
      continue;
    }
    if (handled === 1) continue;
    const [foundSid, productId, session] = typeof found === "string" ? found.split("|") : [];
    if (foundSid === sid && productId && session) {
      const raw = repliesFor(await redisPipeline([["HGET", entriesKey(sid, productId), session]]), 1)?.[0];
      if (raw !== null && typeof raw !== "string") {
        unsure = true;
        continue;
      }
      const entry = parsePreorder(raw);
      if (entry && !entry.revoked) {
        if (entry.given) {
          // Only what this pre-order gave: a purchase of the same product given another way stays.
          const given = repliesFor(await redisPipeline([["HGET", importedKey(sid, entry.to), productId]]), 1)?.[0];
          if (given !== null && typeof given !== "string") {
            unsure = true;
            continue;
          }
          // No record: nothing of this pre-order is held as a purchase any more (null). A record that does not read,
          // or whose job is not text, is unknown, never "given another way" (rule 30, Claude 4 on #2781).
          let job = "";
          if (typeof given === "string") {
            let v: unknown;
            try {
              v = JSON.parse(given);
            } catch {
              v = undefined;
            }
            const named = v && typeof v === "object" && !Array.isArray(v) ? (v as { job?: unknown }).job : undefined;
            if (typeof named !== "string") {
              unsure = true;
              continue;
            }
            job = named;
          }
          if (job === `pre:${session}`) {
            // The course first, then the purchase (Codex G on #2781; rule 30): a course removal that fails keeps the
            // purchase, so the next run takes both away again; taking a course away twice is harmless.
            try {
              await dropStart(entry.to, productId);
            } catch (error) {
              console.error("taking a refunded pre-order's course away failed; tried again next run", error);
              unsure = true;
              continue;
            }
            // Each write confirmed in its exact shape before the next (Codex Z, review 5794703899; CX-123 rule 24):
            // a write left unknown marks nothing taken back or read and keeps the anchor, so the next run does it again.
            const removed = repliesFor(await redisPipeline([["HDEL", importedKey(sid, entry.to), productId]]), 1);
            if (!oneWrite(removed?.[0])) {
              unsure = true;
              continue;
            }
          }
        }
        const saved = repliesFor(await redisPipeline([["HSET", entriesKey(sid, productId), session, JSON.stringify({ ...entry, revoked: now() } satisfies Preorder)], keep(sid, productId)]), 2);
        if (!oneWrite(saved?.[0]) || !oneWrite(saved?.[1])) {
          unsure = true;
          continue;
        }
        revoked += 1;
      }
    }
    // Marked read once handled: a run that stops halfway leaves it to the next, which does the same again.
    if (!(await markRead(sid, id))) unsure = true;
  }
  // The lost disputes' place moves only once every one read was handled (lib/refunds.ts, confirmLostRead), and the
  // anchor with it: the closing events are read from the anchor, so it waits while they are not all read.
  if (!(await confirmLostRead(lost, seenKey(sid)))) unsure = true;
  else if (lost.complete && lost.resumed) newest = Math.min(newest, Math.max(lost.newest, since));
  if (!unsure) await redisPipeline([["SET", anchorKey(sid), String(newest)]]);
  return revoked;
}
