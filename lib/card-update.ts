/**
 * A member putting a new card on one membership, from the link in the email
 * that tells them their card stops working before the next payment (added
 * 12 October 2026; lib/payment-recovery.ts sends it).
 *
 * Why not the portal Stripe already offers: its "update card" changes the
 * customer's default card, and a membership sold through Checkout keeps a
 * card of its own that comes first (lib/payment-recovery.ts says where that
 * was read). So this follows Stripe's own guide for changing the card a
 * subscription is paid with: a Checkout page in setup mode on the creator's
 * account, which saves a card and charges nothing, and then that card is set
 * on the membership itself. If a payment of that membership has already
 * failed, the new card pays it straight away.
 *
 * The emailed link names one membership of one customer on one account, and
 * is good for CARD_LINK_SECONDS. Opening the page it leads to does nothing;
 * only its button asks Stripe for a page, so a mail scanner changes nothing.
 *
 *   nl:card:link:<hash of token>     JSON { a, c, s }, CARD_LINK_SECONDS
 *   nl:card:opens:<hash of token>    presses of its button, CARD_LINK_SECONDS
 *   nl:card:open:<account>:<sub>     the latest Stripe page made for it, two days
 *
 * The last is for a member who saves a card and closes the tab before Stripe
 * sends them back: the daily job finds the finished page and sets the card
 * (lib/payment-recovery.ts), so nothing depends on the redirect arriving.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { type Store, saleHandles } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";

export const CARD_LINK_SECONDS = 21 * 86_400;
const MAX_OPENS = 20;
const OPEN_SECONDS = 2 * 86_400;

export const CARD_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const ACCOUNT_PATTERN = /^acct_[A-Za-z0-9]{8,64}$/;
const CUSTOMER_PATTERN = /^cus_[A-Za-z0-9]{6,64}$/;
const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
const SESSION_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const PM_PATTERN = /^pm_[A-Za-z0-9]{6,64}$/;
const INVOICE_PATTERN = /^in_[A-Za-z0-9]{6,64}$/;

/** States in which a membership is over, and has no card to keep. */
const OVER = new Set(["canceled", "incomplete_expired"]);

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const linkKey = async (token: string) => `nl:card:link:${(await sha256Hex(`nimbus-card:${token}`)).slice(0, 40)}`;
const opensKey = async (token: string) => `nl:card:opens:${(await sha256Hex(`nimbus-card-opens:${token}`)).slice(0, 40)}`;
export const openKey = (account: string, sub: string) => `nl:card:open:${account}:${sub}`;

export type CardGrant = { a: string; c: string; s: string };

/** A new link for one membership, to put in an email. */
export async function cardLink(account: string, customer: string, subscription: string): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const grant: CardGrant = { a: account, c: customer, s: subscription };
  await redisPipeline([["SET", await linkKey(token), JSON.stringify(grant), "EX", CARD_LINK_SECONDS]]);
  return token;
}

/** What a link names, when it is still good and belongs to this store's account. */
export async function cardGrant(store: Store, token: string): Promise<CardGrant | null> {
  if (!CARD_TOKEN_PATTERN.test(token) || !isRedisConfigured() || !store.stripeAccountId) return null;
  const [raw] = await redisPipeline([["GET", await linkKey(token)]]);
  if (typeof raw !== "string") return null;
  try {
    const g = JSON.parse(raw) as Partial<CardGrant>;
    if (typeof g.a !== "string" || !ACCOUNT_PATTERN.test(g.a) || g.a !== store.stripeAccountId) return null;
    if (typeof g.c !== "string" || !CUSTOMER_PATTERN.test(g.c) || typeof g.s !== "string" || !SUB_PATTERN.test(g.s)) return null;
    return { a: g.a, c: g.c, s: g.s };
  } catch {
    return null;
  }
}

type SubRow = {
  id?: unknown;
  status?: unknown;
  customer?: unknown;
  metadata?: Record<string, string> | null;
  latest_invoice?: { id?: unknown; status?: unknown; amount_due?: unknown } | string | null;
};

const customerOf = (sub: SubRow) =>
  typeof sub.customer === "string" ? sub.customer : sub.customer && typeof sub.customer === "object" ? String((sub.customer as { id?: unknown }).id ?? "") : "";

/**
 * A Stripe reply decides only when it is the object asked for (rule 30): it holds its own id, equal to the one
 * requested. Another membership of the same customer on the same store, or a reply with no id, says nothing about
 * this one: its status, its card and its unpaid invoice are not this membership's. A reply that is not an object at all (an HTTP 200 whose JSON body is `null`) is not this object either: it never
 * throws here.
 */
const isOwnReply = (reply: unknown, id: string): boolean =>
  reply !== null && typeof reply === "object" && Object.hasOwn(reply, "id") && (reply as { id?: unknown }).id === id;

/** The membership a grant names, when Stripe's reply is that membership and it is this customer's and this store's. */
async function subFor(store: Store, account: string, customer: string, subscription: string): Promise<SubRow | null> {
  if (!SUB_PATTERN.test(subscription)) return null;
  const sub = (await onAccount("GET", account, `/subscriptions/${subscription}?expand[]=latest_invoice`)) as SubRow;
  if (!isOwnReply(sub, subscription)) return null;
  if (customerOf(sub) !== customer || !saleHandles(store).has(sub.metadata?.store ?? "")) return null;
  return sub;
}

const owes = (sub: SubRow) => {
  const invoice = sub.latest_invoice && typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
  return (sub.status === "past_due" || sub.status === "unpaid") && invoice?.status === "open" && typeof invoice.amount_due === "number" && invoice.amount_due > 0
    ? invoice
    : null;
};

export type CardView = { title: string | null; ended: boolean; owes: boolean };

/** What the page shows: which membership, whether it has ended, whether a payment is waiting. Reads only. */
export async function cardView(store: Store, grant: CardGrant): Promise<CardView | null> {
  try {
    const sub = await subFor(store, grant.a, grant.c, grant.s);
    if (!sub) return null;
    const product = sub.metadata?.product ?? "";
    const title = product ? ((await readListings(store, [product]).catch(() => []))[0]?.title ?? null) : null;
    return { title, ended: OVER.has(String(sub.status)), owes: owes(sub) !== null };
  } catch (error) {
    console.error("reading a membership for a card update failed", store.handle, error);
    return null;
  }
}

/** The presses after SET ... NX and INCR: a whole number from one up, or null when the reply is not that. */
function pressCount(replies: unknown): number | null {
  const both = repliesFor(replies, 2);
  const set = both?.[0];
  if (!both || (set !== "OK" && set !== null)) return null;
  const count = countOf(both[1]);
  return count !== null && count >= 1 ? count : null;
}

export type OpenCard = { ok: true; url: string } | { ok: false; reason: "expired" | "used" | "ended" | "error" };

/** The button: a Stripe page in setup mode that saves a card for this membership. */
export async function openCardUpdate(store: Store, token: string, origin: string): Promise<OpenCard> {
  const grant = await cardGrant(store, token);
  if (!grant) return { ok: false, reason: "expired" };
  const key = await opensKey(token);
  // Counted before Stripe is asked, in its exact shape: a press that cannot
  // be counted is not a first press (CX-123 rule 24).
  const presses = await redisPipeline([
    ["SET", key, "0", "EX", CARD_LINK_SECONDS, "NX"],
    ["INCR", key],
  ]).then(
    (replies) => pressCount(replies),
    (error: unknown) => {
      console.error("counting a card link's presses failed", store.handle, error);
      return null;
    },
  );
  if (presses === null) return { ok: false, reason: "error" };
  if (presses > MAX_OPENS) return { ok: false, reason: "used" };
  try {
    const sub = await subFor(store, grant.a, grant.c, grant.s);
    if (!sub) return { ok: false, reason: "error" };
    if (OVER.has(String(sub.status))) return { ok: false, reason: "ended" };
    const page = `${origin}/@${store.handle}/manage/card?t=${token}`;
    const made = await onAccount(
      "POST",
      grant.a,
      "/checkout/sessions",
      new URLSearchParams({
        mode: "setup",
        customer: grant.c,
        "payment_method_types[0]": "card",
        "setup_intent_data[metadata][subscription]": grant.s,
        "metadata[store]": store.handle,
        "metadata[kind]": "card",
        "metadata[subscription]": grant.s,
        locale: LANGUAGES[parseLanguage(store.language)].stripe,
        success_url: `${origin}/api/store/manage/card?handle=${encodeURIComponent(store.handle)}&t=${token}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${page}&status=canceled`,
      }),
    );
    const id = typeof made.id === "string" ? made.id : "";
    const url = typeof made.url === "string" ? made.url : "";
    if (!SESSION_PATTERN.test(id) || !url.startsWith("https://")) return { ok: false, reason: "error" };
    await redisPipeline([["SET", openKey(grant.a, grant.s), id, "EX", OPEN_SECONDS]]);
    return { ok: true, url };
  } catch (error) {
    console.error("opening a card update failed", store.handle, error);
    return { ok: false, reason: "error" };
  }
}

export type CardFinish = "updated" | "paid" | "declined" | "canceled" | "error";

/**
 * After Stripe's page: the card it saved becomes the one this membership is
 * paid with, and pays a payment that already failed. Safe to run twice: the
 * card is set again, and an invoice already paid is not paid again.
 */
export async function finishCardUpdate(store: Store, sessionId: string): Promise<CardFinish> {
  const account = store.stripeAccountId;
  if (!account || !SESSION_PATTERN.test(sessionId)) return "error";
  try {
    const session = (await onAccount("GET", account, `/checkout/sessions/${sessionId}?expand[]=setup_intent`)) as {
      mode?: unknown;
      status?: unknown;
      customer?: unknown;
      metadata?: Record<string, string> | null;
      setup_intent?: { status?: unknown; payment_method?: unknown; metadata?: Record<string, string> | null } | string | null;
    };
    // Another page's reply, or one with no id, never sets a card: "error" keeps the page waiting (nl:card:open), so
    // the daily job (lib/payment-recovery.ts) asks again.
    if (!isOwnReply(session, sessionId)) return "error";
    if (session.mode !== "setup" || session.metadata?.kind !== "card" || !saleHandles(store).has(session.metadata?.store ?? "")) return "error";
    if (session.status !== "complete") return "canceled";
    const intent = session.setup_intent && typeof session.setup_intent === "object" ? session.setup_intent : null;
    const method = typeof intent?.payment_method === "string" ? intent.payment_method : "";
    const subscription = intent?.metadata?.subscription ?? session.metadata?.subscription ?? "";
    const customer = typeof session.customer === "string" ? session.customer : "";
    if (intent?.status !== "succeeded" || !PM_PATTERN.test(method) || !CUSTOMER_PATTERN.test(customer)) return "error";
    const sub = await subFor(store, account, customer, subscription);
    if (!sub || OVER.has(String(sub.status))) return "error";

    await onAccount("POST", account, `/subscriptions/${subscription}`, new URLSearchParams({ default_payment_method: method }));
    await redisPipeline([["DEL", openKey(account, subscription)]]).catch(() => {});

    const invoice = owes(sub);
    const invoiceId = typeof invoice?.id === "string" && INVOICE_PATTERN.test(invoice.id) ? invoice.id : "";
    if (!invoiceId) return "updated";
    try {
      await onAccount("POST", account, `/invoices/${invoiceId}/pay`, new URLSearchParams({ payment_method: method }), undefined, `nimbus-card-pay:${invoiceId}:${method}`);
      return "paid";
    } catch (error) {
      if (error instanceof StripeError && (error.status === 402 || error.status === 400)) return "declined";
      throw error;
    }
  } catch (error) {
    console.error("finishing a card update failed", store.handle, error);
    return "error";
  }
}
