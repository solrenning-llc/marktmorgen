/**
 * One product bought for several people, kept and handed out (the rules, and
 * why it exists, are in lib/group-rules.ts).
 *
 *   nl:grp:<id>              string  the purchase: store, product, how many people; once paid, its payment
 *   nl:grp:<id>:m            hash    address hash -> { e, at }: who took a place
 *   nl:grp:<id>:n            string  how many places are taken
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
 * Never one place more than was paid for: a place is counted with INCR, and
 * one counted past the number paid for is given back before anything is
 * handed over. Two people pressing at the same instant for the last place
 * leave one of them told that every place is taken.
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
import { allowanceUsed } from "@/lib/store-allowance";
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { addressHash, grantImported, importedKey } from "@/lib/imported-purchases";
import { bundleFromMeta } from "@/lib/bundle-rules";
import { onAccount } from "@/lib/stripe-account";
import { refundRowKnown } from "@/lib/refunds";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { STRIPE_LIST_VERSION, StripeListUnreadable, readStripePage, type StripePage } from "@/lib/stripe-list";
import { formatMoney } from "@/lib/money";
import { type Listing, type Store, setPastBuyers, storeRef } from "@/lib/store";
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
const takenKey = (id: string) => `nl:grp:${id}:n`;
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

/**
 * A purchase's record for settling it, read exactly (sweep A3; CX-123 rules 24 and 30): no record is null, and an
 * answer that is not one reply of text or nothing is unknown and throws, never "no purchase", so a paid checkout is
 * never said as having nothing to settle because Redis answered in another shape.
 */
async function readGroupExactly(id: string): Promise<Group | null> {
  if (!GROUP_ID.test(id) || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", groupKey(id)]]), 1);
  if (!replies || (replies[0] !== null && typeof replies[0] !== "string")) throw new UnknownReplyError("a purchase for several's record");
  if (typeof replies[0] !== "string") return null;
  try {
    const g = JSON.parse(replies[0]) as Group;
    return g && g.id === id && Number.isInteger(g.people) ? g : null;
  } catch {
    return null;
  }
}

/** Writes a purchase down; true only when Redis answered the write in its exact shape ("OK"). */
async function saveGroup(group: Group, seconds: number): Promise<boolean> {
  return repliesFor(await redisPipeline([["SET", groupKey(group.id), JSON.stringify(group), "EX", seconds]]), 1)?.[0] === "OK";
}

/** A paid purchase of this store's that still hands out places; null for anything else. */
export async function openGroup(store: Store, id: string): Promise<Group | null> {
  const group = await readGroup(id);
  if (!group || !store.statsId || group.s !== store.statsId || !group.paid || group.revoked) return null;
  return group;
}

/** How many of its places are taken. */
export async function placesTaken(id: string): Promise<number> {
  if (!GROUP_ID.test(id) || !isRedisConfigured()) return 0;
  const [raw] = await redisPipeline([["GET", takenKey(id)]]);
  const taken = Number(raw);
  return Number.isFinite(taken) && taken > 0 ? Math.floor(taken) : 0;
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
  // Written down exactly before any checkout opens (sweep A3; CX-123 rules 24 and 30): a write answered in another
  // shape may not have landed, and a purchase paid for with no record never hands out a place. Refused instead, as
  // "unavailable" (the page says nothing was charged), and no checkout is made.
  if (!(await saveGroup(group, GROUP_PENDING_SECONDS))) return { ok: false, reason: "unavailable" };
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
  const group = await readGroupExactly(id);
  if (!group || group.s !== store.statsId || group.p !== product.id) return "skip";
  if (group.paid) return receiptForPaid(input, group);
  const settling = `${groupKey(id)}:settling`;
  // Claimed with this run's own value and read exactly (C4-3000): an answer in another shape is read back, never taken
  // as ours, and the mark is let go only while it still holds this run's value (lib/claim-mark.ts).
  const mark = claimValue();
  const claimed = await claimMark(settling, 300, mark);
  if (claimed === "unknown") throw new UnknownReplyError("a purchase for several's settling mark");
  if (claimed === "taken") {
    // Another run is settling it. "already" only once it is paid: said while the other run may still fail, the paid
    // purchase would never be settled (as deliverGift does since Claude 4 on #2726). Thrown, no "sent" mark is kept and
    // the next run tries again. Once paid, the run holding the mark sends the receipt (it keeps the mark until then),
    // and confirmGroup keeps no "sent" mark on "already" (#2872, M1), so a sender that fails is followed by the next run.
    if ((await readGroupExactly(id))?.paid) return "already";
    throw new Error("another run is settling this purchase for several right now");
  }

  const sessionId = typeof session.id === "string" ? session.id : "";
  // Stripe gives the payment as its id, or whole when the caller asked for it.
  const intent = session.payment_intent as { id?: unknown } | string | null | undefined;
  const pi = typeof intent === "string" ? intent : typeof intent?.id === "string" ? intent.id : "";
  // A bundle hands over what it held when it was paid for, to every place.
  const items = bundleFromMeta(session.metadata ?? null, "bundle");
  // The hour its checkout was admitted in, which held room for every place for a day (takePlace).
  const admittedHour = Number(session.metadata?.[ADMITTED_FIELD] ?? "");
  const paid: Group = { ...group, session: sessionId, pi, paid: now(), items: items.length ? items : null, ...(Number.isSafeInteger(admittedHour) && admittedHour > 0 ? { h: admittedHour } : {}) };
  // What a refund looks up (the payment's purchase, and that this store sold one) is written first and the purchase
  // marked paid last, each answered exactly "OK" (sweep A3; CX-123 rules 24 and 30): a write left unknown lets go of
  // the settling mark and throws, so confirmGroup keeps no "sent" mark and the next run does it again, never
  // "already" on a purchase whose payment a refund could not find.
  const kept: (string | number)[][] = [...(pi ? [["SET", piKey(pi), group.id, "EX", GROUP_KEPT_SECONDS]] : []), ["SET", anyKey(group.s), "1"]];
  const keptReplies = repliesFor(await redisPipeline(kept), kept.length);
  if (!keptReplies || !keptReplies.every((reply) => reply === "OK")) {
    await releaseMark(settling, mark);
    throw new UnknownReplyError("a paid purchase for several's payment record");
  }
  if (!(await saveGroup(paid, GROUP_KEPT_SECONDS))) {
    await releaseMark(settling, mark);
    throw new UnknownReplyError("a paid purchase for several's record");
  }
  // Kept, not let go, until it runs out: it covers the receipt below and the "sent" mark confirmGroup writes after it
  // (lib/purchase-email.ts), so a run that reads the purchase paid meanwhile answers "already" and never sends it twice.
  await paidReceipt(input, paid);
  return "settled";
}

/**
 * Within this time of being paid, a purchase read paid with no confirmation "sent" mark (lib/purchase-email.ts keeps
 * that mark 40 days) was settled by a run that did not get to send the receipt: its last write landed with a reply in
 * another shape, so it threw (Claude 4 and Claude 1 on #2872, M1). Past it, the mark ran out long after the receipt.
 */
const RECEIPT_LATE_SECONDS = 30 * 86_400;

/**
 * A purchase read paid: its receipt, with the link that hands out the places, sent now, once, when no run sent it (M1
 * on #2872). The settling mark, read exactly (lib/claim-mark.ts), decides who sends: ours sends and answers "settled",
 * so confirmGroup keeps its "sent" mark and the order is counted once; another run's answers "already" (that run
 * sends, and confirmGroup keeps no mark on "already", so if it fails the next run sends); unknown throws, nothing sent.
 */
async function receiptForPaid(input: Parameters<typeof settleGroup>[0], group: Group): Promise<SettleOutcome> {
  if (group.revoked || now() - (group.paid ?? 0) > RECEIPT_LATE_SECONDS) return "already";
  const claimed = await claimMark(`${groupKey(group.id)}:settling`, 300, claimValue());
  if (claimed === "taken") return "already";
  if (claimed === "unknown") throw new UnknownReplyError("a purchase for several's settling mark");
  await paidReceipt(input, group);
  return "settled";
}

/** The payer's receipt with the places link, under its own idempotency key. */
async function paidReceipt(input: Parameters<typeof settleGroup>[0], group: Group): Promise<void> {
  await sendReceipt({ ...input, group, lead: givingWords(input.store.language).thanksReceipt(input.store.name), idempotencyKey: `nimbus-group-receipt:${group.id}` }).catch((error) =>
    console.error("a receipt for several people failed", error),
  );
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

/**
 * A place taken: the address, when, and the value only the run that took it wrote (`k`, lib/claim-mark.ts claimValue;
 * Claude 6 on #2872), so a run lets go of a place's record only while it is its own. Records written before `k` have
 * none, and no run lets them go. `n`, once counted, is the count the place's own INCR answered (COUNT_OWN).
 */
type Member = { e: string; at: number; k?: string; n?: number };

/**
 * Deletes a place's record only while it still holds exactly what this run wrote (Claude 6 on #2872; CX-123 rules 25
 * and 30), in one script, as releaseMark does for a mark: a run whose own write is unknown never deletes the place
 * another run of the same link holds. The first line names it for the local stand-in (lib/redis-memory.ts).
 */
const HDEL_OWN = '-- marktmorgen:hdel-own:v1\nif redis.call("HGET", KEYS[1], ARGV[1]) == ARGV[2] then return redis.call("HDEL", KEYS[1], ARGV[1]) else return 0 end';

/**
 * Counts a place once, by a run's own hold (Claude 4 and Claude 1 on #2872, L1; CX-123 rules 24 and 30): while the
 * record is exactly the hold, INCR the count and write the record again with that count in it (ARGV[3] is the hold
 * without its closing brace, then `,"n":`), answering the count; while it already carries a count of this hold,
 * answer that count again, moving nothing; anything else answers 0. So a run whose reply came back in another shape
 * reads its own count from the record, never counting twice and never losing a place counted unseen. The first line
 * names it for the local stand-in (lib/redis-memory.ts).
 */
const COUNT_OWN =
  '-- marktmorgen:grp-count-own:v1\nlocal held = redis.call("HGET", KEYS[1], ARGV[1])\nif held == ARGV[2] then local n = redis.call("INCR", KEYS[2]); redis.call("HSET", KEYS[1], ARGV[1], ARGV[3] .. n .. "}"); return n end\nif type(held) == "string" and string.sub(held, 1, string.len(ARGV[3])) == ARGV[3] then return tonumber(string.sub(held, string.len(ARGV[3]) + 1, -2)) end\nreturn 0';

function parseMember(raw: unknown): Member | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<Member>;
    return typeof value.e === "string" && value.e ? { e: value.e, at: typeof value.at === "number" ? value.at : 0 } : null;
  } catch {
    return null;
  }
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

  // Whether this address holds a place, and how many are taken, read exactly (sweep A3; CX-123 rule 24): an answer
  // in another shape sends nothing and says so ("unavailable": nothing was taken or lost), never "nobody, none".
  const looked = repliesFor(await redisPipeline([
    ["HEXISTS", membersKey(group.id), addressHash(email)],
    ["GET", takenKey(group.id)],
  ]), 2);
  const held = looked?.[0];
  const takenRaw = looked?.[1];
  const taken = takenRaw === null ? 0 : typeof takenRaw === "string" && /^\d{1,15}$/.test(takenRaw) ? Number(takenRaw) : null;
  if (!looked || (held !== 0 && held !== 1) || taken === null) return "unavailable";
  const has = held === 1;
  if (!has && taken >= group.people) return "full";

  // The link can be passed to anybody, and each address typed on it is sent
  // one email: counted per purchase and per day, generously for a real team
  // and far short of a way to fill inboxes. The count read exactly (sweep A3;
  // CX-123 rule 24): unknown sends nothing, never an email past the cap.
  const sentCount = countOf(repliesFor(await redisPipeline([["INCR", mailKey(group.id)]]), 1)?.[0]);
  if (sentCount === null) return "unavailable";
  if (sentCount === 1) await redisPipeline([["EXPIRE", mailKey(group.id), 86_400]]);
  if (sentCount > group.people * 3 + 10) return "slow";
  // The email is one of the store's access emails, taken as it is sent
  // (lib/email.ts); when the month's are used, the person is told so here.
  if ((await allowanceUsed(store, "transactional")) >= allowanceFor(store, "transactional")) return "resting";

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
  /** The address holds a record of a place but the product is not on it: nothing can be confirmed yet. */
  | { outcome: "pending"; email: string; group: Group }
  | { outcome: "gone" };

/** Whether the room its checkout held for its places is still held now (lib/order-admission.ts). */
export function placesHeld(group: Pick<Group, "h">, nowMs = Date.now()): boolean {
  return typeof group.h === "number" && Math.floor(nowMs / 3_600_000) - group.h < OPEN_HOURS - 1;
}

/**
 * Opens the link from a place's email: takes a place for its address, once.
 * "already" is the same address opening its link again; "has" is an address
 * that owns the product some other way, which takes no place; "pending" is an
 * address holding a record of a place whose product is not on it (another run
 * still handing it over, or a record a give-back could not remove), which is
 * never said to be a place taken.
 */
export async function takePlace(input: {
  store: Store;
  token: string;
  recordStart: (email: string, courseProductId: string, startSeconds: number) => Promise<void>;
}): Promise<Taken> {
  const { store } = input;
  if (!PLACE_TOKEN.test(input.token) || !isRedisConfigured()) return { outcome: "gone" };
  const [raw] = await redisPipeline([["GET", tokenKey(input.token)]]);
  let asked: { g?: unknown; e?: unknown } = {};
  try {
    asked = typeof raw === "string" ? (JSON.parse(raw) as typeof asked) : {};
  } catch {}
  if (typeof asked.g !== "string" || typeof asked.e !== "string" || !asked.e) return { outcome: "gone" };
  const group = await openGroup(store, asked.g);
  if (!group) return { outcome: "gone" };
  const email = asked.e;
  const who = addressHash(email);

  // Every answer that decides a place read exactly (sweep A3; CX-123 rule 24): unknown hands nothing out and throws
  // (the page says the place was not taken), never a place past the number paid for, never "already" on nothing.
  const looked = repliesFor(await redisPipeline([
    ["HEXISTS", membersKey(group.id), who],
    ["HEXISTS", importedKey(group.s, email), group.p],
  ]), 2);
  const mine = looked?.[0];
  const owned = looked?.[1];
  if (!looked || (mine !== 0 && mine !== 1) || (owned !== 0 && owned !== 1)) throw new UnknownReplyError("a place's holder");
  // "already" only when the product is on the address: a record without it is never said to be a place taken.
  if (mine === 1) return { outcome: owned === 1 ? "already" : "pending", email, group };
  // Given it some other way already: no place is used for it.
  if (owned === 1) return { outcome: "has", email, group };

  const at = now();
  // The hold carries a value only this run writes, so only this run's own hold is ever let go (Claude 6 on #2872).
  const hold = JSON.stringify({ e: email, at, k: claimValue() } satisfies Member);
  // Once counted, the same record with the count its own INCR answered (COUNT_OWN): what a run reads back to learn
  // whether its count moved, and the exact value its give-back deletes.
  const countedAs = `${hold.slice(0, -1)},"n":`;
  const dropOwn = (value: string): (string | number)[] => ["EVAL", HDEL_OWN, 1, membersKey(group.id), who, value];
  // Let go of this address's hold on a place it was not given, so its link works again on a later try, and only while
  // the record is still this run's own and not counted: a hold whose write came back unknown may be another run's of
  // the same link (a double click), whose place is the one a refund takes back. When the script cannot run, the hold
  // stays and the link says "pending" with nothing more handed out; never another run's record deleted.
  const letGo = () => redisPipeline([dropOwn(hold)]).catch(() => null);
  const fresh = repliesFor(await redisPipeline([["HSETNX", membersKey(group.id), who, hold]]), 1)?.[0];
  if (fresh === 0) {
    // Another run of the same link holds the place (a double click) and may still end "full", "resting" or "has":
    // "already" only once the product is on the address, read exactly; before that, "pending" (#2872 review).
    const onIt = repliesFor(await redisPipeline([["HEXISTS", importedKey(group.s, email), group.p]]), 1)?.[0];
    if (onIt !== 0 && onIt !== 1) throw new UnknownReplyError("a place's holder");
    return { outcome: onIt === 1 ? "already" : "pending", email, group };
  }
  if (fresh !== 1) {
    await letGo();
    throw new UnknownReplyError("a place's hold");
  }
  // The place counted once, by this run's own hold (Claude 4 and Claude 1 on #2872, L1): the script moves the count
  // and writes it into the record in one step, so a reply in another shape is read back from the record. The record
  // still this run's hold: the count did not move, the hold is let go and the run refuses. Holding a count: that is
  // this run's place, and the run goes on with it, never a paid place lost to a count that moved unseen. Anything else
  // (unread, another value) refuses and leaves the record as it is.
  let count = countOf(repliesFor(await redisPipeline([["EVAL", COUNT_OWN, 2, membersKey(group.id), takenKey(group.id), who, hold, countedAs]]).catch(() => null), 1)?.[0]);
  if (count === null) {
    const back = repliesFor(await redisPipeline([["HGET", membersKey(group.id), who]]).catch(() => null), 1)?.[0];
    if (back === hold) {
      await letGo();
      throw new UnknownReplyError("the count of places taken");
    }
    const kept = typeof back === "string" && back.startsWith(countedAs) && back.endsWith("}") ? back.slice(countedAs.length, -1) : "";
    count = /^\d{1,15}$/.test(kept) ? Number(kept) : null;
    if (count === null) throw new UnknownReplyError("the count of places taken");
  }
  // 0: the record is no longer this run's hold (taken back meanwhile): nothing was counted, nothing is handed over.
  if (count < 1) throw new UnknownReplyError("a place's hold");
  const counted = `${countedAs}${count}}`;
  // The place given back: this run's own counted record (the same script) and the count its own script moved. Upstash
  // runs each command of a pipeline on its own, so the script can fail while the DECR lands and the call throws: the
  // run keeps its answer ("full", "resting", "has") and tries the script once more alone, never the DECR again
  // (whether it moved is unknown; at worst a place stays counted). A record the retry cannot remove reads "pending",
  // never "already" (#2872 review).
  const giveBack = async () => {
    const replies = repliesFor(await redisPipeline([dropOwn(counted), ["DECR", takenKey(group.id)]]).catch(() => null), 2);
    if (!replies || (replies[0] !== 0 && replies[0] !== 1)) await redisPipeline([dropOwn(counted)]).catch(() => null);
  };
  if (count > group.people) {
    await giveBack();
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
  await redisPipeline([
    ["EXPIRE", membersKey(group.id), GROUP_KEPT_SECONDS],
    ["EXPIRE", takenKey(group.id), GROUP_KEPT_SECONDS],
  ]);

  let given: boolean;
  try {
    [given] = await grantImported(group.s, groupJob(group.id), [{ email, productId: group.p, items: group.items ?? null, option: group.o ?? null }], at, store.sid);
  } catch (error) {
    // The grant answered in another shape (Claude 1 on #2872, N1): whether the product is on the address is read
    // exactly. Not on it: the place is given back (and the room admitted for it), so the same link takes it on a later
    // try, never a paid place reading "pending" for the link's whole day. On it: handed over, and the run goes on.
    // Unknown: nothing is changed and the run refuses.
    const onIt = repliesFor(await redisPipeline([["HEXISTS", importedKey(group.s, email), group.p]]).catch(() => null), 1)?.[0];
    if (onIt !== 1) {
      if (onIt === 0) {
        await giveBack();
        if (!held && hour !== null) await settleAdmitted(store, hour);
      }
      throw error;
    }
    given = true;
  }
  if (!given) {
    // It reached this address another way in the same instant.
    await giveBack();
    if (!held && hour !== null) await settleAdmitted(store, hour);
    return { outcome: "has", email, group };
  }
  // The doors that read what an address was given are opened for this store.
  if (!store.pastBuyers) await setPastBuyers(storeRef(store));
  // A course is dated from the day its place was taken, so what opens over
  // time opens on time for each person.
  for (const id of [group.p, ...(group.items ?? [])]) await input.recordStart(email, id, at);
  // Each place taken is one of the month's orders (lib/orders.ts). The
  // purchase was paid, so it is covered wherever its sale paid a share.
  await countOrder(store, `place:${group.id}:${who}`, group.paid ? 1 : 0);
  // Counted now, so what was held for it is given back (lib/order-admission.ts).
  if (hour !== null) await settleAdmitted(store, hour);
  return { outcome: "taken", email, group };
}

/** A write of one item (SADD of one member, HDEL of one field) answers 0 or 1; anything else is unknown. */
const oneWrite = (reply: unknown): boolean => reply === 0 || reply === 1;
/** Where a pass over the refunds stands between runs: its start, the page it continues from, the newest refund read. */
type RefundPass = { since: number; after: string; newest: number };
function readPass(raw: unknown): RefundPass | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  try {
    const pass = JSON.parse(raw) as Partial<RefundPass>;
    if (Number.isSafeInteger(pass.since) && Number.isSafeInteger(pass.newest) && typeof pass.after === "string" && /^[A-Za-z0-9_]{3,255}$/.test(pass.after)) {
      return { since: pass.since as number, after: pass.after, newest: pass.newest as number };
    }
  } catch {}
  return undefined;
}

/**
 * Takes back the places of purchases refunded in full: reads the store's
 * refunds since it last looked, finds the purchase each paid for, and removes
 * it from every address that took a place. Returns how many places went.
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
 */
export async function revokeRefundedGroups(
  store: Store,
  deadline: number,
  dropStart: (email: string, courseProductId: string) => Promise<void>,
): Promise<number> {
  if (!store.statsId || !store.stripeAccountId || !isRedisConfigured()) return 0;
  const sid = store.statsId;
  const account = store.stripeAccountId;
  const begun = repliesFor(await redisPipeline([["GET", anyKey(sid)], ["GET", anchorKey(sid)], ["GET", passKey(sid)]]), 3);
  if (!begun) return 0;
  const [any, anchorRaw, passRaw] = begun;
  if (!any) return 0;
  // The anchor read exactly: in another shape, no pass starts (Claude 4 on #2781), never one from a week back.
  if (anchorRaw !== null && (typeof anchorRaw !== "string" || !/^\d{1,12}$/.test(anchorRaw))) return 0;
  const kept = readPass(passRaw);
  // A pass kept in an unknown shape is started again from the anchor, which never moved past it.
  const since = kept ? kept.since : Math.max(0, (Number(anchorRaw) || now() - 7 * 86_400) - 300);
  let newest = kept ? kept.newest : Number(anchorRaw) || since;
  let after = kept ? kept.after : "";
  let revoked = 0;

  /** One refund row read whole: false when something it needed was left unknown, and then it is not marked handled. */
  const handle = async (refund: Record<string, unknown>): Promise<boolean> => {
    const id = refund.id as string;
    const pi = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
    const charge = refund.charge as { refunded?: unknown } | null;
    if (!pi || refund.status !== "succeeded" || charge?.refunded !== true) return true;
    const looked = repliesFor(await redisPipeline([["SISMEMBER", seenKey(sid), id], ["GET", piKey(pi)]]), 2);
    const handled = countOf(looked?.[0]);
    const groupId = looked?.[1];
    if (!looked || handled === null || handled > 1 || (groupId !== null && typeof groupId !== "string")) return false;
    if (handled === 1) return true;
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

  /** One page of refunds: its rows read in their exact shape, or null when the page itself could not be read. */
  const readPage = async (from: string): Promise<StripePage | null> => {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge");
    if (from) query.set("starting_after", from);
    try {
      return readStripePage(await onAccount("GET", account, `/refunds?${query}`, undefined, STRIPE_LIST_VERSION), refundRowKnown);
    } catch (error) {
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
      // Only a refund in full is ever kept here (handle reads nothing else), so it is read again as one.
      if (await handle({ id, payment_intent: pi, status: "succeeded", charge: { refunded: true } })) {
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
    for (const refund of top?.rows ?? []) {
      if (Date.now() >= deadline) return revoked;
      await handle(refund);
    }
  }
  for (let page = 0; page < pages; page += 1) {
    if (Date.now() >= deadline) return revoked;
    const read = await readPage(after);
    if (!read) return revoked;
    let whole = read.unreadable === 0;
    for (const refund of read.rows) {
      if (Date.now() >= deadline) return revoked;
      // A refund on a readable row is taken back whatever the other rows. One whose work was left unknown is kept to
      // be tried again first on the next runs, and the pass goes on; when it cannot be kept for sure, the page stays.
      if (!(await handle(refund)) && !(await later(refund))) whole = false;
    }
    // A page with a row not readable, or a row neither handled nor kept for later, is read again next run.
    if (!whole) return revoked;
    for (const refund of read.rows) newest = Math.max(newest, refund.created as number);
    if (!read.hasMore) {
      const ended = repliesFor(await redisPipeline([["SET", anchorKey(sid), String(newest)], ["DEL", passKey(sid)]]), 2);
      if (!ended) console.error("ending a pass over group refunds was left unknown");
      return revoked;
    }
    // More pages, and no readable last row to read them from: not read whole.
    if (!read.lastId) return revoked;
    after = read.lastId;
    await redisPipeline([["SET", passKey(sid), JSON.stringify({ since, after, newest } satisfies RefundPass), "EX", PASS_SECONDS]]);
  }
  return revoked;
}
