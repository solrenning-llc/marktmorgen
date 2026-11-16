/**
 * Ways to pay, and the currencies a store can charge in, as the creator's own
 * Stripe account says.
 *
 * Which ways to pay a buyer meets is the creator's switch, in their own
 * Stripe dashboard: no checkout here names its methods (lib/instant-pay.ts),
 * so Stripe offers what the account has on, narrowed to what fits the buyer,
 * the currency and the amount. The studio shows that list, read from Stripe
 * each time the page opens, and links straight to the page in Stripe where
 * more are switched on. Nothing here switches a method on or off: a payment
 * method is an agreement between the creator and Stripe (Klarna's terms,
 * PayPal's), and the account it is made on is theirs.
 *
 * Read only: two GETs on the creator's account, and one more, kept for half
 * a day, for the currencies their country can charge in.
 */
import { saleHandles } from "@/lib/store";
import { onAccount } from "@/lib/stripe-account";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { DELAYED_METHODS } from "@/lib/instant-pay";
import { CURRENCIES, type Currency } from "@/lib/money";
import type { Store } from "@/lib/store";
import { STRIPE_LIST_VERSION, ownField, plainObject, readStripePage } from "@/lib/stripe-list";

/** How each method is named in the studio, and the one thing worth knowing about it. */
const METHODS: Record<string, { name: string; note?: string; group: WayGroup }> = {
  card: { name: "Cards", note: "Visa, Mastercard, American Express and the rest.", group: "card" },
  apple_pay: { name: "Apple Pay", note: "On Apple devices. It pays with a card.", group: "wallet" },
  google_pay: { name: "Google Pay", note: "In Chrome and on Android. It pays with a card.", group: "wallet" },
  link: { name: "Link", note: "Stripe's saved checkout details, filled in for the buyer.", group: "wallet" },
  paypal: { name: "PayPal", note: "On in Stripe, but not one to count on here: Stripe lists PayPal as not supported for direct charges, which is how every sale here is charged.", group: "wallet" },
  amazon_pay: { name: "Amazon Pay", group: "wallet" },
  cashapp: { name: "Cash App Pay", group: "wallet" },
  revolut_pay: { name: "Revolut Pay", group: "wallet" },
  samsung_pay: { name: "Samsung Pay", group: "wallet" },
  mobilepay: { name: "MobilePay", group: "wallet" },
  twint: { name: "TWINT", group: "wallet" },
  swish: { name: "Swish", group: "wallet" },
  satispay: { name: "Satispay", group: "wallet" },
  mb_way: { name: "MB WAY", group: "wallet" },
  alipay: { name: "Alipay", note: "On in Stripe, but not one to count on here yet: Stripe lists Alipay for direct charges, which is how every sale here is charged, as a private preview.", group: "wallet" },
  wechat_pay: { name: "WeChat Pay", note: "On in Stripe, but not one to count on here yet: Stripe lists WeChat Pay for direct charges, which is how every sale here is charged, as a private preview.", group: "wallet" },
  grabpay: { name: "GrabPay", group: "wallet" },
  kakao_pay: { name: "Kakao Pay", group: "wallet" },
  naver_pay: { name: "Naver Pay", group: "wallet" },
  payco: { name: "PAYCO", group: "wallet" },
  kr_card: { name: "Korean cards", group: "card" },
  cartes_bancaires: { name: "Cartes Bancaires", group: "card" },
  jcb: { name: "JCB", group: "card" },
  klarna: { name: "Klarna", group: "later" },
  afterpay_clearpay: { name: "Afterpay / Clearpay", group: "later" },
  affirm: { name: "Affirm", group: "later" },
  zip: { name: "Zip", group: "later" },
  alma: { name: "Alma", group: "later" },
  billie: { name: "Billie", group: "later" },
  scalapay: { name: "Scalapay", group: "later" },
  sunbit: { name: "Sunbit", group: "later" },
  ideal: { name: "iDEAL", group: "bank" },
  bancontact: { name: "Bancontact", group: "bank" },
  eps: { name: "EPS", group: "bank" },
  p24: { name: "Przelewy24", group: "bank" },
  blik: { name: "BLIK", group: "bank" },
  fpx: { name: "FPX", group: "bank" },
  pay_by_bank: { name: "Pay by Bank", group: "bank" },
  paynow: { name: "PayNow", group: "bank" },
  promptpay: { name: "PromptPay", group: "bank" },
  bizum: { name: "Bizum", group: "bank" },
  sofort: { name: "Sofort", group: "bank" },
  giropay: { name: "giropay", group: "bank" },
  us_bank_account: { name: "ACH Direct Debit", group: "bank" },
  sepa_debit: { name: "SEPA Direct Debit", group: "bank" },
  bacs_debit: { name: "Bacs Direct Debit", group: "bank" },
  au_becs_debit: { name: "BECS Direct Debit", group: "bank" },
  acss_debit: { name: "Pre-authorized debit", group: "bank" },
  nz_bank_account: { name: "NZ bank account", group: "bank" },
  customer_balance: { name: "Bank transfer", group: "bank" },
  boleto: { name: "Boleto", group: "other" },
  oxxo: { name: "OXXO", group: "other" },
  konbini: { name: "Konbini", group: "other" },
  multibanco: { name: "Multibanco", group: "other" },
  crypto: { name: "Stablecoins", group: "other" },
  pix: { name: "Pix", group: "other" },
  upi: { name: "UPI", group: "other" },
  payto: { name: "PayTo", group: "bank" },
};

const GROUP_NOTES: Record<string, string> = {
  later: "The buyer pays in installments; you are paid in full.",
  bank: "Paid from the buyer's bank, confirmed on the spot.",
  wallet: "A wallet the buyer already uses.",
};

/** Methods whose checkout offers keep the one-click offers after paying working. */
const OFFERS_WORK = new Set(["card", "apple_pay", "google_pay"]);

/** How the studio groups the ways to pay: cards and wallets, pay later, banks, the rest. */
export type WayGroup = "card" | "wallet" | "later" | "bank" | "other";

export type WayToPay = {
  type: string;
  name: string;
  note: string;
  group: WayGroup;
  /** A one-click offer after paying can be charged to it. */
  offers: boolean;
};

export type WaysToPay =
  | {
      state: "ok";
      /** On in Stripe, and offered at this store's checkouts. */
      on: WayToPay[];
      /**
       * On in Stripe, and left out of this store's checkouts because it
       * settles days later (lib/instant-pay.ts).
       */
      held: WayToPay[];
      /** Whether PayPal is among the ways on: said apart, because of where Stripe offers it. */
      paypal: boolean;
      /** Where to switch more on, in the creator's own Stripe dashboard. */
      dashboard: string;
    }
  /** Stripe could not be asked just now. */
  | { state: "unknown"; dashboard: string }
  /** No Stripe account connected yet. */
  | { state: "none" };

/** The creator's own payment method settings in Stripe: test mode's when the platform runs on a test key. */
export function paymentMethodsPage(): string {
  const test = /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY?.trim() ?? "");
  return `https://dashboard.stripe.com/${test ? "test/" : ""}settings/payment_methods`;
}

type Config = Record<string, unknown> & {
  id?: unknown;
  active?: unknown;
  is_default?: unknown;
  application?: unknown;
  parent?: unknown;
};

/**
 * The configuration this store's checkouts use. A checkout made by a platform
 * on an account follows the account's settings for that platform when it has
 * some (a configuration with a parent, or one made for an application), and
 * the account's own default otherwise.
 */
export function pickConfig(configs: Config[]): Config | null {
  const live = configs.filter((c) => c.active === true);
  return (
    live.find((c) => c.is_default === true && (typeof c.parent === "string" || typeof c.application === "string")) ??
    live.find((c) => typeof c.parent === "string" || typeof c.application === "string") ??
    live.find((c) => c.is_default === true) ??
    live[0] ??
    null
  );
}

function wayOf(type: string): WayToPay {
  const known = METHODS[type];
  const name = known?.name ?? type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const note = known?.note ?? (known ? GROUP_NOTES[known.group] ?? "" : "");
  return { type, name, note, group: known?.group ?? "other", offers: OFFERS_WORK.has(type) };
}

/** Reads one configuration into the list the studio shows. Exported for the checks. */
export function waysFrom(config: Config, dashboard: string): Extract<WaysToPay, { state: "ok" }> {
  const delayed = new Set<string>(DELAYED_METHODS);
  const on: WayToPay[] = [];
  const held: WayToPay[] = [];
  for (const [type, value] of Object.entries(config)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as { available?: unknown; display_preference?: { value?: unknown } | null };
    if (typeof entry.available !== "boolean") continue;
    // "available" is Stripe's own answer: switched on, and the account is able
    // to take it. A method switched on and still waiting for Stripe is not.
    if (!entry.available) continue;
    (delayed.has(type) ? held : on).push(wayOf(type));
  }
  const order = Object.keys(METHODS);
  const rank = (w: WayToPay) => {
    const at = order.indexOf(w.type);
    return at < 0 ? order.length : at;
  };
  on.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  held.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { state: "ok", on, held, paypal: on.some((w) => w.type === "paypal"), dashboard };
}

/** What the creator's account offers buyers right now, as Stripe says. */
export async function readWaysToPay(store: Store): Promise<WaysToPay> {
  if (!store.stripeAccountId) return { state: "none" };
  const dashboard = paymentMethodsPage();
  try {
    const listed = await onAccount("GET", store.stripeAccountId, "/payment_method_configurations?limit=20");
    const configs = Array.isArray(listed.data) ? (listed.data as Config[]) : [];
    const config = pickConfig(configs);
    if (!config) return { state: "unknown", dashboard };
    return waysFrom(config, dashboard);
  } catch (error) {
    console.error("reading payment methods failed", error);
    return { state: "unknown", dashboard };
  }
}

const currenciesKey = (account: string) => `nl:pay:currencies:${account}`;
/** Half a day: an account's country never changes, and Stripe's list of its currencies seldom does. */
const CURRENCIES_SECONDS = 12 * 60 * 60;

/**
 * Which of the store currencies (lib/money.ts) the creator's Stripe account
 * can charge in, from the list Stripe publishes for its country. Null when
 * there is no account, or Stripe could not be asked or answered a list in an
 * unknown shape (an entry that is not text): every currency on the list is
 * then offered, since each is one Stripe settles in the countries the studio
 * offers. A kept list that does not read back as store currencies is not
 * known either: Stripe is asked again, never "none" (review of #2993).
 */
export async function chargeableCurrencies(store: Store): Promise<Currency[] | null> {
  const account = store.stripeAccountId;
  if (!account) return null;
  const cache = isRedisConfigured();
  if (cache) {
    const [kept] = await redisPipeline([["GET", currenciesKey(account)]]).catch(() => [null]);
    if (typeof kept === "string" && kept) {
      const codes = kept.split(",");
      const known: string[] = CURRENCIES.map((c) => c.code);
      if (codes.every((code) => known.includes(code))) return CURRENCIES.map((c) => c.code).filter((code) => codes.includes(code));
    }
  }
  try {
    const found = await onAccount("GET", account, "/account");
    const country = typeof found.country === "string" ? found.country.toUpperCase() : "";
    if (!/^[A-Z]{2}$/.test(country)) return null;
    const spec = await onAccount("GET", account, `/country_specs/${country}`);
    const listed: unknown[] = Array.isArray(spec.supported_payment_currencies) ? spec.supported_payment_currencies : [];
    // An entry that is not text is a list not known whole: never the shorter list, and never kept.
    if (listed.length === 0 || !listed.every((c): c is string => typeof c === "string")) return null;
    const supported = listed.map((c) => c.toLowerCase());
    const ours = CURRENCIES.map((c) => c.code).filter((code) => supported.includes(code));
    if (cache) await redisPipeline([["SET", currenciesKey(account), ours.join(","), "EX", CURRENCIES_SECONDS]]).catch(() => {});
    return ours;
  } catch (error) {
    console.error("reading the account's currencies failed", error);
    return null;
  }
}

/** Subscriptions on the creator's account still charging, by the statuses Stripe charges in. */
const RUNNING = ["active", "trialing", "past_due"] as const;
/** Pages of a hundred read for each status before giving up on knowing. */
const RUNNING_PAGES = 10;
/** A subscription's own id: a row with another id is not readable, never one of this store's nor another's. */
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{6,128}$/;

/**
 * How many memberships and payment plans of this store are still running on
 * Stripe: each one charges again, in the currency it began in, whatever the
 * store says afterward. Null when Stripe could not be asked, or had more than
 * could be read — which is treated as "some", never as "none".
 */
export async function runningSubscriptions(store: Store): Promise<number | null> {
  const account = store.stripeAccountId;
  if (!account) return 0;
  const handles = saleHandles(store);
  let count = 0;
  // A row not readable (lib/stripe-list.ts) may be one of this store's: the count is then "at least", never "none".
  let unreadable = 0;
  try {
    for (const status of RUNNING) {
      let after = "";
      let done = false;
      for (let page = 0; page < RUNNING_PAGES; page += 1) {
        const read = readStripePage(
          await onAccount(
            "GET",
            account,
            `/subscriptions?status=${status}&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
            undefined,
            STRIPE_LIST_VERSION,
          ),
          // Whose it is is read from metadata.store: absent is a readable "not this store's"; any store that is not
          // text is not readable (Codex CX1 on #2759), so the count is never "none" on it.
          (row) => {
            const meta = ownField(row, "metadata");
            if (!plainObject(meta)) return false;
            const soldBy = ownField(meta, "store");
            return soldBy === undefined || typeof soldBy === "string";
          },
          SUBSCRIPTION_ID,
        );
        unreadable += read.unreadable;
        for (const row of read.rows) {
          const soldBy = ownField(ownField(row, "metadata") as Record<string, unknown>, "store");
          if (typeof soldBy === "string" && handles.has(soldBy)) count += 1;
        }
        if (!read.hasMore) {
          done = true;
          break;
        }
        // More pages, and no readable last row to read them from: not read whole.
        if (!read.lastId) break;
        after = read.lastId;
      }
      if (!done) return count > 0 ? count : null;
    }
    if (unreadable) return count > 0 ? count : null;
    return count;
  } catch (error) {
    console.error("counting running memberships failed", error);
    return null;
  }
}
