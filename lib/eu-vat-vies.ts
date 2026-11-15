/**
 * EU VAT under art. 9a, unit 1 (IVA, 14/11/2026): the VIES check of a business buyer's VAT number, made at the moment
 * of the sale and kept whole with the sale (docs/eu-vat-official-sources-2026-11-13.md, 4, rechecked on 14/11/2026).
 *
 * Sources, read on 14/11/2026:
 *   - VIES REST contract, https://ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml: POST
 *     /check-vat-number with countryCode and vatNumber answers countryCode, vatNumber, requestDate, valid, name,
 *     address and requestIdentifier ("In order to retrieve the requestIdentifier, the information about
 *     requesterMemberStateCode and requesterNumber have to be provided"; the LLC has no EU number to give, so it is
 *     empty); a refusal is {actionSucceed: false, errorWrappers: [{error}]}. The official test service
 *     (/check-vat-test-service) answered every shape below with HTTP 200: "100" valid, "200" not valid, and the errors
 *     INVALID_INPUT, INVALID_REQUESTER_INFO, SERVICE_UNAVAILABLE, MS_UNAVAILABLE, TIMEOUT, VAT_BLOCKED, IP_BLOCKED,
 *     GLOBAL_MAX_CONCURRENT_REQ(_TIME) and MS_MAX_CONCURRENT_REQ(_TIME).
 *   - VIES FAQ (https://ec.europa.eu/taxation_customs/vies/, rest-api/translations?lang=en): resp06 "It is not possible
 *     to confirm the validity of a VAT number in the past. It is possible to do it only for the current day", so the
 *     answer is kept at the sale; resp20 "If you believe that your customer is not a taxable person, you should not
 *     exempt the supply but should charge VAT"; resp03 "If the customer does not have a valid VAT number, then the
 *     supplier will charge VAT".
 *   - Regulation (EU) No 282/2011 art. 18(1)(a) and 18(2), second subparagraph (legislation.gov.uk/eur/2011/282/article/18,
 *     the EU text as at 31/12/2020; EUR-Lex refuses automated reading): the supplier "may regard a customer established
 *     within the Community as a taxable person" once it "obtains confirmation of the validity of that identification
 *     number and of the associated name and address"; an electronically supplied service's customer is a non-taxable
 *     person "as long as that customer has not communicated his individual VAT identification number".
 *
 * So only "valid" ever moves a sale to the reverse charge; "invalid", "unavailable" and anything unreadable charge the
 * consumer's VAT (lib/eu-vat-checkout.ts). This file never throws and never retries: one request, bounded by
 * VIES_TIMEOUT_MS, and nothing calls it yet (the checkout wiring is a later unit, behind EU_VAT_COLLECT_REVIEWED).
 */
import { EU_VAT_COUNTRIES } from "@/lib/eu-vat-supply";

export const VIES_CHECK_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";
/** The one request's whole budget, connection included; past it the answer is "unavailable" and VAT is charged. */
export const VIES_TIMEOUT_MS = 4000;
/** The longest answer read; VIES's own answers are well under 2 KB. */
const MOST_BYTES = 16_384;

/** The VAT prefix of each Member State: its country code, except Greece's EL (VIES FAQ; Directive art. 215). */
const PREFIX_OF: Record<string, string> = { GR: "EL" };
const COUNTRY_OF_PREFIX: Record<string, string> = { EL: "GR" };

/** A VAT number after its prefix: 2 to 12 digits or capital letters (Austria's numbers start with "U"). */
const BODY = /^[0-9A-Z]{2,12}$/;

export type ViesState = "valid" | "invalid" | "unavailable";

/** What VIES said about one number, kept whole with the sale. */
export type ViesAnswer = {
  state: ViesState;
  /** The Member State (GR for Greece) and the number without its prefix, as asked. */
  country: string;
  number: string;
  /** When this code asked, ISO 8601 UTC; VIES's own requestDate when it gave a readable one. */
  askedAt: string;
  viesDate: string | null;
  /** The VIES error code when it gave one (MS_UNAVAILABLE, INVALID_INPUT...), else null. */
  error: string | null;
  /** The name and address VIES returned; "---" (not disclosed by that Member State) is kept as null. */
  name: string | null;
  address: string | null;
  requestIdentifier: string | null;
};

/** A VAT number as a buyer types it, split into its Member State and body; null when it is not one. */
export function splitVatNumber(raw: unknown): { country: string; number: string } | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const compact = raw.replace(/[\s.\-]/g, "").toUpperCase();
  const prefix = compact.slice(0, 2);
  const country = COUNTRY_OF_PREFIX[prefix] ?? prefix;
  // GR is never a VAT prefix (Greece uses EL); a Member State's code passes only as its own prefix.
  if (!EU_VAT_COUNTRIES.has(country) || (PREFIX_OF[country] ?? country) !== prefix) return null;
  const number = compact.slice(2);
  return BODY.test(number) ? { country, number } : null;
}

const shortText = (value: unknown, most: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" || text === "---" || text.length > most ? null : text;
};

const isoMoment = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/**
 * Reads one VIES answer (HTTP status and parsed body) for the number asked. "valid" only when the body says
 * valid: true for the very country and number asked; a refusal with an error code is "unavailable" unless the code
 * says the number itself is not usable (INVALID_INPUT, VAT_BLOCKED: "invalid"). Every other code (SERVICE_UNAVAILABLE,
 * MS_UNAVAILABLE, TIMEOUT, the concurrency limits, IP_BLOCKED, one not listed) and anything unreadable is
 * "unavailable": the VAT is charged, never waived, whatever VIES could not say.
 */
export function readViesAnswer(asked: { country: string; number: string }, status: number, body: unknown, askedAt: Date): ViesAnswer {
  const base: ViesAnswer = {
    state: "unavailable", country: asked.country, number: asked.number, askedAt: askedAt.toISOString(), viesDate: null, error: null,
    name: null, address: null, requestIdentifier: null,
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) return base;
  const answer = body as Record<string, unknown>;
  if (answer.actionSucceed === false) {
    const wrappers = Array.isArray(answer.errorWrappers) ? answer.errorWrappers : [];
    const first = wrappers[0] as { error?: unknown } | undefined;
    const error = typeof first?.error === "string" && /^[A-Z_]{1,60}$/.test(first.error) ? first.error : null;
    const notUsable = error === "INVALID_INPUT" || error === "VAT_BLOCKED";
    return { ...base, state: notUsable ? "invalid" : "unavailable", error };
  }
  if (status !== 200) return base;
  // The answer must be about the number asked: VIES echoes the country and the number.
  const prefix = PREFIX_OF[asked.country] ?? asked.country;
  const echoedCountry = answer.countryCode;
  if (echoedCountry !== prefix && echoedCountry !== asked.country) return base;
  if (typeof answer.vatNumber !== "string" || answer.vatNumber.replace(/\s/g, "").toUpperCase() !== asked.number) return base;
  if (typeof answer.valid !== "boolean") return base;
  return {
    ...base,
    state: answer.valid ? "valid" : "invalid",
    viesDate: isoMoment(answer.requestDate),
    name: shortText(answer.name, 300),
    address: shortText(answer.address, 600),
    requestIdentifier: shortText(answer.requestIdentifier, 64),
  };
}

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

/**
 * Asks VIES once about a number the buyer typed. Never throws: a number that is not one is "invalid" without a
 * request; a network failure, a timeout, a body too long or unreadable is "unavailable". `fetcher` and `now` are
 * injectable so a test runs it against the official answers without the network.
 */
export async function checkVies(raw: unknown, options: { fetcher?: Fetcher; now?: () => Date } = {}): Promise<ViesAnswer | null> {
  const now = options.now ?? (() => new Date());
  const asked = splitVatNumber(raw);
  if (!asked) return null;
  const askedAt = now();
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  try {
    const response = await fetcher(VIES_CHECK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ countryCode: PREFIX_OF[asked.country] ?? asked.country, vatNumber: asked.number }),
      signal: AbortSignal.timeout(VIES_TIMEOUT_MS),
    });
    const text = await response.text();
    if (text.length > MOST_BYTES) return readViesAnswer(asked, 0, null, askedAt);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return readViesAnswer(asked, response.status, body, askedAt);
  } catch {
    return readViesAnswer(asked, 0, null, askedAt);
  }
}

/** The longest a VIES answer may be old when the sale uses it: VIES confirms validity only for the current day. */
export const VIES_FRESH_SECONDS = 3600;

/** Whether `answer` is a "valid" VIES answer for `country`, asked at most VIES_FRESH_SECONDS before `now` (and not after it). */
export function viesValidFor(answer: unknown, country: string, now: Date): answer is ViesAnswer {
  if (!answer || typeof answer !== "object") return false;
  const a = answer as Partial<ViesAnswer>;
  if (a.state !== "valid" || a.country !== country || typeof a.number !== "string" || !BODY.test(a.number)) return false;
  const asked = typeof a.askedAt === "string" ? Date.parse(a.askedAt) : NaN;
  if (!Number.isFinite(asked)) return false;
  const age = (now.getTime() - asked) / 1000;
  return age >= 0 && age <= VIES_FRESH_SECONDS && new Date(asked).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}
