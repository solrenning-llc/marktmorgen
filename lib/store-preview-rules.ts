/**
 * 488 [IT5] unit 1: the rules and the cost of a store preview before an account (docs/it5-store-preview.md).
 *
 * A visitor sees a draft of their store before creating an account; keeping it creates the account and carries the
 * draft into the studio with no second AI call. Nothing here is reachable: no route, page or job uses it yet, and
 * STORE_PREVIEW_ON stays false until every unit is built and reviewed, every cost below is priced and the owner
 * chooses how the previews are funded. Pure and browser-safe: no environment, no network, no database; the only
 * imports are the table of supplier rates and the free places' rules.
 *
 * What it holds:
 *   - the switch and the caps, every one checked before anything is spent;
 *   - the worst cost of one preview, computed from the repository's own rates, never typed, and unknown (null)
 *     while any part of it is not priced;
 *   - the month's and the day's ceilings, the month's taking the source of its places as an argument, so it serves
 *     either way of funding it ((A) a count of its own grown by the paying stores, (B) inside the free places of
 *     lib/free-pool-rules.ts) and chooses neither.
 */
import {
  AI_CALL_INFRA_MICRO_USD, ANTHROPIC_RATES, PROVIDER_CHARGES_BPS, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS, VERCEL_CALL_MICRO_USD_PER_MILLION,
  VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR, WRITING_JOB_MICRO_USD,
} from "@/lib/spend-cost-table";
import { freePoolSize } from "@/lib/free-pool-rules";

/** The switch. False until every unit of 488 [IT5] is built and reviewed, its worst is priced and its funding chosen. */
export const STORE_PREVIEW_ON: boolean = false;

/** Writing jobs one preview may make: the draft and, after the visitor answers its questions, one more. Never a third. */
export const PREVIEW_JOBS = 2;
/** Previews one address (hashed, by its network) may make in a day (UTC), counted before the site-wide count. */
export const PREVIEWS_PER_ADDRESS_PER_DAY = 2;
/**
 * Database commands one preview sends at the most, scripts' inner commands one by one: the address's and the site's
 * day and month counts, the reservation and its settling, the draft kept 24 hours and read back. Held against what
 * the preview's route really sends by that route's own tests (unit 2).
 */
export const PREVIEW_DB_COMMANDS = 40;

/** Tokens one job may write back: the studio's own draft's (writeStoreSetup in lib/ai.ts asks for the same). */
export const PREVIEW_OUTPUT_TOKENS = 2_500;

/** The route the preview runs in (unit 2), and the duration it must declare (export const maxDuration). */
export const PREVIEW_ROUTE = "app/api/store-preview/route.ts";
export const PREVIEW_ROUTE_SECONDS = 60;

/**
 * Whether a route's source declares exactly the preview's duration: only then is its function time the one priced
 * below. A route that declares none runs at the platform's default, which nothing here knows, so it is not priced.
 */
export function routePricedIn(source: string): boolean {
  return typeof source === "string" && source.includes(`export const maxDuration = ${PREVIEW_ROUTE_SECONDS};`);
}

/**
 * The function time of the preview's jobs at their worst: every second of the declared duration at full CPU and
 * VERCEL_FUNCTION_GB of memory, and the call itself, once per job, rounded up (lib/spend-cost-table.ts, Vercel's
 * rates as recorded there).
 */
export function previewFunctionMicroUsd(): number {
  const hours = PREVIEW_ROUTE_SECONDS / 3600;
  const perCall = Math.ceil(hours * VERCEL_CPU_MICRO_USD_PER_HOUR + VERCEL_FUNCTION_GB * hours * VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR + VERCEL_CALL_MICRO_USD_PER_MILLION / 1_000_000);
  return PREVIEW_JOBS * perCall;
}

/**
 * One preview at its worst, in micro-dollars: its writing jobs (WRITING_JOB_MICRO_USD each, the page read inside the
 * first), their function time and its database commands. Null while the route is not priced (routePricedIn): an
 * unknown part is never left out of the sum, and never zero.
 */
export function previewWorstMicroUsd(routeIsPriced: boolean): number | null {
  if (routeIsPriced !== true) return null;
  const db = Math.ceil((PREVIEW_DB_COMMANDS * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1_000_000);
  return PREVIEW_JOBS * WRITING_JOB_MICRO_USD + previewFunctionMicroUsd() + db;
}

/** (B): previews one free place makes, floor(a free store's worst window / a preview's worst); none when either is unknown. */
export function previewsPerFreePlace(nonPayingWorstMicroUsd: number, previewWorst: number | null): number {
  if (!Number.isSafeInteger(nonPayingWorstMicroUsd) || nonPayingWorstMicroUsd <= 0) return 0;
  if (previewWorst === null || !Number.isSafeInteger(previewWorst) || previewWorst <= 0) return 0;
  return Math.floor(nonPayingWorstMicroUsd / previewWorst);
}

/** Where the month's previews come from: (A) a count of their own, (B) the free places. The owner chooses; nothing here does. */
export type PreviewPlaces =
  | { kind: "own"; base: number; perPaying: number }
  | { kind: "free-places"; perPlace: number };

/**
 * Previews in a calendar month (UTC) for this many paying stores. Anything that does not read as the shape above
 * (a negative or non-finite figure, a kind it does not know, a count of stores that is not whole) makes none.
 */
export function previewMonthCeiling(places: PreviewPlaces, paying: number): number {
  if (!Number.isSafeInteger(paying) || paying < 0 || !places || typeof places !== "object") return 0;
  if (places.kind === "own") {
    const { base, perPaying } = places;
    if (!Number.isSafeInteger(base) || base < 0 || typeof perPaying !== "number" || !Number.isFinite(perPaying) || perPaying < 0) return 0;
    const total = base + Math.floor(paying * perPaying);
    return Number.isSafeInteger(total) ? total : 0;
  }
  if (places.kind === "free-places") {
    const { perPlace } = places;
    if (!Number.isSafeInteger(perPlace) || perPlace < 0) return 0;
    const total = freePoolSize(paying) * perPlace;
    return Number.isSafeInteger(total) ? total : 0;
  }
  return 0;
}

/** Previews in a day (UTC): twice a thirtieth of the month's, rounded up, never more than the month's, so one day cannot spend it. */
export function previewDayCeiling(month: number): number {
  if (!Number.isSafeInteger(month) || month <= 0) return 0;
  return Math.min(month, Math.ceil((month * 2) / 30));
}

/**
 * The preview's month pool, in micro-dollars (unit 2): the month's previews (previewMonthCeiling) at every job's
 * priced worst, WRITING_JOB_MICRO_USD, which each job's own hold may not pass. Only the model's part is drawn from the
 * pool; the function time and the database commands are bounded by the counts the route checks. Null while the route
 * is not priced: an unknown worst never opens a pool, and the owner's choice of places is still an argument.
 */
export function previewPoolCapMicroUsd(places: PreviewPlaces, paying: number, routeIsPriced: boolean): number | null {
  if (previewWorstMicroUsd(routeIsPriced) === null) return null;
  const total = previewMonthCeiling(places, paying) * PREVIEW_JOBS * WRITING_JOB_MICRO_USD;
  return Number.isSafeInteger(total) ? total : null;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - BigInt(1)) / b;

/**
 * What one job's call cost, read from the provider's usage at the cost table's rates with its charges and the
 * call's infrastructure, never more than the job's hold: the same reading as the Store assistant's
 * (assistantSettledMicroUsd in lib/store-assistant-rules.ts), for the writing model. A bill that does not read
 * (a count that is not a whole number, more output than asked, a model the table does not price) settles the whole
 * hold, never less (CX-123 rule 24).
 */
export function previewSettledMicroUsd(model: string, usage: unknown, hold: number, maxTokens: number): number {
  if (!Number.isSafeInteger(hold) || hold <= 0) return 0;
  if (!Object.hasOwn(ANTHROPIC_RATES, model) || !usage || typeof usage !== "object") return hold;
  const u = usage as Record<string, unknown>;
  const count = (n: unknown) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null);
  const input = count(u.input_tokens), output = count(u.output_tokens);
  const cacheWrite = count(u.cache_creation_input_tokens ?? 0), cacheRead = count(u.cache_read_input_tokens ?? 0);
  if (input === null || output === null || cacheWrite === null || cacheRead === null || output > maxTokens) return hold;
  const allInput = input + cacheWrite + cacheRead;
  const tier = ANTHROPIC_RATES[model as keyof typeof ANTHROPIC_RATES].tiers.find((row) => allInput <= row.upToInputTokens);
  if (!tier) return hold;
  const million = BigInt(1_000_000);
  // Cache writes cost more than input; counted at 2x, as the assistant counts them. None are asked for.
  const provider = ceilDiv(BigInt(input + cacheRead + 2 * cacheWrite) * BigInt(tier.inputMicroUsdPerMTok), million) + ceilDiv(BigInt(output) * BigInt(tier.outputMicroUsdPerMTok), million);
  const charged = ceilDiv(provider * BigInt(10_000 + PROVIDER_CHARGES_BPS), BigInt(10_000)) + BigInt(AI_CALL_INFRA_MICRO_USD);
  return charged > BigInt(hold) ? hold : Number(charged);
}
