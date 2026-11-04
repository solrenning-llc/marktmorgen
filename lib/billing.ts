import {activateRestartContract,type RestartContractActivation} from "@/lib/contract-restart-activation";
import {publishRestartStore} from "@/lib/contract-restart-publication";
import {createHash,randomUUID} from 'node:crypto';
import {canonicalFinancialSnapshot,CONTRACT_FUNDING_RULES} from '@/lib/contract-funding-rules';
import {takeRestartRecovery,restartSubmissionOpenNow,recordRestartResult,armRestartSubmission,claimRestartIntent,reserveRestartContractFunding,activateCheckoutContract,activateSwitchContract,type ContractGrant,type OwnedRestartIntent,type ArmedRestartSubmission} from '@/lib/contract-funding';
/**
 * The one way Marktmorgen makes money.
 *
 * A subscription on our own Stripe account, monthly or yearly. While the
 * share of each sale is off (lib/plan.ts COMMISSION_LIVE) it is the whole of
 * what we charge; once it is on, the share is taken from each sale on the
 * creator's own account (lib/platform-share.ts), never through this file.
 *
 * Note which account each call runs on. Everything here is the PLATFORM
 * account — no Stripe-Account header anywhere in this file. The creator's own
 * account lives in stripe-connect.ts and store-checkout.ts, and the two must
 * never be confused: a charge made on the wrong one is either us taking a cut
 * we promised not to take, or us billing ourselves.
 */
import { STRIPE_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import {
  type Cycle,
  type Tier,
  PLAN_NAMES,
  PLAN_PRICES,
  PUBLISHED_PLAN_PRICES,
  PRICES_WITHOUT_COMMISSION,
  LEGACY_PLAN_PRICES,
  COMMISSION_LIVE,
  PRICE_CENTS,
  TRIAL_DAYS,
  isSharedPrice,
} from "@/lib/plan";
import { inTheCurrencyShown } from "@/lib/instant-pay";
import { normaliseEmail } from "@/lib/auth";
import {
  CUSTOMER_PATTERN,
  storeForRestartSource,
  HANDLE_PATTERN,
  SUBSCRIPTION_PATTERN,
  type Store,
} from "@/lib/store";
import { feeWords } from "@/lib/fee-words";
import { type BillingPeriod, isPeriod } from "@/lib/allowance-window";
import { costsPaused } from "@/lib/plan-standing";

/** Internal billing calls must keep their route-issued cash grant bound to the
 * published offer. This does not create or release a funding reservation. */
function assertFunding(funding:ContractGrant|undefined,tier:Tier,cycle:Cycle,action:ContractGrant['action'],statsId?:string,subscriptionId?:string):void {
 if(!funding)return;
 const now=Math.floor(Date.now()/1000);
 if(funding.action!==action||(action==='switch'?funding.sourceSubscriptionId!==subscriptionId:funding.sourceSubscriptionId!==null)||funding.key!==tier+'_'+cycle||!/^ctr_[A-Za-z0-9_-]{1,80}$/.test(funding.id)||!Number.isSafeInteger(funding.reservedCents)||funding.reservedCents<PUBLISHED_PLAN_PRICES[tier][cycle]||PLAN_PRICES[tier][cycle]!==PUBLISHED_PLAN_PRICES[tier][cycle]||!Number.isSafeInteger(funding.submitUntilSeconds)||(now<funding.submitUntilSeconds-CONTRACT_FUNDING_RULES.submissionSeconds||now>funding.submitUntilSeconds)||!Number.isSafeInteger(funding.checkoutExpiresAtSeconds)||funding.checkoutExpiresAtSeconds<now+1800||statsId!==undefined&&funding.statsId!==statsId)throw new Error('Funding grant does not cover this published plan or activation window');
}

/**
 * The price and the trial come from lib/plan.ts and are passed straight
 * through, so the checkout this file opens and the price the site advertises
 * cannot drift apart. They are re-exported because this file is where the
 * rest of the app already looks for them.
 */
export { PRICE_CENTS, TRIAL_DAYS };

/** Local tests may point this at a mock on 127.0.0.1; nothing else is taken. */
const STRIPE_API = /^http:\/\/127\.0\.0\.1:\d+$/.test(
  process.env.STRIPE_CONNECT_API_BASE ?? "",
)
  ? `${process.env.STRIPE_CONNECT_API_BASE}/v1`
  : "https://api.stripe.com/v1";

function platformKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key || !/^(sk|rk)_(test|live)_/.test(key)) return null;
  return key;
}

export function isBillingConfigured(): boolean {
  return platformKey() !== null;
}

const SESSION_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

export class BillingError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, stripeMessage: string) {
    // Stripe's sentence is kept. A bare code in a log costs a trip through the
    // dashboard before anyone knows what went wrong.
    super(`Stripe billing failed (${status} ${code}): ${stripeMessage}`);
    this.status = status;
    this.code = code;
  }
}

export async function onPlatform(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: URLSearchParams,
  pinned?: { version?: string; idempotencyKey?: string },
): Promise<Record<string, unknown>> {
  const key = platformKey();
  if (!key) throw new Error("Billing is not configured");

  // Given up after STRIPE_TIMEOUT_MS as a network failure is (lib/fetch-timeout.ts).
  const { response, data } = await timed(STRIPE_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`${STRIPE_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(pinned?.version ? { "Stripe-Version": pinned.version } : {}),
        ...(pinned?.idempotencyKey ? { "Idempotency-Key": pinned.idempotencyKey.slice(0, 255) } : {}),
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body,
      cache: "no-store",
      signal,
    });
    return { response, data: (await response.json()) as Record<string, unknown> };
  });
  if (!response.ok) {
    const error = data.error as
      | { code?: string; type?: string; message?: string }
      | undefined;
    throw new BillingError(
      response.status,
      error?.code ?? error?.type ?? "unknown",
      error?.message ?? "Stripe gave no reason.",
    );
  }
  return data;
}

/**
 * One request on our own account at a pinned API version, for a caller whose
 * reading depends on the shape of what comes back (invoices moved their
 * subscription and payments under new names in 2025). `idempotencyKey` for a
 * write that must never happen twice.
 */
export function onPlatformAt(
  version: string,
  method: "GET" | "POST",
  path: string,
  body?: URLSearchParams,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  return onPlatform(method, path, body, { version, idempotencyKey });
}

/**
 * What marks a subscription of ours as an add-on (the Store assistant,
 * lib/assistant-billing.ts), not a plan, in its metadata. An add-on never
 * carries `metadata[store]`, so the plan's searches and the daily sync never
 * read one as a plan; the reminders about a plan's payment pass it over.
 */
export const ADD_ON_MARK = "assistant";
export function isAddOn(subscription: Record<string, unknown>): boolean {
  const meta = subscription.metadata as Record<string, string> | null | undefined;
  return meta?.addon === ADD_ON_MARK;
}

/** Our products at Stripe, one per plan, under names we choose. */
const PRODUCT_IDS: Record<Tier, string> = {
  creator: "nimbus_labs_creator",
  pro: "nimbus_labs_pro",
  scale: "nimbus_labs_scale",
};
const PRODUCT_DESCRIPTIONS: Record<Tier, string> = {
  creator: feeWords(COMMISSION_LIVE).storeProduct,
  pro: "Everything in Marktmorgen, and what costs us money to run for you.",
  scale: "Everything in Marktmorgen Studio, with the published Scale email and storage allowances.",
};

/** The name each price is found by, so there is never a second one. */
export function lookupKey(tier: Tier, cycle: Cycle): string {
  return `nimbus_${tier}_${cycle}`;
}

function planFromLookupKey(key: unknown): { tier: Tier; cycle: Cycle } | null {
  const match = typeof key === "string" ? /^nimbus_(creator|pro|scale)_(month|year)$/.exec(key) : null;
  return match ? { tier: match[1] as Tier, cycle: match[2] as Cycle } : null;
}

async function ensureProduct(tier: Tier): Promise<string> {
  const id = PRODUCT_IDS[tier];
  try {
    const found = await onPlatform("GET", `/products/${id}`);
    if (found.active === false) {
      await onPlatform("POST", `/products/${id}`, new URLSearchParams({ active: "true" }));
    }
    return id;
  } catch (error) {
    if (!(error instanceof BillingError) || error.status !== 404) throw error;
  }
  try {
    await onPlatform(
      "POST",
      "/products",
      new URLSearchParams({ id, name: PLAN_NAMES[tier], description: PRODUCT_DESCRIPTIONS[tier] }),
    );
  } catch (error) {
    // Made a moment ago by another request: that one is ours too.
    if (!(error instanceof BillingError) || error.code !== "resource_already_exists") throw error;
  }
  return id;
}

/** A lookup name or bare ID is not proof of the amount and billing interval. */
function matchingPlanPrice(value: Record<string, unknown> | undefined, amount: number, cycle: Cycle): string | null {
  const recurring = value?.recurring as { interval?: unknown; interval_count?: unknown } | undefined;
  return typeof value?.id === "string" && value.id.length > 0 &&
    value.unit_amount === amount && value.currency === "usd" &&
    recurring?.interval === cycle && recurring?.interval_count === 1 ? value.id : null;
}

const priceIds = new Map<string, string>();

/**
 * The Stripe price for a plan, made the first time it is needed.
 *
 * The amount comes from lib/plan.ts, and a price at Stripe that no longer
 * matches it is replaced, never used: the number the site shows is the number
 * that is charged. A subscription has to point at a real price to be moved
 * from one plan to another, which is why these exist at all.
 */
export async function ensurePrice(tier: Tier, cycle: Cycle): Promise<string> {
  const key = lookupKey(tier, cycle);
  const amount = PLAN_PRICES[tier][cycle];
  const cached = priceIds.get(`${key}:${amount}`);
  if (cached) return cached;

  const listed = await onPlatform(
    "GET",
    `/prices?${new URLSearchParams({ "lookup_keys[]": key, active: "true", limit: "1" })}`,
  );
  const found = (listed.data as Record<string, unknown>[] | undefined)?.[0];
  const existingId = matchingPlanPrice(found, amount, cycle);
  if (existingId) {
    priceIds.set(`${key}:${amount}`, existingId);
    return existingId;
  }

  const product = await ensureProduct(tier);
  const made = await onPlatform(
    "POST",
    "/prices",
    new URLSearchParams({
      currency: "usd",
      unit_amount: String(amount),
      "recurring[interval]": cycle,
      "recurring[interval_count]": "1",
      product,
      lookup_key: key,
      // Takes the name from an old price whose amount no longer matches.
      transfer_lookup_key: "true",
      nickname: `${PLAN_NAMES[tier]}, ${cycle === "year" ? "yearly" : "monthly"}`,
    }),
  );
  const madeId = matchingPlanPrice(made, amount, cycle);
  if (!madeId) throw new Error("Stripe did not confirm the requested price and single billing interval");
  priceIds.set(`${key}:${amount}`, madeId);
  return madeId;
}

/** The same price, written out on the checkout itself. */
function writeInline(body: URLSearchParams, tier: Tier, cycle: Cycle): void {
  body.set("line_items[0][price_data][currency]", "usd");
  body.set("line_items[0][price_data][unit_amount]", String(PLAN_PRICES[tier][cycle]));
  body.set("line_items[0][price_data][recurring][interval]", cycle);
  body.set("line_items[0][price_data][product_data][name]", PLAN_NAMES[tier]);
  body.set("line_items[0][price_data][product_data][description]", PRODUCT_DESCRIPTIONS[tier]);
}

/**
 * Whether this store is offered the free trial.
 *
 * Once per store: a store that has ever started a subscription with us —
 * trial or not, cancelled or not — pays from the first day when it starts
 * again. Otherwise cancelling inside the trial and starting over would be a
 * free store for as long as anyone cared to keep doing it. The studio reads
 * the same answer, so the button never promises a trial the checkout does not
 * open with.
 *
 * And once per account: the trial is for an account's first store, the one
 * that decides whether we are worth paying for. Every other store an account
 * makes is a subscription of its own from its first day — five stores are
 * not five trials in a row.
 */
export function trialOffered(store: Pick<Store, "stripeCustomerId" | "subscriptionId" | "extra">): boolean {
  return !store.extra && !store.stripeCustomerId && !store.subscriptionId;
}

/**
 * Opens the page where a creator starts paying, and returns where to send them.
 *
 * The amount lives in lib/plan.ts and nowhere else. If the price at Stripe
 * cannot be read or made just now, the checkout is still opened with the same
 * amount written out inline, so a creator ready to pay is never turned away
 * over it.
 *
 * `customerId` is the customer this store already paid us from, when there is
 * one, so a returning creator stays one customer with one history — and, for
 * an account's other stores, the customer its first store pays from, so one
 * person with several stores is one customer with several subscriptions.
 */
export async function createBillingCheckout(
  store: Store,
  origin: string,
  choice: { tier: Tier; cycle: Cycle } = { tier: "creator", cycle: "month" },
  customerId: string | null = store.stripeCustomerId,
  funding?:ContractGrant,
  /** Sooner than its usual end (a store in its closing period, lib/closing-plan-guard.ts): never later than this. */
  expiresAtSeconds?: number,
): Promise<string> {
  const { tier, cycle } = choice;
  assertFunding(funding,tier,cycle,'checkout',store.statsId??'');
  const body = new URLSearchParams({
    mode: "subscription",
    // Keep collection explicit even when a trial has nothing due today.
    payment_method_collection: "always",
    // English, always. Left to itself Stripe picks the language of the
    // browser, and a creator in the United States should never meet a
    // payment page in whatever language the last person to test it spoke.
    locale: "en",
    "line_items[0][quantity]": "1",
    "subscription_data[metadata][store]": store.handle,
    "subscription_data[metadata][tier]": tier,
    "metadata[store]": store.handle,
    // The store rides along, so an owner of several comes back to the one
    // they were paying for, and the way back writes it down on that one.
    success_url: `${origin}/api/billing/return?session_id={CHECKOUT_SESSION_ID}${store.sid ? `&store=${store.sid}` : ""}`,
    cancel_url: `${origin}/studio?${store.sid ? `store=${store.sid}&` : ""}billing=canceled`,
  });
  if(funding){body.set('expires_at',String(funding.checkoutExpiresAtSeconds));body.set('metadata[funding_grant]',funding.id);body.set('metadata[funding_review]',funding.reviewId);body.set('subscription_data[metadata][funding_grant]',funding.id);body.set('subscription_data[metadata][funding_review]',funding.reviewId);}
  if (expiresAtSeconds !== undefined && Number.isSafeInteger(expiresAtSeconds)) {
    const usual = Number(body.get("expires_at"));
    body.set("expires_at", String(usual > 0 ? Math.min(usual, expiresAtSeconds) : expiresAtSeconds));
  }
  if (customerId && CUSTOMER_PATTERN.test(customerId)) {
    body.set("customer", customerId);
  } else {
    body.set("customer_email", store.email);
  }
  if (trialOffered(store)) {
    body.set("subscription_data[trial_period_days]", String(TRIAL_DAYS));
    body.set("subscription_data[trial_settings][end_behavior][missing_payment_method]", "cancel");
  }
  // A year is paid at once, and a yearly first payment is refundable in full
  // for thirty days: the one charge a stolen card would go for. The card's
  // bank is asked to authenticate it (3D Secure), which moves a fraud dispute
  // onto the bank rather than onto us. A month is left to Stripe's own
  // judgement, so the usual sign-up keeps its one-page checkout.
  if (cycle === "year") body.set("payment_method_options[card][request_three_d_secure]", "any");
  inTheCurrencyShown(body);

  let price: string | null = null;
  try {
    price = await ensurePrice(tier, cycle);
  } catch (error) {
    console.error("reading our price failed; opening the checkout with it inline", error);
  }
  if (price) {
    body.set("line_items[0][price]", price);
  } else {
    writeInline(body, tier, cycle);
  }

  let session: Record<string, unknown>;
  try {
    assertFunding(funding,tier,cycle,'checkout',store.statsId??'');
    session = await onPlatform("POST", "/checkout/sessions", body);
  } catch (error) {
    if (!(error instanceof BillingError) || error.status !== 400) throw error;
    if (body.has("customer") && /customer/i.test(error.message)) {
      // A customer Stripe no longer has — deleted, or made with a test key —
      // is started again from the address, the way a first checkout is.
      body.delete("customer");
      body.set("customer_email", store.email);
    } else if (price) {
      // A price archived at Stripe since we last read it: forget it, and open
      // the checkout with the amount written out instead.
      priceIds.clear();
      body.delete("line_items[0][price]");
      writeInline(body, tier, cycle);
    } else {
      throw error;
    }
    assertFunding(funding,tier,cycle,'checkout',store.statsId??'');
    session = await onPlatform("POST", "/checkout/sessions", body);
  }
  if (typeof session.url !== "string" || !session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }
  return session.url;
}

/** What a finished checkout left behind, once Stripe confirms it is ours. */
export type StartedSubscription = {
  customerId: string;
  subscriptionId: string;
  active: boolean;
  /** Only the joint funded Store/index/generation publisher returns this acknowledgement. */
  fundedPublication?: true;
  tier: Tier;
  cycle: Cycle;
  trialEnds: number;
  /** Whether the plan is at the prices that go with a share of each sale. */
  shared: boolean;
  /** The period paid for, which the store's allowances follow (lib/allowance-window.ts); null when Stripe did not say. */
  period: BillingPeriod | null;
};

/**
 * Reads a returning checkout session and says what it actually created.
 *
 * The session id arrives in a URL the creator's browser followed, so it is
 * treated as a claim, not a fact: it must look like a session id, Stripe must
 * know it, it must be a subscription, and its metadata must name this very
 * store. A session from somewhere else buys nothing here.
 */
export async function readStartedSubscription(
  store: Store,
  sessionId: string | undefined,
): Promise<StartedSubscription | null> {
  if (!sessionId || !SESSION_PATTERN.test(sessionId)) return null;

  let session: Record<string, unknown>;
  try {
    session = await onPlatform(
      "GET",
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
    );
  } catch (error) {
    if (error instanceof BillingError && error.status === 404) return null;
    throw error;
  }

  if (session.mode !== "subscription") return null;
  const metadata = session.metadata as Record<string, string> | null;
  if (metadata?.store !== store.handle) return null;

  const customerId = typeof session.customer === "string" ? session.customer : "";
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : "";
  if (!CUSTOMER_PATTERN.test(customerId)) return null;
  if (!SUBSCRIPTION_PATTERN.test(subscriptionId)) return null;

  // Funded checkouts must reconcile the immutable cash receipt before this
  // return path can adopt their rights. The existing subscription GET is reused.
  let state:SubscriptionState;
  if(metadata.funding_grant!==undefined||metadata.funding_review!==undefined){
    const subscription=await subscriptionRecord(subscriptionId);
    if(!subscription||subscription.id!==subscriptionId||subscription.customer!==customerId)return null;
    const meta=subscription.metadata as Record<string,unknown>|null;
    if(meta?.store!==store.handle||meta?.funding_grant!==metadata.funding_grant||meta?.funding_review!==metadata.funding_review)return null;
    state=stateOf(subscription);
    if(state.state!=="active"||state.changePending)return null;
    const items=subscription.items as {data?:{quantity?:unknown;price?:Record<string,unknown>}[]}|undefined;
    const price=items?.data?.[0]?.price;
    const recurring=price?.recurring as {interval?:unknown;interval_count?:unknown}|undefined;
    if(items?.data?.length!==1||items.data[0].quantity!==1||price?.currency!=="usd"||recurring?.interval!==state.cycle||recurring?.interval_count!==1||state.amountCents!==PUBLISHED_PLAN_PRICES[state.tier][state.cycle])return null;
    const began=state.trialing?subscription.trial_start:periodStart(subscription);
    const until=state.trialing?subscription.trial_end:periodEnd(subscription,false);
    if(!(await activateCheckoutContract({
      statsId:store.statsId??"",grantId:metadata.funding_grant,reviewId:metadata.funding_review,
      subscriptionId,tier:state.tier,cycle:state.cycle,createdSeconds:subscription.created as number,
      trialing:state.trialing,periodStartSeconds:began as number,periodEndSeconds:until as number,
    })))return null;
    if(state.state==='active')state={...state,period:fundedPeriod(state.period)};
  }else{
    // Legacy observations have no funded receipt. Their migration remains an
    // explicit unfinished release prerequisite; never invent or free a reserve.
    // Session metadata alone cannot classify a subscription as legacy: both
    // provider records must lack a funding reference. Reuse the same single
    // subscription GET, preserving unknown/missing outcomes without adoption.
    let subscription:Record<string,unknown>|null;
    try{subscription=await subscriptionRecord(subscriptionId);}
    catch(error){
      console.error("reading the subscription failed",error);
      return {customerId,subscriptionId,active:false,tier:"creator",cycle:"month",trialEnds:0,shared:false,period:null};
    }
    const meta=subscription?.metadata as Record<string,unknown>|null|undefined;
    if(meta?.funding_grant!==undefined||meta?.funding_review!==undefined)return null;
    state=subscription?stateOf(subscription):{state:"inactive",reason:"missing"};
  }
  return {
    customerId,
    subscriptionId,
    active: state.state === "active",
    tier: state.state === "active" ? state.tier : "creator",
    cycle: state.state === "active" ? state.cycle : "month",
    trialEnds: state.state === "active" && state.trialing ? state.until : 0,
    shared: state.state === "active" && state.shared,
    period: state.state === "active" ? state.period : null,
  };
}

export type SubscriptionState =
  /** Paying, or inside the trial. Either way the store may take money. */
  | {
      state: "active";
      trialing: boolean;
      /** When the paid period, or the trial, runs out. 0 if Stripe did not say. */
      until: number;
      /** Set to stop at `until`. Nothing more will be charged after it. */
      cancelsAtEnd: boolean;
      tier: Tier;
      cycle: Cycle;
      /** What each renewal charges, in cents, as Stripe has it. */
      amountCents: number;
      /** Whether that is a price that goes with a share of each sale (lib/plan.ts isSharedPrice). */
      shared: boolean;
      /** A change of plan is waiting on a payment the bank has not let through. */
      changePending: boolean;
      /**
       * The renewal of the period now running did not go through and Stripe
       * is still trying the card (`past_due`). The plan has not ended, but
       * what costs us to run stops until it is paid (lib/plan-standing.ts,
       * costStandingOf; queue item 232 [CA1] unit 4).
       */
      renewalUnpaid: boolean;
      /**
       * The period being paid for, which the store's allowances follow
       * (lib/allowance-window.ts): null while trialing, and when Stripe did
       * not give both ends. `renews` is false when it is set to stop.
       */
      period: BillingPeriod | null;
    }
  /** Stripe knows it and it is not paying: unpaid, cancelled, incomplete. */
  | { state: "inactive"; reason: string }
  /** Stripe could not be asked. Says nothing about whether they pay. */
  | { state: "unknown" };

/**
 * The statuses Stripe treats as a subscription in good standing.
 *
 * `past_due` is deliberately in here: a card that failed this morning is a
 * card, not a decision to leave, and Stripe retries it for days. Cutting a
 * creator's store off mid-retry would take their sales away over a bank's
 * timing.
 */
const GOOD = new Set(["active", "trialing", "past_due"]);

/** When the current period began: on the item in newer versions, on the subscription in older ones. */
function periodStart(subscription: Record<string, unknown>): number {
  const items = subscription.items as { data?: { current_period_start?: unknown }[] } | undefined;
  const fromItem = items?.data?.[0]?.current_period_start;
  if (typeof fromItem === "number") return fromItem;
  return typeof subscription.current_period_start === "number" ? subscription.current_period_start : 0;
}

/**
 * Whether a subscription whose last payment failed is still in its grace
 * while Stripe retries the card. Not when the payment that failed is the
 * first one after a free trial: nothing was ever paid, so the trial is
 * simply over. How long the retries last is set in our Stripe account
 * (Billing, retries), which ends the subscription when they run out.
 */
export function pastDueInGrace(subscription: Record<string, unknown>): boolean {
  const start = periodStart(subscription);
  const trialEnd = typeof subscription.trial_end === "number" ? subscription.trial_end : 0;
  return !(trialEnd && start && Math.abs(start - trialEnd) < 24 * 60 * 60);
}

/**
 * When the period already paid for, or the trial, runs out.
 *
 * Stripe moved `current_period_end` off the subscription and onto its items
 * in 2025. This file sends no Stripe-Version header, so it reads whatever the
 * account's default version returns: the item first, the old top-level field
 * if an older account still carries it. While trialing it is the trial's end,
 * because that is the date a creator in the trial is actually deciding about.
 */
function periodEnd(subscription: Record<string, unknown>, trialing: boolean): number {
  if (trialing && typeof subscription.trial_end === "number") {
    return subscription.trial_end;
  }
  const items = subscription.items as
    | { data?: { current_period_end?: unknown }[] }
    | undefined;
  const fromItem = items?.data?.[0]?.current_period_end;
  if (typeof fromItem === "number") return fromItem;
  if (typeof subscription.current_period_end === "number") {
    return subscription.current_period_end;
  }
  return 0;
}

/**
 * Which plan a subscription is on, read from its price: the name we gave the
 * price when there is one, and the amount and interval otherwise, so a
 * subscription begun before prices had names is still read right.
 */
export function planOf(subscription: Record<string, unknown>): { tier: Tier; cycle: Cycle; amountCents: number; shared: boolean } {
  const items = subscription.items as { data?: { price?: Record<string, unknown> }[] } | undefined;
  const price = items?.data?.[0]?.price ?? {};
  const recurring = price.recurring as { interval?: unknown } | null | undefined;
  const amountCents = typeof price.unit_amount === "number" ? price.unit_amount : 0;
  const named = planFromLookupKey(price.lookup_key);
  if (named) return { ...named, amountCents, shared: isSharedPrice(named.tier, named.cycle, amountCents) };
  const cycle: Cycle = recurring?.interval === "year" ? "year" : "month";
  const meta = subscription.metadata as Record<string, string> | null | undefined;
  // An unnamed price is read by what it charges: a plan's price on any list
  // published (today's, or one before 18 October 2026) is that plan; failing
  // that, at or above a plan's price today is that plan, the dearest first.
  const exact = (["scale", "pro", "creator"] as const).find((plan) =>
    amountCents > 0 && [PLAN_PRICES, PRICES_WITHOUT_COMMISSION, ...LEGACY_PLAN_PRICES].some((list) => list[plan][cycle] === amountCents));
  const paysFor = (plan: Tier) => amountCents > 0 && amountCents >= Math.min(PLAN_PRICES[plan][cycle], PRICES_WITHOUT_COMMISSION[plan][cycle]);
  const tier: Tier =
    exact ?? (meta?.tier === "scale" || paysFor("scale") ? "scale" : meta?.tier === "pro" || paysFor("pro") ? "pro" : "creator");
  return { tier, cycle, amountCents, shared: isSharedPrice(tier, cycle, amountCents) };
}

/** One reading of a subscription, used for what Stripe sends back either way. */
export function stateOf(subscription: Record<string, unknown>): SubscriptionState {
  const status = typeof subscription.status === "string" ? subscription.status : "";
  if (!GOOD.has(status)) return { state: "inactive", reason: status || "unknown" };
  if (status === "past_due" && !pastDueInGrace(subscription)) return { state: "inactive", reason: "past_due" };

  const trialing = status === "trialing";
  // Newer versions also fill `cancel_at` when a subscription is set to stop at
  // the period's end, and a date set by hand in the dashboard lands there too.
  // Either way it stops, and the date it stops on is the one to show.
  const cancelAt = typeof subscription.cancel_at === "number" ? subscription.cancel_at : 0;
  return {
    state: "active",
    trialing,
    until: cancelAt || periodEnd(subscription, trialing),
    cancelsAtEnd: subscription.cancel_at_period_end === true || cancelAt > 0,
    ...planOf(subscription),
    changePending: Boolean(subscription.pending_update),
    renewalUnpaid: status === "past_due",
    period: periodOf(subscription, trialing, subscription.cancel_at_period_end === true || cancelAt > 0),
  };
}

/** The period paid for, as the store keeps it; null while trialing or when either end is missing. */
export function periodOf(subscription: Record<string, unknown>, trialing: boolean, stops: boolean): BillingPeriod | null {
  if (trialing) return null;
  const period = { start: periodStart(subscription), end: periodEnd(subscription, false), renews: !stops };
  return isPeriod(period) ? period : null;
}

/** Asks Stripe what a subscription is doing right now. */
export async function readSubscription(
  subscriptionId: string,
  fundingStore?:Store,
): Promise<SubscriptionState> {
  if (!SUBSCRIPTION_PATTERN.test(subscriptionId)) {
    return { state: "inactive", reason: "shape" };
  }

  let subscription: Record<string, unknown>;
  try {
    subscription = await onPlatform(
      "GET",
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
  } catch (error) {
    if (error instanceof BillingError && error.status === 404) {
      return { state: "inactive", reason: "missing" };
    }
    console.error("reading the subscription failed", error);
    return { state: "unknown" };
  }

  // A successful HTTP response is not evidence about this subscription unless
  // its identity and status are explicit. Retain access on unknown observations.
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription) ||
      subscription.id !== subscriptionId || typeof subscription.status !== "string" ||
      !["active", "trialing", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"].includes(subscription.status)) {
    return { state: "unknown" };
  }
  const state=stateOf(subscription);
  if(state.state==='active'&&hasContractFunding(subscription)){
    if(!fundingStore||subscription.id!==subscriptionId)return{state:'unknown'};
    const observed=await startedFromObservedSubscription(fundingStore,subscription);if(!observed)return{state:'unknown'};
    return {...state,period:observed.period};
  }
  return state;
}

/**
 * The subscription as Stripe has it, for a caller that has to read more than
 * the state: when it started, and the card it is charged on. Null when Stripe
 * does not have it; thrown when Stripe could not be asked.
 */
export async function subscriptionRecord(subscriptionId: string): Promise<Record<string, unknown> | null> {
  if (!SUBSCRIPTION_PATTERN.test(subscriptionId)) return null;
  try {
    return await onPlatform("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  } catch (error) {
    if (error instanceof BillingError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Stripe's own page where an unpaid renewal is paid (232 [CA1] unit 4): the
 * hosted page of the subscription's latest invoice, while the subscription
 * is `past_due` and that invoice is open with money on it. Stripe's
 * "Hosted invoice page" guide (read 31 October 2026) says the page takes
 * any enabled payment method and that a URL retrieved through the API is
 * valid for at least 10 days; this is read when the studio is drawn, so the
 * link is always a fresh one. Null when there is none or Stripe could not
 * be asked: the studio then says how to get it instead.
 */
export async function renewalInvoicePage(subscriptionId: string): Promise<string | null> {
  if (!SUBSCRIPTION_PATTERN.test(subscriptionId)) return null;
  try {
    const subscription = await onPlatform("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=latest_invoice`);
    if (subscription?.id !== subscriptionId || subscription.status !== "past_due") return null;
    const invoice = subscription.latest_invoice as { status?: unknown; amount_due?: unknown; hosted_invoice_url?: unknown } | string | null;
    if (!invoice || typeof invoice !== "object" || invoice.status !== "open") return null;
    if (typeof invoice.amount_due !== "number" || invoice.amount_due <= 0) return null;
    const url = typeof invoice.hosted_invoice_url === "string" ? invoice.hosted_invoice_url : "";
    return INVOICE_PAGE.test(url) ? url : null;
  } catch (error) {
    console.error("reading the page that pays a renewal failed", error);
    return null;
  }
}

/**
 * Starts a store's plan again on the card it was last paid with, without the
 * creator at the keyboard: the end of a break they chose (lib/plan-pause.ts).
 *
 * Charged at once, or not at all: if the bank declines, or wants the creator
 * to confirm, Stripe makes nothing and this throws, so a store never ends up
 * with a subscription that is open and unpaid. The plan is the one they had,
 * monthly, at today's price, with no trial.
 */
/** An additional source restriction, not financial authorization.
 * Read only own primitives: an accessor or unknown owner is not a source.
 * The durable grant/barrier remains independently mandatory. */
export function fundedRestartSourceMatches(intent: OwnedRestartIntent, current: unknown): boolean {
  try {
    const encoded = canonicalFinancialSnapshot(intent);
    if (!encoded || !current || typeof current !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(current))) return false;
    const owned = JSON.parse(encoded) as OwnedRestartIntent;
    const paused = JSON.parse(owned.paused) as { customer?: unknown; tier?: unknown };
    if (typeof paused.customer !== "string" || typeof paused.tier !== "string") return false;
    const names = ["handle", "statsId", "subscriptionId", "stripeCustomerId", "subscriptionActive", "tier", "cycle", "email", "sid", "extra"] as const;
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const value: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return false;
      value[name] = descriptor.value;
    }
    if (typeof value.email !== "string" || typeof value.sid !== "string" || typeof value.extra !== "boolean") return false;
    const ref = value.extra ? "#" + value.sid : value.email;
    return owned.grant.action === "restart" && typeof owned.grant.sourceSubscriptionId === "string" &&
      owned.grant.key === paused.tier + "_month" && ref === owned.ref &&
      value.handle === owned.handle && value.statsId === owned.grant.statsId &&
      value.subscriptionId === owned.grant.sourceSubscriptionId &&
      value.stripeCustomerId === paused.customer && value.subscriptionActive === false &&
      value.tier === paused.tier && value.cycle === "month";
  } catch { return false; }
}

export async function restartPlan(input: {
  store: Pick<Store, "handle">;
  customerId: string;
  paymentMethod: string;
  tier: Tier;
  idempotencyKey: string;
  funding?: { statsId: string; sourceSubscriptionId: string; sourceGrantId: string | null; ref: string; paused: string };
}): Promise<StartedSubscription> {
  if (!CUSTOMER_PATTERN.test(input.customerId)) throw new Error("not a customer of ours");
  if (!/^(pm|card|src)_[A-Za-z0-9]{6,64}$/.test(input.paymentMethod)) throw new Error("no card to charge");
  if (input.funding) {
    const source = input.funding;
    // This branch is selected from the durable pause, not a now-inactive store.
    // Current coverage refuses before Redis or any ensurePrice/provider call.
    if (!source.sourceGrantId) throw new Error("The funded restart source is unknown");
    const recovery = await takeRestartRecovery({statsId:source.statsId,sourceSubscriptionId:source.sourceSubscriptionId,sourceGrantId:source.sourceGrantId,ref:source.ref,handle:input.store.handle,paused:source.paused});
    if (!recovery) throw new Error("The funded restart recovery observation is unknown");
    if (recovery.kind === "held") throw new Error("The funded restart remains held without another provider operation");
    if (recovery.kind === "activated") {
      const {armed,subscriptionId,createdSeconds,periodStartSeconds,periodEndSeconds,renews,shared}=recovery;
      const paused=JSON.parse(armed.intent.paused) as {customer?:unknown;paymentMethod?:unknown;tier?:unknown};
      if(paused.customer!==input.customerId||paused.paymentMethod!==input.paymentMethod||paused.tier!==input.tier||armed.intent.handle!==input.store.handle)
        throw new Error("The committed restart source does not match its durable owner");
      const activation={armed,subscriptionId,createdSeconds,periodStartSeconds,periodEndSeconds,renews,shared};
      if(!(await activateRestartContract(activation)))
        throw new Error("The retained paid restart activation was not acknowledged");
      const published=await publishRestartStore(activation);
      if(!published)throw new Error("The funded Store/index/generation publication remains unacknowledged");
      return published;
    }
    if (recovery.kind === "read") {
      const {armed}=recovery,paused=JSON.parse(armed.intent.paused) as {customer?:unknown;paymentMethod?:unknown;tier?:unknown};
      if(paused.customer!==input.customerId||paused.paymentMethod!==input.paymentMethod||paused.tier!==input.tier||armed.intent.handle!==input.store.handle)
        throw new Error("The funded recovery source does not match its durable owner");
      const ownedCustomer=paused.customer as string,ownedTier=paused.tier as Tier;
      let subscription:Record<string,unknown>;
      if(recovery.subscriptionId){
        subscription=await onPlatform("GET","/subscriptions/"+encodeURIComponent(recovery.subscriptionId));
        if(identifyFundedRestartResult(armed,{customerId:ownedCustomer,tier:ownedTier},subscription)!==recovery.subscriptionId)
          throw new Error("The known restart ID returned a different subscription");
      }else{
        // Search is only a bounded positive observation. Empty/lagging pages
        // never prove absence, restore a claim or permit another POST.
        const query="metadata['funding_grant']:'"+armed.intent.grant.id+"' AND metadata['restart_claim']:'"+armed.intent.claim+"' AND metadata['restart_source']:'"+armed.intent.grant.sourceSubscriptionId+"'";
        const page=await onPlatform("GET","/subscriptions/search?"+new URLSearchParams({query,limit:"2"}));
        subscription=selectRestartRecoveryCandidate(armed,{customerId:ownedCustomer,tier:ownedTier},page);
      }
      const id=identifyFundedRestartResult(armed,{customerId:ownedCustomer,tier:ownedTier},subscription);
      if(!(await recordRestartResult({armed,subscriptionId:id})))throw new Error("The recovered restart ID was not durably acknowledged");
      if(!recovery.subscriptionId)throw new Error("The identified restart ID is retained; a separately budgeted exact-ID GET is required before state adoption");
      const activation=observeFundedRestartActivation(armed,{customerId:ownedCustomer,tier:ownedTier},subscription);
      if(!(await activateRestartContract(activation)))throw new Error("The recovered funded restart activation was not acknowledged");
      const published=await publishRestartStore(activation);
      if(!published)throw new Error("The funded Store/index/generation publication remains unacknowledged");
      return published;
    }
    const grant = await reserveRestartContractFunding(source.statsId, source.sourceSubscriptionId, input.tier);
    const intent = grant ? await claimRestartIntent({ grant, ref: source.ref, handle: input.store.handle, paused: source.paused, sourceGrantId: source.sourceGrantId, claim: "claim_" + randomUUID() }) : null;
    if (!intent) throw new Error("The funded restart intent was not acknowledged");
    // Ownership carries the source observed atomically with its cash. Never
    // replace it with a newer active pointer or a mismatched provider request.
    const paused = JSON.parse(intent.paused) as {customer?:unknown;paymentMethod?:unknown;tier?:unknown};
    if (paused.customer !== input.customerId || paused.paymentMethod !== input.paymentMethod || paused.tier !== input.tier || intent.handle !== input.store.handle || intent.source.binding.split("|")[1] !== source.sourceSubscriptionId) {
      throw new Error("The funded restart source does not match its owned intent");
    }
    const ownedCustomer=paused.customer as string,ownedTier=paused.tier as Tier;
    // Only the first acknowledged owner may read its exact original subscription.
    // No search/list, cancellation mutation or retry can infer that it stopped.
    const original = await onPlatform("GET", `/subscriptions/${encodeURIComponent(intent.grant.sourceSubscriptionId!)}`);
    observeStoppedRestartSource(intent, original);
    // A bounded read of an existing published price cannot create products or
    // prices. Empty/ambiguous/partial pages are unknown, never inline fallback.
    const prices = await onPlatform("GET", "/prices?" + new URLSearchParams({
      "lookup_keys[]": lookupKey(ownedTier,"month"),active:"true",limit:"2",
    }));
    const priceId = observeFundedRestartPrice(intent, prices);
    const body = fundedRestartRequestBody(intent,priceId);
    const armed = await armRestartSubmission({intent,priceId,bodyHash:createHash("sha256").update(body.toString()).digest("hex")});
    if (!armed) throw new Error("The funded restart submission barrier was not acknowledged");
    // The barrier identifies exact request bytes and one permanent attempt.
    // No catch/retry, alternate price, fresh key or fallback can submit twice.
    if (armed.bodyHash !== createHash("sha256").update(body.toString()).digest("hex") || armed.priceId !== priceId ||
        !restartSubmissionOpenNow(armed)) {
      throw new Error("The funded restart request changed or its submission window ended");
    }
    // Source reads and price lookup may have waited while the owner changed
    // plans. Re-read a bounded current owner immediately before the one POST.
    // Refusal retains the armed owner/cash; it never re-arms or releases them.
    const currentSource = await storeForRestartSource(intent.ref);
    if (!fundedRestartSourceMatches(intent, currentSource) || !restartSubmissionOpenNow(armed)) {
      throw new Error("The current Store no longer matches the funded restart source");
    }
    const subscription = await onPlatform("POST", "/subscriptions", body, {idempotencyKey:armed.idempotencyKey});
    // Persist an identified outcome BEFORE validating it for adoption. Even a
    // mismatched customer/price is evidence for read-only reconciliation.
    const resultId = subscription?.id;
    if (typeof resultId !== "string" || !SUBSCRIPTION_PATTERN.test(resultId) ||
        !(await recordRestartResult({armed,subscriptionId:resultId}))) {
      throw new Error("The funded restart result ID was not durably acknowledged");
    }
    const activation=observeFundedRestartActivation(armed,{customerId:ownedCustomer,tier:ownedTier},subscription);
    if(!(await activateRestartContract(activation)))throw new Error("The funded restart activation was not acknowledged");
    // Publication still needs its own store ACK and generation-aware cleanup.
    // No rights, pause removal or notification can follow this stage yet.
    const published=await publishRestartStore(activation);
      if(!published)throw new Error("The funded Store/index/generation publication remains unacknowledged");
      return published;
  }
  const priceId = await ensurePrice(input.tier, "month");
  const body = new URLSearchParams({
    customer: input.customerId,
    "items[0][price]": priceId,
    "items[0][quantity]": "1",
    default_payment_method: input.paymentMethod,
    off_session: "true",
    payment_behavior: "error_if_incomplete",
    "metadata[store]": input.store.handle,
    "metadata[tier]": input.tier,
    "metadata[restarted]": "break",
  });
  const subscription = await onPlatform("POST", "/subscriptions", body, { idempotencyKey: input.idempotencyKey });
  return observeRestartedPlan({ customerId: input.customerId, tier: input.tier, priceId }, subscription);
}






/** Exact future request bytes from the immutable owned pause only. A mutable
 * caller object never supplies customer/card/tier/source after an await.
 */
export function fundedRestartRequestBody(intent:OwnedRestartIntent,priceId:string):URLSearchParams{
 const encoded=canonicalFinancialSnapshot({intent,priceId});
 if(!encoded)throw Error("The owned restart request is unknown");
 ({intent,priceId}=JSON.parse(encoded));
 const pause=JSON.parse(intent.paused) as {customer?:unknown;paymentMethod?:unknown;tier?:unknown;subscription?:unknown;funding?:{version?:unknown;grantId?:unknown}};
 const source=intent.grant.sourceSubscriptionId,tier=pause.tier;
 if(typeof pause.customer!=="string"||!CUSTOMER_PATTERN.test(pause.customer)||
    typeof pause.paymentMethod!=="string"||!/^(pm|card|src)_[A-Za-z0-9]{6,64}$/.test(pause.paymentMethod)||
    (tier!=="creator"&&tier!=="pro"&&tier!=="scale")||intent.grant.key!==tier+"_month"||intent.grant.action!=="restart"||
    typeof source!=="string"||!SUBSCRIPTION_PATTERN.test(source)||pause.subscription!==source||
    pause.funding?.version!==1||pause.funding.grantId!==intent.source.binding.split("|")[0]||
    !HANDLE_PATTERN.test(intent.handle)||!/^price_[A-Za-z0-9]{6,100}$/.test(priceId)||
    !/^ctr_[A-Za-z0-9_-]{1,80}$/.test(intent.grant.id)||!/^claim_[A-Za-z0-9_-]{1,80}$/.test(intent.claim))
  throw Error("The restart request does not match its immutable owned source");
 return new URLSearchParams({
  customer:pause.customer,"items[0][price]":priceId,"items[0][quantity]":"1",
  default_payment_method:pause.paymentMethod,off_session:"true",payment_behavior:"error_if_incomplete",
  "metadata[store]":intent.handle,"metadata[tier]":tier,"metadata[restarted]":"break",
  "metadata[funding_grant]":intent.grant.id,"metadata[funding_review]":intent.grant.reviewId,
  "metadata[funding_action]":"restart","metadata[restart_claim]":intent.claim,"metadata[restart_source]":source,
 });
}

/** Positive identity only, across all explicit statuses. A canceled result
 * remains evidence; it cannot pass the separate active paid-plan observer.
 */
export function identifyFundedRestartResult(armed:ArmedRestartSubmission,input:{customerId:string;tier:Tier},subscription:Record<string,unknown>):string{
 const encoded=canonicalFinancialSnapshot({armed,input,subscription});
 if(!encoded)throw Error("The restart recovery identity is unknown");
 ({armed,input,subscription}=JSON.parse(encoded));
 const {intent}=armed,meta=subscription.metadata as Record<string,unknown>|undefined;
 const items=subscription.items as {data?:{quantity?:unknown;price?:Record<string,unknown>}[];has_more?:unknown}|undefined;
 const price=items?.data?.[0]?.price,recurring=price?.recurring as Record<string,unknown>|undefined;
 if(typeof subscription.id!=="string"||!SUBSCRIPTION_PATTERN.test(subscription.id)||subscription.id===intent.grant.sourceSubscriptionId||
    typeof subscription.status!=="string"||!["active","trialing","past_due","unpaid","canceled","incomplete","incomplete_expired","paused"].includes(subscription.status)||
    !Number.isSafeInteger(subscription.created)||(subscription.created as number)<armed.armedAtSeconds||
    (subscription.created as number)>intent.grant.activationUntilSeconds||customerOf(subscription).id!==input.customerId||
    intent.grant.action!=="restart"||intent.grant.key!==input.tier+"_month"||
    items?.data?.length!==1||items.has_more!==false||items.data[0].quantity!==1||
    price?.id!==armed.priceId||price.currency!=="usd"||price.unit_amount!==PUBLISHED_PLAN_PRICES[input.tier].month||
    recurring?.interval!=="month"||recurring.interval_count!==1||planOf(subscription).tier!==input.tier||planOf(subscription).cycle!=="month"||
    meta?.funding_grant!==intent.grant.id||meta.funding_review!==intent.grant.reviewId||meta.restart_claim!==intent.claim||
    meta.restart_source!==intent.grant.sourceSubscriptionId||meta.funding_action!=="restart"||meta.store!==intent.handle||meta.tier!==input.tier)
  throw Error("The restart recovery observation does not identify its exact submitted owner");
 return subscription.id;
}
export function selectRestartRecoveryCandidate(armed:ArmedRestartSubmission,input:{customerId:string;tier:Tier},page:Record<string,unknown>):Record<string,unknown>{
 const encoded=canonicalFinancialSnapshot({armed,input,page});
 if(!encoded)throw Error("The restart search observation is unknown");
 ({armed,input,page}=JSON.parse(encoded));
 if(page.object!=="search_result"||page.has_more!==false||!Array.isArray(page.data)||page.data.length!==1)
  throw Error("The restart search page cannot prove a unique result or absence");
 const candidate=page.data[0] as Record<string,unknown>;
 identifyFundedRestartResult(armed,input,candidate);
 return candidate;
}

/** Observe an already obtained, durably identified result. Descriptive only:
 * callers still need funded activation and acknowledged store/CAS publication.
 */
export function observeFundedRestartResult(
 armed:ArmedRestartSubmission,input:{customerId:string;tier:Tier},subscription:Record<string,unknown>,
 observedAt=Math.floor(Date.now()/1000),
):StartedSubscription{
 const encoded=canonicalFinancialSnapshot({armed,input,subscription,observedAt});
 if(!encoded)throw Error("The funded restart result observation is unknown");
 ({armed,input,subscription,observedAt}=JSON.parse(encoded));
 identifyFundedRestartResult(armed,input,subscription);
 const {intent}=armed,source=intent.grant.sourceSubscriptionId;
 if(subscription.id===source||intent.grant.action!=="restart"||intent.grant.key!==input.tier+"_month")
  throw Error("The funded restart result reused or changed its original source");
 if(periodStart(subscription)<(subscription.created as number))throw Error("The recovered paid period begins before its identified subscription");
 const started=observeRestartedPlan({customerId:input.customerId,tier:input.tier,priceId:armed.priceId},subscription,observedAt);
 const metadata=subscription.metadata as Record<string,unknown>|undefined;
 if(metadata?.funding_grant!==intent.grant.id||metadata.funding_review!==intent.grant.reviewId||
    metadata.restart_claim!==intent.claim||metadata.restart_source!==source||metadata.funding_action!=="restart"||
    metadata.store!==intent.handle||metadata.tier!==input.tier)
  throw Error("The funded restart result does not match its submitted owner and source");
 return started;
}

/** Freezes the exact already-observed paid period before activation awaits.
 * This is a pure handoff, never a provider call or publication permission.
 */
export function observeFundedRestartActivation(
 armed:ArmedRestartSubmission,input:{customerId:string;tier:Tier},subscription:Record<string,unknown>,
 observedAt=Math.floor(Date.now()/1000),
):RestartContractActivation{
 const encoded=canonicalFinancialSnapshot({armed,input,subscription,observedAt});
 if(!encoded)throw Error("The funded activation observation is unknown");
 ({armed,input,subscription,observedAt}=JSON.parse(encoded));
 const paid=observeFundedRestartResult(armed,input,subscription,observedAt);
 if(!paid.period)throw Error("The funded activation has no observed paid period");
 if(typeof subscription.cancel_at_period_end!=="boolean"||(subscription.cancel_at!==null&&(!Number.isSafeInteger(subscription.cancel_at)||Number(subscription.cancel_at)<=0)))throw Error("The funded activation renewal state is unknown");
 return Object.freeze({armed,subscriptionId:paid.subscriptionId,
  createdSeconds:subscription.created as number,
  periodStartSeconds:periodStart(subscription),periodEndSeconds:periodEnd(subscription,false),renews:paid.period.renews,shared:paid.shared});
}

/** Exact existing public monthly price only. No IO, cache, creation or charge.
 * The owned deadline still applies after the source GET and price-list GET.
 */
export function observeFundedRestartPrice(intent:OwnedRestartIntent,page:Record<string,unknown>,observedAt=Math.floor(Date.now()/1000)):string{
 const encoded=canonicalFinancialSnapshot({intent,page,observedAt});
 if(!encoded)throw Error("The funded restart price observation is unknown");
 ({intent,page,observedAt}=JSON.parse(encoded));
 if(!Number.isSafeInteger(observedAt)||observedAt<intent.claimedAtSeconds||observedAt>intent.grant.submitUntilSeconds||
    !["creator_month","pro_month","scale_month"].includes(intent.grant.key)||
    page.object!=="list"||page.has_more!==false||!Array.isArray(page.data)||page.data.length!==1)
  throw Error("The funded restart price page is not one complete owned observation");
 const tier=intent.grant.key.split("_")[0] as Tier;
 const price=page.data[0] as Record<string,unknown>;
 const recurring=price?.recurring as Record<string,unknown>|undefined;
 if(!price||price.object!=="price"||price.active!==true||price.type!=="recurring"||price.billing_scheme!=="per_unit"||
    price.lookup_key!==lookupKey(tier,"month")||typeof price.id!=="string"||!/^price_[A-Za-z0-9]{6,100}$/.test(price.id)||
    price.unit_amount!==PUBLISHED_PLAN_PRICES[tier].month||price.unit_amount!==PLAN_PRICES[tier].month||
    price.currency!=="usd"||recurring?.interval!=="month"||recurring.interval_count!==1||recurring.usage_type!=="licensed"||
    price.transform_quantity!=null||price.tiers_mode!=null||price.custom_unit_amount!=null)
  throw Error("The funded restart price is not the single exact published monthly unit");
 return price.id;
}

/**
 * Validate the exact original fetched by the owned funded restart branch.
 * A canceled-at request, paused collection, 404, empty search or inactive local
 * store is not proof that this paid source ended. No IO or submission permission.
 */
export function observeStoppedRestartSource(
  intent: OwnedRestartIntent, subscription: Record<string, unknown>,
  observedAt = Math.floor(Date.now() / 1000),
): Readonly<{ subscriptionId: string; endedAtSeconds: number; observedAtSeconds: number }> {
  const encoded = canonicalFinancialSnapshot({ intent, subscription, observedAt });
  if (!encoded) throw new Error("The funded restart source observation is unknown");
  ({ intent, subscription, observedAt } = JSON.parse(encoded));
  const [grantId, subscriptionId, key, createdRaw, phase, startRaw, endRaw] = intent.source.binding.split("|");
  const created = Number(createdRaw), start = Number(startRaw), end = Number(endRaw);
  const pause = JSON.parse(intent.paused) as { customer?: unknown; subscription?: unknown; from?: unknown; until?: unknown; funding?: { version?: unknown; grantId?: unknown } };
  if (intent.source.binding.split("|").length !== 7 || !/^ctr_[A-Za-z0-9_-]{1,80}$/.test(grantId) ||
      !SUBSCRIPTION_PATTERN.test(subscriptionId) || subscriptionId !== intent.grant.sourceSubscriptionId ||
      key !== intent.grant.key || phase !== "paid" ||
      ![created,start,end,observedAt,intent.claimedAtSeconds,intent.grant.submitUntilSeconds].every(n => Number.isSafeInteger(n) && n > 0) ||
      start < created || end <= start || end > intent.claimedAtSeconds ||
      observedAt < intent.claimedAtSeconds || observedAt > intent.grant.submitUntilSeconds ||
      pause.subscription !== subscriptionId || pause.from !== end ||
      typeof pause.until !== "number" || pause.until <= end || pause.until > observedAt ||
      pause.funding?.version !== 1 || pause.funding.grantId !== grantId ||
      typeof pause.customer !== "string" || !CUSTOMER_PATTERN.test(pause.customer)) {
    throw new Error("The funded restart source does not match its owned paid period");
  }
  const items = subscription.items as { data?: { quantity?: unknown; price?: Record<string, unknown> }[]; has_more?: unknown } | undefined;
  const price = items?.data?.[0]?.price;
  const recurring = price?.recurring as { interval?: unknown; interval_count?: unknown } | undefined;
  const meta = subscription.metadata as Record<string, unknown> | undefined;
  const pending = meta && (Object.hasOwn(meta,"funding_pending_grant") || Object.hasOwn(meta,"funding_pending_review"));
  const metadataGrant = pending ? meta?.funding_pending_grant : meta?.funding_grant;
  const metadataReview = pending ? meta?.funding_pending_review : meta?.funding_review;
  const tier = key.split("_")[0] as Tier;
  if (!["creator_month","pro_month","scale_month"].includes(key) ||
      subscription.id !== subscriptionId || subscription.status !== "canceled" ||
      customerOf(subscription).id !== pause.customer || subscription.created !== created ||
      subscription.ended_at !== end || periodStart(subscription) !== start || periodEnd(subscription,false) !== end ||
      !Number.isSafeInteger(subscription.canceled_at) || (subscription.canceled_at as number) < created || (subscription.canceled_at as number) > end ||
      subscription.cancel_at_period_end !== true || subscription.pending_update != null ||
      metadataGrant !== grantId || metadataReview !== intent.grant.reviewId ||
      items?.data?.length !== 1 || items.has_more !== false || items.data[0].quantity !== 1 ||
      typeof price?.id !== "string" || !/^price_[A-Za-z0-9]{6,100}$/.test(price.id) ||
      price.currency !== "usd" || price.unit_amount !== PUBLISHED_PLAN_PRICES[tier].month ||
      recurring?.interval !== "month" || recurring.interval_count !== 1 ||
      planOf(subscription).tier !== tier || planOf(subscription).cycle !== "month") {
    throw new Error("The original funded subscription has not been observed stopped exactly");
  }
  // Return detached scalars only. Original source/cash remain in the permanent
  // intent; this observation cannot activate a term or release that evidence.
  return Object.freeze({ subscriptionId, endedAtSeconds:end, observedAtSeconds:observedAt });
}

/**
 * Validate an already obtained provider response using the same checks as the
 * restart POST. No IO, grant activation, store write, retry or new charge.
 * Recovery must separately prove the exact durable intent/subscription/source;
 * a matching customer/price/period alone does not authorize adoption.
 */
export function observeRestartedPlan(
  input: { customerId: string; tier: Tier; priceId: string },
  subscription: Record<string, unknown>,
  observedAt = Math.floor(Date.now() / 1000),
): StartedSubscription {
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription) ||
      !Number.isSafeInteger(observedAt) || observedAt <= 0) {
    throw new Error("the restarted plan observation or clock is unknown");
  }
  const priceId = input.priceId;
  const started = startedFrom(subscription);
  if (!started) throw new Error(`the restarted plan is not in good standing: ${String(subscription.status)}`);
  // A successful response still has to describe the customer and monthly plan requested.
  // A mismatched observation is uncertain billing evidence, never a card refusal.
  if (subscription.status !== "active" || started.customerId !== input.customerId || started.tier !== input.tier || started.cycle !== "month" || started.trialEnds !== 0) {
    throw new Error("the restarted plan does not match the requested customer and paid monthly plan");
  }
  const items = subscription.items as { data?: { quantity?: unknown; price?: Record<string, unknown> }[] } | undefined;
  const price = items?.data?.[0]?.price;
  const recurring = price?.recurring as { interval?: unknown; interval_count?: unknown } | undefined;
  if (items?.data?.length !== 1 || items.data[0].quantity !== 1 || price?.id !== priceId || price?.currency !== "usd" ||
      price?.unit_amount !== PLAN_PRICES[input.tier].month || recurring?.interval !== "month" || recurring?.interval_count !== 1) {
    throw new Error("the restarted plan price does not match the requested monthly charge");
  }
  const start = periodStart(subscription), end = periodEnd(subscription, false);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end <= start ||
      start > observedAt || end <= observedAt || end - start > 31 * 86400 || !started.period) {
    throw new Error("the restarted plan does not have a current paid monthly period");
  }
  return started;
}

/**
 * Stops the subscription at the end of what is already paid for, or takes
 * that back.
 *
 * Only ever the creator's own subscription: the id comes from their store
 * record, never from the request. Stopping at the period's end rather than on
 * the spot is what keeps the help page's promise — access until the end of
 * the period already paid for — and inside the trial it means the card is
 * never charged at all. Until that date the decision can be reversed.
 *
 * Errors are thrown, not swallowed: the caller has to tell the creator that
 * nothing changed, and "Stripe did not answer" is not "cancelled".
 */
export async function setCancelAtPeriodEnd(
  subscriptionId: string,
  cancel: boolean,
): Promise<SubscriptionState> {
  if (!SUBSCRIPTION_PATTERN.test(subscriptionId)) {
    return { state: "inactive", reason: "shape" };
  }
  const subscription = await onPlatform(
    "POST",
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    new URLSearchParams({ cancel_at_period_end: cancel ? "true" : "false" }),
  );
  // Only an identified, explicit provider observation can confirm this change.
  // Unknown replies must throw so callers retain paid access and pause evidence.
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription) ||
      subscription.id !== subscriptionId || typeof subscription.status !== "string" ||
      !["active", "trialing", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"].includes(subscription.status)) {
    throw new Error("The cancellation response does not identify the requested subscription state");
  }
  const state = stateOf(subscription);
  if (state.state === "active" &&
      (typeof subscription.cancel_at_period_end !== "boolean" || state.cancelsAtEnd !== cancel)) {
    throw new Error("The subscription did not acknowledge the requested cancellation setting");
  }
  return state;
}

export type SwitchResult =
  /** Done: the subscription is on the new plan. */
  | { kind: "switched"; state: SubscriptionState }
  /** The bank wants the creator to confirm the charge; send them here. */
  | { kind: "confirm"; url: string }
  /** Already on that plan. */
  | { kind: "same" }
  /** Not now: cancelled, not in good standing, or a change is already waiting. */
  | { kind: "refused"; reason: "canceling" | "standing" | "pending" };

const INVOICE_PAGE = /^https:\/\/invoice\.stripe\.com\//;
const LOCAL_PAGE = /^http:\/\/127\.0\.0\.1:\d+\//;

/**
 * Moves a subscription to another plan or billing cycle.
 *
 * Settled on the spot, and only if it is paid for: a move that costs more is
 * charged now, less what is left of the period already paid, and if the bank
 * refuses or asks the creator to confirm, nothing changes until it is paid. A
 * move that costs less leaves what is left as credit on their account, which
 * pays the next bills until it runs out. Inside the trial nothing is charged
 * and the trial keeps its end.
 */
export async function switchPlan(
  subscriptionId: string,
  choice: { tier: Tier; cycle: Cycle },
  funding?:ContractGrant,
): Promise<SwitchResult> {
  assertFunding(funding,choice.tier,choice.cycle,'switch',undefined,subscriptionId);
  if (!SUBSCRIPTION_PATTERN.test(subscriptionId)) return { kind: "refused", reason: "standing" };
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const subscription = await onPlatform("GET", path);
  const status = typeof subscription.status === "string" ? subscription.status : "";
  if (status !== "active" && status !== "trialing") return { kind: "refused", reason: "standing" };
  if (subscription.cancel_at_period_end === true || (typeof subscription.cancel_at === "number" && subscription.cancel_at > 0)) {
    return { kind: "refused", reason: "canceling" };
  }
  if (subscription.pending_update) return { kind: "refused", reason: "pending" };
  const sourceItems = subscription.items as { data?: { quantity?: unknown }[] } | undefined;
  if (funding && (subscription.id !== subscriptionId || sourceItems?.data?.length !== 1 || sourceItems.data[0].quantity !== 1)) {
    throw new Error("The funded switch source must identify exactly one plan unit");
  }
  function assertSourcePhase(): void {
    if (!funding) return;
    const began = status === "trialing" ? subscription.trial_start : periodStart(subscription);
    const ends = status === "trialing" ? subscription.trial_end : periodEnd(subscription, false);
    const observedAt = Math.floor(Date.now() / 1000);
    const reservedAt = funding.submitUntilSeconds - CONTRACT_FUNDING_RULES.submissionSeconds;
    if (!Number.isSafeInteger(began) || !Number.isSafeInteger(ends) || typeof began !== "number" || typeof ends !== "number" ||
        began <= 0 || ends <= began || began > reservedAt || reservedAt > observedAt || ends <= observedAt) {
      throw new Error("The funded switch source phase does not cover its reservation and observation");
    }
  }
  assertSourcePhase();
  const now = planOf(subscription);
  if (funding) {
    const sourcePrice = (subscription.items as { data: { price?: Record<string, unknown> }[] }).data[0].price;
    const sourceRecurring = sourcePrice?.recurring as { interval?: unknown; interval_count?: unknown } | undefined;
    if (sourcePrice?.currency !== "usd" || sourcePrice?.unit_amount !== PUBLISHED_PLAN_PRICES[now.tier][now.cycle] ||
        sourceRecurring?.interval !== now.cycle || sourceRecurring?.interval_count !== 1) {
      throw new Error("The funded switch source price is not the single reviewed plan interval");
    }

  }
  if (
    now.tier === choice.tier &&
    now.cycle === choice.cycle &&
    now.amountCents === PLAN_PRICES[choice.tier][choice.cycle]
  ) {
    return { kind: "same" };
  }

  const items = subscription.items as { data?: { id?: unknown }[] } | undefined;
  const itemId = items?.data?.[0]?.id;
  if (typeof itemId !== "string") throw new Error("The subscription has no item to change");
  const price = await ensurePrice(choice.tier, choice.cycle);

  // Only what a pending update may carry. Stripe refuses any other field —
  // metadata included — when the change waits on a payment, so the plan's
  // name is written separately below, once the change has actually happened.
  const body = new URLSearchParams({
    "items[0][id]": itemId,
    "items[0][price]": price,
    proration_behavior: "always_invoice",
    payment_behavior: "pending_if_incomplete",
    "expand[]": "latest_invoice",
  });
  if (funding) body.set("items[0][quantity]", "1");
  if (status === "trialing" && typeof subscription.trial_end === "number") {
    body.set("trial_end", String(subscription.trial_end));
  }
  assertSourcePhase();
  assertFunding(funding,choice.tier,choice.cycle,'switch',undefined,subscriptionId);
  if(funding)await onPlatform('POST',path,new URLSearchParams({'metadata[funding_pending_grant]':funding.id,'metadata[funding_pending_review]':funding.reviewId}));
  let updated: Record<string, unknown>;
  try {
    assertSourcePhase();
  assertFunding(funding,choice.tier,choice.cycle,'switch',undefined,subscriptionId);
    updated = await onPlatform("POST", path, body);
  } catch (error) {
    // A price archived at Stripe since we last read it. The creator asked to
    // change plan once; they should not have to ask twice because of our own
    // stale note of a price id. Forget it, make the price again, and retry —
    // the same recovery the first checkout has had all along.
    if (!(error instanceof BillingError) || error.status !== 400) throw error;
    assertSourcePhase();
    assertFunding(funding,choice.tier,choice.cycle,'switch',undefined,subscriptionId);
    priceIds.clear();
    body.set("items[0][price]", await ensurePrice(choice.tier, choice.cycle));
    assertSourcePhase();
  assertFunding(funding,choice.tier,choice.cycle,'switch',undefined,subscriptionId);
    updated = await onPlatform("POST", path, body);
  }

  const updatedMeta=updated.metadata as Record<string,unknown>|null|undefined;
  if(funding&&(updated.id!==subscriptionId||updatedMeta?.funding_pending_grant!==funding.id||updatedMeta?.funding_pending_review!==funding.reviewId))throw new Error('Switch funding observation does not match the submitted contract');
  if (updated.pending_update) {
    const invoice = updated.latest_invoice as { hosted_invoice_url?: unknown } | null;
    const url = typeof invoice?.hosted_invoice_url === "string" ? invoice.hosted_invoice_url : "";
    if (INVOICE_PAGE.test(url) || (LOCAL_PAGE.test(url) && STRIPE_API.startsWith("http://127.0.0.1"))) {
      return { kind: "confirm", url };
    }
    return { kind: "refused", reason: "pending" };
  }
  const observedState=stateOf(updated);
  if(funding&&(observedState.state!=='active'||observedState.tier!==choice.tier||observedState.cycle!==choice.cycle))throw new Error('Switch observation does not match the requested plan');
  if(funding&&!(await activateObservedSwitch(funding.statsId,funding.id,funding.reviewId,subscriptionId,updated)))throw new Error('Switch funding activation was not acknowledged');
  // The price says which plan this is; the note is for whoever reads the
  // subscription in the Stripe dashboard. Missing it changes nothing charged.
  await onPlatform("POST", path, new URLSearchParams({ "metadata[tier]": choice.tier,...(funding?{"metadata[funding_grant]":funding.id,"metadata[funding_review]":funding.reviewId,"metadata[funding_action]":"switch","metadata[funding_pending_grant]":"","metadata[funding_pending_review]":""}:{}) })).catch((error) =>
    console.error("noting the plan on the subscription failed", error),
  );
  return { kind: "switched", state: funding&&observedState.state==="active"?{...observedState,period:fundedPeriod(observedState.period)}:observedState };
}

/**
 * One page of our own subscriptions in a given state, with each customer's
 * email, for the reminders sent before a charge.
 */
export async function listSubscriptions(
  status: "trialing" | "active" | "past_due" | "all",
  startingAfter?: string,
): Promise<{ data: Record<string, unknown>[]; hasMore: boolean }> {
  const query = new URLSearchParams({ status, limit: "100" });
  query.append("expand[]", "data.customer");
  // A renewal that failed is told about with the page that pays it, which is
  // on the invoice, not on the subscription (lib/billing-reminders.ts).
  if (status === "past_due") query.append("expand[]", "data.latest_invoice");
  if (startingAfter) query.set("starting_after", startingAfter);
  const page = await onPlatform("GET", `/subscriptions?${query}`);
  // An unreadable page is not an empty account or the end of pagination.
  // Validate the whole bounded observation before any caller processes rows.
  if (!page || typeof page !== "object" || Array.isArray(page) ||
      !Array.isArray(page.data) || page.data.length > 100 ||
      typeof page.has_more !== "boolean" || (page.has_more && page.data.length === 0) ||
      page.data.some(row => !row || typeof row !== "object" || Array.isArray(row) ||
        typeof row.id !== "string" || !SUBSCRIPTION_PATTERN.test(row.id) ||
        typeof row.status !== "string" || !["active", "trialing", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"].includes(row.status)) ||
      new Set(page.data.map(row => row.id)).size !== page.data.length) {
    throw new Error("The subscription list page is not a complete bounded observation");
  }
  return { data: page.data as Record<string, unknown>[], hasMore: page.has_more };
}

export { periodEnd };

/**
 * Makes whatever card pays this subscription's next invoice its card from then
 * on. Stripe retries a subscription on its own default card before the
 * customer's, so without this a creator who pays a failed invoice with a new
 * card would see the next renewal fail on the old one again.
 */
export async function keepCardThatPays(subscriptionId: string): Promise<void> {
  if (!SUBSCRIPTION_PATTERN.test(subscriptionId)) return;
  await onPlatform(
    "POST",
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    new URLSearchParams({ "payment_settings[save_default_payment_method]": "on_subscription" }),
  );
}

/** The customer a subscription belongs to, whether or not it was expanded. */
export function customerOf(subscription: Record<string, unknown>): { id: string; email: string } {
  const customer = subscription.customer as { id?: unknown; email?: unknown } | string | null | undefined;
  if (typeof customer === "string") return { id: customer, email: "" };
  return {
    id: typeof customer?.id === "string" ? customer.id : "",
    email: typeof customer?.email === "string" ? customer.email : "",
  };
}

/**
 * Whether a subscription of ours was started by this store.
 *
 * The handle in its metadata only says which address it was bought under,
 * and an address that was let go can later belong to somebody else. So it
 * must also be paid by this store's own customer, or by the address this
 * store signs in with — the address the checkout was opened for.
 */
export function ownedBy(store: Store, subscription: Record<string, unknown>): boolean {
  const meta = subscription.metadata as Record<string, string> | null | undefined;
  const named = meta?.store ?? "";
  const customer = customerOf(subscription);
  const sameCustomer = Boolean(store.stripeCustomerId) && customer.id === store.stripeCustomerId;
  // An address this store let go of may be another store's now: a
  // subscription under it is this store's only when it pays as this store's
  // own customer, never by the email address alone.
  if (store.releasedHandles.includes(named)) return sameCustomer;
  const handles = new Set([store.handle, ...store.previousHandles]);
  if (!handles.has(named)) return false;
  if (sameCustomer) return true;
  return customer.email !== "" && normaliseEmail(customer.email) === normaliseEmail(store.email);
}

/** What a subscription in good standing means for the store's snapshot. */
export function startedFrom(subscription: Record<string, unknown>): StartedSubscription | null {
  const state = stateOf(subscription);
  const customerId = customerOf(subscription).id;
  const subscriptionId = typeof subscription.id === "string" ? subscription.id : "";
  if (state.state !== "active") return null;
  if (!CUSTOMER_PATTERN.test(customerId) || !SUBSCRIPTION_PATTERN.test(subscriptionId)) return null;
  return {
    customerId,
    subscriptionId,
    active: true,
    tier: state.tier,
    cycle: state.cycle,
    trialEnds: state.trialing ? state.until : 0,
    shared: state.shared,
    period: state.period,
  };
}

/**
 * Recovery may adopt only its funded Checkout or separately reserved switch
 * phase, never an unfunded renewal. Provider observations are
 * already available from the existing search/list response.
 */
/** Presence is conservative: partial switch metadata cannot become an unmarked legacy contract. */
export function hasSwitchFunding(subscription:Record<string,unknown>):boolean{
 const meta=subscription.metadata as Record<string,unknown>|null|undefined;
 return meta?.funding_action!==undefined||meta?.funding_pending_grant!==undefined||meta?.funding_pending_review!==undefined;
}
/** Any persisted funding marker requires the corresponding owned proof. */
/** This marker follows the exact acknowledged paid period through existing store writes. */
function fundedPeriod(period:BillingPeriod|null):BillingPeriod|null{return period?{...period,funded:true}:null;}
export function hasContractFunding(subscription:Record<string,unknown>):boolean{
 const meta=subscription.metadata as Record<string,unknown>|null|undefined;
 return hasSwitchFunding(subscription)||meta?.funding_grant!==undefined||meta?.funding_review!==undefined;
}
async function activateObservedSwitch(statsId:string,grantId:string,reviewId:string,subscriptionId:string,subscription:Record<string,unknown>):Promise<boolean>{
 const state=stateOf(subscription);
 if(subscription.id!==subscriptionId||state.state!=='active'||state.changePending)return false;
 const items=subscription.items as {data?:{quantity?:unknown;price?:Record<string,unknown>}[]}|undefined;
 const price=items?.data?.[0]?.price,recurring=price?.recurring as {interval?:unknown;interval_count?:unknown}|undefined;
 if(items?.data?.length!==1||items.data[0].quantity!==1||price?.currency!=='usd'||recurring?.interval!==state.cycle||recurring?.interval_count!==1||state.amountCents!==PUBLISHED_PLAN_PRICES[state.tier][state.cycle])return false;
 return activateSwitchContract({statsId,grantId,reviewId,subscriptionId,tier:state.tier,cycle:state.cycle,createdSeconds:subscription.created as number,trialing:state.trialing,periodStartSeconds:(state.trialing?subscription.trial_start:periodStart(subscription)) as number,periodEndSeconds:(state.trialing?subscription.trial_end:periodEnd(subscription,false)) as number});
}
export async function startedFromObservedSubscription(store:Store,subscription:Record<string,unknown>):Promise<StartedSubscription|null>{
 const started=startedFrom(subscription);
 if(!started)return null;
 const meta=subscription.metadata as Record<string,unknown>|null|undefined;
 if(hasSwitchFunding(subscription)){
  if(!ownedBy(store,subscription)||meta?.store!==store.handle||meta?.funding_action!==undefined&&meta.funding_action!=='switch')return null;
  const pending=meta?.funding_pending_grant!==undefined||meta?.funding_pending_review!==undefined;
  const grantId=pending?meta?.funding_pending_grant:meta?.funding_grant,reviewId=pending?meta?.funding_pending_review:meta?.funding_review;
  if(typeof grantId!=='string'||typeof reviewId!=='string')return null;
  return await activateObservedSwitch(store.statsId??'',grantId,reviewId,started.subscriptionId,subscription)?{...started,period:fundedPeriod(started.period)}:null;
 }
 if(meta?.funding_grant===undefined&&meta?.funding_review===undefined)return started;
 if(!ownedBy(store,subscription)||meta?.store!==store.handle||typeof meta.funding_grant!=="string"||typeof meta.funding_review!=="string")return null;
 const state=stateOf(subscription);
 if(state.state!=="active"||state.changePending)return null;
 const items=subscription.items as {data?:{quantity?:unknown;price?:Record<string,unknown>}[]}|undefined;
 const price=items?.data?.[0]?.price;
 const recurring=price?.recurring as {interval?:unknown;interval_count?:unknown}|undefined;
 if(items?.data?.length!==1||items.data[0].quantity!==1||price?.currency!=="usd"||recurring?.interval!==state.cycle||recurring?.interval_count!==1||state.amountCents!==PUBLISHED_PLAN_PRICES[state.tier][state.cycle])return null;
 const began=state.trialing?subscription.trial_start:periodStart(subscription);
 const until=state.trialing?subscription.trial_end:periodEnd(subscription,false);
 if(!(await activateCheckoutContract({
  statsId:store.statsId??"",grantId:meta.funding_grant,reviewId:meta.funding_review,
  subscriptionId:started.subscriptionId,tier:state.tier,cycle:state.cycle,createdSeconds:subscription.created as number,
  trialing:state.trialing,periodStartSeconds:began as number,periodEndSeconds:until as number,
 })))return null;
 return {...started,period:fundedPeriod(started.period)};
}

/** How many of a store's subscriptions one search looks at. */
const SEARCH_LIMIT = 100;
const SEARCH_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"]);

/**
 * Provider search members are evidence only when their identity, ownership
 * fields and cancellation clock are explicit data properties. Stripe JSON is
 * ordinary data; accessors, inherited fields and partial expanded customers
 * are therefore an unknown observation, never proof that checkout is safe.
 */
function searchDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`Subscription search ${label} is unknown`);
  }
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`Subscription search ${label} is unknown`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw new Error(`Subscription search ${label} is unknown`);
    copy[key] = descriptor.value;
  }
  return copy;
}

type SearchOwnership = { customerId: string | null; released: Set<string> };
type SearchMember = { subscription: Record<string, unknown>; terminalOwn: boolean };
/** Only plain dense own data can prove a released handle, without rereading accessors. */
function releasedSearchEvidence(value: unknown): Set<string> {
  const unknown = new Set<string>();
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return unknown;
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  const length = descriptors.length;
  if (!length || !Object.hasOwn(length, "value") || !Number.isSafeInteger(length.value) || length.value < 0 ||
      Reflect.ownKeys(descriptors).length !== length.value + 1) return unknown;
  const handles = new Set<string>();
  for (let index = 0; index < length.value; index++) {
    const slot = descriptors[String(index)];
    if (!slot || !Object.hasOwn(slot, "value") || typeof slot.value !== "string" || !HANDLE_PATTERN.test(slot.value)) return unknown;
    handles.add(slot.value);
  }
  return handles;
}
function searchMember(value: unknown, handles: Set<string>, ownership: SearchOwnership): SearchMember | null {
  const member = searchDataRecord(value, "member");
  if (typeof member.id !== "string" || !SUBSCRIPTION_PATTERN.test(member.id) ||
      typeof member.status !== "string" || !SEARCH_STATUSES.has(member.status) ||
      !Number.isSafeInteger(member.created) || (member.created as number) < 0) {
    throw new Error("Subscription search member is unknown");
  }
  const metadata = searchDataRecord(member.metadata, "member metadata");
  const named = metadata.store;
  if (typeof named !== "string" || !HANDLE_PATTERN.test(named) || !handles.has(named)) {
    throw new Error("Subscription search member ownership is unknown");
  }
  const customer = searchDataRecord(member.customer, "expanded customer");
  // Stripe's DeletedCustomer has id/object/deleted, without an email. Only
  // a known canceled legacy owner or a proved foreign released-handle row
  // can use that partial shape. Unknown funding is never terminal absence.
  if (customer.deleted === true) {
    const valid = customer.object === "customer" && !Object.hasOwn(customer, "email") &&
      typeof customer.id === "string" && CUSTOMER_PATTERN.test(customer.id) && member.status === "canceled";
    if (valid && ownership.customerId) {
      if (ownership.released.has(named) && customer.id !== ownership.customerId) return null;
      const marked = [member, metadata].some(record => Object.keys(record).some(key => /^(funding_|restart_|cf_)/.test(key)));
      if (customer.id === ownership.customerId && !marked) {
        member.metadata = metadata;
        member.customer = customer;
        return { subscription: member, terminalOwn: true };
      }
    }
    throw new Error("Subscription search deleted customer ownership is unknown");
  }
  if (typeof customer.id !== "string" || !CUSTOMER_PATTERN.test(customer.id) ||
      !Object.prototype.hasOwnProperty.call(customer, "email") ||
      customer.email !== null && typeof customer.email !== "string") {
    throw new Error("Subscription search expanded customer is unknown");
  }
  member.metadata = metadata;
  member.customer = customer;

  // A good-standing row can block checkout and be adopted as paid rights, so
  // its one product, price, interval and paid/trial window must also be
  // explicit provider data. Missing items must not silently become Creator.
  if (GOOD.has(member.status as string)) {
    const items = searchDataRecord(member.items, "member items");
    if (!Array.isArray(items.data) || items.data.length !== 1) {
      throw new Error("Subscription search member items are unknown");
    }
    const slot = Object.getOwnPropertyDescriptor(items.data, "0");
    if (!slot || !("value" in slot)) throw new Error("Subscription search member item is unknown");
    const item = searchDataRecord(slot.value, "member item");
    const price = searchDataRecord(item.price, "member price");
    const recurring = searchDataRecord(price.recurring, "member recurrence");
    if (item.quantity !== 1 || price.currency !== "usd" ||
        typeof price.unit_amount !== "number" || !Number.isSafeInteger(price.unit_amount) || price.unit_amount <= 0 ||
        recurring.interval !== "month" && recurring.interval !== "year" ||
        recurring.interval_count !== 1) {
      throw new Error("Subscription search member price is unknown");
    }
    item.price = price;
    price.recurring = recurring;
    items.data = [item];
    member.items = items;
    if (member.status === "trialing") {
      if (typeof member.trial_start !== "number" || !Number.isSafeInteger(member.trial_start) ||
          typeof member.trial_end !== "number" || !Number.isSafeInteger(member.trial_end) ||
          member.trial_start < 0 || member.trial_end <= member.trial_start) {
        throw new Error("Subscription search member trial is unknown");
      }
    } else {
      const start = periodStart(member);
      const end = periodEnd(member, false);
      if (!isPeriod({ start, end, renews: true })) {
        throw new Error("Subscription search member period is unknown");
      }
    }
  }
  return { subscription: member, terminalOwn: false };
}

/**
 * What Stripe already has for this store, looked up before a new checkout is
 * opened.
 *
 * The store's own record only learns of a subscription when the creator comes
 * back from paying. A return that never arrived — a closed tab, Stripe not
 * answering at that moment — would otherwise leave a paying subscription the
 * store does not know about, and a second one started over the top of it,
 * both charged. So Stripe is asked by the handle the checkout wrote into the
 * subscription (Subscription Search: `metadata['store']:'<handle>'`), under
 * every address this store still answers to.
 *
 * `live` is one in good standing, to be written down instead of starting
 * another; `customerId` is the customer this store last paid us from. Search
 * can lag a new subscription by a minute or so; the daily job in
 * lib/billing-sync.ts settles whatever it misses.
 */
export async function findStoreSubscriptions(
  store: Store,
): Promise<{ live: StartedSubscription | null; customerId: string | null; lapsed: string[] }> {
  // Stripe takes at most ten clauses in one query. An address the store let
  // go of is looked under too, and kept only for its own customer (ownedBy).
  const releasedHandles = store.releasedHandles;
  const handles = [...new Set([store.handle, ...store.previousHandles, ...releasedHandles])];
  // A complete result page proves nothing about a handle left out of its
  // query. Refuse unknown or over-cap coverage instead of filtering it away.
  if (handles.length === 0 || handles.length > 10 ||
      handles.some((handle) => typeof handle !== "string" || !HANDLE_PATTERN.test(handle))) {
    throw new Error("Subscription search handle coverage is unknown");
  }
  // Bind only the new DeletedCustomer exception to the identity and released
  // handles captured for this query, before any awaited provider operation.
  const customerContext = Object.getOwnPropertyDescriptor(store, "stripeCustomerId");
  const releasedContext = Object.getOwnPropertyDescriptor(store, "releasedHandles");
  const ownership: SearchOwnership = {
    customerId: customerContext && Object.hasOwn(customerContext, "value") &&
      typeof customerContext.value === "string" && CUSTOMER_PATTERN.test(customerContext.value) ? customerContext.value : null,
    released: releasedContext && Object.hasOwn(releasedContext, "value") && releasedContext.value === releasedHandles
      ? releasedSearchEvidence(releasedHandles) : new Set(),
  };
  const query = new URLSearchParams({
    query: handles.map((handle) => `metadata['store']:'${handle}'`).join(" OR "),
    limit: String(SEARCH_LIMIT),
  });
  query.append("expand[]", "data.customer");
  const page = await onPlatform("GET", `/subscriptions/search?${query}`);
  // Only a complete, bounded page can be read as an empty result. Keep
  // unknown provider evidence out of checkout and destructive maintenance.
  // This does not make Stripe Search strongly consistent after a write.
  if (!page || typeof page !== "object" || Array.isArray(page)) throw new Error("Subscription search page is unknown");
  const data = Object.getOwnPropertyDescriptor(page, "data");
  const more = Object.getOwnPropertyDescriptor(page, "has_more");
  const cursor = Object.getOwnPropertyDescriptor(page, "next_page");
  if (!data || !("value" in data) || !Array.isArray(data.value) ||
      !more || !("value" in more) || more.value !== false ||
      cursor && (!("value" in cursor) || cursor.value !== null && cursor.value !== undefined) ||
      data.value.length > SEARCH_LIMIT) throw new Error("Subscription search page is incomplete");
  const entries: SearchMember[] = [];
  const coveredHandles = new Set(handles);
  for (let index = 0; index < data.value.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(data.value, String(index));
    if (!entry || !("value" in entry)) throw new Error("Subscription search member is unknown");
    const member = searchMember(entry.value, coveredHandles, ownership);
    if (member) entries.push(member);
  }
  const rows = entries
    .filter(({ subscription, terminalOwn }) => terminalOwn || ownedBy(store, subscription))
    .map(({ subscription }) => subscription)
    .sort((a, b) => (b.created as number) - (a.created as number));

  let live: StartedSubscription | null = null;
  for (const subscription of rows) {
    if (stateOf(subscription).state !== "active") continue;
    live = await startedFromObservedSubscription(store, subscription);
    if (!live) throw new Error("Subscription search activation is unknown");
    break;
  }
  const last = rows.map((subscription) => customerOf(subscription).id).find((id) => CUSTOMER_PATTERN.test(id));
  // Not paying, but Stripe could still charge them: a card being retried, or
  // a first payment not finished. Ended before a new one is started.
  // A first payment still going through (a bank debit) is left alone for an hour.
  const hourAgo = Date.now() / 1000 - 3600;
  const lapsed = rows
    .filter(
      (subscription) =>
        !startedFrom(subscription) &&
        (subscription.status === "past_due" || (subscription.status === "incomplete" && (Number(subscription.created) || 0) < hourAgo)),
    )
    .map((subscription) => (typeof subscription.id === "string" ? subscription.id : ""))
    .filter((id) => SUBSCRIPTION_PATTERN.test(id));
  return { live, customerId: last ?? null, lapsed };
}

/**
 * Ends subscriptions that are not paying but that Stripe could still charge,
 * at once and without a final bill, so a new subscription never runs beside
 * one whose retried card goes through later.
 */
export async function endLapsed(ids: string[]): Promise<void> {
  for (const id of ids) {
    if (!SUBSCRIPTION_PATTERN.test(id)) continue;
    try {
      await onPlatform("DELETE", `/subscriptions/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof BillingError && error.status === 404) continue;
      throw error;
    }
  }
}

/**
 * Adds a line to what a store's subscription is billed next.
 *
 * Called only by lib/usage-billing.ts, whose meters all owe nothing since
 * 31 October 2026 (232 [CA1] unit 3): nothing is charged after use, so this
 * is not reached. Kept for that one caller; tests/watch.test.ts fails if any
 * other file calls it.
 *
 * `mark` is written on the line so it can be found again (findInvoiceLine):
 * a request that timed out may still have gone through, and a second line
 * for the same hours would be charging twice.
 */
export async function addToNextInvoice(input: {
  customerId: string;
  subscriptionId: string;
  cents: number;
  description: string;
  mark: string;
  idempotencyKey: string;
}): Promise<string> {
  if (!CUSTOMER_PATTERN.test(input.customerId) || !SUBSCRIPTION_PATTERN.test(input.subscriptionId)) throw new Error("not a subscription of ours");
  if (!Number.isInteger(input.cents) || input.cents <= 0) throw new Error("nothing to add");
  const made = await onPlatform(
    "POST",
    "/invoiceitems",
    new URLSearchParams({
      customer: input.customerId,
      subscription: input.subscriptionId,
      amount: String(input.cents),
      currency: "usd",
      description: input.description.slice(0, 350),
      "metadata[mark]": input.mark,
    }),
    { idempotencyKey: input.idempotencyKey },
  );
  if (typeof made.id !== "string") throw new Error("Stripe did not return the line");
  return made.id;
}

/**
 * The API version the charges below are read at: the one where a paid
 * invoice names the payment it was paid with (`payment_intent`), which
 * versions from 2025 moved elsewhere. Pinned so a refund always finds it.
 */
const CHARGE_VERSION = "2024-06-20";

export type ChargeResult =
  | { ok: true; invoiceId: string; paymentIntent: string }
  | { ok: false; reason: "card" | "declined" | "error" };

/**
 * Charges a creator now, on the card their plan is paid with, for something
 * they asked for and were told the price of first (AI captions,
 * lib/auto-captions.ts). Its own invoice, with one line, paid at once: a
 * thing that costs us money is paid for before it is done, so nothing is
 * ever owed on a card that later fails. A declined card leaves nothing
 * behind: the invoice is voided.
 */
export async function chargeNow(input: {
  customerId: string;
  subscriptionId: string;
  cents: number;
  description: string;
  mark: string;
  idempotencyKey: string;
}): Promise<ChargeResult> {
  if (!CUSTOMER_PATTERN.test(input.customerId) || !SUBSCRIPTION_PATTERN.test(input.subscriptionId)) return { ok: false, reason: "card" };
  if (!Number.isInteger(input.cents) || input.cents < 50) return { ok: false, reason: "error" };
  const at = { version: CHARGE_VERSION };
  let invoiceId = "";
  try {
    const sub = await onPlatform("GET", `/subscriptions/${encodeURIComponent(input.subscriptionId)}`, undefined, at);
    let method = typeof sub.default_payment_method === "string" ? sub.default_payment_method : "";
    if (!method) {
      const customer = await onPlatform("GET", `/customers/${encodeURIComponent(input.customerId)}`, undefined, at);
      const settings = customer.invoice_settings as { default_payment_method?: unknown } | null | undefined;
      method = typeof settings?.default_payment_method === "string" ? settings.default_payment_method : "";
    }
    if (!method) return { ok: false, reason: "card" };
    const invoice = await onPlatform(
      "POST",
      "/invoices",
      new URLSearchParams({
        customer: input.customerId,
        collection_method: "charge_automatically",
        auto_advance: "false",
        pending_invoice_items_behavior: "exclude",
        default_payment_method: method,
        currency: "usd",
        description: input.description.slice(0, 350),
        "metadata[mark]": input.mark,
      }),
      { ...at, idempotencyKey: `${input.idempotencyKey}:invoice` },
    );
    invoiceId = typeof invoice.id === "string" ? invoice.id : "";
    if (!invoiceId) return { ok: false, reason: "error" };
    await onPlatform(
      "POST",
      "/invoiceitems",
      new URLSearchParams({
        customer: input.customerId,
        invoice: invoiceId,
        amount: String(input.cents),
        currency: "usd",
        description: input.description.slice(0, 350),
        "metadata[mark]": input.mark,
      }),
      { ...at, idempotencyKey: `${input.idempotencyKey}:item` },
    );
    await onPlatform("POST", `/invoices/${encodeURIComponent(invoiceId)}/finalize`, new URLSearchParams(), { ...at, idempotencyKey: `${input.idempotencyKey}:finalize` });
    const paid = await onPlatform("POST", `/invoices/${encodeURIComponent(invoiceId)}/pay`, new URLSearchParams(), { ...at, idempotencyKey: `${input.idempotencyKey}:pay` });
    const intent = typeof paid.payment_intent === "string" ? paid.payment_intent : "";
    if (paid.status !== "paid" || !intent) throw new BillingError(402, "not_paid", "The invoice was not paid.");
    return { ok: true, invoiceId, paymentIntent: intent };
  } catch (error) {
    const declined = error instanceof BillingError && (error.status === 402 || error.code === "card_declined" || error.code === "not_paid");
    if (!declined) console.error("charging a creator now failed", error);
    // Nothing is left owed: an invoice that was not paid is voided.
    if (invoiceId) await onPlatform("POST", `/invoices/${encodeURIComponent(invoiceId)}/void`, new URLSearchParams(), at).catch(() => null);
    return { ok: false, reason: declined ? "declined" : "error" };
  }
}

/** Refunds chargeNow's USD payment. True only for a matching succeeded receipt.
 * Pending, unreadable or failed receipts are not proof that money was returned.
 * A false result must never cause a caller to mint a new idempotency key.
 */
export async function refundCharge(paymentIntent: string, cents: number | null, idempotencyKey: string): Promise<boolean> {
  if (!/^pi_[A-Za-z0-9]{8,64}$/.test(paymentIntent)) return false;
  if (cents !== null && (!Number.isSafeInteger(cents) || cents <= 0)) return false;
  try {
    const body = new URLSearchParams({ payment_intent: paymentIntent, reason: "requested_by_customer" });
    if (cents !== null) body.set("amount", String(cents));
    const receipt = await onPlatform("POST", "/refunds", body, { version: CHARGE_VERSION, idempotencyKey });
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
    const intent = typeof receipt.payment_intent === "string"
      ? receipt.payment_intent
      : (receipt.payment_intent as { id?: unknown } | null | undefined)?.id;
    return receipt.object === "refund"
      && typeof receipt.id === "string" && /^re_[A-Za-z0-9]{8,64}$/.test(receipt.id)
      && receipt.status === "succeeded"
      && intent === paymentIntent
      && receipt.currency === "usd"
      && typeof receipt.amount === "number" && Number.isSafeInteger(receipt.amount) && receipt.amount > 0
      && (cents === null || receipt.amount === cents);
  } catch (error) {
    console.error("refunding a charge failed", error);
    return false;
  }
}

/**
 * What Stripe says has happened to the refunds of one of chargeNow's USD
 * payments, read from its own list (GET /v1/refunds?payment_intent=…, newest
 * first, at most 100). `returned` counts only succeeded USD refunds of this
 * intent; `inFlight` those pending or waiting for an action; `failed` those
 * failed or canceled; `paid` what the card paid (the PaymentIntent's
 * amount_received). Null when the list cannot be read whole, so a caller
 * never takes "unread" for "none".
 */
export async function refundsOnIntent(paymentIntent: string): Promise<{ returned: number; inFlight: number; failed: number; paid: number } | null> {
  if (!/^pi_[A-Za-z0-9]{8,64}$/.test(paymentIntent)) return null;
  try {
    // What the card actually paid (an invoice can take part of a price from the customer's credit balance).
    const intent = await onPlatform("GET", `/payment_intents/${encodeURIComponent(paymentIntent)}`, undefined, { version: CHARGE_VERSION });
    if (!intent || intent.object !== "payment_intent" || intent.id !== paymentIntent || intent.currency !== "usd" || typeof intent.amount_received !== "number" || !Number.isSafeInteger(intent.amount_received) || intent.amount_received < 0) return null;
    const query = new URLSearchParams({ payment_intent: paymentIntent, limit: "100" });
    const listed = await onPlatform("GET", `/refunds?${query}`, undefined, { version: CHARGE_VERSION });
    if (!listed || listed.object !== "list" || !Array.isArray(listed.data) || listed.has_more !== false) return null;
    const out = { returned: 0, inFlight: 0, failed: 0, paid: intent.amount_received as number };
    for (const row of listed.data as Record<string, unknown>[]) {
      if (!row || row.object !== "refund" || typeof row.id !== "string") return null;
      const intent = typeof row.payment_intent === "string" ? row.payment_intent : (row.payment_intent as { id?: unknown } | null | undefined)?.id;
      if (intent !== paymentIntent) return null;
      if (row.status === "succeeded") {
        if (row.currency !== "usd" || typeof row.amount !== "number" || !Number.isSafeInteger(row.amount) || row.amount <= 0) return null;
        out.returned += row.amount;
      } else if (row.status === "pending" || row.status === "requires_action") out.inFlight += 1;
      else if (row.status === "failed" || row.status === "canceled") out.failed += 1;
      else return null;
    }
    return out;
  } catch (error) {
    console.error("reading a payment's refunds failed", error);
    return null;
  }
}

/** Whether a line with this mark was added to this customer since `sinceSeconds`, billed yet or not. */
export async function findInvoiceLine(customerId: string, mark: string, sinceSeconds: number): Promise<boolean> {
  if (!CUSTOMER_PATTERN.test(customerId)) return false;
  let after = "";
  // A customer has a handful of these a month at most; three pages is far more than any has.
  for (let page = 0; page < 3; page += 1) {
    const query = new URLSearchParams({ customer: customerId, limit: "100", "created[gte]": String(Math.max(0, Math.floor(sinceSeconds))) });
    if (after) query.set("starting_after", after);
    const listed = await onPlatform("GET", `/invoiceitems?${query}`);
    const rows = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
    if (rows.some((row) => (row.metadata as Record<string, string> | null | undefined)?.mark === mark)) return true;
    const lastId = rows[rows.length - 1]?.id;
    if (listed.has_more !== true || typeof lastId !== "string") return false;
    after = lastId;
  }
  return false;
}

/**
 * Has a subscription bill what was added to it once a month, whatever its
 * own cycle. A plan paid by the year makes one invoice a year, and a line
 * added in February would otherwise wait for it until the next January.
 */
export async function billAddedLinesMonthly(subscriptionId: string): Promise<void> {
  if (!SUBSCRIPTION_PATTERN.test(subscriptionId)) return;
  await onPlatform(
    "POST",
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    new URLSearchParams({ "pending_invoice_item_interval[interval]": "month", "pending_invoice_item_interval[interval_count]": "1" }),
  );
}

/**
 * Whether this store is paid up, read from what we wrote down.
 *
 * The snapshot is what the public store page uses, because a buyer's page load
 * must not wait on a call to Stripe. The studio refreshes it every time the
 * creator opens it, which is the moment they would notice it being wrong.
 */
export function isPaidUp(store: Store): boolean {
  // A renewal Stripe could not collect is not paid up (232 [CA1] unit 4):
  // the checkout, sign-ups, free copies and emails that need a paid plan
  // stop until it is paid, while the plan itself goes on and nothing closes.
  // A plan payment the creator disputed does the same (unit 5, lib/plan-dispute-rules.ts).
  return store.subscriptionActive && !costsPaused(store);
}
