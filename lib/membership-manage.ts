/**
 * A member cancelling on their own.
 *
 * A membership is charged on the creator's own Stripe account, so the member
 * is the creator's customer, and until now the only way out was to write to
 * the creator and wait. That is the kind of cancellation people remember, and
 * not kindly. Here the member types the address they pay with, we email a
 * link to it, and the link opens Stripe's own page for their membership on
 * the creator's account: cancel, change the card, see the receipts.
 *
 * Three things are deliberate:
 *
 *   - It works whatever state the creator's own Marktmorgen subscription is in. A
 *     store that stops paying us stops selling; it never traps anybody in a
 *     charge they want to stop.
 *   - The page answers the same whether or not the address has a membership,
 *     so it cannot be used to find out who is a member of what.
 *   - Opening the email link never does anything. Mail scanners open links;
 *     only the button on the page it leads to asks Stripe for the portal.
 *
 * Cancelling ends the membership at the end of the period already paid for,
 * which is what the member has bought and is the fair default.
 */
import { saleHandles } from "@/lib/store";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { StripeListUnreadable, ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import { orderWrite } from "@/lib/order-data";
import { StripeError, onAccount, platformKey } from "@/lib/stripe-account";
import type { Store } from "@/lib/store";
import { readListings, sellsAny } from "@/lib/catalog";
import { canOffer, saveOn } from "@/lib/save-offer";
import { productOfSub } from "@/lib/tier-rules";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { membershipWords } from "@/lib/buyer-words/membership";
import { type PauseSub, cannotPause, pauseOf, periodEndOf } from "@/lib/membership-pause-rules";
import { isOwnReasonId, offers } from "@/lib/leave-rules";
import { countLeave } from "@/lib/leave-flow";
import { canSellProduct } from "@/lib/store-checkout";
import { type YearlyChoice, type YearlySub, yearlyChoice } from "@/lib/yearly-switch-rules";

/** How long the emailed link keeps working. */
export const MANAGE_LINK_SECONDS = 60 * 60;

/** How many times one emailed link may open the portal. */
const MAX_OPENS = 10;

/** Requests from one connection to one store, and for one inbox, per hour. */
const IP_LIMIT = 10;
const ADDRESS_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60 * 60;

/** Subscription states in which the member can still be charged, or still has access. */
const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

export const MANAGE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The most customers one link may manage, and the most its record may weigh (Claude 6, R43 F1 on #2985). Every
 * checkout makes a new customer on the creator's Stripe account, so one address can stand behind several, each
 * holding its own membership; the link carries every one of them that holds one of this store's, newest first.
 * MANAGE_CUSTOMERS_MAX is also the one page of customers read for an address. MANAGE_GRANT_BYTES keeps the record
 * inside what tests/store-data-registry.ts counts for an emailed link (LINK_BYTES, the key beside it). Past either,
 * the link says so (`m`), and the page lists nothing rather than a list that may miss one (membershipsFor).
 * The page and each action then read one list of memberships per customer, side by side (ownedSubsOf): Stripe
 * bills no API call, no store command or byte is added, and the wait is one read's.
 */
export const MANAGE_CUSTOMERS_MAX = 20;
export const MANAGE_GRANT_BYTES = 700;
const CUSTOMER_PATTERN = /^cus_[A-Za-z0-9]{6,64}$/;
const CONFIG_PATTERN = /^bpc_[A-Za-z0-9]{6,64}$/;

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const tokenKey = async (token: string) =>
  `nl:manage:link:${(await sha256Hex(`nimbus-manage:${token}`)).slice(0, 40)}`;
const opensKey = async (token: string) =>
  `nl:manage:opens:${(await sha256Hex(`nimbus-manage-opens:${token}`)).slice(0, 40)}`;
const ipKey = async (ip: string, handle: string) =>
  `nl:rl:manage:ip:${(await sha256Hex(`nimbus-manage-ip:${ip}:${handle}`)).slice(0, 32)}`;
const addressKey = async (email: string) =>
  `nl:rl:manage:addr:${(await sha256Hex(`nimbus-manage-addr:${email}`)).slice(0, 32)}`;
/**
 * The portal set-up made on one connected account, reused for every member.
 * Its heading is in the store's language, so a store in another language has
 * its own set-up, made the first time one of its members needs it.
 */
const configKey = (account: string, language: unknown = "en") => {
  const code = parseLanguage(language);
  return code === "en" ? `nl:manage:portal:${account}` : `nl:manage:portal:${account}:${code}`;
};
/** What Stripe's own pages are asked to speak (the portal's `locale`). */
const stripeLocale = (store: Store) => LANGUAGES[parseLanguage(store.language)].stripe;

/**
 * Counts one more open of an emailed link and answers the count, or null when Redis answered in a shape it does
 * not know (CX-123 rule 24; Claude 5, sweep APP2 finding 2). Only a whole count from 1 up is a count: a missing
 * reply, nil or a word is not "under the limit", so the caller refuses the press and opens nothing at Stripe.
 */
async function countOpen(key: string): Promise<number | null> {
  const replies = repliesFor(await redisPipeline([
    ["SET", key, "0", "EX", MANAGE_LINK_SECONDS, "NX"],
    ["INCR", key],
  ]), 2);
  if (!replies || (replies[0] !== "OK" && replies[0] !== null)) return null;
  const count = countOf(replies[1]);
  return count !== null && count >= 1 ? count : null;
}

async function within(key: string, limit: number): Promise<boolean> {
  const [, count] = await redisPipeline([
    ["SET", key, "0", "EX", RATE_WINDOW_SECONDS, "NX"],
    ["INCR", key],
  ]);
  return Number(count) <= limit;
}

/** Whether members of this store can be offered the way out. */
export function canManage(store: Store): boolean {
  return (
    Boolean(store.stripeAccountId) &&
    platformKey() !== null &&
    isRedisConfigured() &&
    isSenderConfigured()
  );
}

/** Whether this store sells anything that renews. */
export function sellsMemberships(store: Store): boolean {
  return sellsAny(store, "recurring");
}

type Listed = { data?: unknown };

/**
 * Every one of the creator's customers behind an address that has a membership of this store still running, the
 * newest membership's first; empty when there is none. Every checkout makes a new customer, so a member who bought
 * twice has two, and the link must reach both (Claude 6, R43 F1 on #2985). A customer whose memberships could not
 * be read whole is kept too once another holds one, so the page reads it again and says it cannot list rather
 * than leave it out; `more` says customers past the one page read may hold more.
 *
 * Stripe's hosted checkout keeps the address as the buyer typed it, and the `email` filter of Stripe's customer list
 * is case-sensitive, so "Ana@Example.com" and "ana@example.com" are two customers no one exact read finds together.
 * The address is read as typed and in small letters (one read when they are the same), never by sweeping the
 * account's customers; both together stay within MANAGE_CUSTOMERS_MAX customers, past which `more` says so. A
 * customer counts only when its own address is the one typed, ignoring capitals: any other row proves nothing and
 * keeps "no membership" from being said (Claude 5, the residue of R43 F1 on #2985). A spelling neither read nor
 * typed ("ANA@example.com" behind "Ana@Example.com") is not found: Stripe has no case-blind exact filter.
 *
 * Asked of the creator's own Stripe account. A membership counts when it was
 * sold by this store under any address the store has used.
 */
export async function findMembers(store: Store, email: string): Promise<{ customers: string[]; more: boolean }> {
  const account = store.stripeAccountId;
  if (!account) return { customers: [], more: false };
  const handles = saleHandles(store);

  // Each list is read in its exact shape (lib/stripe-list.ts; Claude 5, sweep APP2, the findMember sibling of
  // finding 4): a membership found on a readable row stands, but "no membership" is said only when every list
  // was read to its end with every row readable. Anything else throws StripeListUnreadable, so the form says
  // something went wrong (the route's "error"), never "sent" with no email behind it.
  let unknown = false;
  const typed = email.trim();
  const lower = normaliseEmail(typed);
  const spellings = typed === lower ? [lower] : [typed, lower];
  const sameAddress = (row: Record<string, unknown>) => {
    const own = ownField(row, "email");
    return typeof own === "string" && own.toLowerCase() === lower;
  };
  const pages = await Promise.all(spellings.map(async (spelling) =>
    readStripePage(
      await onAccount("GET", account, `/customers?email=${encodeURIComponent(spelling)}&limit=${MANAGE_CUSTOMERS_MAX}`),
      sameAddress,
      CUSTOMER_PATTERN,
    ),
  ));
  if (pages.some((page) => page.unreadable > 0 || page.hasMore)) unknown = true;
  // Both spellings' customers, newest first, each once, within the one ceiling: what is past it is said by `more`.
  const createdOf = (row: Record<string, unknown>) => {
    const at = ownField(row, "created");
    return typeof at === "number" ? at : 0;
  };
  const seen = new Set<string>();
  const all = pages.flatMap((page) => page.rows).filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id)));
  all.sort((x, y) => createdOf(y) - createdOf(x));
  if (all.length > MANAGE_CUSTOMERS_MAX) unknown = true;
  const more = unknown;

  const holding = new Map<string, number>();
  const unread: string[] = [];
  for (const customer of all.slice(0, MANAGE_CUSTOMERS_MAX)) {
    const subs = readStripePage(
      await onAccount("GET", account, `/subscriptions?customer=${encodeURIComponent(customer.id)}&status=all&limit=20`),
      (row) => typeof ownField(row, "status") === "string" && plainObject(ownField(row, "metadata")),
    );
    if (subs.unreadable > 0 || subs.hasMore) {
      unknown = true;
      unread.push(customer.id);
    }
    const rows = subs.rows as { status?: unknown; metadata?: Record<string, string> | null; created?: unknown }[];
    for (const sub of rows) {
      if (typeof sub.status !== "string" || !LIVE.has(sub.status)) continue;
      if (!handles.has(sub.metadata?.store ?? "")) continue;
      // A payment plan is paying for something already delivered, not a
      // membership: it ends by itself and is not cancelled from here.
      if (sub.metadata?.kind === "plan") continue;
      const at = typeof sub.created === "number" ? sub.created : 0;
      if (at >= (holding.get(customer.id) ?? -1)) holding.set(customer.id, at);
    }
  }
  if (!holding.size && unknown) throw new StripeListUnreadable("the customers or memberships of an address, not read to their end");
  if (!holding.size) return { customers: [], more: false };
  const newest = [...holding].sort((x, y) => y[1] - x[1]).map(([id]) => id);
  return { customers: [...newest, ...unread.filter((id) => !holding.has(id))], more };
}

/** The newest membership's customer behind an address, or null when it holds no membership of this store. */
export async function findMember(store: Store, email: string): Promise<string | null> {
  return (await findMembers(store, email)).customers[0] ?? null;
}

/** A name that can sit inside the quotes of an email's From line. */
function displayName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
}

/** The address part of NIMBUS_FROM, whatever form it was written in. */
function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}

export type ManageRequest = "sent" | "email" | "limited" | "unavailable" | "error";

export type Grant = {
  /** The connected account the membership is on. */
  a: string;
  /** The creator's customer who owns it: the newest membership's, when the address has several customers. */
  c: string;
  /** The store's address when the link was asked for. */
  h: string;
  /**
   * Every customer of the address the link manages, `c` first, when there is more than one (findMembers); a link
   * made before (or for one customer) has only `c`. Proven by the same inbox: each is a customer of that address.
   */
  cs?: string[];
  /** Customers past MANAGE_CUSTOMERS_MAX or MANAGE_GRANT_BYTES may hold more: the page cannot list them whole. */
  m?: 1;
};

/** The customers a link manages, `c` first. */
export function customersOf(grant: Grant): string[] {
  return grant.cs?.length ? grant.cs : [grant.c];
}

/** The record of a new link: every customer that fits MANAGE_CUSTOMERS_MAX and MANAGE_GRANT_BYTES, the rest said by `m`. */
export function grantRecord(account: string, handle: string, customers: string[], more: boolean): Grant {
  const all = customers.slice(0, MANAGE_CUSTOMERS_MAX);
  let past = more || customers.length > all.length;
  for (;;) {
    const grant: Grant = { a: account, c: all[0], h: handle, ...(all.length > 1 ? { cs: all } : {}), ...(past ? { m: 1 as const } : {}) };
    if (all.length <= 1 || new TextEncoder().encode(JSON.stringify(grant)).length <= MANAGE_GRANT_BYTES) return grant;
    all.pop();
    past = true;
  }
}

/**
 * Emails a way in to the address typed, when it has a membership here.
 *
 * "sent" is returned whether or not a membership was found. The only person
 * who learns the difference is whoever reads that inbox.
 */
export async function requestManageLink(input: {
  store: Store;
  email: string;
  ip: string;
  origin: string;
}): Promise<ManageRequest> {
  const { store, ip, origin } = input;
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  const email = normaliseEmail(raw);
  if (!canManage(store)) return "unavailable";

  if (!(await within(await ipKey(ip, store.handle), IP_LIMIT))) return "limited";
  if (!(await within(await addressKey(email), ADDRESS_LIMIT))) return "limited";

  // The address as typed, so a customer Stripe holds with its capitals is found too (findMembers); sent in small letters.
  const found = await findMembers(store, raw);
  if (!found.customers.length) return "sent";

  const token = randomToken();
  const grant = grantRecord(store.stripeAccountId as string, store.handle, found.customers, found.more);
  await redisPipeline([
    ["SET", await tokenKey(token), JSON.stringify(grant), "EX", MANAGE_LINK_SECONDS],
  ]);

  const name = store.name;
  const link = `${origin}/@${store.handle}/manage?token=${token}`;
  const m = membershipWords(store.language);
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "transactional" },
    from: `"${m.fromName(displayName(name))}" <${senderAddress()}>`,
    to: email,
    subject: m.membershipWith(name),
    text: [
      m.linkIntro(name),
      "",
      link,
      "",
      store.tiers.length ? m.linkTiers : m.linkNoTiers,
      "",
      m.linkWorks,
      "",
      m.linkFooter(name),
    ].join("\n"),
  });
  return sent ? "sent" : "error";
}

function parseGrant(raw: unknown): Grant | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Grant>;
    if (typeof value.a !== "string" || !/^acct_[A-Za-z0-9]{8,64}$/.test(value.a)) return null;
    if (typeof value.c !== "string" || !CUSTOMER_PATTERN.test(value.c)) return null;
    const grant: Grant = { a: value.a, c: value.c, h: typeof value.h === "string" ? value.h : "" };
    if (value.cs !== undefined) {
      // Every customer exactly as written when the link was made, `c` first, none twice; any other shape is no link.
      const cs = value.cs as unknown;
      if (!Array.isArray(cs) || cs.length < 2 || cs.length > MANAGE_CUSTOMERS_MAX || cs[0] !== value.c) return null;
      if (!cs.every((id) => typeof id === "string" && CUSTOMER_PATTERN.test(id)) || new Set(cs).size !== cs.length) return null;
      grant.cs = cs as string[];
    }
    if (value.m !== undefined) {
      if (value.m !== 1) return null;
      grant.m = 1;
    }
    return grant;
  } catch {
    return null;
  }
}

/** Whether an emailed link is still good, without spending it. For the page. */
export async function linkIsLive(token: string): Promise<boolean> {
  if (!MANAGE_TOKEN_PATTERN.test(token) || !isRedisConfigured()) return false;
  const [raw] = await redisPipeline([["GET", await tokenKey(token)]]);
  return parseGrant(raw) !== null;
}

/** The portal set-up on this account, made the first time a member needs it. */
async function portalConfiguration(store: Store, origin: string, fresh = false, askWhy = true): Promise<string> {
  const account = store.stripeAccountId as string;
  // A member who already said why on the store's own page is not asked again
  // on Stripe's (lib/leave-rules.ts): a set-up of its own, without the question.
  const key = askWhy ? configKey(account, store.language) : `${configKey(account, store.language)}:quiet`;
  if (!fresh) {
    const [cached] = await redisPipeline([["GET", key]]);
    if (typeof cached === "string" && CONFIG_PATTERN.test(cached)) return cached;
  }

  const body = new URLSearchParams({
    "business_profile[headline]": membershipWords(store.language).membershipWith(displayName(store.name)).slice(0, 60),
    default_return_url: `${origin}/@${store.handle}`,
    "features[subscription_cancel][enabled]": "true",
    "features[subscription_cancel][mode]": "at_period_end",
    "features[subscription_cancel][cancellation_reason][enabled]": askWhy ? "true" : "false",
    ...(askWhy
      ? {
          "features[subscription_cancel][cancellation_reason][options][0]": "too_expensive",
          "features[subscription_cancel][cancellation_reason][options][1]": "unused",
          "features[subscription_cancel][cancellation_reason][options][2]": "missing_features",
          "features[subscription_cancel][cancellation_reason][options][3]": "switched_service",
          "features[subscription_cancel][cancellation_reason][options][4]": "other",
        }
      : {}),
    "features[payment_method_update][enabled]": "true",
    "features[invoice_history][enabled]": "true",
    "metadata[made_by]": "nimbus-labs",
  });
  const made = await onAccount("POST", account, "/billing_portal/configurations", body);
  const id = typeof made.id === "string" ? made.id : "";
  if (!CONFIG_PATTERN.test(id)) throw new Error("Stripe returned no portal configuration");
  await redisPipeline([["SET", key, id]]);
  return id;
}

export type OpenResult = { ok: true; url: string } | { ok: false; reason: "expired" | "used" | "error" };

/**
 * Turns a live emailed link into a Stripe portal session and returns its URL.
 *
 * The link is checked against the store it is opened on: it only works on the
 * connected account it was issued for, so a link cannot be carried to another
 * store.
 *
 * Stripe's page is one customer's. With a membership named, it is the page of
 * the customer who holds that membership among the link's (R43 F1 on #2985: a
 * member who bought in two checkouts has two); without, the newest one's.
 */
export async function openPortal(store: Store, token: string, origin: string, subscription = ""): Promise<OpenResult> {
  if (subscription && !SUB_PATTERN.test(subscription)) return { ok: false, reason: "error" };
  if (!MANAGE_TOKEN_PATTERN.test(token) || !isRedisConfigured()) return { ok: false, reason: "expired" };
  const [raw] = await redisPipeline([["GET", await tokenKey(token)]]);
  const grant = parseGrant(raw);
  if (!grant || grant.a !== store.stripeAccountId) return { ok: false, reason: "expired" };

  const count = await countOpen(await opensKey(token));
  if (count === null) return { ok: false, reason: "error" };
  if (count > MAX_OPENS) return { ok: false, reason: "used" };

  let customer = grant.c;
  if (subscription) {
    try {
      const owned = await ownedSub(store, grant, subscription);
      // Not one of this link's: the same answer as a refused page, nothing made at Stripe.
      if (!owned) return { ok: false, reason: "error" };
      customer = owned.grant.c;
    } catch (error) {
      console.error("reading the membership whose page to open failed", error);
      return { ok: false, reason: "error" };
    }
  }

  const session = async (configuration: string) =>
    onAccount(
      "POST",
      grant.a,
      "/billing_portal/sessions",
      new URLSearchParams({
        customer,
        configuration,
        return_url: `${origin}/@${store.handle}`,
        locale: stripeLocale(store),
      }),
    );

  try {
    let made: Record<string, unknown>;
    try {
      made = await session(await portalConfiguration(store, origin));
    } catch (error) {
      // The creator may have removed the set-up from their own dashboard.
      // Make it again, once, rather than leaving the member stuck.
      if (error instanceof StripeError && (error.status === 400 || error.status === 404)) {
        made = await session(await portalConfiguration(store, origin, true));
      } else {
        throw error;
      }
    }
    if (typeof made.url !== "string" || !made.url) return { ok: false, reason: "error" };
    return { ok: true, url: made.url };
  } catch (error) {
    console.error("opening the membership portal failed", error);
    return { ok: false, reason: "error" };
  }
}

// ---- Leaving one membership, with an offer made once ---------------------

/** A membership as the member's own page lists it. */
export type Membership = {
  id: string;
  /** The creator's customer who holds it: a member who bought in two checkouts has two (R43 F1 on #2985). */
  customer: string;
  /** The product it is on now: switching tiers changes it (lib/tier-rules.ts). */
  product: string;
  /** Stripe's state for it, and whether it was sold to end after a set number of payments. */
  status: string;
  fixedEnd: boolean;
  /** What it is, by the product's name in the store today. */
  title: string;
  /** Each payment, in the currency's smallest unit. */
  amount: number;
  currency: string;
  interval: string;
  intervalCount: number;
  /**
   * When it stops, if the member already cancelled and it is running out the
   * time they paid for. Null while it runs on. A membership in this state has
   * no Cancel button: there is nothing left to cancel.
   */
  endsAt: number | null;
  /** A pause the member chose (lib/membership-pause-rules.ts), started or still to start; null when there is none. */
  pause: { from: number; until: number } | null;
  /** Whether the member may pause it now, as the store allows. */
  canPause: boolean;
  /** When the period already paid for ends, in seconds: where a pause would start. */
  periodEnd: number;
  /** The same membership's yearly price, when this one can move to it (lib/yearly-switch-rules.ts). */
  yearly: YearlyChoice | null;
};

const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
/** Once the offer has been made on a membership, it is never made again. */
const offeredKey = (account: string, subscription: string) => `nl:save:${account}:${subscription}`;

export type SubRow = {
  id?: unknown;
  status?: unknown;
  /** The currency Stripe bills it in, for the whole subscription. */
  currency?: unknown;
  customer?: unknown;
  metadata?: Record<string, string> | null;
  cancel_at_period_end?: unknown;
  cancel_at?: unknown;
  current_period_end?: unknown;
  items?: {
    data?: {
      current_period_end?: unknown;
      id?: unknown;
      price?: { unit_amount?: unknown; currency?: unknown; metadata?: Record<string, string> | null; recurring?: { interval?: unknown; interval_count?: unknown } | null };
    }[];
  };
};

/**
 * The currency a subscription is paid in: the one Stripe bills the whole
 * subscription in, else its one price's, else the store's (22 [E5], unit 2b).
 * The member's page and the tier switch read it the same way.
 */
export function subscriptionCurrency(sub: Pick<SubRow, "currency" | "items">, fallback: string): string {
  const own = typeof sub.currency === "string" && sub.currency ? sub.currency : sub.items?.data?.[0]?.price?.currency;
  return typeof own === "string" && own ? own.toLowerCase() : fallback.toLowerCase();
}

/** The grant behind a live link, read without spending one of its opens. */
export async function grantOf(store: Store, token: string): Promise<Grant | null> {
  if (!MANAGE_TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", await tokenKey(token)]]);
  const grant = parseGrant(raw);
  return grant && grant.a === store.stripeAccountId ? grant : null;
}

/** When a subscription stops, if it is set to; null while it runs on. */
export function endsAtOf(sub: SubRow): number | null {
  const at = typeof sub.cancel_at === "number" && sub.cancel_at > 0 ? sub.cancel_at : 0;
  if (at) return at;
  if (sub.cancel_at_period_end !== true) return null;
  // Stripe moved the period's end onto the items in 2025; an older account
  // may still carry it on the subscription. Read both, item first, as
  // lib/billing.ts does.
  const fromItem = sub.items?.data?.[0]?.current_period_end;
  if (typeof fromItem === "number") return fromItem;
  return typeof sub.current_period_end === "number" ? sub.current_period_end : 0;
}

/** The live memberships of this store held by one of the creator's customers. */
export async function subsOf(store: Store, grant: Grant): Promise<SubRow[]> {
  const handles = saleHandles(store);
  const listed = (await onAccount(
    "GET",
    grant.a,
    `/subscriptions?customer=${encodeURIComponent(grant.c)}&status=all&limit=20`,
  )) as Listed;
  const rows = Array.isArray(listed.data) ? (listed.data as SubRow[]) : [];
  return rows.filter(
    (sub) =>
      typeof sub.id === "string" &&
      SUB_PATTERN.test(sub.id) &&
      typeof sub.status === "string" &&
      LIVE.has(sub.status) &&
      handles.has(sub.metadata?.store ?? "") &&
      // A payment plan pays for something already delivered and ends by
      // itself; it is not a membership and is not cancelled from here.
      sub.metadata?.kind !== "plan",
  );
}

/** One membership of the link's, with the link narrowed to the customer who holds it (`c`). */
export type OwnedSub = { sub: SubRow; grant: Grant };

/**
 * The live memberships of this store held by every customer a link manages (customersOf), each with the customer
 * who holds it (Claude 6, R43 F1 on #2985): one list per customer, read side by side, as subsOf reads one. What
 * could not be read is answered as `unread` (the first failure), never as no membership; `more` when the link
 * says customers past its record may hold more.
 */
export async function ownedSubsOf(store: Store, grant: Grant): Promise<{ subs: OwnedSub[]; unread: unknown; more: boolean }> {
  const lists = await Promise.allSettled(customersOf(grant).map(async (customer) => {
    const own: Grant = { a: grant.a, c: customer, h: grant.h };
    return (await subsOf(store, own)).map((sub) => ({ sub, grant: own }));
  }));
  const failed = lists.find((list) => list.status === "rejected");
  return {
    subs: lists.flatMap((list) => (list.status === "fulfilled" ? list.value : [])),
    unread: failed && failed.status === "rejected" ? (failed.reason ?? new StripeListUnreadable("a member's memberships")) : null,
    more: grant.m === 1,
  };
}

/**
 * One membership of the link's, with the customer who holds it; null only when every customer the link manages
 * was read whole and none holds it. A membership not found while one of them could not be read, or while the
 * link says there may be more, throws, so an action ends in its error and never in "not yours" or "gone".
 */
export async function ownedSub(store: Store, grant: Grant, subscription: string): Promise<OwnedSub | null> {
  const { subs, unread, more } = await ownedSubsOf(store, grant);
  const found = subs.find((owned) => owned.sub.id === subscription);
  if (found) return found;
  if (unread) throw unread;
  if (more) throw new StripeListUnreadable("a member's customers, more than the link holds");
  return null;
}

/**
 * The memberships behind a live link, for the page to list. Null when the
 * link is not good, so the page can say so rather than show an empty list.
 *
 * Reading this spends nothing: opening the page is still not an action, and a
 * mail scanner that follows the link changes nothing and uses up nothing.
 */
export async function membershipsFor(store: Store, token: string): Promise<Membership[] | null> {
  const grant = await grantOf(store, token);
  if (!grant) return null;
  let owned: OwnedSub[];
  try {
    const read = await ownedSubsOf(store, grant);
    // A list that may miss one of the member's memberships is not shown: the page says it cannot list them, with
    // Stripe's own page still there, rather than leave one out as if it were not theirs (R43 F1 on #2985).
    if (read.unread) throw read.unread;
    if (read.more) throw new StripeListUnreadable("a member's customers, more than the link holds");
    owned = read.subs;
  } catch (error) {
    console.error("listing a member's memberships failed", error);
    return [];
  }
  const subs = owned.map((o) => o.sub);
  const holder = new Map(owned.map((o) => [o.sub.id, o.grant.c]));
  const ids = [...new Set(subs.map((s) => productOfSub(s)).filter(Boolean))];
  const listings = new Map(ids.length ? (await readListings(store, ids).catch(() => [])).map((p) => [p.id, p]) : []);
  const titles = new Map([...listings.values()].map((p) => [p.id, p.title]));
  const nowSeconds = Math.floor(Date.now() / 1000);
  return subs.map((sub) => {
    const price = sub.items?.data?.[0]?.price;
    const product = productOfSub(sub);
    return {
      id: sub.id as string,
      customer: holder.get(sub.id) ?? grant.c,
      product,
      status: typeof sub.status === "string" ? sub.status : "",
      fixedEnd: Boolean(sub.metadata?.ends_after),
      title: titles.get(product) || membershipWords(store.language).yourMembership,
      amount: typeof price?.unit_amount === "number" ? price.unit_amount : 0,
      currency: subscriptionCurrency(sub, store.currency),
      interval: typeof price?.recurring?.interval === "string" ? price.recurring.interval : "month",
      intervalCount: typeof price?.recurring?.interval_count === "number" ? price.recurring.interval_count : 1,
      endsAt: endsAtOf(sub),
      pause: pauseOf(sub as PauseSub),
      canPause: cannotPause(sub as PauseSub, store.pause) === null,
      periodEnd: periodEndOf(sub as PauseSub),
      yearly: (() => {
        const listing = listings.get(product);
        return listing && canSellProduct(store, listing) ? yearlyChoice(sub as YearlySub, listing, store.tiers, store.currency, nowSeconds) : null;
      })(),
    };
  });
}

/**
 * Opens Stripe's own cancellation page for one membership, carrying the
 * creator's offer the first time — and only the first time — it can be made
 * and honoured on that membership.
 *
 * The subscription is checked against the link before anything is asked of
 * Stripe: it has to belong to the very customer the link was issued for, on
 * this store's account, and be one this store sold. A link cannot be used to
 * cancel somebody else's membership by changing the id in the form.
 *
 * What happens afterward is Stripe's to say. Its confirmation page shows
 * whichever thing the member did — took the offer, or cancelled — in Stripe's
 * own words, so nothing written here can describe it wrongly.
 */
export async function openCancel(store: Store, token: string, subscription: string, origin: string, why = ""): Promise<OpenResult> {
  if (!SUB_PATTERN.test(subscription)) return { ok: false, reason: "error" };
  const grant = await grantOf(store, token);
  if (!grant) return { ok: false, reason: "expired" };

  // The same counter as the portal button: one link opens Stripe a limited
  // number of times, whichever button is pressed.
  const count = await countOpen(await opensKey(token));
  if (count === null) return { ok: false, reason: "error" };
  if (count > MAX_OPENS) return { ok: false, reason: "used" };

  try {
    // Among every customer the link manages, read with the one who holds it (R43 F1 on #2985): a member who bought
    // in two checkouts cancels either membership. One that could not be read throws, the same "error" below.
    const owned = await ownedSub(store, grant, subscription);
    const sub = owned?.sub;
    // Not this member's, not this store's, or already ended: the same answer
    // for all three, so the form cannot be used to learn which.
    if (!owned || !sub || endsAtOf(sub) !== null) return { ok: false, reason: "error" };
    const customer = owned.grant.c;

    const price = sub.items?.data?.[0]?.price;
    const interval = typeof price?.recurring?.interval === "string" ? price.recurring.interval : "";
    const every = typeof price?.recurring?.interval_count === "number" ? price.recurring.interval_count : 1;
    const offer = store.save;
    // Claimed before Stripe is asked, with NX: two presses at once make one
    // offer, and a member who backs out of Stripe's page and presses Cancel
    // again is not shown it a second time.
    let withOffer = false;
    if (saveOn(store) && canOffer(offer, interval, every)) {
      // Kept for good, once a membership: counted in the store's room (lib/order-data.ts).
      // Only an exact "OK" is a claim made now; nil is the offer already made. Any other reply is unknown: the
      // mark may be written already, so the offer is left out (the creator's coupon is never given twice) and
      // the member can still cancel, which is what they came for (Claude 5, sweep APP2 finding 1).
      // An order's write now reads each reply in its exact shape and throws on any other (lib/order-data.ts,
      // readScript), and it throws on a refused command too: whether the mark landed is then unknown, so it is
      // the same case, the offer left out and the cancellation page still made, never a failed cancellation.
      try {
        const claimed = repliesFor(await orderWrite(store, [["SET", offeredKey(grant.a, subscription), String(Date.now()), "NX"]]), 1)?.[0];
        if (claimed !== "OK" && claimed !== null) console.error("the offer to stay was left out: its mark answered in an unknown shape", store.handle);
        withOffer = claimed === "OK";
      } catch (error) {
        console.error("the offer to stay was left out: its mark could not be written", store.handle, error);
      }
    }

    // The reason given on the store's own page (lib/leave-rules.ts), written
    // on the membership so "Why members leave" counts it once it is canceled
    // (lib/membership-numbers.ts), and not asked again on Stripe's page.
    const said = store.leaving.on && why && offers(store.leaving, why) ? why : "";
    if (said) {
      await onAccount(
        "POST",
        grant.a,
        `/subscriptions/${subscription}`,
        new URLSearchParams({
          "metadata[leave_reason]": said,
          "metadata[leave_at]": String(Math.floor(Date.now() / 1000)),
          "metadata[leave_text]": isOwnReasonId(said) ? (store.leaving.own.find((o) => o.id === said)?.text ?? "") : "",
        }),
      );
    }
    if (store.leaving.on) await countLeave(store.statsId, "left");

    const body = new URLSearchParams({
      customer,
      configuration: await portalConfiguration(store, origin, false, !said),
      return_url: `${origin}/@${store.handle}/manage?token=${token}`,
      locale: stripeLocale(store),
      "flow_data[type]": "subscription_cancel",
      "flow_data[subscription_cancel][subscription]": subscription,
      "flow_data[after_completion][type]": "hosted_confirmation",
    });
    if (withOffer) {
      body.set("flow_data[subscription_cancel][retention][type]", "coupon_offer");
      body.set("flow_data[subscription_cancel][retention][coupon_offer][coupon]", offer.coupon);
    }

    let made: Record<string, unknown>;
    try {
      made = await onAccount("POST", grant.a, "/billing_portal/sessions", body);
    } catch (error) {
      // Refused: the creator may have deleted the coupon, or the portal
      // set-up, in their own dashboard. The member came to cancel, and letting
      // them is the one thing this must never fail at — so the set-up is made
      // again and the offer is left out, once. The mark is kept, so a coupon
      // that no longer exists is not tried again on this membership.
      if (!(error instanceof StripeError) || (error.status !== 400 && error.status !== 404)) throw error;
      body.set("configuration", await portalConfiguration(store, origin, true, !said));
      body.delete("flow_data[subscription_cancel][retention][type]");
      body.delete("flow_data[subscription_cancel][retention][coupon_offer][coupon]");
      made = await onAccount("POST", grant.a, "/billing_portal/sessions", body);
    }
    if (typeof made.url !== "string" || !made.url) return { ok: false, reason: "error" };
    return { ok: true, url: made.url };
  } catch (error) {
    console.error("opening the cancellation page failed", error);
    return { ok: false, reason: "error" };
  }
}
