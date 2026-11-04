/**
 * OWNER SR,27 October2026 08:00 Fortaleza (docs/stripe-platform-eligibility.md):
 * country eligibility is NOT established by this payload or COUNTRIES.
 * For contradictory Stripe replies the less favorable answer applies until a
 * later complete, non-contradictory reply: BR platform connects BR creators only;
 * US platform planning requires SSN/ITIN, a US-resident legal representative and
 * a real US business address, not a PO box. These are owner-reported answers,
 * not verified platform-account approval. Earlier design rationale below is
 * retained as history; it cannot override SR or establish cross-border access.
 * SR2 separately requires dated company-account/direct-charge eligibility proof
 * before opening. No account, country list, fee, loss or release flag changes here.
 *
 * Connecting a creator's own Stripe account.
 *
 * The creator ends up owning a full Stripe account: their name on it, their
 * dashboard, their payouts, their money. Marktmorgen holds the account's identifier
 * and nothing else — no key to it, and never the money that lands in it. That
 * is what lets the site say the buyer pays into the creator's own account
 * without stretching the truth.
 *
 * Accounts v2, because Stripe now refuses v1 account creation for new Connect
 * integrations and points here. The shape below is not a style choice:
 *
 *   dashboard: "full"        the creator logs into Stripe itself
 *   fees_collector: stripe   Stripe bills them, not us
 *   losses_collector: stripe disputes and refunds are theirs, settled with Stripe
 *
 * Those three together are what Stripe calls a full-dashboard account, and it
 * is the only arrangement a platform registered in one country may open for a
 * creator in another. The platform-controlled variants — a dashboard we own,
 * fees and losses collected by us — are refused across a border. So the honest
 * design and the possible design are the same design here.
 */
import { STRIPE_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { DEMO_CONNECTED_ACCOUNT } from "@/lib/demo-account";

/** Local tests may point this at a mock on 127.0.0.1; nothing else is taken. */
const STRIPE_ROOT = /^http:\/\/127\.0\.0\.1:\d+$/.test(
  process.env.STRIPE_CONNECT_API_BASE ?? "",
)
  ? (process.env.STRIPE_CONNECT_API_BASE as string)
  : "https://api.stripe.com";

/**
 * Pinned on purpose.
 *
 * This file reads specific fields out of specific shapes. Letting the account's
 * default version float means a Stripe release could quietly change what
 * `capabilities.card_payments.status` looks like and the site would start
 * telling creators the wrong thing about their own money.
 */
export const STRIPE_VERSION = "2026-08-26.dahlia";

/** A link Stripe hands back is short-lived and single use. */
export const ONBOARDING_LINK_TTL_SECONDS = 5 * 60;

function platformKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key || !/^(sk|rk)_(test|live)_/.test(key)) return null;
  return key;
}

export function isConnectConfigured(): boolean {
  return platformKey() !== null;
}

/** True when the platform key is a test key, so the UI can say so plainly. */
export function isConnectInTestMode(): boolean {
  return /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY?.trim() ?? "");
}

/**
 * Whether what this store sells is paid for in Stripe's test mode: the site
 * as a whole is, or the store charges the demo's account. Asked of the store
 * and not only of our own key, because the demo store stays in test mode on
 * the day everything else stops being (lib/demo-account.ts).
 */
export function sellsInTestMode(store: { stripeAccountId: string | null }): boolean {
  return store.stripeAccountId === DEMO_CONNECTED_ACCOUNT || isConnectInTestMode();
}

/**
 * Carries what Stripe actually said.
 *
 * An earlier version of this file kept only the error code and threw the
 * message away. A creator then hit a plain "400 invalid_request_error" in the
 * logs and the reason — that the whole endpoint had been retired — took a trip
 * through the Stripe dashboard to find. The message is the useful part.
 */
export class StripeConnectError extends Error {
  readonly status: number;
  readonly code: string;
  readonly stripeMessage: string;

  constructor(status: number, code: string, stripeMessage: string) {
    super(`Stripe request failed (${status} ${code}): ${stripeMessage}`);
    this.status = status;
    this.code = code;
    this.stripeMessage = stripeMessage;
  }

  /** The creator's country is one this platform may not open an account in. */
  get isCrossBorderRefusal(): boolean {
    return this.code === "cross_border_connected_account_creation_not_allowed";
  }
}

async function stripeRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const key = platformKey();
  if (!key) throw new Error("Stripe is not configured");

  // Given up after STRIPE_TIMEOUT_MS as a network failure is (lib/fetch-timeout.ts).
  const { response, data } = await timed(STRIPE_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`${STRIPE_ROOT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Stripe-Version": STRIPE_VERSION,
        // API v2 speaks JSON, unlike the form-encoded v1 endpoints.
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal,
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { response, data };
  });
  if (!response.ok) {
    const error = data.error as
      | { code?: string; type?: string; message?: string }
      | undefined;
    throw new StripeConnectError(
      response.status,
      error?.code ?? error?.type ?? "unknown",
      error?.message ?? "Stripe gave no reason.",
    );
  }
  return data;
}

/**
 * The countries a creator can pick from.
 *
 * Every country where Stripe opens accounts for businesses in general — the
 * list it publishes as "Stripe-supported countries" — except the ones it
 * offers only by invitation or in preview, and except Brazil, which this
 * company does not sell into — and where, by Stripe's own rule, a platform
 * based outside Brazil may not take an application fee at all, so a store
 * there could not pay the share of each sale its plan is priced with
 * (lib/platform-share.ts; tests/platform-share.test.ts holds this). The six most creators choose come first; the
 * rest follow in alphabetical order.
 *
 * One list, used both to draw the menu and to check what comes back, so the
 * form can never accept something it did not offer. Stripe may still refuse a
 * country on this list — its rules change and they depend on where our own
 * account is registered — and that refusal is reported as itself rather than
 * as a generic failure.
 *
 * Stripe support, 28 October 2026 (thread "Connect platform eligibility for
 * international accounts", docs/stripe-platform-eligibility.md), for a US
 * platform taking direct charges on Standard accounts with no application
 * fee: available in each country below; not available in Malaysia, so
 * Malaysia is no longer offered; Brazil is a public beta and India is by
 * invitation only, so neither is offered. tests/connect-configuration.test.ts
 * holds the list to that answer.
 */
export const COUNTRIES: { code: string; name: string; top?: true }[] = [
  { code: "us", name: "United States", top: true },
  { code: "gb", name: "United Kingdom", top: true },
  { code: "ca", name: "Canada", top: true },
  { code: "au", name: "Australia", top: true },
  { code: "ie", name: "Ireland", top: true },
  { code: "nz", name: "New Zealand", top: true },
  { code: "at", name: "Austria" },
  { code: "be", name: "Belgium" },
  { code: "bg", name: "Bulgaria" },
  { code: "hr", name: "Croatia" },
  { code: "cy", name: "Cyprus" },
  { code: "cz", name: "Czech Republic" },
  { code: "dk", name: "Denmark" },
  { code: "ee", name: "Estonia" },
  { code: "fi", name: "Finland" },
  { code: "fr", name: "France" },
  { code: "de", name: "Germany" },
  { code: "gi", name: "Gibraltar" },
  { code: "gr", name: "Greece" },
  { code: "hk", name: "Hong Kong" },
  { code: "hu", name: "Hungary" },
  { code: "it", name: "Italy" },
  { code: "jp", name: "Japan" },
  { code: "lv", name: "Latvia" },
  { code: "li", name: "Liechtenstein" },
  { code: "lt", name: "Lithuania" },
  { code: "lu", name: "Luxembourg" },
  { code: "mt", name: "Malta" },
  { code: "mx", name: "Mexico" },
  { code: "nl", name: "Netherlands" },
  { code: "no", name: "Norway" },
  { code: "pl", name: "Poland" },
  { code: "pt", name: "Portugal" },
  { code: "ro", name: "Romania" },
  { code: "sg", name: "Singapore" },
  { code: "sk", name: "Slovakia" },
  { code: "si", name: "Slovenia" },
  { code: "es", name: "Spain" },
  { code: "se", name: "Sweden" },
  { code: "ch", name: "Switzerland" },
  { code: "th", name: "Thailand" },
  { code: "ae", name: "United Arab Emirates" },
];

const OFFERED = new Set(COUNTRIES.map((country) => country.code));

/** Empty for anything we did not put on the menu ourselves. */
export function normaliseCountry(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return OFFERED.has(trimmed) ? trimmed : "";
}

/**
 * Opens a Stripe account that belongs to the creator.
 *
 * The country has to be settled here, before Stripe's onboarding starts, and
 * it cannot be changed afterward — which is why the studio asks for it in
 * plain words rather than guessing from an IP address.
 *
 * The store's own address is left for onboarding to collect. Stripe asks the
 * creator for their business URL there, and an answer they gave themselves is
 * worth more on their account than one we filled in for them.
 */
export async function createConnectedAccount(options: {
  email: string;
  country: string;
  displayName: string;
}): Promise<string> {
  const country = normaliseCountry(options.country);
  if (!country) throw new Error("A country is needed to open an account");

  const account = await stripeRequest("POST", "/v2/core/accounts", {
    contact_email: options.email,
    display_name: options.displayName,
    dashboard: "full",
    identity: { country },
    configuration: {
      merchant: { capabilities: { card_payments: { requested: true } } },
    },
    defaults: {
      responsibilities: {
        fees_collector: "stripe",
        losses_collector: "stripe",
      },
    },
  });

  const id = account.id;
  if (typeof id !== "string" || !id) {
    throw new Error("Stripe did not return an account id");
  }
  return id;
}

/**
 * The one-time link that takes the creator into Stripe's own onboarding.
 *
 * Stripe is explicit that these must never be emailed or passed around: they
 * open a door to the account holder's personal information, so this link only
 * ever goes to a browser that has just proved it holds the session.
 *
 * `storeId` names the store the way back is for, so a creator with several
 * stores comes back to the one whose account they were finishing.
 */
export async function createOnboardingLink(
  accountId: string,
  origin: string,
  storeId = "",
): Promise<string> {
  const pin = /^[0-9a-f]{32}$/.test(storeId) ? `?store=${storeId}` : "";
  const link = await stripeRequest("POST", "/v2/core/account_links", {
    account: accountId,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        configurations: ["merchant"],
        refresh_url: `${origin}/api/stripe/refresh${pin}`,
        return_url: `${origin}/api/stripe/return${pin}`,
      },
    },
  });

  if (typeof link.url !== "string" || !link.url) {
    throw new Error("Stripe did not return an onboarding link");
  }
  return link.url;
}

export type AccountState = {
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
};

type MerchantConfiguration = {
  capabilities?: { card_payments?: { status?: unknown } };
};

type Requirements = {
  summary?: { minimum_deadline?: { status?: unknown } };
};

/**
 * Asks Stripe what that account can actually do right now.
 *
 * Read every time rather than remembered, because a capability can be switched
 * off by Stripe hours after onboarding finished, and a store that says "buy"
 * over a dead account wastes a buyer's time and the creator's reputation.
 */
export async function readAccount(accountId: string): Promise<AccountState> {
  const account = await stripeRequest(
    "GET",
    `/v2/core/accounts/${encodeURIComponent(accountId)}` +
      "?include=configuration.merchant&include=requirements",
  );

  const configuration = account.configuration as
    | { merchant?: MerchantConfiguration }
    | undefined;
  const status = configuration?.merchant?.capabilities?.card_payments?.status;

  const requirements = account.requirements as Requirements | undefined;
  const deadline = requirements?.summary?.minimum_deadline?.status;

  return {
    chargesEnabled: status === "active",
    // Onboarding still has something outstanding while a deadline is past due.
    detailsSubmitted: deadline !== "past_due",
  };
}
