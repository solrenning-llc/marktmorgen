/**
 * Members moved from another platform (lib/move-rules.ts says what it is):
 * the invitation each one is given by an import (lib/imports.ts, "members"),
 * the email that carries their link, the one reminder, and the checkout the
 * link opens.
 *
 *   nl:mv:<statsId>          address hash:product -> { e, p, o, r, job, at, t, kept }
 *   nl:mv:link:<token>       who a link is for: { s, f }, until LINK_DAYS after the renewal date
 *   nl:mv:due                reminders waiting: "<store id>|<field>", by when each goes
 *   nl:mv:gone:<statsId>:<product>  a membership just removed, for GONE_MARK_SECONDS: no import step writes to it
 *   nl:mv:pend:<statsId>     memberships being removed whose invitations are not yet confirmed deleted: a person's
 *                            erasure and the copy of their data read them besides the catalog
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
import { UnknownReplyError, countOf, listSlots, repliesFor, scanPage, stringList } from "@/lib/redis-reply";
import type { Listing, Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { addressHash } from "@/lib/imported-purchases";
import { canSellProduct, createCheckout } from "@/lib/store-checkout";
import { namedPriceGone, namedPriceOffered } from "@/lib/product-option";
import { withStockHold } from "@/lib/stock";
import { onAccount } from "@/lib/stripe-account";
import { StripeListUnreadable, readStripePage } from "@/lib/stripe-list";
import { storeBase } from "@/lib/purchase-email";
import { membershipLine, speech } from "@/lib/buyer-words";
import { moveWords } from "@/lib/buyer-words/move";
import { activeIntro } from "@/lib/intro-price";
import { firstChargeAt, linkSeconds, reminderAt } from "@/lib/move-rules";
import { giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

const invitesKey = (statsId: string) => `nl:mv:${statsId}`;
export const linkKey = (token: string) => `nl:mv:link:${token}`;
const DUE_KEY = "nl:mv:due";
/**
 * A membership's removal marks it before it reads its invitations (dropProductInvites), and an import step writes an
 * invitation only while its product is not marked, in the same step as the write (INVITE_UNLESS_ERASED; Claude 7,
 * MEDIUM on #3473): a step that read the catalog before the removal and writes after it writes nothing to it.
 */
const goneMarkKey = (statsId: string, productId: string) => `nl:mv:gone:${statsId}:${productId}`;
/** How long the mark is kept: far longer than one import step runs between its catalog read and its write. */
export const GONE_MARK_SECONDS = 86_400;
/** The database commands the mark adds to an import step: one MGET inside INVITE_UNLESS_ERASED, whatever the rows. */
export const INVITE_GONE_READ_COMMANDS = 1;
/**
 * The memberships a removal noted before it went (notePendingInvites) whose invitations are not yet confirmed deleted;
 * dropProductInvites takes each off once it has deleted them all (Claude 3, MEDIUM on #3473). The one deletion runs
 * after the product is gone, when nothing in the studio can ask for it again, so a deletion that did not finish (a reply
 * not known, the studio's requests used up) left every invitation under a product no erasure read: noted here first, a
 * person's erasure and the copy of their data still reach them (withPendingInvites).
 */
const pendingKey = (statsId: string) => `nl:mv:pend:${statsId}`;
/** The most memberships a store notes in pendingKey; past it a removal that would need one more is refused (InvitesPendingFullError). */
export const PENDING_MAX = 20;
/** A product's id as pendingKey keeps it (lib/store.ts makes them so; app/api/store/product/route.ts PRODUCT_ID). */
const PENDING_ID = /^[a-z0-9]{6,40}$/;
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
  /** When they kept it here, in seconds; 0 until then. */
  kept: number;
};

export const inviteField = (email: string, productId: string) => `${addressHash(email)}:${productId}`;

function parseInvite(raw: unknown): Invite | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Invite>;
    if (typeof v.e !== "string" || typeof v.p !== "string" || typeof v.r !== "number" || typeof v.t !== "string") return null;
    return { e: v.e, p: v.p, o: typeof v.o === "string" ? v.o : "", r: v.r, job: typeof v.job === "string" ? v.job : "", at: Number(v.at) || 0, t: v.t, kept: Number(v.kept) || 0 };
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
 * reminder. Returns, for each, the field it is kept under when it is new,
 * null when that address was already invited to that membership, false when
 * the address was deleted from the store, and "gone" when the membership was
 * removed since the catalog was read (an import, `erased` given).
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
): Promise<(string | null | false | "gone")[]> {
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
  if (erased) {
    // The record, its link and its reminder written in the one step that checks the address and the membership.
    const answers = await invitedUnlessErased(store.sid, statsId, made.map((m) => ({ ...m, when: reminderAt(m.row.renews, now), seconds: linkSeconds(m.row.renews, now) })), erased);
    // An address already invited to that membership, deleted from the store, or invited to a membership removed since
    // the catalog was read, was not written: its room goes back.
    const unwritten = made.filter((_, i) => answers[i] !== 1).reduce((sum, m) => sum + m.bytes, 0);
    if (unwritten > 0) await giveData(store, [{ slot: INVITES_SLOT, bytes: unwritten }], now);
    return made.map(({ field }, i) => (answers[i] === 1 ? field : answers[i] === -1 ? false : answers[i] === -2 ? "gone" : null));
  }
  const answers = await redisPipeline(made.map(({ field, value }) => ["HSETNX", invitesKey(statsId), field, value]));
  const fresh = made.filter((_, i) => Number(answers[i]) === 1);
  // An address already invited to that membership was not written: its room goes back.
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
  return made.map(({ field }, i) => (Number(answers[i]) === 1 ? field : null));
}

/**
 * Invitations written only for addresses not deleted from the store (review of #3383, as lib/suppression.ts
 * KEEP_UNLESS_ERASED) and only to memberships not removed since the catalog was read (Claude 7, MEDIUM on #3473), in
 * one step with both checks, the record, its link and its reminder (so a removal that marks the membership either
 * comes first and nothing is written, or comes after and finds the record, its link and its reminder whole).
 * KEYS[1] the store's prints, KEYS[2] the store's invitations, KEYS[3] the reminders; then, for each invitation, its
 * link (KEYS[2 + 2i]) and its membership's removal mark (KEYS[3 + 2i]). ARGV, for each: its address's print, its
 * field, its record, its link's value, its link's seconds, its reminder's time ("" for none) and the reminder.
 * One HMGET and one MGET; a print found writes nothing and answers -1, a mark found writes nothing and answers -2,
 * otherwise HSETNX (1 new, 0 already), and for a new one its link's SET; the reminders in one ZADD. Billed as
 * before (the EVAL, the HMGET, each HSETNX, each link and the one ZADD) with the MGET one command more
 * (INVITE_GONE_READ_COMMANDS); lib/redis-memory.ts runs it the same way.
 */
export const INVITE_UNLESS_ERASED = `-- marktmorgen:invite-unless-erased:v2
local n = math.floor(#ARGV / 7)
local prints = {}
local marks = {}
for i = 1, n do
  prints[i] = ARGV[7 * i - 6]
  marks[i] = KEYS[3 + 2 * i]
end
local found = redis.call("HMGET", KEYS[1], unpack(prints))
local gone = redis.call("MGET", unpack(marks))
local out = {}
local due = {}
for i = 1, n do
  if found[i] then
    out[i] = -1
  elseif gone[i] then
    out[i] = -2
  else
    out[i] = redis.call("HSETNX", KEYS[2], ARGV[7 * i - 5], ARGV[7 * i - 4])
    if out[i] == 1 then
      redis.call("SET", KEYS[2 + 2 * i], ARGV[7 * i - 3], "EX", ARGV[7 * i - 2])
      if ARGV[7 * i - 1] ~= "" then
        due[#due + 1] = ARGV[7 * i - 1]
        due[#due + 1] = ARGV[7 * i]
      end
    end
  end
end
if #due > 0 then redis.call("ZADD", KEYS[3], unpack(due)) end
return out`;

/** Runs INVITE_UNLESS_ERASED; its answer read exactly, one of -2, -1, 0 or 1 for each, or it throws. */
async function invitedUnlessErased(
  sid: string,
  statsId: string,
  made: { row: { email: string; productId: string }; field: string; value: string; token: string; when: number | null; seconds: number }[],
  erased: { key: string; print: (email: string) => string },
): Promise<number[]> {
  const keys = [erased.key, invitesKey(statsId), DUE_KEY, ...made.flatMap(({ row, token }) => [linkKey(token), goneMarkKey(statsId, row.productId)])];
  const args = made.flatMap(({ row, field, value, when, seconds }) => [
    erased.print(row.email), field, value, JSON.stringify({ s: statsId, f: field }), seconds, when ? String(when) : "", `${sid}|${field}`,
  ]);
  const replies = await redisPipeline([["EVAL", INVITE_UNLESS_ERASED, keys.length, ...keys, ...args]]);
  const reply: unknown = Array.isArray(replies) && replies.length === 1 ? replies[0] : null;
  if (!Array.isArray(reply) || reply.length !== made.length || !reply.every((a) => a === -2 || a === -1 || a === 0 || a === 1)) {
    throw new Error("the invitations could not be checked where they are written");
  }
  return reply as number[];
}

/** How many members a store invited, and how many kept their membership here. */
export async function moveCounts(store: Store): Promise<{ invited: number; kept: number }> {
  if (!store.statsId || !isRedisConfigured()) return { invited: 0, kept: 0 };
  const [all] = await redisPipeline([["HVALS", invitesKey(store.statsId)]]);
  const invites = (Array.isArray(all) ? all : []).map(parseInvite).filter((i): i is Invite => i !== null);
  return { invited: invites.length, kept: invites.filter((i) => i.kept > 0).length };
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
  const product = await readListing(store, invite.p);
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
  const product = await readListing(store, invite.p);
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
 */
export async function keptAlready(store: Store, email: string, productId: string): Promise<boolean> {
  const account = store.stripeAccountId;
  if (!account || !EMAIL_PATTERN.test(email)) return false;
  const customers: string[] = [];
  for (const address of new Set([email, normaliseEmail(email)])) {
    const page = readStripePage(await onAccount("GET", account, `/customers?${new URLSearchParams({ email: address, limit: "100" })}`), undefined, CUSTOMER_PATTERN);
    if (page.hasMore || page.unreadable > 0) throw new StripeListUnreadable("a moved member's customers, read in part");
    for (const row of page.rows) if (!customers.includes(row.id)) customers.push(row.id);
  }
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

export type MoveOpen = { ok: true; url: string } | { ok: false; reason: "expired" | "kept" | "unavailable" | "price" | "refused" | "consent" };

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
  const product: Product | null = await readProduct(store, productId);
  if (!product?.recurring) return { ok: false, reason: "unavailable" };
  // The option they had. One the creator has since taken away, even the last,
  // is not swapped for another or for the product's own price: the page says
  // that price is no longer offered, with a link to the product's page.
  if (namedPriceGone(product, invite.o)) return { ok: false, reason: "price" };
  // Not on sale now, or the option kept with nothing to hand over: the general answer, nothing charged.
  if (!canSellProduct(store, product) || !namedPriceOffered(product, invite.o)) return { ok: false, reason: "unavailable" };
  // Kept already, through this link or found live on the creator's account: a second checkout would be a second
  // membership of the same thing, charged every period beside the first. A reply that cannot be read opens nothing.
  if (invite.kept) return { ok: false, reason: "kept" };
  try {
    if (await keptAlready(store, invite.e, productId)) {
      await noteKept(store, invite.e, productId, now);
      return { ok: false, reason: "kept" };
    }
  } catch (error) {
    console.error("reading a moved member's live membership failed", store.handle, error);
    return { ok: false, reason: "refused" };
  }
  const option = product.options.length ? invite.o : undefined;
  try {
    const held = await withStockHold(store, product, (holding) =>
      createCheckout(store, product, origin, option, { email: invite.e, noTrial: true, held: holding, moved: { firstChargeAt: firstChargeAt(invite.r, now) }, digitalConsent: consent }),
    );
    if (!held.ok) return { ok: false, reason: "unavailable" };
    return { ok: true, url: held.value.url };
  } catch (error) {
    // The store's orders for the month are reached (lib/order-admission.ts): not open right now, nothing charged.
    if (error instanceof OrdersPausedError) return { ok: false, reason: "unavailable" };
    // The box to start access at once was not checked: said beside it, nothing opened.
    if (error instanceof DigitalConsentMissing) return { ok: false, reason: "consent" };
    console.error("opening a moved member's checkout failed", store.handle, error);
    return { ok: false, reason: "refused" };
  }
}

/**
 * Deletes the invitations an import gave one person to keep a membership
 * here, their links and their reminders (lib/person-erasure.ts). A
 * membership they already kept is the creator's Stripe record, not this.
 */
export async function forgetInvitesPerson(store: Pick<Store, "sid" | "statsId">, current: string[], email: string): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const statsId = store.statsId;
  // The products the catalog holds and those whose removal has not confirmed their invitations gone (pendingKey).
  const productIds = await withPendingInvites(statsId, current);
  if (!productIds.length) return 0;
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
  ]), 3);
  if (!gone || gone.some((n) => { const c = countOf(n); return c === null || c > held.length; })) throw new UnknownReplyError(what);
  return held.length;
}

/**
 * The products asked about and the memberships in pendingKey, each once, in that order: what a person's erasure and the
 * copy of their data read invitations under. The note is the only way back to a removed membership's invitations, so it
 * is read exactly (rule 24): any other reply, or a member that is not a product's id, throws UnknownReplyError, and the
 * erasure says it is not finished instead of a receipt that left them.
 */
export async function withPendingInvites(statsId: string, current: string[]): Promise<string[]> {
  if (!statsId || !isRedisConfigured()) return current;
  const what = "the memberships whose invitations wait to be deleted";
  const reply = repliesFor(await redisPipeline([["SMEMBERS", pendingKey(statsId)]]), 1);
  const pending = stringList(reply?.[0]);
  if (!pending || !pending.every((id) => PENDING_ID.test(id))) throw new UnknownReplyError(what);
  return [...new Set([...current, ...pending])];
}

/** Thrown when pendingKey already holds PENDING_MAX memberships: nothing was noted, and nothing is removed. */
export class InvitesPendingFullError extends Error {
  constructor() {
    super("too many removed memberships still wait for their invitations to be deleted");
    this.name = "InvitesPendingFullError";
  }
}

/**
 * Notes a membership in pendingKey before it is removed (app/api/store/product/route.ts), in the studio request that
 * also pays for its invitations' deletion's first page (dropProductInvites, `firstPaid`): taken first, and refused
 * (InvitesUnpaidError) before anything is read. Already noted, nothing more is written. Every reply is read exactly
 * (rule 24): unknown throws UnknownReplyError and the product is not removed, so no invitation is left that neither the
 * catalog nor the note leads to. A full note (PENDING_MAX) throws InvitesPendingFullError, and the product stays.
 */
export async function notePendingInvites(store: Pick<Store, "sid" | "statsId">, productId: string, pay: (units: number) => Promise<boolean>): Promise<void> {
  if (!store.statsId || !store.sid || !isRedisConfigured()) return;
  if (!PENDING_ID.test(productId)) throw new RangeError("not a product's id");
  if (!(await pay(1))) throw new InvitesUnpaidError();
  const key = pendingKey(store.statsId);
  const what = "the memberships whose invitations wait to be deleted";
  const counted = repliesFor(await redisPipeline([["SISMEMBER", key, productId], ["SCARD", key]]), 2);
  const already = counted ? countOf(counted[0]) : null;
  const size = counted ? countOf(counted[1]) : null;
  if (already === null || already > 1 || size === null) throw new UnknownReplyError(what);
  if (already === 1) return;
  if (size >= PENDING_MAX) throw new InvitesPendingFullError();
  // Not the room's (a few ids, capped): bounded by PENDING_MAX in tests/store-data-registry.ts.
  const added = repliesFor(await redisPipeline([["SADD", key, productId]]), 1)?.[0];
  if (added !== 1 && added !== 0) throw new UnknownReplyError(what);
}

/**
 * Takes a membership off pendingKey once every invitation to it is confirmed deleted (dropProductInvites). Not
 * confirmed, it throws UnknownReplyError: the note staying only costs a person's erasure one more field to read.
 */
async function settlePendingInvites(statsId: string, productId: string): Promise<void> {
  const taken = repliesFor(await redisPipeline([["SREM", pendingKey(statsId), productId]]), 1)?.[0];
  if (taken !== 1 && taken !== 0) throw new UnknownReplyError("the note of a membership whose invitations were deleted");
}

/**
 * The invitations one studio request reads and deletes when their membership is removed: a page of the store's
 * invitations. A studio request pays for 50,000 bytes through the database (tests/plan-cost-registry.ts,
 * UNIT_COST.studio), and a page at its heaviest, read and deleted, with the first request's own commands, fits in
 * them: INVITES_PER_UNIT x (INVITE_READ_BYTES_MAX + INVITE_DROP_BYTES_MAX) + INVITES_FIRST_REQUEST_BYTES, held by
 * tests/move-invites-page-bytes.test.ts against the real field and record (Claude 1's review of #4831, MEDIUM).
 */
export const INVITES_PER_UNIT = 50;
/**
 * The most one invitation weighs as HSCAN returns it: its field (an address's 32-character print, a colon and a
 * product id of 40) and its record as inviteMembers writes it (an address of MAX_EMAIL_LENGTH, ids at their longest,
 * every number at 13 digits: about 500 bytes), each in RESP's framing, rounded up.
 */
export const INVITE_READ_BYTES_MAX = 620;
/** The most deleting one weighs in the request: its field again (HDEL), its reminder (ZREM: a store id, "|" and the field) and its link (DEL). */
export const INVITE_DROP_BYTES_MAX = 300;
/** The first request's own commands besides its page: the removal's mark, the count, and the note's SISMEMBER, SCARD, SADD and SREM. */
export const INVITES_FIRST_REQUEST_BYTES = 1_000;

/** Thrown when a page of a store's invitations could not be paid for in studio requests: nothing of it was read. */
export class InvitesUnpaidError extends Error {
  constructor() {
    super("the studio requests to delete a removed membership's invitations could not be taken");
    this.name = "InvitesUnpaidError";
  }
}

/**
 * Deletes every invitation to one membership, its link and its reminder, as the membership is removed (sibling of
 * audit A1, 9 November 2026): kept under the product's id, they would otherwise outlive it, and a person's erasure,
 * which reads only the products the store holds, would never reach them. The store's invitations are read a page at
 * a time (HSCAN), each page paid for first in one studio request (`pay`, false when the studio will not:
 * InvitesUnpaidError, nothing more read). Every reply is read exactly (rule 24): an unknown one throws
 * UnknownReplyError, and what is left is found again by the next try. The first studio request pays for the removal's
 * mark, the count and the first page; a store with no invitations takes that one request and reads one count. With
 * `firstPaid`, that request was already taken by notePendingInvites, which noted the membership before its removal.
 * Once every invitation to it is deleted, it is taken off that note (settlePendingInvites, in the same first request).
 */
export async function dropProductInvites(
  store: Pick<Store, "sid" | "statsId">,
  productId: string,
  pay: (units: number) => Promise<boolean>,
  firstPaid = false,
): Promise<number> {
  if (!store.statsId || !store.sid || !isRedisConfigured()) return 0;
  const key = invitesKey(store.statsId);
  // The membership is marked removed before its invitations are read, in the first request paid for (the mark, the
  // count and the first page): an import step that read the catalog before the removal then writes nothing to it, and
  // one that wrote before the mark is found below (Claude 7, MEDIUM on #3473). Not confirmed, it throws, and the same
  // removal asked again marks it again.
  if (!firstPaid && !(await pay(1))) throw new InvitesUnpaidError();
  const first = repliesFor(await redisPipeline([["SET", goneMarkKey(store.statsId, productId), "1", "EX", GONE_MARK_SECONDS], ["HLEN", key]]), 2);
  if (!first || first[0] !== "OK") throw new UnknownReplyError("a removed membership's mark");
  const size = countOf(first[1]);
  if (size === null) throw new UnknownReplyError("a store's invitations");
  if (size === 0) {
    await settlePendingInvites(store.statsId, productId);
    return 0;
  }
  const suffix = `:${productId}`;
  let dropped = 0;
  let cursor = "0";
  let paid = true;
  do {
    if (!paid && !(await pay(1))) throw new InvitesUnpaidError();
    paid = false;
    const page = scanPage(await redisPipeline([["HSCAN", key, cursor, "MATCH", `*${suffix}`, "COUNT", INVITES_PER_UNIT]]));
    if (!page || page.items.length % 2 !== 0) throw new UnknownReplyError("a page of a store's invitations");
    // COUNT is only a hint in Redis: a page answered with more than INVITES_PER_UNIT invitations pays one more studio
    // request for each further INVITES_PER_UNIT before anything on it is deleted (Claude 1's review of #4831, MEDIUM);
    // refused, nothing on it is deleted, and the same removal asked again finds it again.
    const extra = Math.ceil(page.items.length / 2 / INVITES_PER_UNIT) - 1;
    if (extra > 0 && !(await pay(extra))) throw new InvitesUnpaidError();
    const held: { field: string; token: string }[] = [];
    for (let i = 0; i < page.items.length; i += 2) {
      const field = page.items[i];
      if (!field.endsWith(suffix)) continue;
      // An invitation that does not read whole, or whose token is not one, is not "an invitation without a link"
      // (Codex G, HIGH on #3473): its field is the only way back to a link that may hold the store and the address's
      // field, so nothing on this page is deleted, and the next try finds it again (rule 24).
      const token = parseInvite(page.items[i + 1])?.t;
      if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw new UnknownReplyError("a moved-member invitation");
      held.push({ field, token });
    }
    if (held.length) {
      const links = held.map((h) => linkKey(h.token));
      const commands: (string | number)[][] = [
        ["HDEL", key, ...held.map((h) => h.field)],
        ["ZREM", DUE_KEY, ...held.map((h) => `${store.sid}|${h.field}`)],
        ["DEL", ...links],
      ];
      const replies = repliesFor(await redisPipeline(commands), commands.length);
      if (!replies || !replies.every((r) => countOf(r) !== null)) throw new UnknownReplyError("the deletion of a removed membership's invitations");
      dropped += held.length;
    }
    cursor = page.next;
  } while (cursor !== "0");
  await settlePendingInvites(store.statsId, productId);
  return dropped;
}
