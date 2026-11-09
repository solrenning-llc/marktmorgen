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
import { type SendOutcome, sendEmailOutcome } from "@/lib/email";
import { grantImported, importedKey } from "@/lib/imported-purchases";
import { onAccount } from "@/lib/stripe-account";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { confirmLostRead, givenBack, lostCursorKey, lostDisputesOrRetry, refundRowKnown, rowGivesBack } from "@/lib/refunds";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { canSell } from "@/lib/store-checkout";
// On its own line, so open pull requests that change the redis-reply import above still merge cleanly.
import { listSlots } from "@/lib/redis-reply";
import { type Listing, type Store, saleHandles, setPastBuyers, storeRef } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import { preorderWords } from "@/lib/buyer-words/preorder";
import { isSettled } from "@/lib/instant-pay";
import { formatMoney } from "@/lib/money";
import { type Preorder, keptDay, parsePreorder, preorderCounts, preorderJob, preorderOpen, preorderProblem, readPreorderJob } from "@/lib/preorder-rules";

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

/**
 * `partial` is set when some member of the coming-soon set could not be read: the products read stay coming soon,
 * and whether any other product is coming soon is unknown (CX-123 rule 24), so a page draws no way to buy it.
 */
export type SoonState = { soon: Set<string>; days: Map<string, string>; partial?: true };

/**
 * True only when the product is known not to be coming soon: not in the read set, and the set read whole. While the
 * read is `partial`, a product outside the read set is unknown (CX-123 rule 24), so it is never "not coming soon": a
 * caller that sells, lists or sends it to Stripe leaves it out.
 */
export function knownNotSoon(state: SoonState, productId: string): boolean {
  return !state.partial && !state.soon.has(productId);
}

function knownSoonMember(raw: unknown): boolean {
  if (raw === 1 || raw === "1") return true;
  if (raw === 0 || raw === "0") return false;
  throw new UnknownReplyError("coming-soon membership");
}

/**
 * The products coming soon, and the day each pre-ordered one is expected: one request, for the store page. A reply
 * that is not a list is unknown, never "none coming soon" (CX-123 rule 24): it throws, and each page then draws no way
 * to buy. A list with a member that is not a product id keeps the ones that are, marked `partial`. A day that cannot
 * be read only takes its pre-order away (preorderDay).
 */
export async function soonState(store: Store): Promise<SoonState> {
  if (!store.statsId || !isRedisConfigured()) return { soon: new Set(), days: new Map() };
  const replies = repliesFor(await redisPipeline([["SMEMBERS", soonKey(store.statsId)], ["HGETALL", dayKey(store.statsId)]]), 2);
  if (!replies) throw new UnknownReplyError("coming-soon products");
  const slots = listSlots(replies[0]);
  if (!slots) throw new UnknownReplyError("coming-soon products");
  const members = slots.filter((member): member is string => typeof member === "string");
  const days = daysOf(replies[1]);
  return members.length === slots.length ? { soon: new Set(members), days } : { soon: new Set(members), days, partial: true };
}

/** One product: coming soon or not, and the day it is expected when it takes pre-orders. One request. */
export async function soonOne(store: Store, productId: string): Promise<{ soon: boolean; day: string | null }> {
  if (!store.statsId || !isRedisConfigured()) return { soon: false, day: null };
  const replies = repliesFor(await redisPipeline([["SISMEMBER", soonKey(store.statsId), productId], ["HGET", dayKey(store.statsId), productId]]), 2);
  if (!replies) throw new UnknownReplyError("coming-soon product");
  const day = replies[1];
  if (day !== null && typeof day !== "string") throw new UnknownReplyError("coming-soon day");
  return { soon: knownSoonMember(replies[0]), day: keptDay(day) };
}

/** One exact membership read for callers that do not need the pre-order day. */
export async function isComingSoon(store: Store, productId: string): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const replies = repliesFor(await redisPipeline([["SISMEMBER", soonKey(store.statsId), productId]]), 1);
  if (!replies) throw new UnknownReplyError("coming-soon product");
  return knownSoonMember(replies[0]);
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
 * How many of a product's pre-orders wait to be handed over. Read exactly (CX-123 rule 24): an answer in another
 * shape throws UnknownReplyError, never "none waiting" (a product removed while paid pre-orders wait, a release never
 * queued); a record that does not read counts as waiting, since it may be a paid one.
 */
export async function waitingCount(store: Store, productId: string): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const read = repliesFor(await redisPipeline([["HVALS", entriesKey(store.statsId, productId)]]), 1);
  const values = read ? stringList(read[0]) : null;
  if (!values) throw new UnknownReplyError("a product's pre-orders");
  const entries = values.map(parsePreorder);
  const unread = entries.filter((e) => e === null).length;
  return preorderCounts(entries.filter((e): e is Preorder => e !== null)).waiting + unread;
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

/**
 * One pre-order's entry, read exactly for the hand-over (Codex C2 on #2963; CX-123 rule 24): one reply; null is a
 * confirmed absence; an entry that parses is the entry. Anything else (no reply, a hole, one too many, another type,
 * text that does not parse) throws, so the release job keeps it and the next run asks again, never "skip".
 */
async function readPreorderExact(sid: string, productId: string, sessionId: string): Promise<Preorder | null> {
  const replies = repliesFor(await redisPipeline([["HGET", entriesKey(sid, productId), sessionId]]), 1);
  if (!replies) throw new UnknownReplyError("a pre-order's entry");
  const [raw] = replies;
  if (raw === null) return null;
  const entry = parsePreorder(raw);
  if (!entry) throw new UnknownReplyError("a pre-order's entry");
  return entry;
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
function readSession(store: Store, session: Session): { id: string; productId: string; email: string; at: number; pi: string; ship: boolean } | null {
  const meta = session.metadata ?? {};
  if (meta.preorder !== "yes" || !saleHandles(store).has(meta.store ?? "")) return null;
  if (!isSettled(session)) return null;
  const id = typeof session.id === "string" ? session.id : "";
  const email = typeof session.customer_details?.email === "string" ? session.customer_details.email.trim() : "";
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent as { id?: unknown } | null)?.id;
  if (!SESSION_ID.test(id) || !email || !meta.product) return null;
  return { id, productId: meta.product, email, at: typeof session.created === "number" ? session.created : now(), pi: typeof pi === "string" && INTENT_ID.test(pi) ? pi : "", ship: meta.ship === "yes" };
}

/**
 * Writes a paid pre-order down, once. Returns it as it is kept. Every reply is read exactly (CX-123 rule 24; Claude 5
 * on #2963): HSETNX and EXPIRE answer 0 or 1, HGET the entry as kept, each SET "OK". Anything else throws
 * UnknownReplyError, never "recorded": a receipt for an entry that does not exist, or a "skip" on sale, would leave
 * the paid pre-order never handed over. confirmPreorderOnce then lets its mark go and the webhook is retried; HSETNX
 * keeps the first entry, so the retry records it once.
 */
async function recordPreorder(store: Store, read: NonNullable<ReturnType<typeof readSession>>): Promise<Preorder> {
  const sid = store.statsId as string;
  const entry: Preorder = { to: read.email, at: read.at, pi: read.pi, ship: read.ship };
  const commands: (string | number)[][] = [
    ["HSETNX", entriesKey(sid, read.productId), read.id, JSON.stringify(entry)],
    ["HGET", entriesKey(sid, read.productId), read.id],
    keep(sid, read.productId),
    ...(read.pi ? [["SET", piKey(read.pi), `${sid}|${read.productId}|${read.id}`, "EX", KEPT_SECONDS]] : []),
    ["SET", anyKey(sid), "1"],
  ];
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  const kept = replies && oneWrite(replies[0]) && oneWrite(replies[2]) && replies.slice(3).every((r) => r === "OK") ? parsePreorder(replies[1]) : null;
  if (!kept) throw new UnknownReplyError("a paid pre-order's record");
  return kept;
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
    if (!SESSION_ID.test(sessionId)) return "skip";
    const entry = await readPreorderExact(sid, product.id, sessionId);
    if (!entry || entry.revoked) return "skip";
    if (entry.given) {
      // Given by an earlier run: the way in is asked for again under the SAME idempotency key, which the senders
      // keep (Amazon's once-only mark, Resend's key and receipt), so an email already sent is not sent or billed
      // again, and one that run never reached (it stopped between the mark and the email) still goes out.
      await sendOut(store, product, entry.to, deps, `nimbus-preorder-out:${sessionId}`);
      return "already";
    }
    // Whether it ships goes with the grant, which outlives the entry (Claude 1's H on #2827; lib/preorder-rules.ts).
    await grantImported(sid, preorderJob(sessionId, entry.ship), [{ email: entry.to, productId: product.id, items: null }], entry.at, store.sid);
    if (!store.pastBuyers) await setPastBuyers(storeRef(store));
    if (product.course) await deps.recordStart(entry.to, product.id, now());
    // The way in is emailed once the grant stands and BEFORE the "given" mark is written (Codex P on #3077): a mark
    // that Redis applied but whose answer was lost (the transport threw) would otherwise leave the pre-order given and
    // never emailed, since a retry stops at "given". Its idempotency key makes a retry's email the same one.
    await sendOut(store, product, entry.to, deps, `nimbus-preorder-out:${sessionId}`);
    // The "given" mark read exactly (rule 30 of Claude 5's finding on #2963): HSET and EXPIRE of one field answer 0 or
    // 1. On anything else the grant and the email above stand; it throws, never "given": the caller retries, and the
    // retry finds it given or marks it.
    const marked = repliesFor(await redisPipeline([["HSET", entriesKey(sid, product.id), sessionId, JSON.stringify({ ...entry, given: now() } satisfies Preorder)], keep(sid, product.id)]), 2);
    if (!marked || !oneWrite(marked[0]) || !oneWrite(marked[1])) throw new UnknownReplyError("a pre-order's given mark");
    return "given";
  } finally {
    // Let go only while it still holds this run's value (releaseMark never throws).
    await releaseMark(giveKey(sessionId), value);
  }
}

/** The email the day it comes out: it is theirs, and the way in. */
async function sendOut(store: Store, product: Listing, to: string, deps: HandOverDeps, idempotencyKey?: string): Promise<SendOutcome> {
  const p = preorderWords(store.language);
  const g = givingWords(store.language);
  const link = product.course ? `${deps.base}/course/${product.id}` : ((await deps.ordersLink(to)) ?? `${deps.base}/orders`);
  return sendEmailOutcome({ meter: { by: "order" },
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
    // Thrown after the request may have reached the sender: not known, never "not sent" (rule 30).
    console.error("a pre-order's email failed", error);
    return "uncertain" as const;
  });
}

/** The receipt: what was pre-ordered, what it cost, and the day it is expected. */
async function sendReceipt(store: Store, product: Listing, session: Session, to: string, reference: string, day: string | null, deps: HandOverDeps, idempotencyKey?: string): Promise<SendOutcome> {
  const p = preorderWords(store.language);
  const amount = typeof session.amount_total === "number" ? session.amount_total : product.priceCents;
  const currency = typeof session.currency === "string" && session.currency ? session.currency : store.currency;
  const said = speech(store);
  return sendEmailOutcome({ meter: { by: "order" },
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
    return "uncertain" as const;
  });
}

/**
 * "uncertain": the receipt's send is not known (a timeout, a 5xx, a network
 * error after the request may have reached the sender), so it may have
 * arrived: its confirmation mark is kept as for a sent one
 * (lib/purchase-email.ts confirmPreorderOnce lets it go only on "failed"),
 * so it is never sent twice (9 November 2026, rule 30).
 */
export type PreorderConfirm = "sent" | "given" | "skip" | "failed" | "uncertain";

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
  return sent === "refused" ? "failed" : sent;
}

/**
 * Sends a pre-order's buyer their email again, when the creator asks from the
 * studio's list of sales: the receipt while it waits, the way in once it was
 * handed over. "refunded" once it was given back. "uncertain" when the
 * sender's answer is not known: it may still arrive, so the studio says to
 * check before sending again (lib/purchase-email.ts ResendOutcome).
 */
export async function resendPreorder(store: Store, session: Session, product: Listing, deps: HandOverDeps): Promise<"sent" | "refunded" | "unknown" | "failed" | "uncertain"> {
  const read = readSession(store, session);
  if (!read || read.productId !== product.id) return "unknown";
  const entry = (await readPreorder(store, product.id, read.id)) ?? (await recordPreorder(store, read));
  if (entry.revoked) return "refunded";
  const sent = entry.given
    ? await sendOut(store, product, entry.to, deps)
    : await sendReceipt(store, product, session, read.email, read.id, (await soonOne(store, product.id)).day, deps);
  return sent === "refused" ? "failed" : sent;
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
  const read = repliesFor(await redisPipeline([["SMEMBERS", JOBS]]), 1);
  const members = read ? stringList(read[0]) : null;
  if (!members) throw new UnknownReplyError("the products with pre-orders to hand over");
  let given = 0;
  for (const member of members) {
    if (Date.now() > deadline) break;
    // One job that cannot be read (a listing that does not read throws) is kept for the next run, never holding up
    // the others.
    try {
      given += await releaseJob(member, load, readProduct, depsFor, deadline);
    } catch (error) {
      console.error("a product's pre-orders could not be handed over; kept for the next run", member, error);
    }
  }
  return given;
}

/**
 * One job of runPreorderReleases. Paid pre-orders (CX-123 rule 24; Claude 4's Stripe hand-over audit): the job is let
 * go only on a confirmed reading, every pre-order handed over or refunded, or the product put back to coming soon
 * (queueRelease queues it again). Pre-orders read in another shape throw; a store or product not found, a store
 * without its Stripe account, or a pre-order record that does not read keep the job and are said. Returns how many
 * were handed over.
 */
async function releaseJob(
  member: string,
  load: (handle: string) => Promise<Store | null>,
  readProduct: (store: Store, id: string) => Promise<Listing | null>,
  depsFor: (store: Store) => HandOverDeps,
  deadline: number,
): Promise<number> {
  const [sid, pid, handle] = member.split("|");
  if (!sid || !pid || !handle) {
    console.error("a pre-order job that does not read is kept", member);
    return 0;
  }
  const read = repliesFor(await redisPipeline([["HGETALL", entriesKey(sid, pid)]]), 1);
  const flat = read ? stringList(read[0]) : null;
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("a product's pre-orders");
  const pairs: [string, Preorder][] = [];
  let unread = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const entry = parsePreorder(flat[i + 1]);
    if (entry) pairs.push([flat[i], entry]);
    else unread += 1;
  }
  if (unread) console.error(`${unread} pre-order record(s) do not read; the job is kept`, member);
  const waiting = pairs.filter(([, e]) => !e.given && !e.revoked);
  // Confirmed: nothing left to hand over.
  if (!waiting.length && !unread) {
    await redisPipeline([["SREM", JOBS, member]]);
    return 0;
  }
  const store = await load(handle);
  const product = store && store.statsId === sid ? await readProduct(store, pid) : null;
  if (!store || !product || !store.stripeAccountId) {
    console.error("a product's pre-orders wait: its store or product could not be read; the job is kept", member);
    return 0;
  }
  // Put back to "coming soon" since: it waits for its next release.
  const { soon } = await soonOne(store, pid);
  if (soon) {
    await redisPipeline([["SREM", JOBS, member]]);
    return 0;
  }
  const deps = depsFor(store);
  let given = 0;
  let left = unread;
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
          if (readPreorderJob(job)?.checkout === session) {
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
