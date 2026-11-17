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
import { UnknownReplyError, countOf, listSlots, repliesFor } from "@/lib/redis-reply";
import type { Listing, Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { addressHash } from "@/lib/imported-purchases";
import { canSellProduct, createCheckout } from "@/lib/store-checkout";
import { namedPriceGone, namedPriceOffered, withInvitedOption } from "@/lib/product-option";
import { withStockHold } from "@/lib/stock";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { StripeListUnreadable, readStripePage } from "@/lib/stripe-list";
import { storeBase } from "@/lib/purchase-email";
import { membershipLine, speech } from "@/lib/buyer-words";
import { moveWords } from "@/lib/buyer-words/move";
import { activeIntro } from "@/lib/intro-price";
import { firstChargeAt, linkSeconds, reminderAt } from "@/lib/move-rules";
import { giveData, needData } from "@/lib/store-data";
import { takePublicRequest } from "@/lib/traffic";
import { AFFILIATE_STRIPE_PAGES_PER_UNIT } from "@/lib/public-read-rules";
import { dataBytes } from "@/lib/store-data-rules";

const invitesKey = (statsId: string) => `nl:mv:${statsId}`;
export const linkKey = (token: string) => `nl:mv:link:${token}`;
const DUE_KEY = "nl:mv:due";
/** The slot invites are counted in, in the store's data room. */
const INVITES_SLOT = "mv";
const TOKEN_PATTERN = /^[0-9a-f]{40}$/;
const FIELD_PATTERN = /^[0-9a-f]{32}:[A-Za-z0-9_-]{1,64}$/;
const LIVE = new Set(["active", "trialing", "past_due"]);

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

/** Every status Stripe names a subscription with; another is a row that cannot be read. */
const SUB_STATUSES = new Set(["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"]);
const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
const CUSTOMER_PATTERN = /^cus_[A-Za-z0-9]{6,64}$/;
/** Pages of a hundred memberships read for one customer at most; one with more is unknown, never "not kept". */
const KEPT_PAGES = 5;

/** A membership row read whole: a status Stripe names and its metadata as a map of strings (as lib/winback-send.ts cameBack). */
function legibleSub(row: Record<string, unknown>): boolean {
  const { status, metadata } = row;
  if (typeof status !== "string" || !SUB_STATUSES.has(status)) return false;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return Object.values(metadata).every((value) => typeof value === "string");
}

/**
 * Whether this address has a live membership to this product on the creator's account now. Read whole (CX-123 rule
 * 24; review of #4121, MEDIUM): the customers under the address, and every page of each one's memberships, each list
 * in its exact shape and each row legible. A list in another shape, one read in part (has_more past what is read), or
 * a row that cannot be read throws StripeListUnreadable (an unknown answer, never "not kept"), so openMove opens
 * nothing and a reminder is put back in line.
 *
 * `most` bounds a read whose pages were counted before it (openMove): at most that many customer records under the
 * address forms together, each list asked for that many; more is not read whole, so it throws. Without it (the
 * reminders), the lists are read as above.
 */
export async function keptAlready(store: Store, email: string, productId: string, most?: number): Promise<boolean> {
  const account = store.stripeAccountId;
  if (!account || !EMAIL_PATTERN.test(email)) return false;
  const customers: string[] = [];
  for (const address of new Set([email, normaliseEmail(email)])) {
    const limit = most ?? 100;
    const page = readStripePage(await onAccount("GET", account, `/customers?${new URLSearchParams({ email: address, limit: String(limit) })}`), undefined, CUSTOMER_PATTERN);
    if (page.hasMore || page.unreadable > 0) throw new StripeListUnreadable("a moved member's customers, read in part");
    // More rows than were asked for is not a page Stripe answers (Claude 4's LEVE on #2685): not read as whole.
    if (page.rows.length > limit) throw new StripeListUnreadable("a moved member's customers, more than were asked for");
    for (const row of page.rows) if (!customers.includes(row.id)) customers.push(row.id);
  }
  // More records than were counted for (the two forms together): not read whole.
  if (most !== undefined && customers.length > most) throw new StripeListUnreadable("a moved member's customers, more than are read");
  for (const customer of customers) {
    let after = "";
    for (let pages = 0; ; pages += 1) {
      if (pages >= KEPT_PAGES) throw new StripeListUnreadable("a moved member's memberships, more than are read");
      const query = new URLSearchParams({ customer, status: "all", limit: "100", ...(after ? { starting_after: after } : {}) });
      const page = readStripePage(await onAccount("GET", account, `/subscriptions?${query}`), legibleSub, SUB_PATTERN);
      if (page.unreadable > 0) throw new StripeListUnreadable("a moved member's membership that cannot be read");
      if (page.rows.some((s) => LIVE.has(String(s.status)) && (s.metadata as Record<string, string>).product === productId)) return true;
      if (!page.hasMore) break;
      if (!page.lastId) throw new StripeListUnreadable("a moved member's memberships, with no place to read on from");
      after = page.lastId;
    }
  }
  return false;
}

/** How long a run holds the reminders it took (dueReminders) before they come due again on their own. */
export const REMINDER_LEASE_SECONDS = 15 * 60;

/**
 * Reminders due now, "<store id>|<field>", leased rather than taken off the line (webhooks/cron audit, Claude 1,
 * 12/11/2026): each is moved REMINDER_LEASE_SECONDS ahead, only while still in line (XX, so one forgotten in between
 * is never added back). The caller puts one back for later (remindLater) or takes it off once finished
 * (dropReminder); one a run never finishes (the function cut off, Redis failing for the put-back too) comes due again
 * when the lease runs out, instead of being lost.
 */
export async function dueReminders(now = Date.now(), limit = 50): Promise<{ sid: string; field: string }[]> {
  if (!isRedisConfigured()) return [];
  const [due] = await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, 0, Math.floor(now / 1000), "LIMIT", 0, limit]]);
  const entries = (Array.isArray(due) ? due : []).map(String);
  const until = Math.floor(now / 1000) + REMINDER_LEASE_SECONDS;
  if (entries.length) await redisPipeline([["ZADD", DUE_KEY, "XX", ...entries.flatMap((entry) => [until, entry])]]);
  return entries.flatMap((entry) => {
    const [sid, field] = [entry.slice(0, entry.indexOf("|")), entry.slice(entry.indexOf("|") + 1)];
    return sid && FIELD_PATTERN.test(field) ? [{ sid, field }] : [];
  });
}

/** Takes a finished reminder off the line: sent, nothing to send, or no longer wanted. */
export async function dropReminder(sid: string, field: string): Promise<void> {
  await redisPipeline([["ZREM", DUE_KEY, `${sid}|${field}`]]);
}

/**
 * Puts a leased reminder back in line, to be tried again in an hour: only while it is still in line (XX), so one taken
 * off meanwhile (a deletion, a membership kept) is never made again (Codex U on #4359). New reminders are put in line
 * where the invite is made, never here.
 */
export async function remindLater(sid: string, field: string, now = Date.now()): Promise<void> {
  await redisPipeline([["ZADD", DUE_KEY, "XX", Math.floor(now / 1000) + 3_600, `${sid}|${field}`]]);
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

export type MoveOpen = { ok: true; url: string } | { ok: false; reason: "expired" | "kept" | "unavailable" | "price" | "refused" | "consent" | "checking" | "unknown" };

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
  // member never holds two memberships from it (Revisor 1 on #2685). The page says it was kept only when it was;
  // a state that cannot be read is said to be unknown, never kept (Claude 4's MÉDIO on #2685), so nobody lets
  // their old membership lapse on our word. Kept: main's own answer, "kept" (review of #4121).
  if (invite.keptUnknown) return { ok: false, reason: "unknown" };
  if (invite.kept !== 0) return { ok: false, reason: "kept" };
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
  // Kept already, found live on the creator's account (review of #4121; B4): paid in a checkout the thanks page and
  // the sweep never saw. A second checkout would be a second membership of the same thing, charged every period
  // beside the first, so the link opens nothing more and says it was kept, before any checkout this link opened is
  // handed back (main's order: a press after paying says "kept", not the paid page again). Read whole by keptAlready
  // (main's reader): a reply that cannot be read, or one with more than is counted, opens nothing, and the next press
  // asks again. Every Stripe page this press may read is counted before the first (Codex C2 on #2685):
  // MOVE_STRIPE_PAGES, each a public request unit at AFFILIATE_STRIPE_PAGES_PER_UNIT. Not counted (the store's month
  // is used): nothing read, nothing opened. None of this takes the open mark below, so none can leave it behind.
  if (!(await takePublicRequest(store, "buyer", now, Math.ceil(MOVE_STRIPE_PAGES / AFFILIATE_STRIPE_PAGES_PER_UNIT)))) return { ok: false, reason: "unavailable" };
  let live: boolean;
  try {
    live = await keptAlready(store, invite.e, productId, MOVE_CUSTOMERS_READ);
  } catch (error) {
    console.error("reading a moved member's live membership failed", store.handle, error);
    return { ok: false, reason: "refused" };
  }
  if (live) {
    // Kept, whatever the note says (Claude 4 A5 on #2690): a note that fails to be written is written by the next
    // press, the thanks page or the sweep.
    try {
      await noteKept(store, invite.e, productId, now);
    } catch (error) {
      console.error("noting a moved membership as kept failed", store.handle, error);
    }
    return { ok: false, reason: "kept" };
  }
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
    // When Stripe closes it, as openCheckout read it (closesAt, main's since #3482); unknown (null), read from Stripe.
    const closes = held.value.closesAt ?? (await checkoutCloses(store, held.value.id));
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

/** Customer records read for an invitation's press, under the address forms together; more is not read whole (Codex C2 on #2685). */
export const MOVE_CUSTOMERS_READ = 5;
/** Address forms keptAlready asks Stripe for: the address as kept, and its normalised form when that differs. */
const MOVE_ADDRESS_FORMS = 2;
/**
 * Stripe pages one press may read, all counted before the first: a customer page for each address form, up to
 * KEPT_PAGES pages of memberships for each customer record read (keptAlready, main's reader since #4121), and the
 * checkout's closing time when its creation leaves it out.
 */
export const MOVE_STRIPE_PAGES = MOVE_ADDRESS_FORMS + MOVE_CUSTOMERS_READ * KEPT_PAGES + 1;

/**
 * Deletes the invitations an import gave one person to keep a membership
 * here, their links and their reminders (lib/person-erasure.ts). A
 * membership they already kept is the creator's Stripe record, not this.
 */
export async function forgetInvitesPerson(store: Pick<Store, "sid" | "statsId">, productIds: string[], email: string): Promise<number> {
  if (!store.statsId || !productIds.length || !isRedisConfigured()) return 0;
  const statsId = store.statsId;
  const fields = productIds.map((p) => inviteField(email, p));
  // Read exactly (unknown is never zero): a reply in another shape, or a kept invite that does not read, may still
  // hold the address and its reminder, so it is never said to be forgotten. It throws, and the erasure reports this
  // part as not done and tries again (lib/person-erasure.ts), the way forgetLeadPerson does.
  const what = "a person's membership move invitations";
  const replies = repliesFor(await redisPipeline([["HMGET", invitesKey(statsId), ...fields]]), 1);
  const rows = replies ? listSlots(replies[0]) : null;
  if (!rows || rows.length !== fields.length) throw new UnknownReplyError(what);
  const held: { field: string; invite: Invite }[] = [];
  fields.forEach((field, i) => {
    if (rows[i] === null) return;
    const invite = parseInvite(rows[i]);
    if (!invite) throw new UnknownReplyError(what);
    held.push({ field, invite });
  });
  if (!held.length) return 0;
  const gone = repliesFor(await redisPipeline([
    ["HDEL", invitesKey(statsId), ...held.map((h) => h.field)],
    ["DEL", ...held.map((h) => linkKey(h.invite.t))],
    ["ZREM", DUE_KEY, ...held.map((h) => `${store.sid}|${h.field}`)],
    // The checkout their link last opened, kept a day so it is not opened twice.
    ["DEL", ...held.map((h) => openKey(statsId, h.field))],
  ]), 4);
  if (!gone || gone.some((n) => { const c = countOf(n); return c === null || c > held.length; })) throw new UnknownReplyError(what);
  return held.length;
}
