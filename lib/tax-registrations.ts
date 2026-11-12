/**
 * Where a creator collects tax, as their own Stripe account says (655 [WG15]):
 * the tax registrations active on their connected account, read only.
 *
 * Source, read 6 November 2026: Stripe's API reference, "List registrations"
 * (https://docs.stripe.com/api/tax/registrations/all), GET /v1/tax/registrations
 * with status=active, limit 1 to 100 and starting_after, answering a list with
 * has_more; each a `tax.registration` with its country, `country_options`
 * (a US registration's state under `country_options.us.state`), `active_from`,
 * `expires_at` and `status`. Where the creator adds or corrects one: the
 * Locations tab of the Tax page in their own Stripe Dashboard
 * (https://docs.stripe.com/tax/registering, https://dashboard.stripe.com/tax/locations).
 *
 * What this is not: no threshold is worked out, no coverage is promised, and
 * nothing here touches Marktmorgen's own tax reading or the EU article 9a
 * rule (lib/tax.ts, lib/deemed-supplier.ts), which stay Marktmorgen's.
 *
 * Read exactly (CX-123 rule 24): a list only when every page came back in its
 * exact shape and the last said has_more false; any other answer is
 * "unknown", shown as "We could not read this", never as an empty list. Kept
 * TAX_REGISTRATIONS_SECONDS (half a day, as lib/payment-methods.ts keeps an
 * account's currencies), and only a complete list is kept.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { onAccount } from "@/lib/stripe-account";
import { STRIPE_VERSION } from "@/lib/stripe-connect";
import type { Store } from "@/lib/store";

/** How long a complete list is kept before Stripe is asked again. */
export const TAX_REGISTRATIONS_SECONDS = 12 * 60 * 60;
/** Pages of a hundred read at the most in one look; more than this is said as not read. */
export const TAX_REGISTRATION_PAGES = 3;
/** The most a kept list may weigh, checked before it is written (tests/store-data-registry.ts). */
export const TAX_REGISTRATIONS_MAX_BYTES = 32 * 1024;

export type TaxRegistration = {
  id: string;
  /** Two letters, as Stripe gives it ("US", "DE"). */
  country: string;
  /** A US state's two letters, or a Canadian province's, when the registration is for one. */
  region: string | null;
  /** Stripe's name for the kind of registration ("state_sales_tax", "oss_union"…). */
  type: string | null;
  /** When it started, in seconds. */
  activeFrom: number;
  /** When it ends, in seconds, if an end is set. */
  expiresAt: number | null;
};

export type TaxRegistrations =
  | { state: "ok"; list: TaxRegistration[]; dashboard: string }
  | { state: "unknown"; dashboard: string }
  | { state: "none" };

/** The Locations tab of the creator's own Stripe Tax page: test mode's when the platform runs on a test key. */
export function taxLocationsPage(): string {
  const test = /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY?.trim() ?? "");
  return `https://dashboard.stripe.com/${test ? "test/" : ""}tax/locations`;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const ID = /^taxreg_[A-Za-z0-9]{1,64}$/;
const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[A-Z]{2}$/;
const TYPE = /^[a-z_]{1,40}$/;

/**
 * One row as Stripe gives it, or null when it is not exactly an active
 * registration: then the whole answer is unknown.
 */
export function readRegistration(row: unknown): TaxRegistration | null {
  if (!isObject(row)) return null;
  if (row.object !== "tax.registration" || typeof row.id !== "string" || !ID.test(row.id)) return null;
  if (row.status !== "active") return null;
  if (typeof row.country !== "string" || !COUNTRY.test(row.country)) return null;
  if (!whole(row.active_from)) return null;
  if (row.expires_at !== null && !whole(row.expires_at)) return null;
  if (!isObject(row.country_options)) return null;
  const options = row.country_options[row.country.toLowerCase()];
  if (options !== undefined && !isObject(options)) return null;
  let region: string | null = null;
  let type: string | null = null;
  if (isObject(options)) {
    // A US registration names its state; a Canadian provincial one its province.
    const province = isObject(options.province_standard) ? options.province_standard.province : undefined;
    const named = options.state ?? province;
    if (named !== undefined && (typeof named !== "string" || !REGION.test(named))) return null;
    region = typeof named === "string" ? named : null;
    if (options.type !== undefined && (typeof options.type !== "string" || !TYPE.test(options.type))) return null;
    type = typeof options.type === "string" ? options.type : null;
  }
  return { id: row.id, country: row.country, region, type, activeFrom: row.active_from, expiresAt: row.expires_at === null ? null : (row.expires_at as number) };
}

/** One page, or null when it is not exactly a list of registrations. */
export function readPage(body: unknown): { rows: TaxRegistration[]; more: boolean } | null {
  if (!isObject(body) || body.object !== "list" || !Array.isArray(body.data) || typeof body.has_more !== "boolean") return null;
  const rows: TaxRegistration[] = [];
  for (const row of body.data) {
    const read = readRegistration(row);
    if (!read) return null;
    rows.push(read);
  }
  // A page that says there is more must end on a row to go on from.
  if (body.has_more && rows.length === 0) return null;
  return { rows, more: body.has_more };
}

const keptKey = (account: string) => `nl:taxreg:${account}`;

/** A kept list read back whole, or null. */
function readKept(raw: unknown): TaxRegistration[] | null {
  if (typeof raw !== "string" || raw.length > TAX_REGISTRATIONS_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out: TaxRegistration[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== "string" || !ID.test(item.id) || typeof item.country !== "string" || !COUNTRY.test(item.country)) return null;
    if (item.region !== null && (typeof item.region !== "string" || !REGION.test(item.region))) return null;
    if (item.type !== null && (typeof item.type !== "string" || !TYPE.test(item.type))) return null;
    if (!whole(item.activeFrom) || (item.expiresAt !== null && !whole(item.expiresAt))) return null;
    out.push({ id: item.id, country: item.country, region: item.region as string | null, type: item.type as string | null, activeFrom: item.activeFrom, expiresAt: item.expiresAt as number | null });
  }
  return out;
}

/**
 * The active registrations on the store's Stripe account: from the kept copy
 * when there is one, otherwise read from Stripe, at most
 * TAX_REGISTRATION_PAGES pages. The caller has already counted the page this
 * is shown on (lib/studio-route.ts, studioView).
 */
export async function readTaxRegistrations(store: Pick<Store, "stripeAccountId">): Promise<TaxRegistrations> {
  const account = store.stripeAccountId;
  if (!account) return { state: "none" };
  const dashboard = taxLocationsPage();
  const cache = isRedisConfigured();
  if (cache) {
    const [kept] = await redisPipeline([["GET", keptKey(account)]]).catch(() => [null]);
    const list = readKept(kept);
    if (list) return { state: "ok", list, dashboard };
  }
  const list: TaxRegistration[] = [];
  let after = "";
  try {
    for (let page = 0; page < TAX_REGISTRATION_PAGES; page += 1) {
      const query = new URLSearchParams({ status: "active", limit: "100" });
      if (after) query.set("starting_after", after);
      const read = readPage(await onAccount("GET", account, `/tax/registrations?${query}`, undefined, STRIPE_VERSION));
      if (!read) return { state: "unknown", dashboard };
      list.push(...read.rows);
      if (!read.more) {
        list.sort((a, b) => a.country.localeCompare(b.country) || (a.region ?? "").localeCompare(b.region ?? "") || a.activeFrom - b.activeFrom);
        const json = JSON.stringify(list);
        if (cache && json.length <= TAX_REGISTRATIONS_MAX_BYTES) {
          await redisPipeline([["SET", keptKey(account), json, "EX", TAX_REGISTRATIONS_SECONDS]]).catch(() => {});
        }
        return { state: "ok", list, dashboard };
      }
      after = read.rows[read.rows.length - 1].id;
    }
  } catch (error) {
    console.error("reading a store's tax registrations failed", error);
    return { state: "unknown", dashboard };
  }
  // Still more after the pages read: not the whole list, so not shown as one.
  return { state: "unknown", dashboard };
}

/** US states and DC, named in full (AX274 3.1.4: no bare abbreviation). */
const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
};
/** Canadian provinces and territories, named in full. */
const CA_PROVINCES: Record<string, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador", NS: "Nova Scotia",
  NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
};

/** "California, United States", "Germany": the place in words, never a bare code. */
export function placeOf(registration: Pick<TaxRegistration, "country" | "region">): string {
  let country = registration.country;
  try {
    country = new Intl.DisplayNames(["en-US"], { type: "region" }).of(registration.country) ?? registration.country;
  } catch {}
  if (!registration.region) return country;
  const region =
    (registration.country === "US" ? US_STATES[registration.region] : registration.country === "CA" ? CA_PROVINCES[registration.region] : undefined) ??
    registration.region;
  return `${region}, ${country}`;
}
