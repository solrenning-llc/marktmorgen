/**
 * One product bought for several people, kept and handed out (the rules, and
 * why it exists, are in lib/group-rules.ts).
 *
 *   nl:grp:<id>              string  the purchase: store, product, how many people; once paid, its payment
 *   nl:grp:<id>:m            hash    address hash -> { e, at }: who took a place; its length is how many are taken
 *   nl:grp:<id>:n            string  how many places were taken, as counted before 5 November 2026 (no longer written)
 *   nl:grp:<id>:t:<hash>     string  one open of an address's link at a time, for 30 seconds at most
 *   nl:grp:<id>:mail         string  emails this link sent today, so it cannot be used to fill inboxes
 *   nl:grp:take:<token>      string  the link in a place's email: which purchase, which address
 *   nl:grp:pi:<payment>      string  the purchase a payment paid for, so a refund finds it
 *   nl:grp:<store>:any       string  present once the store has sold one
 *   nl:grp:<store>:refunds   string  how far the refunds were read for these
 *   nl:grp:<store>:seen      set     refunds already handled
 *
 * A place is handed over the way a gift is (lib/gifts.ts): written down under
 * the address that took it (lib/imported-purchases.ts), so every door that
 * opens a purchase for an address opens it for them, and the buyer's own
 * checkout opens nothing (lib/bundle-rules.ts deliveredIds).
 *
 * Never one place more than was paid for: a place is the address's mark in
 * the purchase's hash, written first, and the places taken are the hash's
 * length read after it. A mark that finds more marks than places is taken
 * off before anything is handed over. Since 5 November 2026 there is no
 * separate count: one INCR whose answer was lost after Redis did it left a
 * place counted that nobody had, for good (audit SG2, CX-123 rule 24). A
 * mark whose answer was lost belongs to its address, and opening its link
 * again picks it up where it stopped.
 *
 * Each place taken is one of the store's orders in the month it is taken
 * (lib/orders.ts). The checkout held room for every place for a day
 * (lib/order-admission.ts, OPEN_HOURS), and a place taken in that day uses
 * it. Since 18 October 2026 a place taken later is admitted then, like any
 * new order, before anything is handed over: when the store's month has no
 * room, nothing is taken, and the person is told the store is resting and
 * that their place is kept for them. The emails that hand out places are
 * the store's access emails (lib/store-allowance-rules.ts), counted before
 * they go.
 */
import { consentEmailLines } from "@/lib/digital-consent-email";
import { countOrder } from "@/lib/orders";
import { ADMITTED_FIELD, OPEN_HOURS, admitOrders, settleAdmitted } from "@/lib/order-admission";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { allowanceUsedExact } from "@/lib/store-allowance";
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { addressHash, grantImported, importedKey } from "@/lib/imported-purchases";
import { bundleFromMeta } from "@/lib/bundle-rules";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { refundRowKnown } from "@/lib/refunds";
import { STRIPE_LIST_VERSION, StripeListUnreadable, ownField, plainObject, readStripePage, type StripePage } from "@/lib/stripe-list";
import { formatMoney } from "@/lib/money";
import { STRIPE_ACCOUNT_PATTERN, type Listing, type Store, setPastBuyers, storeRef } from "@/lib/store";
import { givenOption } from "@/lib/gift-rules";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import {
  GROUP_ID,
  GROUP_KEPT_SECONDS,
  GROUP_PENDING_SECONDS,
  PLACE_LINK_SECONDS,
  PLACE_TOKEN,
  canGroup,
  payable,
  peopleWords,
  readPeople,
} from "@/lib/group-rules";

export type Group = {
  id: string;
  /** The store's statsId. */
  s: string;
  /** The product. */
  p: string;
  /** For a product with price options: the one that was chosen for everyone. */
  o?: string;
  /** How many people it was bought for. */
  people: number;
  at: number;
  /** Once paid: the checkout and its payment, and when. */
  session?: string;
  pi?: string;
  paid?: number;
  /** For a bundle: the products it held when it was paid for. */
  items?: string[] | null;
  /** Once taken back by a refund, in seconds. */
  revoked?: number;
  /** The hour its checkout held room for every place in (lib/order-admission.ts), when it was counted there. */
  h?: number;
};

const groupKey = (id: string) => `nl:grp:${id}`;
const membersKey = (id: string) => `nl:grp:${id}:m`;
/** The count kept before 5 November 2026: no longer written, still deleted with the purchase. */
const takenKey = (id: string) => `nl:grp:${id}:n`;
const openingKey = (id: string, who: string) => `nl:grp:${id}:t:${who}`;
const mailKey = (id: string) => `nl:grp:${id}:mail`;
const tokenKey = (token: string) => `nl:grp:take:${token}`;
const piKey = (pi: string) => `nl:grp:pi:${pi}`;
/** What one purchase for several people keeps, by its id and its payment: for a closed store (lib/closed-store-data.ts). */
export const groupKeys = (id: string, pi: string): string[] => [...(id ? [groupKey(id), membersKey(id), takenKey(id), mailKey(id)] : []), ...(pi ? [piKey(pi)] : [])];
const anyKey = (sid: string) => `nl:grp:${sid}:any`;
const anchorKey = (sid: string) => `nl:grp:${sid}:refunds`;
const seenKey = (sid: string) => `nl:grp:${sid}:seen`;
/** Pages of a hundred refunds read in one run; a pass longer than that goes on from where it stopped in the next. */
const REFUND_PAGES = 10;
/** Where a pass over the refunds stands, kept between runs (revokeRefundedGroups). */
const passKey = (sid: string) => `nl:grp:${sid}:refunds:pass`;
/**
 * The Stripe account the anchor is of, written with it (REFUNDS_END). An anchor kept before anchors named their account
 * has none, and is read as the store's account today, as it was read then.
 */
const ownerKey = (sid: string) => `nl:grp:${sid}:refunds:acct`;
/**
 * Where each account the store left is read from again should the store come back to it (A, then B, then A): a
 * sorted set, the account as member and, as score, its anchor when the store left it, or the start of a pass on it
 * that never ended. At most REFUND_ACCOUNTS_KEPT; past that the newest marks are let go, and an account with no mark
 * is read from the oldest mark kept (never later than any mark let go) or a week back, whichever is older, so no
 * refund is lost and what is kept stays bounded.
 */
const leftKey = (sid: string) => `nl:grp:${sid}:refunds:left`;
const REFUND_ACCOUNTS_KEPT = 16;
/** A pass ended: the anchor and the account it is of written together, that account's mark let go, the pass too. */
const REFUNDS_END = `-- marktmorgen:group-refunds-end:v1
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('ZREM', KEYS[3], ARGV[2])
redis.call('DEL', KEYS[4])
return 1`;
/** How long a pass is kept: well past the runs it takes, and short enough that one left behind is started again. */
const PASS_SECONDS = 7 * 86_400;
/**
 * Refunds whose work was left unknown (a record that does not read, a reply in another shape), refund id to payment,
 * tried again first on every run, so one of them never holds back the refunds after it (Claude 4 on #2781).
 */
const retryKey = (sid: string) => `nl:grp:${sid}:refunds:retry`;
/**
 * At most this many waiting; with the list full, the pass stops on the page it could not hand over. The list has no
 * expiry (Claude 4 on #2781): a refund waiting on it is let go only once handled, never in silence; it is bounded by
 * this cap, and the store's nl:grp: keys go with the store.
 */
const RETRY_CAP = 100;
const REFUND_ID = /^re_[A-Za-z0-9]{3,252}$/;
const PAYMENT_ID = /^pi_[A-Za-z0-9]{3,252}$/;
const now = () => Math.floor(Date.now() / 1000);

/**
 * The refunds of one charge read in one run (one GET /refunds?charge= each, only for a refund that succeeded on a
 * charge read refunded in full without covering the charge by itself): past it, the refund holds the anchor and is
 * read in the next run. A scheduled job bounded by its schedule, like REFUND_PAGES; Stripe bills no API call.
 */
const CHARGE_REFUND_LOOKUPS = 10;
/**
 * A refund still on its way this long is said in the log, and still takes nothing back (the owner's decision 18, 9
 * November 2026: a refund pending for many days raises an alert, never a revocation). Stripe finishes almost every
 * refund within days; one still pending after a week needs a look (the creator's balance short, a payment method
 * that answers slowly). Said on every run that reads it, from the log alone: no store command, no email.
 */
const REFUND_STUCK_SECONDS = 7 * 86_400;

// The reading of a refund in parts below is a copy of the one on #2868 (lib/licence-keys.ts, claude5/fix-licence-refund,
// wholeOnItsOwn and chargeRefundsSettled), not yet on main: once both are, one shared function in lib/refunds.ts
// should take the place of both copies.
/** The most refunds of one charge read in one GET /refunds?charge= (one page; more than that is unknown). */
const CHARGE_REFUNDS_PAGE = 100;
const CHARGE_PATTERN = /^(ch|py)_[A-Za-z0-9]{6,255}$/;
/** Statuses a refund still on its way has: it may yet fail, and Stripe already counts it in amount_refunded. */
const REFUND_ON_ITS_WAY = new Set(["pending", "requires_action"]);
const REFUND_STATUS_KNOWN = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);
const centsKnown = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Whether a succeeded refund whose charge reads refunded in full gave the whole charge back by itself: its own amount
 * covers the charge's. Only then is no other refund of the charge needed to say the money went back for good.
 */
function wholeOnItsOwn(refund: Record<string, unknown>): boolean {
  const charge = refund.charge;
  if (!plainObject(charge)) return false;
  const amount = ownField(charge, "amount");
  return centsKnown(refund.amount) && centsKnown(amount) && amount > 0 && refund.amount >= amount;
}

/**
 * A full refund made of several refunds of one charge, read from all of that charge's refunds (one GET /refunds?charge=,
 * Stripe's own list): "held" while any is still on its way (it may still fail, and Stripe counts it in the charge's
 * amount_refunded already), "through" when the ones that succeeded add up to the whole charge. Anything else (no
 * charge id, a row or a list in another shape, more than one page, or succeeded refunds that do not add up although
 * the charge reads refunded in full) throws StripeListUnreadable: never "nothing pending" (CX-123 rule 24).
 */
async function chargeRefundsSettled(account: string, refund: Record<string, unknown>): Promise<"held" | "through"> {
  const charge = refund.charge;
  const id = plainObject(charge) ? ownField(charge, "id") : undefined;
  const amount = plainObject(charge) ? ownField(charge, "amount") : undefined;
  if (typeof id !== "string" || !CHARGE_PATTERN.test(id) || !centsKnown(amount) || amount <= 0) {
    throw new StripeListUnreadable("a refund's charge without its id or amount");
  }
  const legible = (row: Record<string, unknown>) => {
    const status = ownField(row, "status");
    const named = ownField(row, "charge");
    const chargeId = typeof named === "string" ? named : plainObject(named) ? ownField(named, "id") : undefined;
    return typeof status === "string" && REFUND_STATUS_KNOWN.has(status) && centsKnown(ownField(row, "amount")) && chargeId === id;
  };
  const listed = readStripePage(
    await onAccount("GET", account, `/refunds?${new URLSearchParams({ charge: id, limit: String(CHARGE_REFUNDS_PAGE) })}`),
    legible,
  );
  if (listed.unreadable > 0 || listed.hasMore) throw new StripeListUnreadable("a charge's refunds");
  // The refund being read is one of them, as it now stands: if Stripe's list does not have it, the list proves nothing.
  if (!listed.rows.some((row) => row.id === refund.id)) throw new StripeListUnreadable("a charge's refunds without the one read");
  if (listed.rows.some((row) => REFUND_ON_ITS_WAY.has(ownField(row, "status") as string))) return "held";
  const through = listed.rows.reduce((sum, row) => sum + (ownField(row, "status") === "succeeded" ? (ownField(row, "amount") as number) : 0), 0);
  if (through >= amount) return "through";
  throw new StripeListUnreadable("a charge read refunded in full whose succeeded refunds do not add up");
}

/** How a place is named where purchases given to an address are kept. */
export const groupJob = (id: string) => `group:${id}`;
/** Whether something written down for an address was a place in a purchase for several. */
export const isGroupJob = (job: string) => job.startsWith("group:");

export function newGroupId(): string {
  return `grp_${randomBytes(12).toString("hex")}`;
}

export async function readGroup(id: string): Promise<Group | null> {
  if (!GROUP_ID.test(id) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", groupKey(id)]]);
  if (typeof raw !== "string") return null;
  try {
    const g = JSON.parse(raw) as Group;
    return g && g.id === id && Number.isInteger(g.people) ? g : null;
  } catch {
    return null;
  }
}

async function saveGroup(group: Group, seconds: number): Promise<void> {
  await redisPipeline([["SET", groupKey(group.id), JSON.stringify(group), "EX", seconds]]);
}

/** A paid purchase of this store's that still hands out places; null for anything else. */
export async function openGroup(store: Store, id: string): Promise<Group | null> {
  const group = await readGroup(id);
  if (!group || !store.statsId || group.s !== store.statsId || !group.paid || group.revoked) return null;
  return group;
}

/** How many of its places are taken: the addresses that hold one. Throws when the answer is not a count. */
export async function placesTaken(id: string): Promise<number> {
  if (!GROUP_ID.test(id) || !isRedisConfigured()) return 0;
  const one = repliesFor(await redisPipeline([["HLEN", membersKey(id)]]), 1);
  const taken = one ? countOf(one[0]) : null;
  if (taken === null) throw new UnknownReplyError("a purchase's places");
  return taken;
}

export type NewGroup = { ok: true; group: Group } | { ok: false; reason: "people" | "product" | "option" | "amount" | "unavailable" };

/**
 * Writes down how many people a purchase is for, before its checkout opens.
 * For a product with price options, `optionId` names the one everybody gets.
 */
export async function startGroup(store: Store, product: Listing, people: unknown, optionId: unknown = ""): Promise<NewGroup> {
  if (!store.statsId || !isRedisConfigured()) return { ok: false, reason: "unavailable" };
  if (!canGroup(product)) return { ok: false, reason: "product" };
  const chosen = givenOption(product, optionId);
  if (!chosen.ok) return { ok: false, reason: "option" };
  const count = readPeople(people);
  if (count === null) return { ok: false, reason: "people" };
  if (!payable(chosen.option ? chosen.option.priceCents : product.priceCents, count)) return { ok: false, reason: "amount" };
  const group: Group = { id: newGroupId(), s: store.statsId, p: product.id, ...(chosen.option ? { o: chosen.option.id } : {}), people: count, at: now() };
  await saveGroup(group, GROUP_PENDING_SECONDS);
  return { ok: true, group };
}

type Session = {
  id?: unknown;
  created?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  payment_intent?: unknown;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: unknown } | null;
};

/** What a purchase for several is of, by name: the product, with the price option chosen when it has them. */
export function groupTitle(product: Listing, group: Pick<Group, "o">): string {
  const label = group.o ? product.options.find((o) => o.id === group.o)?.label ?? "" : "";
  return label ? `${product.title} (${label})` : product.title;
}

/** The page that hands out a purchase's places. */
export function groupLink(base: string, id: string): string {
  return `${base}/group/${id}`;
}

export type SettleOutcome = "settled" | "already" | "skip";

/**
 * Marks a purchase for several as paid, once, and emails the buyer their
 * receipt with the link that hands out its places. The caller has checked
 * the checkout is settled and this store's.
 */
export async function settleGroup(input: {
  store: Store;
  session: Session;
  product: Listing;
  /** Where the store lives, for the link (lib/purchase-email.ts storeBase). */
  base: string;
  from: string;
}): Promise<SettleOutcome> {
  const { store, session, product } = input;
  const id = session.metadata?.group ?? "";
  const group = await readGroup(id);
  if (!group || group.s !== store.statsId || group.p !== product.id) return "skip";
  if (group.paid) return "already";
  const [claimed] = await redisPipeline([["SET", `${groupKey(id)}:settling`, "1", "NX", "EX", 300]]);
  if (claimed === null) return "already";

  const sessionId = typeof session.id === "string" ? session.id : "";
  // Stripe gives the payment as its id, or whole when the caller asked for it.
  const intent = session.payment_intent as { id?: unknown } | string | null | undefined;
  const pi = typeof intent === "string" ? intent : typeof intent?.id === "string" ? intent.id : "";
  // A bundle hands over what it held when it was paid for, to every place.
  const items = bundleFromMeta(session.metadata ?? null, "bundle");
  // The hour its checkout was admitted in, which held room for every place for a day (takePlace).
  const admittedHour = Number(session.metadata?.[ADMITTED_FIELD] ?? "");
  const paid: Group = { ...group, session: sessionId, pi, paid: now(), items: items.length ? items : null, ...(Number.isSafeInteger(admittedHour) && admittedHour > 0 ? { h: admittedHour } : {}) };
  await saveGroup(paid, GROUP_KEPT_SECONDS);
  await redisPipeline([
    ...(pi ? [["SET", piKey(pi), group.id, "EX", GROUP_KEPT_SECONDS] as (string | number)[]] : []),
    ["SET", anyKey(group.s), "1"],
    ["DEL", `${groupKey(id)}:settling`],
  ]);

  await sendReceipt({ ...input, group: paid, lead: givingWords(store.language).thanksReceipt(store.name), idempotencyKey: `nimbus-group-receipt:${group.id}` }).catch((error) =>
    console.error("a receipt for several people failed", error),
  );
  return "settled";
}

/** The buyer's receipt, with the link that hands out the places. False when it has nobody to go to or was not sent. */
async function sendReceipt(input: {
  store: Store;
  session: Session;
  product: Listing;
  base: string;
  from: string;
  group: Group;
  lead: string;
  idempotencyKey?: string;
  /** Sent again, from the studio: one of the store's own emails (lib/store-allowance-rules.ts), not the order's. */
  again?: boolean;
}): Promise<boolean> {
  const { store, session, product, group } = input;
  const title = groupTitle(product, group);
  const buyer = typeof session.customer_details?.email === "string" ? session.customer_details.email : "";
  if (!buyer) return false;
  const amount = typeof session.amount_total === "number" ? session.amount_total : product.priceCents * group.people;
  const currency = typeof session.currency === "string" && session.currency ? session.currency : store.currency;
  const g = givingWords(store.language);
  return sendEmail({ meter: input.again ? { by: "store", store, kind: "email" } : { by: "order" },
    from: input.from,
    to: buyer,
    subject: g.groupReceiptSubject(group.people, title).slice(0, 200),
    text: [
      input.lead,
      "",
      g.forWho(title, peopleWords(group.people, store.language)),
      g.paidLine(formatMoney(amount, currency, speech(store).lang.locale)),
      g.orderRef(group.session ?? ""),
      ...consentEmailLines(store, input.session?.metadata),
      "",
      g.passLinkOn,
      groupLink(input.base, group.id),
      "",
      g.eachPerson(title, group.people),
      "",
      g.keepEmail,
      "",
      g.chargedBy(store.name),
    ].join("\n"),
    replyTo: store.email,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}

/**
 * Sends the buyer their receipt and link again, when the creator asks from
 * the studio's list of sales: a buyer who lost the link has lost the only way
 * to hand out what they paid for. False for a purchase that is not open.
 */
export async function resendGroupReceipt(input: { store: Store; session: Session; product: Listing; base: string; from: string }): Promise<boolean> {
  const group = await openGroup(input.store, input.session.metadata?.group ?? "");
  if (!group || group.p !== input.product.id) return false;
  return sendReceipt({ ...input, group, lead: givingWords(input.store.language).resentReceipt(input.store.name), again: true });
}

type Member = { e: string; at: number };

function parseMember(raw: unknown): Member | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<Member>;
    return typeof value.e === "string" && value.e ? { e: value.e, at: typeof value.at === "number" ? value.at : 0 } : null;
  } catch {
    return null;
  }
}

/** What a SET ... NX then INCR answered: the count, a whole number from one up, or null when the reply is not exactly that. */
function incremented(replies: unknown): number | null {
  const two = repliesFor(replies, 2);
  if (!two || (two[0] !== "OK" && two[0] !== null)) return null;
  const count = countOf(two[1]);
  return count !== null && count >= 1 ? count : null;
}

/** A 0 or a 1 (HEXISTS, HSETNX), or null for anything else. */
function bit(reply: unknown): 0 | 1 | null {
  const n = countOf(reply);
  return n === 0 || n === 1 ? n : null;
}

/**
 * What an address was given of a product, as HGET answers it: null only for
 * an explicit nil (nothing given), the job that gave it and when for a record
 * as lib/imported-purchases.ts grantImported writes one (a JSON object with
 * a job and a time), or undefined for anything else: a record that cannot
 * be read is unknown, never a gift made some other way (CX-123 rule 24), so
 * it never says "has" or "already" and never takes a mark off.
 */
function givenBy(reply: unknown): { job: string; at: number } | null | undefined {
  if (reply === null) return null;
  if (typeof reply !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(reply);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { job, at } = value as { job?: unknown; at?: unknown };
  if (typeof job !== "string" || !job || typeof at !== "number" || !Number.isFinite(at) || at < 0) return undefined;
  return { job, at };
}

/**
 * A hash's values, read exactly as Redis returns HGETALL (Codex G on #2781; CX-123 rule 30): a flat list of an even
 * length with every field and value text, or an object whose every value is text. HGETALL answers an empty list,
 * never null, for a hash with nothing in it, so null, a list of odd length or anything not text is unknown (null),
 * never "nobody".
 */
function hashValues(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    if (raw.length % 2 !== 0 || !raw.every((item) => typeof item === "string")) return null;
    return raw.filter((_, i) => i % 2 === 1) as string[];
  }
  if (raw && typeof raw === "object") {
    const all = Object.values(raw as Record<string, unknown>);
    return all.every((item) => typeof item === "string") ? (all as string[]) : null;
  }
  return null;
}

export type Asked = "sent" | "email" | "gone" | "full" | "slow" | "unavailable" | "resting";

/**
 * Somebody typed an address on a purchase's page: sends that address the
 * link that takes a place. Nothing is taken yet, so a mistyped address costs
 * nothing. An address that already has its place is sent the way in again,
 * and the answer is the same either way.
 */
export async function askPlace(input: {
  store: Store;
  id: string;
  email: unknown;
  product: Listing;
  base: string;
  from: string;
  ordersLink: (email: string) => Promise<string | null>;
}): Promise<Asked> {
  const { store, product, base } = input;
  if (!isRedisConfigured()) return "unavailable";
  const group = await openGroup(store, input.id);
  if (!group || group.p !== product.id) return "gone";
  const raw = typeof input.email === "string" ? input.email.trim() : "";
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  const email = normaliseEmail(raw);
  const title = groupTitle(product, group);
  const g = givingWords(store.language);

  // Read in their exact shape: an answer that is missing, cut short or of
  // another shape is not "nothing taken", and nothing is sent on it (CX-123 rule 24).
  const read = repliesFor(
    await redisPipeline([
      ["HEXISTS", membersKey(group.id), addressHash(email)],
      ["HLEN", membersKey(group.id)],
      ["HGET", importedKey(group.s, email), group.p],
    ]),
    3,
  );
  const marked = read ? bit(read[0]) : null;
  const marks = read ? countOf(read[1]) : null;
  const given = read ? givenBy(read[2]) : undefined;
  if (marked === null || marks === null || given === undefined) return "unavailable";
  // Its place is its own once this purchase gave it the product. A mark with
  // nothing given (an open of its link that stopped half way) is picked up
  // by a new link, and the places the others hold are the rest of the marks.
  const has = marked === 1 && given?.job === groupJob(group.id);
  if (!has && marks - marked >= group.people) return "full";

  // The link can be passed to anybody, and each address typed on it is sent
  // one email: counted per purchase and per day, generously for a real team
  // and far short of a way to fill inboxes. The day is put on the count in
  // the same pipeline, before it is counted, so a count whose answer is lost
  // still ends with its day.
  const sentCount = incremented(
    await redisPipeline([
      ["SET", mailKey(group.id), "0", "EX", 86_400, "NX"],
      ["INCR", mailKey(group.id)],
    ]),
  );
  if (sentCount === null) return "unavailable";
  if (sentCount > group.people * 3 + 10) return "slow";
  // The email is one of the store's access emails, taken as it is sent
  // (lib/email.ts); when the month's are used, the person is told so here. A count that cannot be read is not room
  // (rule 24): nothing is sent, and the person is asked to try again.
  const accessUsed = await allowanceUsedExact(store, "transactional");
  if (accessUsed === null) return "unavailable";
  if (accessUsed >= allowanceFor(store, "transactional")) return "resting";

  if (has) {
    const link = (await input.ordersLink(email)) ?? `${base}/orders`;
    const sent = await sendEmail({ meter: { by: "store", store, kind: "transactional" },
      from: input.from,
      to: email,
      subject: g.placeAgainSubject(title).slice(0, 200),
      text: [
        g.placeAgainLead(title, store.name),
        link,
        "",
        g.link24(`${base}/orders`),
        "",
        g.ignoreThis,
        "",
        g.sentByNothing(store.name),
      ].join("\n"),
    }).catch(() => false);
    return sent ? "sent" : "unavailable";
  }

  const token = randomBytes(32).toString("hex");
  await redisPipeline([["SET", tokenKey(token), JSON.stringify({ g: group.id, e: email }), "EX", PLACE_LINK_SECONDS]]);
  const sent = await sendEmail({ meter: { by: "store", store, kind: "transactional" },
    from: input.from,
    to: email,
    subject: g.takePlaceSubject(title).slice(0, 200),
    text: [
      g.takePlaceLead(title, store.name, peopleWords(group.people, store.language)),
      "",
      g.openToTake,
      `${groupLink(base, group.id)}?take=${token}`,
      "",
      g.takePlaceNote(title),
      "",
      g.ignoreUnlessOpened,
      "",
      g.sentBy(store.name),
    ].join("\n"),
  }).catch(() => false);
  return sent ? "sent" : "unavailable";
}

export type Taken =
  | { outcome: "taken" | "already" | "has"; email: string; group: Group }
  | { outcome: "full" | "resting"; email: string; group: Group }
  | { outcome: "gone" };

/** Whether the room its checkout held for its places is still held now (lib/order-admission.ts). */
export function placesHeld(group: Pick<Group, "h">, nowMs = Date.now()): boolean {
  return typeof group.h === "number" && Math.floor(nowMs / 3_600_000) - group.h < OPEN_HOURS - 1;
}

/**
 * The notice the purchase's page shows after its link was opened, by name
 * (lib/buyer-words/giving.ts groupNotices): "opening" when opening a valid
 * link threw, since then the place may or may not be the person's already
 * (the product given, another open of the same link still going), and only
 * opening it again says which. "expired" is only for a link that is not one,
 * or no longer leads anywhere.
 */
export function placeNotice(input: { token: string; tokenValid: boolean; taken: Taken | null; threw: boolean; status: string }): string | null {
  const { taken } = input;
  if (taken?.outcome === "full") return "full";
  if (taken?.outcome === "resting") return "resting";
  if (input.tokenValid && input.threw) return "opening";
  if (taken?.outcome === "gone" || (input.token && !taken)) return "expired";
  // A notice only this page draws is never read from the address bar.
  return input.status && input.status !== "expired" && input.status !== "opening" ? input.status : null;
}

/**
 * Opens the link from a place's email: takes a place for its address, once.
 * "already" is the same address opening its link again; "has" is an address
 * that owns the product some other way, which takes no place.
 */
export async function takePlace(input: {
  store: Store;
  token: string;
  recordStart: (email: string, courseProductId: string, startSeconds: number) => Promise<void>;
}): Promise<Taken> {
  if (!PLACE_TOKEN.test(input.token) || !isRedisConfigured()) return { outcome: "gone" };
  const [raw] = await redisPipeline([["GET", tokenKey(input.token)]]);
  let asked: { g?: unknown; e?: unknown } = {};
  try {
    asked = typeof raw === "string" ? (JSON.parse(raw) as typeof asked) : {};
  } catch {}
  if (typeof asked.g !== "string" || typeof asked.e !== "string" || !asked.e) return { outcome: "gone" };
  const group = await openGroup(input.store, asked.g);
  if (!group) return { outcome: "gone" };
  const email = asked.e;
  const who = addressHash(email);

  // The link opened again once all was done: answered from one read, with
  // nothing written (CX-123 rule 24: in its exact shape, or not at all).
  const first = await readPlace(group, email, who);
  if (first.given?.job === groupJob(group.id) && first.mark?.d) return { outcome: "already", email, group };

  // One open of an address's link at a time (two tabs, or a mail scanner and
  // the person), so each finds the address's mark as the other left it. The
  // opening is this open's own random value, and is taken off only while it
  // still holds it. An answer of another shape may have set it: it ends on
  // its own.
  const opening = openingKey(group.id, who);
  const mine = randomBytes(16).toString("hex");
  const lock = await redisPipeline([["SET", opening, mine, "NX", "EX", OPENING_SECONDS]]).then((r) => repliesFor(r, 1)?.[0], () => undefined);
  if (lock === null) throw new Error("this place's link is being opened already");
  if (lock !== "OK") throw new UnknownReplyError("a place's opening");
  try {
    return await takeOpened(input, group, email, who);
  } finally {
    // Compared and deleted in one step (Codex C2's proof on #2654): an open that outlived its 30 seconds never
    // takes off the hold of the open that came after it.
    await redisPipeline([["EVAL", PLACE_RELEASE, 1, opening, mine]]).catch(() => undefined);
  }
}

/** Deletes a place's opening hold only while it is still this open's own (its random token). */
const PLACE_RELEASE = `-- marktmorgen:group-place-release:v1
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/**
 * Marks a place done (KEYS[1] the marks, ARGV[1] the address, ARGV[2] the
 * mark with d = 1): 1 only when it turned a mark that was there and not done,
 * 0 when it was done already, 2 when there was no mark (written, nothing to
 * give back), -1 for a mark that is not JSON (left as it is).
 */
const PLACE_DONE = `-- marktmorgen:group-place-done:v1
local now = redis.call('HGET', KEYS[1], ARGV[1])
if not now then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  return 2
end
local ok, mark = pcall(cjson.decode, now)
if not ok or type(mark) ~= 'table' then return -1 end
if mark.d == 1 then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1`;

/** How long one open of a link holds it, at most. */
const OPENING_SECONDS = 30;

/** A place's mark: who, when, the hour its order was admitted in, and whether all that follows the gift was done. */
type Mark = Member & { h?: number; d?: 1 };

/**
 * A place's mark as HGET answers it: null only for an explicit nil (no
 * mark), the mark when it is exactly what this file writes (a JSON object
 * with an address, a time from one up, and, when present, a whole hour and
 * d = 1), or undefined for anything else. A mark that cannot be read is
 * unknown, never one made up, so it never says "already" or "done"
 * (CX-123 rule 24).
 */
function markOf(reply: unknown): Mark | null | undefined {
  if (reply === null) return null;
  if (typeof reply !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(reply);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((name) => !["e", "at", "h", "d"].includes(name))) return undefined;
  const { e, at, h, d } = fields;
  if (typeof e !== "string" || !e || !Number.isSafeInteger(at) || (at as number) < 1) return undefined;
  if (h !== undefined && !Number.isSafeInteger(h)) return undefined;
  if (d !== undefined && d !== 1) return undefined;
  return { e, at: at as number, ...(h !== undefined ? { h: h as number } : {}), ...(d === 1 ? { d: 1 as const } : {}) };
}

/** The address's mark and what it was given, in their exact shape; throws when either is not. */
async function readPlace(group: Group, email: string, who: string): Promise<{ mark: Mark | null; given: { job: string; at: number } | null }> {
  const read = repliesFor(
    await redisPipeline([
      ["HGET", membersKey(group.id), who],
      ["HGET", importedKey(group.s, email), group.p],
    ]),
    2,
  );
  const mark = read ? markOf(read[0]) : undefined;
  const given = read ? givenBy(read[1]) : undefined;
  if (mark === undefined || given === undefined) throw new UnknownReplyError("a place's address");
  return { mark, given };
}

async function takeOpened(input: Parameters<typeof takePlace>[0], group: Group, email: string, who: string): Promise<Taken> {
  const { store } = input;
  const members = membersKey(group.id);
  const write = (mark: Mark) => JSON.stringify({ e: email, at: mark.at, ...(mark.h !== undefined ? { h: mark.h } : {}), ...(mark.d ? { d: 1 } : {}) });
  /**
   * All that follows the gift, each part once: the doors that read gifts
   * opened for this store, a course dated from the day the place was taken,
   * the order counted by its name (lib/orders.ts). Then the mark says it is
   * done, and only once that is written is the room its order was admitted
   * with given back (lib/order-admission.ts): a mark whose "done" was lost
   * leaves that room held until its day ends, never given back twice.
   */
  const finish = async (mark: Mark) => {
    if (!store.pastBuyers) await setPastBuyers(storeRef(store));
    for (const id of [group.p, ...(group.items ?? [])]) await input.recordStart(email, id, mark.at);
    // The purchase was paid, so it is covered wherever its sale paid a share.
    await countOrder(store, `place:${group.id}:${who}`, group.paid ? 1 : 0);
    // Only the open that turns the mark to done gives the room back (Claude 5's review of #2654): an open that
    // outlived its hold and one that came after it may both get here, and the hour's room is shared by every
    // checkout of the store, so a second give-back would take another order's room.
    const done = await redisPipeline([["EVAL", PLACE_DONE, 1, members, who, write({ ...mark, d: 1 })]]).then((r) => repliesFor(r, 1), () => null);
    if (done && done[0] === 1 && mark.h !== undefined) await settleAdmitted(store, mark.h);
  };

  // Read again now that this open holds the link.
  const { mark, given } = await readPlace(group, email, who);
  if (given && given.job === groupJob(group.id)) {
    // Given by this purchase: "already" only once that is so. A gift whose
    // mark went missing has it written back, so it is counted among the
    // places. What follows the gift is done again when it was not, for a
    // gift of the last week (well inside the mark that counts its order
    // once, lib/orders.ts, 45 days).
    const held: Mark = mark ?? { e: email, at: given.at > 0 ? given.at : now() };
    if (!mark) await redisPipeline([["HSETNX", members, who, write(held)]]);
    if (!held.d && given.at > 0 && now() - given.at < 7 * 86_400) await finish({ ...held, at: given.at });
    return { outcome: "already", email, group };
  }
  if (given) {
    // Given it some other way: no place is used for it, and a mark left by an
    // open that stopped half way is taken off.
    if (mark) await redisPipeline([["HDEL", members, who]]).catch(() => undefined);
    return { outcome: "has", email, group };
  }

  const at = now();
  // The mark first, then how many marks there are: the places taken, this
  // one among them. A mark already there is this address's own, from an open
  // that stopped before handing anything over, and is picked up here.
  const wrote = await redisPipeline([
    ...(mark ? [] : [["HSETNX", members, who, write({ e: email, at })] as (string | number)[]]),
    ["HLEN", members],
  ]).then(
    (r) => repliesFor(r, mark ? 1 : 2),
    () => null,
  );
  const set = wrote && !mark ? bit(wrote[0]) : 1;
  const count = wrote ? countOf(wrote.at(-1)) : null;
  if (!wrote || set === null || count === null || count < 1) {
    // The answer never came or is of another shape: the mark may be written,
    // so nothing is given and no place is handed out. The mark is this
    // address's alone: taken off, or, if that is lost too, picked up when the
    // link is opened again. No other address's place moves.
    await redisPipeline([["HDEL", members, who]]).catch(() => undefined);
    throw new UnknownReplyError("a place's count");
  }
  const giveBack = () => redisPipeline([["HDEL", members, who]]);
  if (count > group.people) {
    // More marks than places: this one comes off. When that leaves a place
    // free (two pressed for the last one in the same instant and both came
    // off), it is not said that every place is taken: the open is said as
    // not done, and the link works again.
    const after = await redisPipeline([["HDEL", members, who], ["HLEN", members]]).then(
      (r) => {
        const two = repliesFor(r, 2);
        return two ? countOf(two[1]) : null;
      },
      () => null,
    );
    if (after === null) throw new UnknownReplyError("a place given back");
    if (after < group.people) throw new Error("a place was given back in the same instant");
    return { outcome: "full", email, group };
  }
  // One of the store's orders this month: inside the room its checkout held
  // when that is still held, admitted now otherwise, before anything is
  // handed over (lib/order-admission.ts).
  const held = placesHeld(group);
  let hour: number | null = held ? group.h ?? null : null;
  if (!held) {
    const admitted = await admitOrders(store, 1);
    if (!admitted.ok) {
      await giveBack();
      return { outcome: "resting", email, group };
    }
    hour = admitted.hour;
  }
  const placed: Mark = { e: email, at: mark?.at ?? at, ...(hour !== null ? { h: hour } : {}) };
  await redisPipeline([["EXPIRE", members, GROUP_KEPT_SECONDS]]);

  const [granted] = await grantImported(group.s, groupJob(group.id), [{ email, productId: group.p, items: group.items ?? null, option: group.o ?? null }], placed.at, store.sid);
  if (!granted) {
    // This open's order is not counted by this open: the room it was
    // admitted with goes back (another open gives back its own, and an open
    // of this link that finds this gift later counts the order without it).
    if (!held && hour !== null) await settleAdmitted(store, hour);
    // Read in its exact shape: only a gift as grantImported writes it says
    // who has the product. An unknown answer, or none at all just after the
    // grant was refused for one being there, takes nothing off and is said
    // as not done: the mark stays for the next open of the link.
    const one = repliesFor(await redisPipeline([["HGET", importedKey(group.s, email), group.p]]), 1);
    const other = one ? givenBy(one[0]) : undefined;
    if (!other) throw new UnknownReplyError("a place's gift");
    if (other.job === groupJob(group.id)) {
      // This purchase gave it already, from another open of the same link:
      // its place stays, and what follows is that open's, or the next one's.
      return { outcome: "already", email, group };
    }
    // It reached this address another way in the same instant.
    await giveBack();
    return { outcome: "has", email, group };
  }
  // The hour goes on the mark once this open's gift is the one made, so an
  // open that stops before all that follows is done gives its room back when
  // the link is opened again; a mark without it leaves the room held until
  // its day ends, never given back twice.
  if (hour !== null) await redisPipeline([["HSET", members, who, write(placed)]]);
  await finish(placed);
  return { outcome: "taken", email, group };
}

/** A write of one item (SADD of one member, HDEL of one field) answers 0 or 1; anything else is unknown. */
const oneWrite = (reply: unknown): boolean => reply === 0 || reply === 1;
/**
 * Where a pass over the refunds stands between runs: its start, the page it continues from, the newest refund read,
 * the Stripe account whose list it is reading (its cursor is a refund of that account and of no other), and, when a
 * row it passed was not readable, the oldest time such a row holds (`hold`: the anchor goes no further when the pass
 * ends, so the next pass reads that row again).
 */
type RefundPass = { since: number; after: string; newest: number; account: string; hold?: number };
/** A pass's cursor: an id as Stripe gives one. */
const CURSOR = /^[A-Za-z0-9_]{3,255}$/;
/** A time kept as a mark: whole seconds, as Redis answers a score or a value; anything else is unknown (undefined). */
function timeMark(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  return typeof raw === "string" && /^\d{1,12}$/.test(raw) ? Number(raw) : undefined;
}
/** The oldest mark of an account left, from ZRANGEBYSCORE ... LIMIT 0 1 WITHSCORES: null when there is none. */
function lowestMark(raw: unknown): number | null | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return null;
  if (raw.length !== 2 || typeof raw[0] !== "string") return undefined;
  return timeMark(raw[1]) ?? undefined;
}
/**
 * A kept pass, only when it is in its exact shape and reads the store's account today. One kept on another account
 * (the creator connected another one) or before passes named their account is not read from: its cursor would be
 * answered 404 by this account. Then the pass starts again from the anchor, which never moved past it.
 */
function readPass(raw: unknown, account: string): RefundPass | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  try {
    const pass = JSON.parse(raw) as Partial<RefundPass>;
    if (
      Number.isSafeInteger(pass.since) &&
      Number.isSafeInteger(pass.newest) &&
      typeof pass.after === "string" &&
      CURSOR.test(pass.after) &&
      pass.account === account &&
      (pass.hold === undefined || (Number.isSafeInteger(pass.hold) && (pass.hold as number) >= 0))
    ) {
      return { since: pass.since as number, after: pass.after, newest: pass.newest as number, account, ...(pass.hold !== undefined ? { hold: pass.hold } : {}) };
    }
  } catch {}
  return undefined;
}

/**
 * Takes back the places of purchases refunded in full: reads the store's
 * refunds since it last looked, finds the purchase each paid for, and removes
 * it from every address that took a place. Returns how many places went.
 *
 * A refund takes the places back only once it succeeded on a charge refunded in full by the refunds that succeeded
 * (the owner's decision 18, 9 November 2026): one still on its way, or a part of a charge whose rest is on its way,
 * holds the anchor at its time and takes nothing back yet; one that failed or was canceled takes nothing back; one
 * on its way for more than REFUND_STUCK_SECONDS is said in the log, never taken back for that.
 *
 * The refunds are read in Stripe's exact list shape, every row as refundRowKnown (lib/refunds.ts) reads it, page
 * after page (CX-123 rules 24 and 30; C4-20261106-0450-C5-16). One pass from the anchor to the end of the list may
 * take several runs: where it stands is kept (passKey) after every page read whole and handled, so the next run goes
 * on from there instead of starting over (Codex G on #2781, M1); a run that resumes a pass first reads the newest page,
 * so a refund made meanwhile does not wait for the pass. The anchor moves, and the pass ends, only once the list was
 * read to its end. A refund is marked handled only after everything it takes back was written and confirmed, so a
 * run that stops halfway leaves it to the next (Codex G on #2781, M2); one whose work was left unknown (a reply in
 * another shape, a record that does not read) marks nothing and is kept on a short list tried first on every run, so
 * it never holds back the refunds after it (Claude 4 on #2781); with that list full, the pass stays on its page.
 *
 * The pass is kept with the account it reads: one kept on the store's previous Stripe account is never read from on
 * the new one, and a kept cursor the account answers 404 `resource_missing` for is let go and the pass starts again
 * from the top in the same run, so a refund is never left unread behind a cursor that cannot be followed (the sibling
 * of M2 on #3301). A row that is not readable never holds back the pages after it (the sibling of M1 on #3301): the
 * pass goes on from the page's last readable row or, on a page with none, from its last row's id when that id reads;
 * when it ends, the anchor goes no further than the oldest such row's time (the start of the pass when that time does
 * not read), so the next pass reads it again and the week a store with no anchor starts from never slides past it. A
 * page with no row whose id reads gives nothing to go on from: the pass stays on it, says in the log that what is
 * after it is unknown, and reads it again on the next run, at most the newest page and that one.
 *
 * The anchor is of one account (ownerKey). A store that connects another account starts that one from its own mark
 * (leftKey): where it was left, or, for one never read, a week back or the oldest mark kept, whichever is older; the
 * account left is marked at its anchor before anything else, and the anchor moves to the new account only once a pass
 * over it ends (REFUNDS_END, in one step). So a store that goes back to an account it left reads that account from
 * where it left it, never from the other account's anchor (A, then B, then A).
 */
export async function revokeRefundedGroups(
  store: Store,
  deadline: number,
  dropStart: (email: string, courseProductId: string) => Promise<void>,
): Promise<number> {
  if (!store.statsId || !store.stripeAccountId || !isRedisConfigured()) return 0;
  const sid = store.statsId;
  const account = store.stripeAccountId;
  const begun = repliesFor(await redisPipeline([["GET", anyKey(sid)], ["GET", anchorKey(sid)], ["GET", passKey(sid)], ["GET", ownerKey(sid)]]), 4);
  if (!begun) return 0;
  const [any, anchorRaw, passRaw, ownerRaw] = begun;
  if (!any) return 0;
  // The anchor read exactly: in another shape, no pass starts (Claude 4 on #2781), never one from a week back.
  if (anchorRaw !== null && (typeof anchorRaw !== "string" || !/^\d{1,12}$/.test(anchorRaw))) return 0;
  // And the account it is of: in another shape, no pass starts either.
  if (ownerRaw !== null && (typeof ownerRaw !== "string" || !STRIPE_ACCOUNT_PATTERN.test(ownerRaw))) return 0;
  // Where this account is read from: its anchor, when the anchor is of this account (or kept before anchors named one).
  let start: number;
  if (anchorRaw !== null && (ownerRaw === null || ownerRaw === account)) start = Number(anchorRaw);
  else {
    // No anchor of this account: its own mark, if the store left it before, else a week back or the oldest mark kept.
    const marks = repliesFor(await redisPipeline([["ZSCORE", leftKey(sid), account], ["ZRANGEBYSCORE", leftKey(sid), "-inf", "+inf", "LIMIT", 0, 1, "WITHSCORES"]]), 2);
    const own = marks ? timeMark(marks[0]) : undefined;
    const lowest = marks ? lowestMark(marks[1]) : undefined;
    if (own === undefined || lowest === undefined) return 0;
    start = own ?? Math.min(lowest ?? Number.MAX_SAFE_INTEGER, Math.max(0, now() - 7 * 86_400));
    // Before anything is read: the account left is marked at its anchor, and this one at where it starts, so neither
    // is lost if the store moves again before a pass here ends; then the newest marks past the bound are let go.
    const marking: (string | number)[][] = [];
    if (anchorRaw !== null && ownerRaw !== null) marking.push(["ZADD", leftKey(sid), "NX", anchorRaw, ownerRaw]);
    marking.push(["ZADD", leftKey(sid), "NX", String(start), account], ["ZREMRANGEBYRANK", leftKey(sid), REFUND_ACCOUNTS_KEPT, -1]);
    const marked = repliesFor(await redisPipeline(marking), marking.length);
    if (!marked || !marked.slice(0, -1).every(oneWrite) || countOf(marked.at(-1)) === null) return 0;
  }
  const kept = readPass(passRaw, account);
  // A pass kept in an unknown shape, or on another account, is started again from the anchor, which never moved past it.
  const since = kept ? kept.since : Math.max(0, start - 300);
  let newest = kept ? kept.newest : start;
  let after = kept ? kept.after : "";
  let hold = kept?.hold;
  let revoked = 0;

  let lookups = CHARGE_REFUND_LOOKUPS;
  /** Refunds read in this run still on their way after REFUND_STUCK_SECONDS, each said in the log once a run. */
  const stuck = new Set<string>();

  /**
   * One refund row read whole: true when it was handled or takes nothing back; false when something it needed was left
   * unknown, and then it is not marked handled; "hold" when it may still take its purchase back but has not yet, and it
   * then holds the anchor at its time, so the next pass reads it again (audit of refunds, A1).
   *
   * The owner's decision 18 (9 November 2026): the places go only once the refund succeeded on a charge refunded in full.
   * A refund still on its way (pending, or waiting on an action) takes nothing back, since it may yet fail, and holds
   * the anchor; failed or canceled, it takes nothing back and holds nothing. A refund in parts (as on #2868): a
   * succeeded part on a charge read refunded in full (Stripe counts a refund still pending in amount_refunded) takes
   * the places back only once the charge's succeeded refunds add up to the whole charge; while one of them is on its
   * way, or when they cannot be read, it holds. `decided` is a refund already read through, kept to be tried again.
   */
  const handle = async (refund: Record<string, unknown>, decided = false): Promise<boolean | "hold"> => {
    const id = refund.id as string;
    const pi = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
    if (!pi) return true;
    if (!decided && REFUND_ON_ITS_WAY.has(refund.status as string)) {
      if (typeof refund.created === "number" && refund.created <= now() - REFUND_STUCK_SECONDS && !stuck.has(id)) {
        stuck.add(id);
        // An alert for whoever reads the logs, never a revocation (the owner's decision 18): nothing goes until it succeeded.
        console.error("a refund for a group purchase has been pending for more than seven days; its places are kept until it succeeds", { store: sid, account, refund: id, status: refund.status, created: refund.created });
      }
      return "hold";
    }
    const charge = refund.charge as { refunded?: unknown } | null;
    if (refund.status !== "succeeded" || charge?.refunded !== true) return true;
    // Through already when kept read through, or when its own amount covers the charge; otherwise only once the
    // charge's refunds are read below.
    const through = decided || wholeOnItsOwn(refund);
    const looked = repliesFor(await redisPipeline([["SISMEMBER", seenKey(sid), id], ["GET", piKey(pi)]]), 2);
    const handled = countOf(looked?.[0]);
    const groupId = looked?.[1];
    // Left unknown before it was read through: held for the next pass, never kept on the retry list, which reads what
    // it keeps as through.
    if (!looked || handled === null || handled > 1 || (groupId !== null && typeof groupId !== "string")) return through ? false : "hold";
    if (handled === 1) return true;
    // A succeeded part of the charge: through only once the charge's succeeded refunds add up to it. Read after the
    // handled mark, so a refund already handled asks Stripe nothing more.
    if (!through) {
      if (lookups <= 0) return "hold";
      lookups -= 1;
      try {
        if ((await chargeRefundsSettled(account, refund)) === "held") return "hold";
      } catch (error) {
        if (!(error instanceof StripeListUnreadable) && !(error instanceof StripeError)) throw error;
        console.error("reading the refunds of a refunded charge for group purchases failed; held for the next pass", error);
        return "hold";
      }
    }
    if (typeof groupId === "string") {
      const raw = repliesFor(await redisPipeline([["GET", groupKey(groupId)]]), 1);
      if (!raw || (raw[0] !== null && typeof raw[0] !== "string")) return false;
      let group: Group | null = null;
      if (typeof raw[0] === "string") {
        try {
          const read = JSON.parse(raw[0]) as Group;
          group = read && read.id === groupId && Number.isInteger(read.people) ? read : null;
        } catch {}
        // A record that is there but cannot be read is not "nothing to take back".
        if (!group) return false;
      }
      if (group && group.s === sid) {
        if (!group.revoked) {
          // Closed first, so nobody takes a place while the others are taken back.
          const closed = repliesFor(await redisPipeline([["SET", groupKey(group.id), JSON.stringify({ ...group, revoked: now() }), "EX", GROUP_KEPT_SECONDS]]), 1);
          if (closed?.[0] !== "OK") return false;
        }
        // Closed already (a run that stopped halfway): the places still held are taken back now.
        // Every place taken, read exactly: a list in another shape, or one place that does not read, is unknown, and
        // the refund is not marked handled (it waits to be tried again), never "nobody to take back".
        const members = hashValues(repliesFor(await redisPipeline([["HGETALL", membersKey(group.id)]]), 1)?.[0]);
        if (!members) return false;
        // Every readable place is taken back now; one that does not read leaves the refund unmarked, to be tried
        // again, without holding back the others (Claude 4 on #2781).
        const places = members.map(parseMember);
        let unread = false;
        for (const member of places) {
          if (!member) {
            unread = true;
            continue;
          }
          // Only what this purchase gave: an address that also has the product
          // another way keeps that.
          const given = repliesFor(await redisPipeline([["HGET", importedKey(sid, member.e), group.p]]), 1);
          if (!given || (given[0] !== null && typeof given[0] !== "string")) {
            unread = true;
            continue;
          }
          // No record: the place has nothing of this purchase (null). A record that does not read, or whose job is not
          // text, is unknown, never "came another way" (Claude 4 on #2781): the refund then waits to be tried again.
          let job = "";
          if (typeof given[0] === "string") {
            let read: unknown;
            try {
              read = JSON.parse(given[0]);
            } catch {
              read = undefined;
            }
            const named = read && typeof read === "object" && !Array.isArray(read) ? (read as { job?: unknown }).job : undefined;
            if (typeof named !== "string") {
              unread = true;
              continue;
            }
            job = named;
          }
          if (job !== groupJob(group.id)) continue;
          // The access first, then the record that says the place holds it (Codex G on #2781): a failure between the
          // two leaves the record, so the next run takes the access away again (dropStart is idempotent); a reply
          // lost on the record's removal leaves nothing to find, and the access is already gone.
          try {
            for (const productId of [group.p, ...(group.items ?? [])]) await dropStart(member.e, productId);
          } catch (error) {
            console.error("taking a refunded place's access away failed; tried again next run", error);
            unread = true;
            continue;
          }
          const removed = repliesFor(await redisPipeline([["HDEL", importedKey(sid, member.e), group.p]]), 1);
          if (!oneWrite(removed?.[0])) {
            unread = true;
            continue;
          }
          revoked += 1;
        }
        if (unread) return false;
      }
    }
    // Marked handled only now, once everything it takes back was written.
    return oneWrite(repliesFor(await redisPipeline([["SADD", seenKey(sid), id]]), 1)?.[0]);
  };

  /**
   * One page of refunds: its rows read in their exact shape, null when the page itself could not be read, or "gone"
   * when the account does not know the refund it was asked to read on from (404 `resource_missing` on a cursor). With
   * the page: its last row's id when that id reads, whatever the rest of the row (`tailId`), and the oldest time a row
   * not readable holds (`holdAt`: its own time when that reads, the start of the pass when it does not).
   */
  const readPage = async (from: string): Promise<(StripePage & { tailId: string | null; holdAt: number | null }) | null | "gone"> => {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge");
    if (from) query.set("starting_after", from);
    try {
      const raw = await onAccount("GET", account, `/refunds?${query}`, undefined, STRIPE_LIST_VERSION);
      const page = readStripePage(raw, refundRowKnown);
      // A page that read is a plain object whose own data is a list: its rows are looked at again, slot by slot.
      const data = ownField(raw as Record<string, unknown>, "data") as unknown[];
      const readable = new Set<unknown>(page.rows);
      const slot = (i: number): unknown => {
        const own = Object.getOwnPropertyDescriptor(data, String(i));
        return own && Object.hasOwn(own, "value") ? own.value : undefined;
      };
      let holdAt: number | null = null;
      for (let i = 0; i < data.length; i += 1) {
        const row = slot(i);
        if (readable.has(row)) continue;
        const created = plainObject(row) ? ownField(row, "created") : undefined;
        // A time Stripe could have given this list (inside its window, not ahead of now); otherwise the pass's start.
        const at = typeof created === "number" && Number.isSafeInteger(created) && created >= since && created <= now() + 300 ? created : since + 300;
        holdAt = holdAt === null ? at : Math.min(holdAt, at);
      }
      const last = data.length > 0 ? slot(data.length - 1) : undefined;
      const lastId = plainObject(last) ? ownField(last, "id") : undefined;
      return { ...page, tailId: typeof lastId === "string" && CURSOR.test(lastId) ? lastId : null, holdAt };
    } catch (error) {
      if (from && error instanceof StripeError && error.status === 404 && error.code === "resource_missing") {
        console.error("a kept pass over group refunds named a refund this account does not know; started again", error);
        return "gone";
      }
      if (!(error instanceof StripeListUnreadable)) throw error;
      console.error("reading refunds for group purchases failed", error);
      return null;
    }
  };

  /** Keeps a refund whose work was left unknown for the next runs; false when that could not be written for sure. */
  const later = async (refund: Record<string, unknown>): Promise<boolean> => {
    const id = refund.id as string;
    const pi = refund.payment_intent;
    if (typeof pi !== "string" || !REFUND_ID.test(id) || !PAYMENT_ID.test(pi)) return false;
    const counted = countOf(repliesFor(await redisPipeline([["HLEN", retryKey(sid)]]), 1)?.[0]);
    if (counted === null || counted >= RETRY_CAP) return false;
    return oneWrite(repliesFor(await redisPipeline([["HSET", retryKey(sid), id, pi]]), 1)?.[0]);
  };

  // Those left unknown before, first: each tried again, and let go once handled.
  const waiting = repliesFor(await redisPipeline([["HGETALL", retryKey(sid)]]), 1)?.[0];
  if (waiting !== undefined && waiting !== null && typeof waiting === "object") {
    const pairs: [unknown, unknown][] = Array.isArray(waiting)
      ? waiting.flatMap((field, i) => (i % 2 === 0 ? [[field, waiting[i + 1]] as [unknown, unknown]] : []))
      : Object.entries(waiting as Record<string, unknown>);
    for (const [id, pi] of pairs) {
      if (Date.now() >= deadline) return revoked;
      if (typeof id !== "string" || typeof pi !== "string" || !REFUND_ID.test(id) || !PAYMENT_ID.test(pi)) continue;
      // Only a refund read through in full is ever kept here (handle hands nothing else to later), so it is read again
      // as one, without asking Stripe again.
      if ((await handle({ id, payment_intent: pi, status: "succeeded", charge: { refunded: true } }, true)) === true) {
        await redisPipeline([["HDEL", retryKey(sid), id]]);
      }
    }
  }

  let pages = REFUND_PAGES;
  if (after) {
    // Resuming a pass: the newest refunds first, so one made meanwhile is not left until the pass ends. What is read
    // here never moves the pass or the anchor; a later pass reads these again, and what was handled stays handled.
    pages -= 1;
    const top = await readPage("");
    for (const refund of top && top !== "gone" ? top.rows : []) {
      if (Date.now() >= deadline) return revoked;
      await handle(refund);
    }
  }
  for (let page = 0; page < pages; page += 1) {
    if (Date.now() >= deadline) return revoked;
    const read = await readPage(after);
    if (read === "gone") {
      // The cursor is not this account's: the pass is let go and started again from the top, never read from it again.
      // The anchor did not move during the pass, so nothing it covers is skipped; what was handled stays handled.
      await redisPipeline([["DEL", passKey(sid)]]);
      after = "";
      newest = start;
      hold = undefined;
      continue;
    }
    if (!read) return revoked;
    let whole = true;
    const held: number[] = [];
    for (const refund of read.rows) {
      if (Date.now() >= deadline) return revoked;
      // A refund on a readable row is taken back whatever the other rows. One whose work was left unknown is kept to
      // be tried again first on the next runs, and the pass goes on; when it cannot be kept for sure, the page stays.
      const result = await handle(refund);
      if (result === "hold") held.push(refund.created as number);
      else if (!result && !(await later(refund))) whole = false;
    }
    // A row neither handled nor kept for later: the page is read again next run.
    if (!whole) return revoked;
    // A row not readable holds the anchor at its time, so the next pass reads it again, and never holds back the pages
    // after it (the sibling of M1 on #3301).
    if (read.holdAt !== null) hold = hold === undefined ? read.holdAt : Math.min(hold, read.holdAt);
    // A refund that has not taken its purchase back yet but may (on its way, a part of a charge not settled, or one
    // whose charge's refunds did not read) holds the anchor the same way (audit of refunds, A1): the next pass reads it
    // again, and its places go once it went through.
    for (const at of held) hold = hold === undefined ? at : Math.min(hold, at);
    for (const refund of read.rows) newest = Math.max(newest, refund.created as number);
    if (!read.hasMore) {
      // Every row read and final: the anchor goes to the newest. A row not read, or a refund not final yet: no further
      // than its time, never back before where this pass started.
      const at = hold === undefined ? newest : Math.max(since + 300, hold);
      const ended = repliesFor(await redisPipeline([["EVAL", REFUNDS_END, 4, anchorKey(sid), ownerKey(sid), leftKey(sid), passKey(sid), String(at), account]]), 1);
      if (ended?.[0] !== 1) console.error("ending a pass over group refunds was left unknown");
      return revoked;
    }
    // More pages: read on from the last readable row (a row not readable after it is read again on the next page), or,
    // on a page with no readable row, from its last row's id when that id reads.
    const next = read.lastId ?? read.rows.at(-1)?.id ?? read.tailId;
    if (!next) {
      // Nothing to read on from: the refunds after this page are unknown until it reads. The pass stays on it and the
      // anchor (or this account's mark) where it was, so nothing after it leaves the window; each run reads the newest
      // page and this one again, inside its page bound.
      console.error("a page of refunds for group purchases has no row whose id reads: the pass stays on it, and the refunds after it are unknown", { store: sid, account });
      return revoked;
    }
    after = next;
    await redisPipeline([["SET", passKey(sid), JSON.stringify({ since, after, newest, account, ...(hold !== undefined ? { hold } : {}) } satisfies RefundPass), "EX", PASS_SECONDS]]);
  }
  return revoked;
}
