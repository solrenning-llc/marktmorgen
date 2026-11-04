/**
 * Who may come into a store's community, asked again on every request.
 *
 * The creator chooses which of their products open it. Buying any one of
 * them is the ticket, read from the creator's own Stripe account — the
 * record of who paid for what — and never from anything a visitor says:
 *
 *   - a one-off product, a call or a course: a settled payment that was not
 *     refunded in full (a payment plan counts from its first payment, as it
 *     does for a course);
 *   - a membership: only while its subscription is live — active, in its
 *     trial, or with a payment being retried. A membership that is cancelled
 *     or stops being paid closes the door on the next check;
 *   - something free, when the creator includes it: the address confirmed it
 *     reads its own inbox by using the link we emailed (lib/free.ts), and the
 *     creator's list says so;
 *   - a purchase the creator brought over from another platform
 *     (lib/imported-purchases.ts) of a product that opens the community, or
 *     of a bundle that held one. Only the store's owner and Admins can bring
 *     buyers over, a membership never can be, and the creator's "remove"
 *     closes the door on one of them as on anybody.
 *
 * A product added in the box at checkout, or in one click after it, counts
 * the same as one bought on its own.
 *
 * Nobody makes an account. A member is somebody whose address is proved the
 * way a course student's is (lib/learn.ts): a link emailed to the address,
 * after which the browser holds the store's pass for 90 days, or a Marktmorgen
 * sign-in with that address. A pass made in the browser that paid for one
 * course opens that course only, and is not enough here: the community is
 * where a member is seen by others, so the address has to be shown to be
 * theirs, not only to have been typed at a checkout.
 *
 * Stripe's answer is kept for five minutes when it lets somebody in and for
 * one minute when it does not, so a page does not wait on Stripe every time
 * and somebody who just bought is not kept out for long. A membership that
 * lapses therefore loses the door within five minutes; the creator taking a
 * member out (lib/community.ts, `removed`) is read on every request and is
 * immediate.
 *
 *   nl:cm:<id>:ok:<address key>   Stripe's latest answer, with the settings' version
 *   nl:cm:link:<hash>             an emailed link: who, which store (1 hour)
 *   nl:cm:link:<hash>:opens       how often it was used (at most 10)
 *   nl:rl:cm:ip:<hash>, nl:rl:cm:addr:<hash>   how often a link was asked for
 */
import { spaceGate } from "@/lib/community-gate";
import { currentMeta } from "@/lib/tier-rules";
import { saleHandles } from "@/lib/store";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { communityWords } from "@/lib/buyer-words/community";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { orderWrite } from "@/lib/order-data";
import { type DataStore, DataRoomError } from "@/lib/store-data";
import { onAccount } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import { isLiveSub } from "@/lib/membership-access";
import { purchaseRefunded, refundedInFull } from "@/lib/refunds";
import { leadsKey, parseContact } from "@/lib/contacts";
import { type Learner, TOKEN_PATTERN, emailKey, learnerFrom, storeKey } from "@/lib/learn";
import type { Listing, Store } from "@/lib/store";
import { KIND, itemFor, readListings } from "@/lib/catalog";
import { deliveredIds } from "@/lib/bundle-rules";
import { importedFor } from "@/lib/imported-purchases";
import {
  CREATOR,
  type CommunityConfig,
  type Member,
  type Space,
  memberKey,
  readConfig,
  readMember,
  touchMember,
} from "@/lib/community";
import { send as sendMessage } from "@/lib/community-dm";

const OPEN_SECONDS = 5 * 60;
const SHUT_SECONDS = 60;
export const LINK_SECONDS = 60 * 60;
const MAX_LINK_OPENS = 10;
const IP_LIMIT = 10;
const ADDRESS_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60 * 60;
const CUSTOMER_PATTERN = /^cus_[A-Za-z0-9]{6,64}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const okKey = (id: string, email: string) => `nl:cm:${id}:ok:${emailKey(email)}`;
const linkKey = (token: string) => `nl:cm:link:${sha(`nimbus-community:${token}`).slice(0, 40)}`;
const opensKey = (token: string) => `${linkKey(token)}:opens`;

/** The products of this store that the settings let in, as they are now. */
export async function accessProducts(store: Store, config: CommunityConfig): Promise<Listing[]> {
  return readListings(store, config.access);
}

type Row = Record<string, unknown>;
type Listed = { data?: unknown };

function rows(listed: Listed): Row[] {
  return Array.isArray(listed.data) ? (listed.data as Row[]) : [];
}

/** The rule every door uses for a refund (lib/refunds.ts). */
const refunded = refundedInFull;

/**
 * Whether this address paid for one of `ids` on the creator's Stripe account
 * and still holds it: not refunded, and for a membership, still running.
 */
export async function paidForAny(store: Store, email: string, ids: Set<string>): Promise<boolean> {
  const account = store.stripeAccountId;
  if (!account || ids.size === 0) return false;
  const handles = saleHandles(store);
  const customers = new Set<string>();
  // Stripe keeps the address as it was typed at checkout.
  const variants = [...new Set([email.trim(), normaliseEmail(email)])];
  for (const variant of variants) {
    const query = new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: "100" });
    query.append("expand[]", "data.subscription");
    query.append("expand[]", "data.payment_intent.latest_charge");
    const listed = (await onAccount("GET", account, `/checkout/sessions?${query}`)) as Listed;
    for (const session of rows(listed)) {
      // A membership switched to another tier hands over what it is on now (lib/tier-rules.ts).
      const meta = currentMeta((session.metadata ?? {}) as Record<string, string>, session);
      if (!handles.has(meta.store ?? "")) continue;
      if (!isSettled(session)) continue;
      if (refunded(session.payment_intent)) continue;
      if (typeof session.customer === "string" && CUSTOMER_PATTERN.test(session.customer)) customers.add(session.customer);
      // A product in a bundle opens the door as if bought on its own.
      const bought = deliveredIds(meta).filter((id) => ids.has(id));
      if (!bought.length) continue;
      // A payment plan's first payment is read only for a purchase that would open the door.
      if (await purchaseRefunded(account, session)) continue;
      // A membership opens the door while it is being paid for; a payment
      // plan is a one-off paid in parts, and counts like one.
      if (session.mode === "subscription" && meta.kind !== "plan") {
        const sub = session.subscription as { status?: unknown } | null;
        // The same rule as every other door a membership opens (lib/membership-access.ts).
        if (!sub || typeof sub !== "object" || !isLiveSub(sub)) continue;
      }
      return true;
    }
  }
  // What was added in one click after paying is its own payment.
  for (const customer of [...customers].slice(0, 10)) {
    const query = new URLSearchParams({ customer, limit: "50" });
    query.append("expand[]", "data.latest_charge");
    const listed = (await onAccount("GET", account, `/payment_intents?${query}`)) as Listed;
    for (const intent of rows(listed)) {
      const meta = (intent.metadata ?? {}) as Record<string, string>;
      if (meta.kind !== "upsell" || !handles.has(meta.store ?? "")) continue;
      if (intent.status !== "succeeded" || refunded(intent)) continue;
      if (deliveredIds(meta).some((id) => ids.has(id))) return true;
    }
  }
  return false;
}

/** Whether a confirmed address on the creator's list got one of these free things. */
async function gotFree(store: Store, email: string, ids: Set<string>): Promise<boolean> {
  if (!store.listId || ids.size === 0) return false;
  const [raw] = await redisPipeline([["HGET", leadsKey(store.listId), normaliseEmail(email)]]);
  const contact = parseContact(raw);
  return Boolean(contact && contact.ids.some((id) => ids.has(id)));
}

/** Whether the creator brought this address over holding one of these products, or a bundle with one in it. */
async function broughtOver(store: Store, email: string, ids: Set<string>): Promise<boolean> {
  if (!store.pastBuyers || ids.size === 0) return false;
  const given = await importedFor(store, email);
  return given.some((p) => ids.has(p.productId) || (p.items ?? []).some((id) => ids.has(id)));
}

/**
 * Whether this address holds a ticket in, by the settings as they are now.
 * Stripe is asked at most once every five minutes per address (once a minute
 * while the answer is no); a change to the settings asks again at once.
 */
export async function holdsTicket(store: Store, config: CommunityConfig, email: string): Promise<boolean> {
  const id = store.community?.id;
  if (!id || !isRedisConfigured()) return false;
  return ticketFor(store, config.access, email, okKey(id, email), config.v);
}

/**
 * The same question for a narrower door: whether this address holds one of
 * `ids` — a live event open only to the buyers of some of the community's
 * products (lib/community-events.ts). Its answer is kept under `cacheKey`
 * with `version`, apart from the community's own, for the same five minutes
 * (one while it is no), so a membership that lapses loses the event with the
 * community.
 */
export async function holdsAnyOf(store: Store, ids: string[], email: string, cacheKey: string, version: string): Promise<boolean> {
  if (!store.community?.id || !isRedisConfigured()) return false;
  return ticketFor(store, ids, email, cacheKey, version);
}

/**
 * The same question for any product, without a community: whether this
 * address holds one of `ids` now — paid and not refunded, a membership still
 * running, given for free, brought over or given as a gift. For a private
 * podcast's feed (lib/podcast-access.ts). Cached like the community's answer.
 */
export async function holdsProducts(store: Store, ids: string[], email: string, cacheKey: string, version: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  return ticketFor(store, ids, email, cacheKey, version);
}

/**
 * The same question, for a door that takes something away when the answer
 * is no (lib/discord-access.ts): Stripe that cannot be asked is not a no.
 * Throws instead, so nothing is taken from anybody on a failed request.
 */
export async function holdsProductsOrThrow(store: Store, ids: string[], email: string, cacheKey: string, version: string): Promise<boolean> {
  if (!isRedisConfigured()) throw new Error("the database is not set up");
  return ticketFor(store, ids, email, cacheKey, version, true);
}

async function ticketFor(store: Store, ids: string[], email: string, cacheKey: string, version: number | string, strict = false): Promise<boolean> {
  // Which products let in, and whether each is free, is in the store record.
  const products = ids.flatMap((pid) => {
    const item = itemFor(store, pid);
    return item ? [{ id: item.id, free: (item.kind & KIND.free) !== 0 }] : [];
  });
  if (products.length === 0) return false;
  const [cached] = await redisPipeline([["GET", cacheKey]]);
  if (typeof cached === "string") {
    try {
      const value = JSON.parse(cached) as { v?: unknown; ok?: unknown };
      if (value.v === version && typeof value.ok === "boolean") return value.ok;
    } catch {}
  }
  const free = new Set(products.filter((p) => p.free).map((p) => p.id));
  const paid = new Set(products.filter((p) => !p.free).map((p) => p.id));
  let ok = false;
  try {
    // Stripe last: the other two are one read each.
    ok =
      (await gotFree(store, email, free)) ||
      (await broughtOver(store, email, new Set(products.map((p) => p.id)))) ||
      (await paidForAny(store, email, paid));
  } catch (error) {
    // Stripe could not be asked. Nobody is let in on a guess, and the answer
    // is not kept, so the next page asks again. A door that would take
    // something away on a no is told it could not be asked.
    if (strict) throw error;
    console.error("checking community access failed", error);
    return false;
  }
  await redisPipeline([["SET", cacheKey, JSON.stringify({ v: version, ok }), "EX", ok ? OPEN_SECONDS : SHUT_SECONDS]]);
  return ok;
}

/**
 * Whether somebody the community let in may see one space: the creator
 * always; a member when the space is for everyone, or when their address
 * holds one of the products it is kept for — among those that still open the
 * community.
 *
 * This is the same gate an event uses (lib/community-events.ts mayAttend),
 * and deliberately so: a space kept for the buyers of one product is worth
 * nothing if the answer can be got at from somewhere else, so there is one
 * answer, cached under the community's own version, and it moves the moment
 * the creator changes what opens the community.
 */
export async function maySeeSpace(
  store: Store,
  config: CommunityConfig,
  space: { id: string; only: string[] },
  viewer: { owner: boolean; email: string },
): Promise<boolean> {
  if (viewer.owner) return true;
  // The same rule the creator's "View as a member" uses (lib/community-gate.ts).
  const gate = spaceGate(space, config.access);
  if (gate.open) return true;
  const ids = gate.needs;
  const id = store.community?.id;
  if (!id) return false;
  return holdsAnyOf(store, ids, viewer.email, `nl:cm:${id}:sp:ok:${space.id}:${emailKey(viewer.email)}`, String(config.v));
}

/**
 * The spaces one viewer may see, in the creator's order. One Stripe answer
 * per gated space at worst, and each is cached.
 */
export async function visibleSpaces(
  store: Store,
  config: CommunityConfig,
  viewer: { owner: boolean; email: string },
): Promise<Space[]> {
  if (viewer.owner) return config.spaces;
  const gated = config.spaces.filter((s) => s.only.length);
  if (!gated.length) return config.spaces;
  const allowed = await Promise.all(gated.map((s) => maySeeSpace(store, config, s, viewer)));
  const mine = new Set(gated.filter((_, i) => allowed[i]).map((s) => s.id));
  return config.spaces.filter((s) => !s.only.length || mine.has(s.id));
}

/** Forgets Stripe's answer for one address, so the next request asks again. */
export async function forgetTicket(store: Store, email: string): Promise<void> {
  if (!store.community) return;
  await redisPipeline([["DEL", okKey(store.community.id, email)]]);
}

type CookieJar = { get(name: string): { value: string } | undefined };

export type Viewer =
  /** No community, or it is switched off. */
  | { state: "off" }
  /** Nobody we know: the page asks for an address. */
  | { state: "out"; config: CommunityConfig }
  /** A proved address that holds no ticket. */
  | { state: "closed"; config: CommunityConfig; email: string }
  /** Taken out by the creator. */
  | { state: "removed"; config: CommunityConfig; email: string }
  | {
      state: "in";
      config: CommunityConfig;
      email: string;
      /** CREATOR for the creator, else the member's key. */
      key: string;
      owner: boolean;
      /** The member's own record; null for the creator, or when the community is full. */
      member: Member | null;
      /** Whether they may post, comment, like and report. */
      canWrite: boolean;
    };

/**
 * Who is looking at this community, and what they may do, asked afresh.
 * The creator is always in, even while it is switched off, so they can set
 * it up before anybody else sees it.
 */
export async function communityViewer(store: Store, cookies: CookieJar): Promise<Viewer> {
  const id = store.community?.id;
  if (!id) return { state: "off" };
  const config = await readConfig(id);
  if (!config) return { state: "off" };
  const learner: Learner | null = await learnerFrom(store, cookies).catch(() => null);
  if (learner?.owner) {
    return { state: "in", config, email: learner.email, key: CREATOR, owner: true, member: null, canWrite: true };
  }
  if (!store.community?.on) return { state: "off" };
  if (!learner || learner.scope !== "all") return { state: "out", config };
  const key = memberKey(learner.email);
  const existing = await readMember(id, key);
  if (existing?.removed) return { state: "removed", config, email: learner.email };
  if (!(await holdsTicket(store, config, learner.email))) return { state: "closed", config, email: learner.email };
  const member = await touchMember(id, learner.email, existing, store);
  // The first time somebody comes in, the creator's welcome, sent privately
  // from the creator, where messages are on (lib/community-dm.ts). Once: the
  // record did not exist before this request, and the one made is theirs.
  if (!existing && member) {
    await welcome(id, config, member.k, store).catch((error) => console.error("sending a community welcome failed", error));
  }
  return {
    state: "in",
    config,
    email: learner.email,
    key,
    owner: false,
    member,
    canWrite: Boolean(member && !member.muted),
  };
}

/**
 * Sends the creator's welcome to a member who has just come in for the first
 * time, privately, from the creator — once, whatever happens at the same
 * moment: two first requests both find no record, and the mark lets only one
 * of them send. Nothing is sent while private messages are off.
 */
export async function welcome(id: string, config: CommunityConfig, member: string, room: DataStore): Promise<boolean> {
  if (!config.welcome.trim() || !config.dm.on) return false;
  // The welcome's mark, once a member: counted in the store's room (lib/order-data.ts).
  const [first] = await orderWrite(room, [["HSETNX", `nl:cm:${id}:wel`, member, Math.floor(Date.now() / 1000)]]);
  if (Number(first) !== 1) return false;
  // A welcome that does not fit in the store's data room is not sent; the member still comes in.
  const sent = await sendMessage(id, config.dm, CREATOR, member, config.welcome, room).catch((error) => {
    if (error instanceof DataRoomError) return { ok: false as const };
    throw error;
  });
  return sent.ok;
}

// ------------------------------------------------------------ emailed links

type LinkGrant = { e: string; k: string; h: string };

function displayName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
}

function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}

async function within(key: string, limit: number): Promise<boolean> {
  const [, count] = await redisPipeline([
    ["SET", key, "0", "EX", RATE_WINDOW_SECONDS, "NX"],
    ["INCR", key],
  ]);
  return Number(count) <= limit;
}

export type LinkRequest = "sent" | "email" | "limited" | "error";

/**
 * Emails a way in, when the address holds a ticket. "sent" either way: only
 * whoever reads the inbox learns whether it did, so the form cannot be used
 * to find out who bought what, or to fill a stranger's inbox.
 */
export async function requestCommunityLink(input: {
  store: Store;
  email: string;
  ip: string;
  origin: string;
}): Promise<LinkRequest> {
  const { store, ip, origin } = input;
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  const id = store.community?.id;
  if (!id || !store.community?.on || !isRedisConfigured()) return "error";
  if (!(await within(`nl:rl:cm:ip:${sha(`${ip}|${store.handle}`).slice(0, 32)}`, IP_LIMIT))) return "limited";
  if (!(await within(`nl:rl:cm:addr:${emailKey(raw)}`, ADDRESS_LIMIT))) return "limited";

  const config = await readConfig(id);
  if (!config) return "error";
  const member = await readMember(id, memberKey(raw));
  if (member?.removed) return "sent";
  if (!(await holdsTicket(store, config, raw))) return "sent";

  const token = randomBytes(32).toString("hex");
  const grant: LinkGrant = { e: normaliseEmail(raw), k: storeKey(store), h: store.handle };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", LINK_SECONDS]]);
  const link = `${origin}/api/store/community/open?token=${token}`;
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "transactional" },
    from: `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`,
    to: normaliseEmail(raw),
    subject: communityWords(store.language).linkSubject(config.name).slice(0, 200),
    text: communityWords(store.language).linkBody(config.name, link, store.name),
  });
  return sent ? "sent" : "error";
}

/** Spends one open of an emailed link, and says who it was for. */
export async function openCommunityLink(token: string): Promise<LinkGrant | null> {
  if (!TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const [raw, , opens] = await redisPipeline([
    ["GET", linkKey(token)],
    ["SET", opensKey(token), "0", "EX", LINK_SECONDS, "NX"],
    ["INCR", opensKey(token)],
  ]);
  if (typeof raw !== "string" || Number(opens) > MAX_LINK_OPENS) return null;
  try {
    const grant = JSON.parse(raw) as LinkGrant;
    return typeof grant.e === "string" && typeof grant.h === "string" && typeof grant.k === "string" ? grant : null;
  } catch {
    return null;
  }
}

/**
 * Forgets the answers kept about whether one address may come into the
 * community and its spaces, and the mark that it was welcomed
 * (lib/community-erasure.ts).
 */
export async function forgetAccessPerson(id: string, email: string, spaceIds: string[], productIds: string[]): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const key = emailKey(email);
  const replies = await redisPipeline([
    ["DEL", okKey(id, email), ...spaceIds.map((space) => `nl:cm:${id}:sp:ok:${space}:${key}`), ...productIds.map((p) => `nl:cm:${id}:sg:${p}:${key}`)],
    ["HDEL", `nl:cm:${id}:wel`, key],
  ]);
  return replies.reduce<number>((sum, n) => sum + (Number(n) || 0), 0);
}
