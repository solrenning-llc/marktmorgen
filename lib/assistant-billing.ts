/**
 * The Store assistant's own subscription (lib/store-assistant-rules.ts), on
 * our platform Stripe account, like the plan's (lib/billing.ts).
 *
 * Its own subscription, beside the plan's, on the same Stripe customer: a
 * yearly plan cannot carry a monthly line, and the plan's code reads a
 * subscription's first line as the plan. So it pays its own fixed card fee,
 * which its margin counts (assistantMonthWorst). Its metadata names the
 * store under `assistant_for`, never `store`, so nothing that reads plans
 * (lib/billing.ts findStoreSubscriptions, lib/billing-sync.ts) can take it
 * for one.
 *
 * Sold only while Marktmorgen is open (lib/opening.ts, ASSISTANT_ON_SALE),
 * and only to a store whose plan is paid, not in its trial. A store whose
 * add-on payment is disputed has it ended at once and is not sold it again.
 * A store whose plan ends has its add-on set to stop at the end of the month
 * already paid: nothing more is charged for it. A second live add-on for one
 * store (two starts paid at once) is set by the daily job to stop the same way,
 * once Stripe confirms the written-down one active and renewing.
 */
import { ADD_ON_MARK, BillingError, isAddOn, onPlatform, onPlatformAt, setCancelAtPeriodEnd } from "@/lib/billing";
export { ADD_ON_MARK, isAddOn } from "@/lib/billing";
import { standingOf } from "@/lib/plan-standing";
import { CUSTOMER_PATTERN, SUBSCRIPTION_PATTERN, type Store, setAssistantPlan, storeForHandle, storeRef } from "@/lib/store";
import { ASSISTANT_NAME, ASSISTANT_PRICE_CENTS, type AssistantPlan } from "@/lib/store-assistant-rules";
import { StripeListUnreadable, type StripeRow, hasOwnField, ownField, plainObject, readStripePage } from "@/lib/stripe-list";

export const ASSISTANT_PRODUCT_ID = "nimbus_labs_store_assistant";
export const ASSISTANT_LOOKUP_KEY = "nimbus_assistant_month";

const SESSION_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
/** The version invoices are read at, where a paid invoice names its charge (lib/billing.ts, CHARGE_VERSION). */
const INVOICE_VERSION = "2024-06-20";
const CHECKOUT_VERSION = "2025-09-30.clover";

/**
 * A Stripe reply decides only when it is the object asked for (rule 30): it holds its own id, equal to the one
 * requested. A reply for another object, or with no id, says nothing about this add-on. A reply that is not an object at all (an HTTP 200 whose JSON body is `null`) is not this object either: it never
 * throws here.
 */
const isOwnReply = (reply: unknown, id: string): boolean =>
  reply !== null && typeof reply === "object" && Object.hasOwn(reply, "id") && (reply as { id?: unknown }).id === id;

/** Thrown on a reply that is not the object asked for: nothing is decided on it, and the next pass reads again. */
class NotOwnReply extends Error {
  constructor(id: string) {
    super(`Stripe's reply was not the object asked for (${id})`);
  }
}

/** The add-on's subscription as Stripe has it, read by its id; throws NotOwnReply on a reply for anything else. */
async function readSubscription(id: string): Promise<Record<string, unknown>> {
  const reply = await onPlatform("GET", `/subscriptions/${encodeURIComponent(id)}`);
  if (!isOwnReply(reply, id)) throw new NotOwnReply(id);
  return reply;
}

/** Why a store may not buy the add-on now, or null when it may. */
export function assistantRefusal(store: Store, nowSeconds = Date.now() / 1000): "plan" | "already" | "disputed" | "customer" | null {
  if (store.assistantPlan?.disputedAt) return "disputed";
  if (store.assistantPlan?.active) return "already";
  if (standingOf(store, nowSeconds) !== "paid") return "plan";
  if (!store.stripeCustomerId || !CUSTOMER_PATTERN.test(store.stripeCustomerId)) return "customer";
  return null;
}

let priceId: string | null = null;

/** The add-on's price at Stripe, made the first time it is needed, and replaced when it no longer matches ASSISTANT_PRICE_CENTS. */
export async function ensureAssistantPrice(): Promise<string> {
  if (priceId) return priceId;
  const listed = await onPlatform("GET", `/prices?${new URLSearchParams({ "lookup_keys[]": ASSISTANT_LOOKUP_KEY, active: "true", limit: "1" })}`);
  const found = (listed.data as Record<string, unknown>[] | undefined)?.[0];
  const recurring = found?.recurring as { interval?: unknown } | null | undefined;
  if (found && typeof found.id === "string" && found.unit_amount === ASSISTANT_PRICE_CENTS && found.currency === "usd" && recurring?.interval === "month") {
    priceId = found.id;
    return found.id;
  }
  try {
    await onPlatform("GET", `/products/${ASSISTANT_PRODUCT_ID}`);
  } catch (error) {
    if (!(error instanceof BillingError) || error.status !== 404) throw error;
    try {
      await onPlatform("POST", "/products", new URLSearchParams({ id: ASSISTANT_PRODUCT_ID, name: `Marktmorgen ${ASSISTANT_NAME}`, description: "An AI assistant that answers buyers on one store, from what the store published." }));
    } catch (made) {
      if (!(made instanceof BillingError) || made.code !== "resource_already_exists") throw made;
    }
  }
  const made = await onPlatform(
    "POST",
    "/prices",
    new URLSearchParams({
      currency: "usd",
      unit_amount: String(ASSISTANT_PRICE_CENTS),
      "recurring[interval]": "month",
      product: ASSISTANT_PRODUCT_ID,
      lookup_key: ASSISTANT_LOOKUP_KEY,
      transfer_lookup_key: "true",
      nickname: `${ASSISTANT_NAME}, monthly`,
    }),
  );
  if (typeof made.id !== "string") throw new Error("Stripe did not return a price");
  priceId = made.id;
  return made.id;
}

/**
 * Opens the page where a creator starts paying for the add-on, on the customer their plan is paid by. Called only by
 * startAssistant, which first makes sure the store has no add-on live, still charged or open at Stripe.
 */
export async function createAssistantCheckout(store: Store, origin: string): Promise<string> {
  if (assistantRefusal(store)) throw new Error("the add-on cannot be sold to this store now");
  const body = new URLSearchParams({
    mode: "subscription",
    "subscription_data[billing_mode][type]": "classic",
    locale: "en",
    customer: store.stripeCustomerId!,
    "line_items[0][price]": await ensureAssistantPrice(),
    "line_items[0][quantity]": "1",
    "metadata[addon]": ADD_ON_MARK,
    "metadata[assistant_for]": store.handle,
    "subscription_data[metadata][addon]": ADD_ON_MARK,
    "subscription_data[metadata][assistant_for]": store.handle,
    // The bank is asked to authenticate the card: a fraud dispute then lands on the bank, not on us.
    "payment_method_options[card][request_three_d_secure]": "any",
    success_url: `${origin}/api/billing/assistant?session_id={CHECKOUT_SESSION_ID}${store.sid ? `&store=${store.sid}` : ""}`,
    cancel_url: `${origin}/studio?${store.sid ? `store=${store.sid}&` : ""}assistant=canceled#assistant`,
  });
  // Two tabs at the same moment send the same key, and Stripe gives both the same page (startAssistant gives an open
  // page again afterward). The price is in the key: a request with other values under a used key is refused by Stripe.
  const slot = Math.floor(Date.now() / 1000 / CHECKOUT_KEY_SECONDS);
  const idempotencyKey = `assistant-checkout:${store.stripeCustomerId}:${store.handle}:${body.get("line_items[0][price]")}:${slot}`;
  const session = await onPlatform("POST", "/checkout/sessions", body, { version: CHECKOUT_VERSION, idempotencyKey });
  if (typeof session.url !== "string" || !session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

/** How long one add-on checkout key lasts: two tabs opened at once fall in the same window. */
const CHECKOUT_KEY_SECONDS = 300;
/** The most pages of one customer's list read before a start; a longer list is not known to hold no add-on. */
const START_LIST_PAGES = 2;
/** Statuses under which Stripe charges a subscription, or may still charge it. */
const STILL_CHARGES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);
/** Statuses under which Stripe charges a subscription no more. */
const ENDED = new Set(["canceled", "incomplete_expired"]);
const CHECKOUT_PAGE = /^https:\/\/checkout\.stripe\.com\//;

/** A row that names this store's add-on in its own metadata. */
const isStoreAddOn = (row: Record<string, unknown>, store: Store): boolean => {
  const meta = ownField(row, "metadata");
  return plainObject(meta) && ownField(meta, "addon") === ADD_ON_MARK && ownField(meta, "assistant_for") === store.handle;
};

/**
 * One of the customer's lists on our account, read in its exact shape (lib/stripe-list.ts) for at most START_LIST_PAGES
 * pages. `complete` only when it was read to its end with every row readable: only then may it say "none".
 */
async function readCustomerList(path: string, query: URLSearchParams, legible: (row: Record<string, unknown>) => boolean, version?: string): Promise<{ rows: StripeRow[]; complete: boolean }> {
  const rows: StripeRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < START_LIST_PAGES; page += 1) {
    if (after) query.set("starting_after", after);
    const read = readStripePage(await onPlatform("GET", `${path}?${query}`, undefined, version ? { version } : undefined), legible);
    rows.push(...read.rows);
    if (read.unreadable) return { rows, complete: false };
    if (!read.hasMore) return { rows, complete: true };
    if (!read.lastId) return { rows, complete: false };
    after = read.lastId;
  }
  return { rows, complete: false };
}

export type AssistantStart =
  /** The page to pay on: an open one for this store's add-on, or a new one. */
  | { checkout: string }
  /** A live add-on at Stripe for this store, written down now: no checkout opened. */
  | { already: Store }
  /** One Stripe may still charge for this store (its first payment, or a retried one): no second one beside it. */
  | { waiting: true };

/**
 * Where a creator starts the add-on (app/api/billing/assistant/route.ts). The local record alone does not show the
 * store has none: the way back from a paid checkout may not have been written ("unconfirmed"), or another tab paid. So
 * the customer's subscriptions are read from Stripe first; a live add-on for this store is adopted, and one Stripe may
 * still charge opens nothing. Then an open page for this store's add-on is given again. A checkout is created only
 * when both lists were read to their end and hold none; any other reply throws, and nothing opens (rule 24: unknown
 * is never "none").
 */
export async function startAssistant(store: Store, origin: string): Promise<AssistantStart> {
  if (assistantRefusal(store)) throw new Error("the add-on cannot be sold to this store now");
  const customer = store.stripeCustomerId!;
  const subscriptions = await readCustomerList("/subscriptions", new URLSearchParams({ customer, status: "all", limit: "100" }), (row) => {
    const meta = ownField(row, "metadata");
    const status = ownField(row, "status");
    if (!(meta === null || plainObject(meta)) || typeof status !== "string" || !(STILL_CHARGES.has(status) || ENDED.has(status))) return false;
    return !isStoreAddOn(row, store) || (ownField(row, "customer") === customer && SUBSCRIPTION_PATTERN.test(row.id as string));
  });
  const mine = subscriptions.rows.filter((row) => isStoreAddOn(row, store));
  const live = mine.find((row) => ownField(row, "status") === "active");
  if (live) {
    const plan = assistantPlanOf(live);
    const saved = plan ? await setAssistantPlan(storeRef(store), plan) : null;
    // Not written down, the next start would ask again: an error to retry, never "already".
    if (!saved) throw new Error("the store's live add-on was not written down");
    return { already: await syncAssistant(saved, live) };
  }
  if (mine.some((row) => STILL_CHARGES.has(ownField(row, "status") as string))) return { waiting: true };
  if (!subscriptions.complete) throw new StripeListUnreadable("the store's add-on subscriptions are not all known");

  const pages = await readCustomerList("/checkout/sessions", new URLSearchParams({ customer, status: "open", limit: "100" }), (row) => {
    const meta = ownField(row, "metadata");
    if (!(meta === null || plainObject(meta)) || ownField(row, "status") !== "open" || typeof ownField(row, "mode") !== "string") return false;
    const url = ownField(row, "url");
    return !isStoreAddOn(row, store) || (ownField(row, "customer") === customer && typeof url === "string" && CHECKOUT_PAGE.test(url));
  }, CHECKOUT_VERSION);
  const open = pages.rows.find((row) => isStoreAddOn(row, store) && ownField(row, "mode") === "subscription");
  if (open) return { checkout: ownField(open, "url") as string };
  if (!pages.complete) throw new StripeListUnreadable("the store's open add-on pages are not all known");
  return { checkout: await createAssistantCheckout(store, origin) };
}

/** What one add-on subscription says, as the store keeps it. Only "active" answers: an unpaid month of AI is not given on credit. */
export function assistantPlanOf(subscription: Record<string, unknown>, disputedAt = ""): AssistantPlan | null {
  const id = typeof subscription.id === "string" ? subscription.id : "";
  if (!SUBSCRIPTION_PATTERN.test(id)) return null;
  const items = subscription.items as { data?: { current_period_start?: unknown; current_period_end?: unknown }[] } | undefined;
  const start = items?.data?.[0]?.current_period_start ?? subscription.current_period_start;
  const end = items?.data?.[0]?.current_period_end ?? subscription.current_period_end;
  const cancelAt = typeof subscription.cancel_at === "number" ? subscription.cancel_at : 0;
  const cancelsAtEnd = subscription.cancel_at_period_end === true || cancelAt > 0;
  const period = typeof start === "number" && typeof end === "number" && end > start ? { start, end: cancelAt && cancelAt < end ? cancelAt : end, renews: !cancelsAtEnd } : null;
  return { subscriptionId: id, active: subscription.status === "active" && !disputedAt, period, cancelsAtEnd, disputedAt };
}

/** Reads a returning checkout session: it must be an add-on for this very store, on this store's own customer. */
export async function readAssistantReturn(store: Store, sessionId: string | undefined): Promise<AssistantPlan | null> {
  if (!sessionId || !SESSION_PATTERN.test(sessionId)) return null;
  let session: Record<string, unknown>;
  try {
    session = await onPlatform("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  } catch (error) {
    if (error instanceof BillingError && error.status === 404) return null;
    throw error;
  }
  // Another page's reply, or one with no id, grants nothing: the return says "unconfirmed", and the daily job
  // (billing-sync) reads the add-on again from Stripe's list.
  if (!isOwnReply(session, sessionId)) throw new NotOwnReply(sessionId);
  const meta = session.metadata as Record<string, string> | null;
  if (session.mode !== "subscription" || meta?.addon !== ADD_ON_MARK || meta.assistant_for !== store.handle) return null;
  if (typeof session.customer !== "string" || session.customer !== store.stripeCustomerId) return null;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : "";
  if (!SUBSCRIPTION_PATTERN.test(subscriptionId)) return null;
  // A reply for another subscription throws: the return says "unconfirmed", and the daily job (billing-sync) reads
  // the add-on again from Stripe's list.
  return assistantPlanOf(await readSubscription(subscriptionId));
}

/**
 * Whether any of the add-on's last payments was disputed. The page is read in its exact shape (lib/stripe-list.ts):
 * a disputed charge on any readable row is a yes; "none disputed" is said only when every row of the page is readable
 * (each with its charge, or none, and that charge's own disputed true or false). Otherwise it throws, and nothing is
 * written on it this run (syncAssistant leaves the store as it is). The page is the last three payments by design, so
 * more invoices after them do not make it incomplete.
 */
async function disputed(subscriptionId: string): Promise<boolean> {
  const chargeOf = (row: Record<string, unknown>) => ownField(row, "charge");
  const read = readStripePage(
    await onPlatformAt(INVOICE_VERSION, "GET", `/invoices?${new URLSearchParams({ subscription: subscriptionId, limit: "3", "expand[]": "data.charge" })}`),
    (row) => {
      if (!hasOwnField(row, "charge")) return false;
      const charge = chargeOf(row);
      return charge === null || (plainObject(charge) && typeof ownField(charge, "disputed") === "boolean");
    },
  );
  if (read.rows.some((row) => { const charge = chargeOf(row); return plainObject(charge) && ownField(charge, "disputed") === true; })) return true;
  if (read.unreadable) throw new StripeListUnreadable("an add-on invoice not readable");
  return false;
}

/**
 * Brings a store's add-on in line with Stripe: what the subscription says;
 * a disputed payment ends it at once and keeps it from being sold to this
 * store again; a plan that is no longer paid sets it to stop at the end of
 * the month already paid. Called on the way back from checkout, from the
 * studio, and by the daily job (lib/billing-sync.ts). Returns the store as
 * it is now. Unchanged when Stripe cannot be asked, or answers for another
 * subscription than this add-on's (rule 30): nothing is ended, stopped or
 * written on such a reply, and the next call reads again.
 */
export async function syncAssistant(store: Store, subscription?: Record<string, unknown>, nowSeconds = Date.now() / 1000): Promise<Store> {
  const id = store.assistantPlan?.subscriptionId;
  if (!id) return store;
  try {
    let current = subscription ?? (await readSubscription(id));
    if (!isOwnReply(current, id)) throw new NotOwnReply(id);
    let disputedAt = store.assistantPlan?.disputedAt ?? "";
    if (!disputedAt && current.status === "active" && (await disputed(id))) {
      disputedAt = new Date(nowSeconds * 1000).toISOString();
      await onPlatform("DELETE", `/subscriptions/${encodeURIComponent(id)}`).catch((error) => console.error("ending a disputed add-on failed", error));
    }
    if (!disputedAt && current.status === "active" && current.cancel_at_period_end !== true && standingOf(store, nowSeconds) !== "paid") {
      await setCancelAtPeriodEnd(id, true);
      current = await readSubscription(id);
    }
    const plan = assistantPlanOf(current, disputedAt);
    if (!plan) return store;
    return (await setAssistantPlan(storeRef(store), plan)) ?? store;
  } catch (error) {
    if (error instanceof BillingError && error.status === 404) {
      return (await setAssistantPlan(storeRef(store), { ...store.assistantPlan!, active: false })) ?? store;
    }
    console.error("reading a store's add-on failed", error);
    return store;
  }
}

/**
 * An add-on of this very store, on its own customer, active and renewing, read in its exact shape (rule 24): its own
 * metadata marks it `addon=assistant` for this store and carries no plan's `store`, and its stop fields say it does not
 * stop (`cancel_at_period_end` exactly false, `cancel_at` exactly null). Anything else is not known to be one.
 */
function renewsForStore(subscription: Record<string, unknown>, store: Store): boolean {
  const meta = ownField(subscription, "metadata");
  return (
    ownField(subscription, "status") === "active" &&
    ownField(subscription, "cancel_at_period_end") === false &&
    hasOwnField(subscription, "cancel_at") &&
    ownField(subscription, "cancel_at") === null &&
    typeof store.stripeCustomerId === "string" &&
    ownField(subscription, "customer") === store.stripeCustomerId &&
    plainObject(meta) &&
    ownField(meta, "addon") === ADD_ON_MARK &&
    ownField(meta, "assistant_for") === store.handle &&
    !hasOwnField(meta, "store")
  );
}

/**
 * A second live add-on beside the one a store wrote down (two starts paid at the same moment, across the checkout key's
 * window): settled by the daily job, never left for a person. The written-down one is read again from Stripe in this
 * run; only when it is confirmed an undisputed add-on of this store, active and renewing, is the second one read again
 * the same way and, when it too is an undisputed active add-on of this store, set to stop at the end of the month
 * already paid (setCancelAtPeriodEnd: never ended at once, never refunded or prorated), under a key named by that
 * subscription so a retry is the same request. Any other reply leaves both as they are, and a stop whose reply is not
 * acknowledged is not done: the next run reads both again. True only when Stripe acknowledged the stop.
 */
async function settleSecondAddOn(store: Store, secondId: string): Promise<boolean> {
  const keptId = store.assistantPlan?.subscriptionId ?? "";
  if (!SUBSCRIPTION_PATTERN.test(keptId) || keptId === secondId) return false;
  try {
    const kept = await readSubscription(keptId);
    if (!renewsForStore(kept, store) || (await disputed(keptId))) {
      console.error("a second add-on beside one Stripe does not confirm active and renewing: both left as they are");
      return false;
    }
    const second = await readSubscription(secondId);
    // One in dispute is never acted on here: the dispute rules (syncAssistant) stay as they are.
    if (!renewsForStore(second, store) || (await disputed(secondId))) return false;
    const state = await setCancelAtPeriodEnd(secondId, true, `assistant-duplicate-stop:${secondId}`);
    if (state.state !== "active" || !state.cancelsAtEnd) throw new Error("the stop of a second add-on was not acknowledged");
    return true;
  } catch (error) {
    console.error("settling a second add-on failed; the next run reads it again", error);
    return false;
  }
}

/** One add-on subscription met in Stripe's list (lib/billing-sync.ts): its store, by `assistant_for`, brought in line when it is that store's. */
export async function applyListedAssistant(subscription: Record<string, unknown>): Promise<boolean> {
  const meta = subscription.metadata as Record<string, string> | null | undefined;
  const handle = meta?.assistant_for;
  const id = typeof subscription.id === "string" ? subscription.id : "";
  if (!handle || !SUBSCRIPTION_PATTERN.test(id)) return false;
  const store = await storeForHandle(handle);
  if (!store) return false;
  const customer = typeof subscription.customer === "string" ? subscription.customer : (subscription.customer as { id?: unknown } | null)?.id;
  // Only on this store's own customer: an address let go may be another store's now.
  if (!store.stripeCustomerId || customer !== store.stripeCustomerId) return false;
  if (store.assistantPlan && store.assistantPlan.subscriptionId !== id) {
    // Another one beside the one written down. Beside one in good standing, a live second one is set to stop
    // (settleSecondAddOn); beside one no longer active, a live one is adopted below.
    if (store.assistantPlan.active) {
      if (!isAddOn(subscription) || subscription.status !== "active" || subscription.cancel_at_period_end === true) return false;
      return settleSecondAddOn(store, id);
    }
    if (subscription.status !== "active") return false;
  }
  const known = store.assistantPlan?.subscriptionId === id ? store : ((await setAssistantPlan(storeRef(store), assistantPlanOf(subscription))) ?? store);
  await syncAssistant(known, subscription);
  return true;
}

/** Sets the add-on to stop at the end of the month paid, or takes that back. */
export async function setAssistantStop(store: Store, stop: boolean): Promise<Store | null> {
  const id = store.assistantPlan?.subscriptionId;
  if (!id || !store.assistantPlan?.active) return null;
  await setCancelAtPeriodEnd(id, stop);
  return syncAssistant(store);
}
