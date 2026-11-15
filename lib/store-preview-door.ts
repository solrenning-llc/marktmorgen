/**
 * 488 [IT5] unit 3a: the store preview's door (app/api/store-preview/route.ts; docs/it5-store-preview.md).
 *
 * Off: while STORE_PREVIEW_ON is false it answers 404, as a path that does not exist, before reading the body or the
 * database. `on` and the other options exist for its tests; the route passes none.
 *
 * Every check before anything is spent, in this order: another site, the hidden field, the body's size and shape, a
 * robot (lib/bot-check.ts); then the month's previews, from the places the owner chooses ((A) or (B),
 * lib/store-preview-rules.ts) and the count of paying stores: with either unknown, previews are full and nothing is
 * asked, never a guess. A new preview counts its address's day first (hashed, as the studio demo's door hashes it,
 * never kept as typed), then the site's day (previewDayCeiling) and month; a refused address takes nothing from the
 * site. The answers round needs a preview this door opened: its id is signed with the day it was opened
 * (deriveKey), so checking it sends nothing to the database, and it is good that day and the next. With no key to
 * sign with, the door opens nothing. The job itself never makes a third (lib/store-preview.ts).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isAutomated } from "@/lib/bot-check";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { BodyTooLarge, clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { deriveKey } from "@/lib/secret-box";
import { shareAddress } from "@/lib/traffic-rules";
import { windowCount, windowCountOf } from "@/lib/window-count";
import { storeSetupWords } from "@/lib/ai";
import { PREVIEW_ID, type PreviewJobResult, previewDraft } from "@/lib/store-preview";
import {
  PREVIEWS_PER_ADDRESS_PER_DAY, type PreviewPlaces, STORE_PREVIEW_ON, previewDayCeiling, previewMonthCeiling, previewPoolCapMicroUsd,
} from "@/lib/store-preview-rules";

/** The most the door reads of a request: the visitor's words, capped again by the draft (MAX_AI_NOTES). */
export const PREVIEW_DOOR_BODY_BYTES = 8_192;
/**
 * The places the month's previews come from: none until the owner chooses (A) or (B). Null keeps previews full.
 */
export const PREVIEW_PLACES: PreviewPlaces | null = null;
/**
 * The route declares the duration the preview's function time is priced at (routePricedIn holds the route's source
 * in tests/store-preview-door.test.ts), so the worst is known and the pool's cap can be worked out.
 */
const ROUTE_DECLARES_DURATION = true;
const DAY_SECONDS = 86_400;
const MONTH_KEEP_SECONDS = 40 * DAY_SECONDS;

export type StorePreviewOptions = {
  on?: boolean;
  isAutomated?: () => Promise<boolean>;
  now?: () => number;
  places?: PreviewPlaces | null;
  /** Paying stores now; unknown (null) until a reading of them is wired in, and then previews are full. */
  paying?: number | null;
};

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status: number) => Response.json(body, { status, headers: NO_STORE });
/** As a path that does not exist answers. */
export const storePreviewNotFound = () => new Response(null, { status: 404, headers: NO_STORE });

const STATUS: Record<Exclude<PreviewJobResult, { ok: true }>["reason"], number> = { off: 404, notes: 400, used: 429, spent: 429, failed: 502 };

/** The address's field: its network block, keyed, never the address as typed. */
function addressOf(request: Request): string {
  const of = `marktmorgen-store-preview:${shareAddress(clientAddress(request)) || "unknown"}`;
  const key = deriveKey("store-preview-address");
  return (key ? createHmac("sha256", key).update(of) : createHash("sha256").update(of)).digest("hex").slice(0, 32);
}

/** A preview's id: 16 random characters and 16 of their signature with the day it was opened. Null with no key. */
function signedId(random: string, day: string): string | null {
  const key = deriveKey("store-preview-id");
  if (!key) return null;
  return `${random}${createHmac("sha256", key).update(`${random}:${day}`).digest("base64url").slice(0, 16)}`;
}

/** Whether an id is one this door opened today or yesterday (UTC). */
function opened(previewId: string, now: number): boolean {
  if (!PREVIEW_ID.test(previewId)) return false;
  const random = previewId.slice(0, 16);
  return [now, now - DAY_SECONDS * 1_000].some((at) => {
    const made = signedId(random, new Date(at).toISOString().slice(0, 10));
    return made !== null && timingSafeEqual(Buffer.from(made), Buffer.from(previewId));
  });
}

/** A count taken, or null when the database did not answer in its exact shape. */
async function count(key: string, seconds: number): Promise<number | null> {
  try {
    return windowCountOf(await redisPipeline(windowCount(key, seconds)));
  } catch {
    return null;
  }
}

export async function answerStorePreview(request: Request, options: StorePreviewOptions = {}): Promise<Response> {
  const on = (options.on ?? STORE_PREVIEW_ON) === true;
  if (!on) return storePreviewNotFound();
  if (fromAnotherSite(request)) return json({ ok: false, error: "forbidden" }, 403);
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await (await limited(request, PREVIEW_DOOR_BODY_BYTES)).text()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ ok: false, error: "invalid" }, 400);
    body = parsed as Record<string, unknown>;
  } catch (error) {
    return json({ ok: false, error: "invalid" }, error instanceof BodyTooLarge ? 413 : 400);
  }
  if (typeof body.website === "string" && body.website.trim()) return json({ ok: false, error: "automated" }, 403);
  if (await (options.isAutomated ?? isAutomated)()) return json({ ok: false, error: "automated" }, 403);
  // Nothing to draft from is said before anything is counted: an empty form never takes a place.
  if (!storeSetupWords(body).about) return json({ ok: false, error: "notes" }, 400);
  if (!isRedisConfigured()) return json({ ok: false, error: "unknown" }, 503);

  const now = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now <= 0) return json({ ok: false, error: "unknown" }, 503);
  const date = new Date(now).toISOString();
  const day = date.slice(0, 10), month = date.slice(0, 7);
  const places = options.places === undefined ? PREVIEW_PLACES : options.places;
  const paying = options.paying === undefined ? null : options.paying;
  if (places === null || paying === null) return json({ ok: false, error: "full" }, 429);
  const monthCeiling = previewMonthCeiling(places, paying);
  const cap = previewPoolCapMicroUsd(places, paying, ROUTE_DECLARES_DURATION);
  if (monthCeiling <= 0 || cap === null || cap <= 0) return json({ ok: false, error: "full" }, 429);

  const given = body.previewId;
  let previewId: string;
  if (given === undefined) {
    // Made before anything is counted: with no key to sign with, nothing is opened.
    const made = signedId(randomBytes(12).toString("base64url"), day);
    if (!made) return json({ ok: false, error: "unknown" }, 503);
    // A new preview: the address's day first, so a refused address takes nothing from the site's counts.
    const mine = await count(`nl:storepv:addr:${day}:${addressOf(request)}`, DAY_SECONDS);
    if (mine === null) return json({ ok: false, error: "unknown" }, 503);
    if (mine > PREVIEWS_PER_ADDRESS_PER_DAY) return json({ ok: false, error: "address" }, 429);
    let site: number | null = null, inMonth: number | null = null;
    try {
      const replies = await redisPipeline([...windowCount(`nl:storepv:day:${day}`, DAY_SECONDS), ...windowCount(`nl:storepv:month:${month}`, MONTH_KEEP_SECONDS)]);
      site = windowCountOf(replies, 0, 4);
      inMonth = windowCountOf(replies, 2, 4);
    } catch {
      site = null;
    }
    if (site === null || inMonth === null) return json({ ok: false, error: "unknown" }, 503);
    if (site > previewDayCeiling(monthCeiling) || inMonth > monthCeiling) return json({ ok: false, error: "full" }, 429);
    previewId = made;
  } else {
    if (typeof given !== "string" || !PREVIEW_ID.test(given)) return json({ ok: false, error: "invalid" }, 400);
    if (!opened(given, now)) return json({ ok: false, error: "expired" }, 410);
    previewId = given;
  }

  const result = await previewDraft({
    previewId, month, poolCapMicroUsd: cap,
    storeName: typeof body.storeName === "string" ? body.storeName : "",
    currency: typeof body.currency === "string" ? body.currency : "",
    language: typeof body.language === "string" ? body.language : "",
    about: body.about, selling: body.selling, answers: body.answers,
  }, on);
  if (!result.ok) return json({ ok: false, error: result.reason === "spent" ? "full" : result.reason, previewId }, STATUS[result.reason]);
  return json({ ok: true, previewId, draft: result.draft }, 200);
}
