/**
 * Members moved from another platform (lib/move-rules.ts says what it is):
 * the invitation each one is given by an import (lib/imports.ts, "members"),
 * the email that carries their link, the one reminder, and the checkout the
 * link opens.
 *
 *   nl:mv:<statsId>          address hash:product -> { e, p, o, r, job, at, t, kept }
 *   nl:mv:link:<token>       who a link is for: { s, f }, until LINK_DAYS after the renewal date
 *   nl:mv:due                reminders waiting: "<store id>|<field>", by when each goes
 *
 * Nothing here gives anybody anything: an invitation is an offer to keep a
 * membership by paying for it, from the renewal date on. A member who keeps
 * it holds an ordinary membership on the creator's Stripe account, and every
 * door reads that, as it reads any other.
 */
import { type DigitalConsent, DigitalConsentMissing } from "@/lib/digital-consent";
import { OrdersPausedError } from "@/lib/order-admission";
import { randomBytes } from "node:crypto";
import { EMAIL_PATTERN, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Listing, Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { addressHash } from "@/lib/imported-purchases";
import { canSellProduct, createCheckout } from "@/lib/store-checkout";
import { namedPriceGone, namedPriceOffered, withInvitedOption } from "@/lib/product-option";
import { withStockHold } from "@/lib/stock";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { storeBase } from "@/lib/purchase-email";
import { membershipLine, speech } from "@/lib/buyer-words";
import { moveWords } from "@/lib/buyer-words/move";
import { activeIntro } from "@/lib/intro-price";
import { firstChargeAt, linkSeconds, reminderAt } from "@/lib/move-rules";
import { dataKey, giveData, needData } from "@/lib/store-data";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { takePublicRequest } from "@/lib/traffic";
import { AFFILIATE_STRIPE_PAGES_PER_UNIT } from "@/lib/public-read-rules";
import { dataBytes } from "@/lib/store-data-rules";

const invitesKey = (statsId: string) => `nl:mv:${statsId}`;
export const linkKey = (token: string) => `nl:mv:link:${token}`;
const DUE_KEY = "nl:mv:due";
/** The slot invites are counted in, in the store's data room. */
const INVITES_SLOT = "mv";
/** The most bytes of invitations the studio reads to count them per price (one studio request's included bytes, less room). */
export const INVITED_READ_BYTES = 40_000;
const TOKEN_PATTERN = /^[0-9a-f]{40}$/;
const FIELD_PATTERN = /^[0-9a-f]{32}:[A-Za-z0-9_-]{1,64}$/;
const LIVE = new Set(["active", "trialing", "past_due"]);
/** Every status Stripe gives a subscription (https://docs.stripe.com/api/subscriptions/object, read 10/11/2026). */
const SUB_STATUSES = new Set(["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"]);

/**
 * Whether one subscription row is a live membership to this product: true or false only when the row reads (rule 24,
 * Codex CX1's MEDIUM on #3598). A row that is not an object, a status Stripe has no name for, or metadata that is not
 * a map of strings (missing, null, a product that is a number) is null, never "not a member". Empty metadata reads.
 */
function liveRow(sub: unknown, productId: string): boolean | null {
  if (!sub || typeof sub !== "object" || Array.isArray(sub)) return null;
  const { status, metadata } = sub as { status?: unknown; metadata?: unknown };
  if (typeof status !== "string" || !SUB_STATUSES.has(status)) return null;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  if (!Object.values(metadata).every((value) => typeof value === "string")) return null;
  return LIVE.has(status) && (metadata as Record<string, string>).product === productId;
}

/** One member invited to keep their membership here. */
export type Invite = {
  /** The address in the creator's file, as it is written to. */
  e: string;
  /** The membership, and the price option they had, if it has several. */
  p: string;
  o: string;
  /** The day it would have renewed on the old platform, noon UTC, in seconds. */
  r: number;
  /** The import that brought it, and when. */
  job: string;
  at: number;
  /** The token of their link. */
  t: string;
  /** When they kept it here, in seconds; 0 until then; KEPT_UNKNOWN when the record does not say. */
  kept: number;
  /** Set when the record's kept could not be read: taken as used, never as unused (Codex C2, Revisor 1 on #2685). */
  keptUnknown?: true;
};

/**
 * The kept of a record whose kept cannot be read. Not 0, so every "not yet kept" check (openMove, the emails, the
 * moving-in page) takes it as used: no price taken off sale reopens to it and no email goes. The record itself is
 * still read, so the person's copy shows it and their erasure deletes it.
 */
export const KEPT_UNKNOWN = -1;
/** How long a moving-in checkout stays the one an invitation opens: Stripe's own life of a checkout, and a minute. */
const OPEN_SECONDS = 86_400 + 60;
const openKey = (statsId: string, field: string) => `nl:mv:open:${statsId}:${field}`;

export const inviteField = (email: string, productId: string) => `${addressHash(email)}:${productId}`;

function parseInvite(raw: unknown): Invite | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Invite>;
    if (typeof v.e !== "string" || typeof v.p !== "string" || typeof v.r !== "number" || typeof v.t !== "string") return null;
    // When it was kept, exactly (Codex C2 on #2685): a whole number of seconds, 0 for not yet. Anything else cannot
    // say whether the invitation was used, so it is KEPT_UNKNOWN: taken as used, never as unused, which would reopen a
    // price taken off sale to it (withInvitedOption). The record is still read, for the person's copy and erasure
    // (Revisor 1 on #2685).
    const keptAt: unknown = v.kept;
    const known = typeof keptAt === "number" && Number.isSafeInteger(keptAt) && keptAt >= 0;
    return { e: v.e, p: v.p, o: typeof v.o === "string" ? v.o : "", r: v.r, job: typeof v.job === "string" ? v.job : "", at: Number(v.at) || 0, t: v.t, kept: known ? keptAt : KEPT_UNKNOWN, ...(known ? {} : { keptUnknown: true as const }) };
  } catch {
    return null;
  }
}

export async function readInvite(statsId: string, field: string): Promise<Invite | null> {
  if (!FIELD_PATTERN.test(field) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["HGET", invitesKey(statsId), field]]);
  return parseInvite(raw);
}

/**
 * One invitation as kept, for the person's data copy (619 [SZ3]): null is none
 * kept; "unknown" is a reply in an unknown shape (a missing reply, anything but
 * text or null) or a record that does not read, never taken as none, so the
 * copy fails and is made again rather than leaving it out (CX-123 rule 24).
 */
export async function inviteForCopy(statsId: string, field: string): Promise<Invite | null | "unknown"> {
  if (!FIELD_PATTERN.test(field) || !isRedisConfigured()) return null;
  const replies: unknown = await redisPipeline([["HGET", invitesKey(statsId), field]]);
  // The one reply, from the list's own data slot: a missing reply, a hole or a getter is unknown.
  const slot = Array.isArray(replies) && replies.length === 1 ? Object.getOwnPropertyDescriptor(replies, "0") : undefined;
  if (!slot || !Object.hasOwn(slot, "value")) return "unknown";
  if (slot.value === null) return null;
  return parseInvite(slot.value) ?? "unknown";
}

/**
 * Invites many members in one round trip: each one's record, link and
 * reminder. Returns, for each, the field it is kept under when it is new, or
 * null when that address was already invited to that membership.
 */
export async function inviteMembers(
  store: Store,
  job: string,
  rows: { email: string; productId: string; option: string; renews: number }[],
  now = Date.now(),
  /**
   * The store's prints key and how one address is printed (lib/suppression.ts), for an import: each record is then
   * written only when its address was not deleted from the store, in the same step (INVITE_UNLESS_ERASED), and a
   * deleted one answers false, nothing written. Throws when that step's answer is not exact (CX-123 rule 24).
   */
  erased: { key: string; print: (email: string) => string } | null = null,
): Promise<(string | null | false)[]> {
  const statsId = store.statsId;
  if (!rows.length || !statsId || !store.sid || !isRedisConfigured()) return rows.map(() => null);
  const at = Math.floor(now / 1000);
  const made = rows.map((row) => {
    const field = inviteField(row.email, row.productId);
    const token = randomBytes(20).toString("hex");
    const value = JSON.stringify({ e: normaliseEmail(row.email), p: row.productId, o: row.option, r: row.renews, job, at, t: token, kept: 0 } satisfies Invite);
    // Its record for as long as the store is, its link until it expires
    // (lib/store-data.ts); the record is counted once more when it is kept,
    // which writes it again at the most a little longer.
    return { row, field, token, value, bytes: dataBytes([field, value, '"kept":0000000000'], 1), link: dataBytes([linkKey(token), JSON.stringify({ s: statsId, f: field })], 1) };
  });
  // Taken before anything is written: an import past the store's room stops
  // with DataRoomError and says so (lib/imports.ts).
  const longest = Math.max(...made.map(({ row }) => linkSeconds(row.renews, now)));
  await needData(store, [
    { slot: INVITES_SLOT, bytes: made.reduce((sum, m) => sum + m.bytes, 0) },
    { until: now + longest * 1000, bytes: made.reduce((sum, m) => sum + m.link, 0) },
  ], now);
  const answers = erased ? await invitedUnlessErased(statsId, made, erased) : await redisPipeline(made.map(({ field, value }) => ["HSETNX", invitesKey(statsId), field, value]));
  const fresh = made.filter((_, i) => Number(answers[i]) === 1);
  // An address already invited to that membership, or deleted from the store, was not written: its room goes back.
  const already = made.filter((_, i) => Number(answers[i]) !== 1).reduce((sum, m) => sum + m.bytes, 0);
  if (already > 0) await giveData(store, [{ slot: INVITES_SLOT, bytes: already }], now);
  if (fresh.length) {
    const reminders = fresh.flatMap(({ row, field }) => {
      const when = reminderAt(row.renews, now);
      return when ? [when, `${store.sid}|${field}`] : [];
    });
    await redisPipeline([
      ...fresh.map(({ row, field, token }) => ["SET", linkKey(token), JSON.stringify({ s: statsId, f: field }), "EX", linkSeconds(row.renews, now)]),
      ...(reminders.length ? [["ZADD", DUE_KEY, ...reminders]] : []),
    ]);
  }
  return made.map(({ field }, i) => (Number(answers[i]) === 1 ? field : Number(answers[i]) === -1 ? false : null));
}

/**
 * Invitations written only for addresses not deleted from the store, in one
 * step with the check (review of #3383, as lib/suppression.ts
 * KEEP_UNLESS_ERASED): KEYS[1] the store's prints, KEYS[2] the store's
 * invitations; ARGV, for each, its address's print, its field and its record.
 * One HMGET; a print found writes nothing and answers -1, otherwise HSETNX
 * (1 new, 0 already). Billed 1 + 1 + 1 an invitation at most, the same HSETNX
 * as before; lib/redis-memory.ts runs it the same way.
 */
export const INVITE_UNLESS_ERASED = `-- marktmorgen:invite-unless-erased:v1
local n = math.floor(#ARGV / 3)
local prints = {}
for i = 1, n do prints[i] = ARGV[3 * i - 2] end
local found = redis.call("HMGET", KEYS[1], unpack(prints))
local out = {}
for i = 1, n do
  if found[i] then
    out[i] = -1
  else
    out[i] = redis.call("HSETNX", KEYS[2], ARGV[3 * i - 1], ARGV[3 * i])
  end
end
return out`;

/** Runs INVITE_UNLESS_ERASED; its answer read exactly, one of -1, 0 or 1 for each, or it throws. */
async function invitedUnlessErased(statsId: string, made: { row: { email: string }; field: string; value: string }[], erased: { key: string; print: (email: string) => string }): Promise<number[]> {
  const replies = await redisPipeline([["EVAL", INVITE_UNLESS_ERASED, 2, erased.key, invitesKey(statsId), ...made.flatMap(({ row, field, value }) => [erased.print(row.email), field, value])]]);
  const reply: unknown = Array.isArray(replies) && replies.length === 1 ? replies[0] : null;
  if (!Array.isArray(reply) || reply.length !== made.length || !reply.every((a) => a === -1 || a === 0 || a === 1)) {
    throw new Error("the invitations could not be checked where they are written");
  }
  return reply as number[];
}

/** How many members a store invited, and how many kept their membership here. */
export async function moveCounts(store: Store): Promise<{ invited: number; kept: number }> {
  if (!store.statsId || !isRedisConfigured()) return { invited: 0, kept: 0 };
  const [all] = await redisPipeline([["HVALS", invitesKey(store.statsId)]]);
  const invites = (Array.isArray(all) ? all : []).map(parseInvite).filter((i): i is Invite => i !== null);
  // An invitation whose state cannot be read (KEPT_UNKNOWN) is in neither column: not a guess either way.
  const known = invites.filter((i) => !i.keptUnknown);
  return { invited: known.length, kept: known.filter((i) => i.kept > 0).length };
}

/**
 * How many invitations to move here, not yet kept, name each of these price options of one product (642 [WG2]):
 * the studio says them apart from the members already paying, so a price taken off sale never reads as nobody on
 * their way. One HVALS of the store's invitations, read in its exact shape: a list of records every one of which
 * reads as an invitation. Anything else (no reading, a reply that is not a list, a record that does not read)
 * makes every count unknown (null), never 0; 0 only when the whole list was read and none names the option.
 */
export async function pendingInvitesOnOptions(store: Store, productId: string, optionIds: string[], maxBytes = INVITED_READ_BYTES, now = Date.now()): Promise<Record<string, number | null>> {
  const unknown = Object.fromEntries(optionIds.map((id) => [id, null])) as Record<string, number | null>;
  if (!store.statsId || !isRedisConfigured()) return unknown;
  // Bounded before anything is transferred (Codex Z on #2690): the invitations' bytes as the store's data room
  // counts them when they are written (INVITES_SLOT, at least every field and value), and how many there are. None
  // at all is a proved 0; more bytes than the bound, or invitations with no count of their bytes (written before it
  // was kept), are unknown, and the list is not read.
  const room = dataKey(store);
  let many: number | null;
  try {
    const sized = repliesFor(await redisPipeline([["HLEN", invitesKey(store.statsId)], ...(room ? [["HGET", room, INVITES_SLOT]] : [])]), room ? 2 : 1);
    many = sized ? countOf(sized[0]) : null;
    if (many === null) return unknown;
    if (many === 0) return Object.fromEntries(optionIds.map((id) => [id, 0])) as Record<string, number | null>;
    const counted = sized && room && typeof sized[1] === "string" && /^\d{1,12}$/.test(sized[1]) ? Number(sized[1]) : null;
    if (counted === null || counted > maxBytes) return unknown;
  } catch {
    return unknown;
  }
  let reply: unknown;
  try {
    const receipt: unknown = await redisPipeline([["HVALS", invitesKey(store.statsId)]]);
    if (!Array.isArray(receipt) || receipt.length !== 1) return unknown;
    reply = receipt[0];
  } catch {
    return unknown;
  }
  // The list read must be the whole of what was counted (Codex T on #2690): a list shorter or longer than HLEN said
  // (an empty list for invitations that exist, a cut reply, a write between the two reads) is unknown, never a count.
  if (!Array.isArray(reply) || reply.length !== many) return unknown;
  const counts = Object.fromEntries(optionIds.map((id) => [id, 0])) as Record<string, number | null>;
  // Each record must be a different invitation (Codex T on #2690): its identity is the field it is kept under, so
  // HLEN records with HLEN different identities are the whole hash. A record seen twice is a reply nobody can trust.
  const identities = new Set<string>();
  for (let at = 0; at < reply.length; at += 1) {
    const slot = Object.getOwnPropertyDescriptor(reply, String(at));
    const invite = slot && Object.hasOwn(slot, "value") ? parseInvite(slot.value) : null;
    if (!invite) return unknown;
    const identity = inviteField(invite.e, invite.p);
    if (identities.has(identity)) return unknown;
    identities.add(identity);
    if (invite.p !== productId || !Object.hasOwn(counts, invite.o)) continue;
    // One whose state cannot be read: not a guess either way (Claude 4 on #2690).
    if (invite.kept < 0) return unknown;
    if (invite.kept > 0) continue;
    // Only while its link still works: the link lives linkSeconds from the day it was sent (lib/move-rules.ts).
    if (invite.at + linkSeconds(invite.r, invite.at * 1000) <= Math.floor(now / 1000)) continue;
    counts[invite.o] = (counts[invite.o] ?? 0) + 1;
  }
  return counts;
}

/** Marks an invitation kept: the member paid, or their membership was found live. */
export async function noteKept(store: Store, email: string, productId: string, now = Date.now()): Promise<void> {
  if (!store.statsId || !store.sid || !isRedisConfigured()) return;
  const field = inviteField(email, productId);
  const invite = await readInvite(store.statsId, field);
  if (!invite || invite.kept) return;
  await redisPipeline([
    ["HSET", invitesKey(store.statsId), field, JSON.stringify({ ...invite, kept: Math.floor(now / 1000) })],
    ["ZREM", DUE_KEY, `${store.sid}|${field}`],
  ]);
}

/** What a member's page and emails say about the payments: the first one here, and the price as it goes on. */
export function priceWords(store: Store, product: Listing, optionId: string): { amount: string; line: string } | null {
  if (!product.recurring) return null;
  // The price the email named, or nothing: never another option, nor the product's own price once its option is gone.
  // Nor one kept with nothing to hand over: the checkout does not offer it.
  if (!namedPriceOffered(product, optionId)) return null;
  const option = product.options.find((o) => o.id === optionId) ?? null;
  const say = speech(store);
  const regular = option ? option.priceCents : product.priceCents;
  const intro = option ? null : activeIntro(product, store.tiers);
  return {
    amount: say.money(intro ? intro.cents : regular),
    line: membershipLine(store, { ...product.recurring, trialDays: 0 }, say.money(regular), intro),
  };
}

/** The email that carries a member's link, or null when there is nothing it could say truly. */
export async function inviteEmail(store: Store, field: string, now = Date.now()): Promise<{ to: string; subject: string; text: string } | null> {
  if (!store.statsId) return null;
  const invite = await readInvite(store.statsId, field);
  if (!invite || invite.kept) return null;
  // The price their invitation names, even one the creator has since taken off sale (642 [WG2]): theirs to keep.
  const listing = await readListing(store, invite.p);
  const product = listing ? withInvitedOption(listing, invite.o) : null;
  if (!product?.recurring || !canSellProduct(store, product)) return null;
  const price = priceWords(store, product, invite.o);
  if (!price) return null;
  const m = moveWords(store.language);
  const say = speech(store);
  const first = firstChargeAt(invite.r, now);
  const link = `${storeBase(store)}/move/${encodeURIComponent(product.id)}?k=${invite.t}`;
  const until = say.date((Math.floor(now / 1000) + linkSeconds(invite.r, now)) * 1000);
  const text = [
    first ? m.inviteDeferred(store.name, product.title, price.amount, say.date(invite.r * 1000)) : m.inviteNow(store.name, product.title, price.amount),
    "",
    link,
    "",
    m.linkNote(until),
    "",
    first && reminderAt(invite.r, now) ? m.whyReminder(store.name, say.date(invite.r * 1000)) : m.whyOnce(store.name),
    m.sentBy(store.name),
  ].join("\n");
  return { to: invite.e, subject: m.inviteSubject(product.title, store.name).slice(0, 200), text };
}

/** The one reminder, for a member who has not kept it yet. */
export async function reminderEmail(store: Store, field: string, now = Date.now()): Promise<{ to: string; subject: string; text: string } | null> {
  if (!store.statsId) return null;
  const invite = await readInvite(store.statsId, field);
  if (!invite || invite.kept) return null;
  const first = firstChargeAt(invite.r, now);
  if (!first) return null;
  const listing = await readListing(store, invite.p);
  const product = listing ? withInvitedOption(listing, invite.o) : null;
  if (!product?.recurring || !canSellProduct(store, product)) return null;
  const price = priceWords(store, product, invite.o);
  if (!price) return null;
  const m = moveWords(store.language);
  const say = speech(store);
  const text = [
    m.reminderBody(store.name, product.title, price.amount, say.date(invite.r * 1000)),
    "",
    `${storeBase(store)}/move/${encodeURIComponent(product.id)}?k=${invite.t}`,
    "",
    m.reminderLast,
    m.sentBy(store.name),
  ].join("\n");
  return { to: invite.e, subject: m.reminderSubject(product.title).slice(0, 200), text };
}

/** How many customer records under one address keptAlready reads: more is not read whole, so it throws. */
const KEPT_CUSTOMERS_READ = 10;

/**
 * A Stripe list page's items, only when the page says it is whole: its `data` a list, `has_more` exactly false and no
 * more items than were asked for. Anything else is null, never an empty or complete list (B4, Claude 4 on #2685).
 */
function wholeList(page: Record<string, unknown>, limit: number): unknown[] | null {
  return Array.isArray(page.data) && page.has_more === false && page.data.length <= limit ? page.data : null;
}

/** Whether this address has a live membership to this product on the creator's account now. */
export async function keptAlready(store: Store, email: string, productId: string): Promise<boolean> {
  const account = store.stripeAccountId;
  if (!account || !EMAIL_PATTERN.test(email)) return false;
  // CX-123 rule 24 (rule 30 of Claude 4's sweep, C4-2890): a list without its data is unknown, never "not kept": it
  // throws, and sendMoveReminders puts the reminder back an hour instead of emailing someone who kept it. So is a list
  // cut short or that does not say it is whole (Claude 4's LEVE on #2685): a live membership may lie beyond it.
  const customers = wholeList(await onAccount("GET", account, `/customers?${new URLSearchParams({ email, limit: String(KEPT_CUSTOMERS_READ) })}`), KEPT_CUSTOMERS_READ);
  if (!customers) throw new Error("a member's customers did not read whole");
  for (const customer of customers) {
    const id = customer && typeof customer === "object" ? (customer as { id?: unknown }).id : undefined;
    // A customer without its id is unknown, never skipped: its membership may be the live one.
    if (typeof id !== "string" || !/^cus_[A-Za-z0-9]+$/.test(id)) throw new Error("a member's customer did not read");
    const subs = wholeList(await onAccount("GET", account, `/subscriptions?customer=${id}&status=all&limit=100`), 100);
    if (!subs) throw new Error("a member's subscriptions did not read whole");
    for (const sub of subs) {
      const live = liveRow(sub, productId);
      if (live === null) throw new Error("a member's subscription did not read");
      if (live) return true;
    }
  }
  return false;
}

/** Reminders due now, taken off the line: "<store id>|<field>". A reminder not sent is put back by the caller. */
export async function dueReminders(now = Date.now(), limit = 50): Promise<{ sid: string; field: string }[]> {
  if (!isRedisConfigured()) return [];
  const [due] = await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, 0, Math.floor(now / 1000), "LIMIT", 0, limit]]);
  const entries = (Array.isArray(due) ? due : []).map(String);
  if (entries.length) await redisPipeline([["ZREM", DUE_KEY, ...entries]]);
  return entries.flatMap((entry) => {
    const [sid, field] = [entry.slice(0, entry.indexOf("|")), entry.slice(entry.indexOf("|") + 1)];
    return sid && FIELD_PATTERN.test(field) ? [{ sid, field }] : [];
  });
}

/** Puts a reminder back in line, to be tried again in an hour. */
export async function remindLater(sid: string, field: string, now = Date.now()): Promise<void> {
  await redisPipeline([["ZADD", DUE_KEY, Math.floor(now / 1000) + 3_600, `${sid}|${field}`]]);
}

/** Who a member's link is for, on this store and membership, while it works. */
export async function readMove(store: Store, productId: string, token: string): Promise<(Invite & { field: string }) | null> {
  if (!TOKEN_PATTERN.test(token) || !store.statsId || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", linkKey(token)]]);
  if (typeof raw !== "string") return null;
  try {
    const link = JSON.parse(raw) as { s?: unknown; f?: unknown };
    if (link.s !== store.statsId || typeof link.f !== "string") return null;
    const invite = await readInvite(store.statsId, link.f);
    if (!invite || invite.p !== productId || invite.t !== token) return null;
    return { ...invite, field: link.f };
  } catch {
    return null;
  }
}

export type MoveOpen = { ok: true; url: string } | { ok: false; reason: "expired" | "unavailable" | "price" | "refused" | "consent" | "done" | "checking" | "unknown" };

/** The open mark's value once a try's outcome is not known (a checkout may exist): later presses say so. */
const OPEN_UNKNOWN = "unknown";

/** The checkout a member's link opens: this membership, this address, first charged on the renewal date. */
export async function openMove(
  store: Store,
  productId: string,
  token: string,
  origin: string,
  now = Date.now(),
  /** The box to start access at once, checked on the button's page (lib/digital-consent.ts). */
  consent: DigitalConsent | null = null,
): Promise<MoveOpen> {
  const invite = await readMove(store, productId, token);
  if (!invite) return { ok: false, reason: "expired" };
  // Kept already, or its state cannot be read (KEPT_UNKNOWN): the link opens nothing more, at any price, so one
  // member never holds two memberships from it (Revisor 1 on #2685). The page says it was moved only when it was;
  // a state that cannot be read is said to be unknown, never moved (Claude 4's MÉDIO on #2685), so nobody lets
  // their old membership lapse on our word.
  if (invite.keptUnknown) return { ok: false, reason: "unknown" };
  if (invite.kept !== 0) return { ok: false, reason: "done" };
  const stored: Product | null = await readProduct(store, productId);
  // A price the creator has since taken off sale stays open to this member alone while the invitation is not yet
  // kept (642 [WG2], C4-20261105-1945-C2-2): the checkout below gets the product with that option back on sale;
  // every other path reads the product as it is, and refuses it.
  const product: Product | null = stored && !invite.kept ? withInvitedOption(stored, invite.o) : stored;
  if (!product?.recurring) return { ok: false, reason: "unavailable" };
  // The option they had. One the creator has since taken away, even the last,
  // is not swapped for another or for the product's own price: the page says
  // that price is no longer offered, with a link to the product's page.
  if (namedPriceGone(product, invite.o)) return { ok: false, reason: "price" };
  // Not on sale now, or the option kept with nothing to hand over: the general answer, nothing charged.
  if (!canSellProduct(store, product) || !namedPriceOffered(product, invite.o)) return { ok: false, reason: "unavailable" };
  const option = product.options.length ? invite.o : undefined;
  // One invitation opens one checkout at a time (Claude 4 on #2690): pressed twice at once or again while it is open,
  // it is the same one, so one member never holds two memberships from it. Taken before Stripe is asked, for the
  // longest a checkout lives; an answer in any other shape than OK or nil opens nothing.
  const key = openKey(store.statsId as string, invite.field);
  const taken = repliesFor(await redisPipeline([["SET", key, "opening", "NX", "EX", OPEN_SECONDS]]), 1);
  if (!taken || (taken[0] !== "OK" && taken[0] !== null)) return { ok: false, reason: "refused" };
  if (taken[0] === null) {
    const open = repliesFor(await redisPipeline([["GET", key]]), 1);
    const url = open ? open[0] : null;
    // The checkout already opened for it, or one still being opened: never a second. A last try whose outcome is not
    // known says so (Revisor 1 on #2685), rather than "try again in a few minutes" for up to a day.
    if (typeof url === "string" && url.startsWith("https://")) return { ok: true, url };
    return { ok: false, reason: url === OPEN_UNKNOWN ? "checking" : "refused" };
  }
  /** Let go only when nothing was made at Stripe, so the invitation may be pressed again. */
  const release = () => redisPipeline([["DEL", key]]).catch(() => {});
  /** Kept for the longest a checkout lives, marked as an outcome not known, so later presses say so. */
  const keepUnknown = () => redisPipeline([["SET", key, OPEN_UNKNOWN, "XX", "EX", OPEN_SECONDS]]).catch(() => {});
  // Paid already in a checkout the thanks page and the sweep never saw (B4): Stripe shows the membership live, so
  // the link opens nothing more and says it was moved. Not read whole: nothing opened, the next press asks again.
  // Every Stripe page this press may read is counted before the first (Codex C2 on #2685): the customer records, one
  // subscription page each, and the checkout's closing time when its creation leaves it out, each a public request
  // unit at AFFILIATE_STRIPE_PAGES_PER_UNIT. Not counted (the store's month is used): nothing read, nothing opened.
  if (!(await takePublicRequest(store, "buyer", now, Math.ceil(MOVE_STRIPE_PAGES / AFFILIATE_STRIPE_PAGES_PER_UNIT)))) {
    await release();
    return { ok: false, reason: "unavailable" };
  }
  const live = await liveMembership(store, invite.e, productId);
  if (live === null) {
    await release();
    return { ok: false, reason: "refused" };
  }
  if (live) {
    // Moved, whatever the note says (Claude 4 A5 on #2690): a note that fails to be written is written by the next
    // press, the thanks page or the sweep, and the mark is let go either way, never left "opening" for a day.
    try {
      await noteKept(store, invite.e, productId, now);
    } catch (error) {
      console.error("noting a moved membership as kept failed", store.handle, error);
    } finally {
      await release();
    }
    return { ok: false, reason: "done" };
  }
  let asked = false;
  try {
    const held = await withStockHold(store, product, (holding) => {
      asked = true;
      return createCheckout(store, product, origin, option, { email: invite.e, noTrial: true, held: holding, moved: { firstChargeAt: firstChargeAt(invite.r, now) }, digitalConsent: consent });
    });
    if (!held.ok) {
      // Refused before Stripe was asked (no unit left, or the hold not taken): nothing made. A hold not recorded
      // after the checkout was made keeps the mark, so a second is not made while the first may be open.
      if (!asked || held.reason === "soldout") {
        await release();
        return { ok: false, reason: "unavailable" };
      }
      // The checkout may exist: said as a try still being checked, as every later press says it.
      await keepUnknown();
      return { ok: false, reason: "checking" };
    }
    // The mark lives as long as Stripe keeps this checkout open, and a minute (B2): a checkout on a store with
    // reminders closes in an hour, a held unit's in half an hour. Its closing time not read: the longest.
    // The time Stripe gave with the checkout is used first; read again only when that answer left it out (A3).
    const closes = held.value.expiresAt ?? (await checkoutCloses(store, held.value.id));
    const life = closes === null ? OPEN_SECONDS : Math.min(OPEN_SECONDS, Math.max(60, closes - Math.floor(Date.now() / 1000) + 60));
    await redisPipeline([["SET", key, held.value.url, "XX", "EX", life]]);
    return { ok: true, url: held.value.url };
  } catch (error) {
    // Let go only when nothing was made (B3): not asked yet, refused by the store's own rules before Stripe, or
    // refused by Stripe itself. A failure whose outcome is unknown (an answer lost on the way back, a timeout, a
    // server error) keeps the mark for the longest a checkout lives: the link opens nothing until then.
    const nothingMade =
      !asked || error instanceof OrdersPausedError || error instanceof DigitalConsentMissing || (error instanceof StripeError && error.status >= 400 && error.status < 500);
    if (nothingMade) await release();
    else await keepUnknown();
    // The store's orders for the month are reached (lib/order-admission.ts): not open right now, nothing charged.
    if (error instanceof OrdersPausedError) return { ok: false, reason: "unavailable" };
    // The box to start access at once was not checked: said beside it, nothing opened.
    if (error instanceof DigitalConsentMissing) return { ok: false, reason: "consent" };
    console.error("opening a moved member's checkout failed", store.handle, error);
    // Nothing made: try again. Not known: the same words every later press shows (Claude 4 on #2690).
    return { ok: false, reason: nothingMade ? "refused" : "checking" };
  }
}

/** When Stripe closes one checkout on the store's account (expires_at, in seconds); null when it cannot be read. */
async function checkoutCloses(store: Store, sessionId: string): Promise<number | null> {
  const account = store.stripeAccountId;
  if (!account || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
  try {
    const session = await onAccount("GET", account, `/checkout/sessions/${sessionId}`);
    const at: unknown = Object.hasOwn(session, "expires_at") ? session.expires_at : null;
    return typeof at === "number" && Number.isSafeInteger(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

/** Customer records under one address read for an invitation's press; more than this is not read whole (Codex C2 on #2685). */
export const MOVE_CUSTOMERS_READ = 5;
/** Stripe pages one press may read: the customer records, one subscription page each, and the checkout's closing time. */
export const MOVE_STRIPE_PAGES = 1 + MOVE_CUSTOMERS_READ + 1;

/**
 * Whether Stripe shows this address a live membership to this product, read whole (B4): true or false only from
 * complete lists in their exact shape; anything else (an error, a list cut short, a reply that is not a list) is
 * null, never "not a member".
 *
 * Known limit (Revisor 1 on #2685): Stripe's email filter matches the spelling exactly. The invitation's address is
 * kept in lower case, and every checkout this link opens is made with it, so a membership opened from the link is
 * found here. One the member opened elsewhere under another spelling is not; for those the invitation's kept mark
 * (noteKept, from the thanks page and the checkout sweep) is what closes the link.
 */
async function liveMembership(store: Store, email: string, productId: string): Promise<boolean | null> {
  const account = store.stripeAccountId;
  if (!account || !EMAIL_PATTERN.test(email)) return null;
  try {
    // At most MOVE_CUSTOMERS_READ records under the address: more is not read whole, so nothing opens (the cost bound).
    const customers = wholeList(await onAccount("GET", account, `/customers?${new URLSearchParams({ email, limit: String(MOVE_CUSTOMERS_READ) })}`), MOVE_CUSTOMERS_READ);
    if (!customers) return null;
    for (const customer of customers) {
      const id = customer && typeof customer === "object" ? (customer as { id?: unknown }).id : undefined;
      if (typeof id !== "string" || !/^cus_[A-Za-z0-9]+$/.test(id)) return null;
      const subs = wholeList(await onAccount("GET", account, `/subscriptions?customer=${id}&status=all&limit=100`), 100);
      if (!subs) return null;
      for (const sub of subs) {
        const live = liveRow(sub, productId);
        if (live === null) return null;
        if (live) return true;
      }
    }
    return false;
  } catch {
    return null;
  }
}

/**
 * Deletes the invitations an import gave one person to keep a membership
 * here, their links and their reminders (lib/person-erasure.ts). A
 * membership they already kept is the creator's Stripe record, not this.
 */
export async function forgetInvitesPerson(store: Pick<Store, "sid" | "statsId">, productIds: string[], email: string): Promise<number> {
  if (!store.statsId || !productIds.length || !isRedisConfigured()) return 0;
  const statsId = store.statsId;
  const fields = productIds.map((p) => inviteField(email, p));
  // CX-123 rule 24 (Claude 4, C4-2890): a reply out of its exact shape is unknown, never "no invitations": it throws,
  // so the erasure lists this part as not finished instead of reporting 0 while the invitation and its link stay.
  const rows = repliesFor(await redisPipeline([["HMGET", invitesKey(statsId), ...fields]]), 1)?.[0];
  if (!Array.isArray(rows) || rows.length !== fields.length || rows.some((row) => row !== null && typeof row !== "string")) {
    throw new UnknownReplyError("a person's invitations");
  }
  // An invitation kept under the person's field is deleted even when its record no longer reads: its field, schedule and
  // checkout mark are known from the field alone; only a link read from the record can be deleted by its token.
  const held = fields.flatMap((field, i) => (rows[i] === null ? [] : [{ field, invite: parseInvite(rows[i]) }]));
  if (!held.length) return 0;
  const links = held.flatMap((h) => (h.invite ? [linkKey(h.invite.t)] : []));
  await redisPipeline([
    ["HDEL", invitesKey(statsId), ...held.map((h) => h.field)],
    ...(links.length ? [["DEL", ...links]] : []),
    ["ZREM", DUE_KEY, ...held.map((h) => `${store.sid}|${h.field}`)],
    // The checkout their link last opened, kept a day so it is not opened twice.
    ["DEL", ...held.map((h) => openKey(statsId, h.field))],
  ]);
  return held.length;
}
