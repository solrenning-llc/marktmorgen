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
import { UnknownReplyError, countOf, repliesFor, scanPage } from "@/lib/redis-reply";
import type { Listing, Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { addressHash } from "@/lib/imported-purchases";
import { canSellProduct, createCheckout } from "@/lib/store-checkout";
import { namedPriceGone, namedPriceOffered } from "@/lib/product-option";
import { withStockHold } from "@/lib/stock";
import { onAccount } from "@/lib/stripe-account";
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

/** Whether this address has a live membership to this product on the creator's account now. */
export async function keptAlready(store: Store, email: string, productId: string): Promise<boolean> {
  const account = store.stripeAccountId;
  if (!account || !EMAIL_PATTERN.test(email)) return false;
  const customers = await onAccount("GET", account, `/customers?${new URLSearchParams({ email, limit: "10" })}`);
  for (const customer of (Array.isArray(customers.data) ? customers.data : []) as { id?: unknown }[]) {
    if (typeof customer.id !== "string") continue;
    const subs = await onAccount("GET", account, `/subscriptions?customer=${customer.id}&status=all&limit=100`);
    const list = (Array.isArray(subs.data) ? subs.data : []) as { status?: unknown; metadata?: Record<string, string> | null }[];
    if (list.some((s) => LIVE.has(String(s.status)) && s.metadata?.product === productId)) return true;
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

export type MoveOpen = { ok: true; url: string } | { ok: false; reason: "expired" | "unavailable" | "price" | "refused" | "consent" };

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
export async function forgetInvitesPerson(store: Pick<Store, "sid" | "statsId">, productIds: string[], email: string): Promise<number> {
  if (!store.statsId || !productIds.length || !isRedisConfigured()) return 0;
  const statsId = store.statsId;
  const fields = productIds.map((p) => inviteField(email, p));
  const [rows] = await redisPipeline([["HMGET", invitesKey(statsId), ...fields]]);
  const held = fields.flatMap((field, i) => {
    const invite = parseInvite(Array.isArray(rows) ? rows[i] : null);
    return invite ? [{ field, invite }] : [];
  });
  if (!held.length) return 0;
  await redisPipeline([
    ["HDEL", invitesKey(statsId), ...held.map((h) => h.field)],
    ["DEL", ...held.map((h) => linkKey(h.invite.t))],
    ["ZREM", DUE_KEY, ...held.map((h) => `${store.sid}|${h.field}`)],
  ]);
  return held.length;
}

/** The invitations one studio request reads and deletes when their membership is removed: a page of the store's invitations. */
export const INVITES_PER_UNIT = 100;

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
 * UnknownReplyError, and what is left is found again by the next try. A store with no invitations reads one count.
 */
export async function dropProductInvites(store: Pick<Store, "sid" | "statsId">, productId: string, pay: (units: number) => Promise<boolean>): Promise<number> {
  if (!store.statsId || !store.sid || !isRedisConfigured()) return 0;
  const key = invitesKey(store.statsId);
  const size = countOf(repliesFor(await redisPipeline([["HLEN", key]]), 1)?.[0]);
  if (size === null) throw new UnknownReplyError("a store's invitations");
  if (size === 0) return 0;
  const suffix = `:${productId}`;
  let dropped = 0;
  let cursor = "0";
  do {
    if (!(await pay(1))) throw new InvitesUnpaidError();
    const page = scanPage(await redisPipeline([["HSCAN", key, cursor, "MATCH", `*${suffix}`, "COUNT", INVITES_PER_UNIT]]));
    if (!page || page.items.length % 2 !== 0) throw new UnknownReplyError("a page of a store's invitations");
    const held: { field: string; token: string | null }[] = [];
    for (let i = 0; i < page.items.length; i += 2) {
      const field = page.items[i];
      if (!field.endsWith(suffix)) continue;
      held.push({ field, token: parseInvite(page.items[i + 1])?.t ?? null });
    }
    if (held.length) {
      const links = held.flatMap((h) => (h.token && TOKEN_PATTERN.test(h.token) ? [linkKey(h.token)] : []));
      const commands: (string | number)[][] = [
        ["HDEL", key, ...held.map((h) => h.field)],
        ["ZREM", DUE_KEY, ...held.map((h) => `${store.sid}|${h.field}`)],
        ...(links.length ? [["DEL", ...links]] : []),
      ];
      const replies = repliesFor(await redisPipeline(commands), commands.length);
      if (!replies || !replies.every((r) => countOf(r) !== null)) throw new UnknownReplyError("the deletion of a removed membership's invitations");
      dropped += held.length;
    }
    cursor = page.next;
  } while (cursor !== "0");
  return dropped;
}
