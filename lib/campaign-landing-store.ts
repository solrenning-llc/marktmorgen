/**
 * Where a product's campaign landing pages are kept: 632 [AA2] (m), unit 2.
 * lib/campaign-landing.ts says what one is (the ad's checked words over the
 * product's own sales page); the page is never stored twice, only the words.
 *
 *   nl:product:landing:<statsId>:<productId> -> the product's landings, as JSON:
 *                                               a list of CampaignLanding, at most
 *                                               MAX_LANDINGS, one per campaign
 *
 *   nl:product:landing:<statsId>:<productId>:gone -> set when they were dropped with the page, for
 *                                               LANDINGS_GONE_SECONDS: a save that began before is refused
 *
 * The record takes room in the store's data room (lib/store-data.ts) before it
 * is written, one slot per product, so a save that does not fit is refused and
 * the landings stay as they were. It goes with the product's page
 * (dropPage, lib/sales-page-store.ts) and with the store.
 *
 * What a page shows is checked again (parseLandings): a tag or words that no
 * longer fit their place are left out, never cut. A save is stricter: it
 * writes over a record only when every entry in it reads back whole, so an
 * entry it cannot confirm is never dropped by rewriting the list (Codex G2, #1947).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { CAMPAIGN_TAG, type CampaignLanding } from "@/lib/campaign-landing";
import { MAX_CTA_LABEL, MAX_HEADLINE, MAX_SUBHEADLINE } from "@/lib/sales-page";
import { type DataStore, DataRoomError, TAKE_DATA, dataKey, monthOf } from "@/lib/store-data";
import { contentRoomFor, dataBytes, dataFullWords, dataRoomFor } from "@/lib/store-data-rules";
import { largerPlanFor } from "@/lib/larger-plan";

/** The most campaigns one product keeps a landing for. */
export const MAX_LANDINGS = 10;

const landingKey = (statsId: string, productId: string) => `nl:product:landing:${statsId}:${productId}`;
const LANDING_SLOT = (productId: string) => `al:${productId}`;
/** Set in the same step as the landings are dropped with their page: while it is there, no save writes them again. */
const goneKey = (statsId: string, productId: string) => `${landingKey(statsId, productId)}:gone`;
/**
 * The ids a landing record may be kept under: a product's (lib/sales-page.ts) or a site page's (site-<id>), letters,
 * digits and hyphens. Anything else, such as "<product>:gone" (the key separator), would name another key of this
 * family (Codex G, #1947: the deletion fence), so it is never deleted here.
 */
const LANDING_ID = /^[a-z0-9-]{1,48}$/;

/**
 * How long a dropped product's landings stay closed to saves, in seconds: far longer than any request runs, so a save
 * that read the record before the page was dropped can never write it again (Codex G2, #1947). The product is gone by
 * then, and nothing saves for it.
 */
export const LANDINGS_GONE_SECONDS = 86_400;

/** The longest record a product's landings can make, with room for JSON's quoting. */
export const MAX_STORED_LANDINGS_BYTES = MAX_LANDINGS * (40 + MAX_HEADLINE + MAX_SUBHEADLINE + MAX_CTA_LABEL) * 6 + 1_024;

const field = (raw: unknown, max: number): string | null => {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : null;
};

/** The landings as kept, made safe: each valid, each campaign once, at most MAX_LANDINGS. */
export function parseLandings(raw: unknown): CampaignLanding[] {
  if (!Array.isArray(raw)) return [];
  const out: CampaignLanding[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Partial<Record<keyof CampaignLanding, unknown>>;
    const campaign = typeof entry.campaign === "string" && CAMPAIGN_TAG.test(entry.campaign) ? entry.campaign : null;
    const headline = field(entry.headline, MAX_HEADLINE);
    const sub = field(entry.sub, MAX_SUBHEADLINE);
    const button = field(entry.button ?? "", MAX_CTA_LABEL);
    if (!campaign || seen.has(campaign) || !headline || sub === null || button === null) continue;
    seen.add(campaign);
    out.push({ campaign, headline, sub, button });
    if (out.length === MAX_LANDINGS) break;
  }
  return out;
}

function landingsOf(raw: unknown): CampaignLanding[] {
  if (typeof raw !== "string" || !raw || raw.length > MAX_STORED_LANDINGS_BYTES) return [];
  try {
    return parseLandings(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** A product's landings could not be read as they are: a save refuses rather than take them for none (Codex G and J, #1947/#1950). */
export class LandingsUnreadable extends Error {
  constructor() {
    super("The landing pages could not be read just now, so nothing was saved. Try again in a moment.");
  }
}

/** The page these landings belong to was dropped since the save began: nothing was written. */
export class LandingsGone extends Error {
  constructor() {
    super("This page was deleted, so its landing pages were not saved.");
  }
}

/** A drop whose answer was not the one expected, every try: the landings may still be there, and their room stays counted. */
export class LandingsDropUnconfirmed extends Error {
  constructor() {
    super("We could not confirm the landing pages were deleted. They stay counted in the store's room until they are.");
  }
}

/** A write whose answer was not the one expected: it may or may not have landed, and no room is given back for it. */
export class LandingsWriteUnconfirmed extends Error {
  constructor() {
    super("We could not confirm the landing pages were saved. Reload the page to see what they are now.");
  }
}

/**
 * The record exactly as kept: its text, or null when the product has none.
 * Only Redis's exact answer counts (one GET: a text or null), and a text
 * must be a JSON list whose every entry is a whole landing; anything else
 * throws LandingsUnreadable, never "none" (Codex G and J: an empty or broken
 * read let the next save erase the others; Codex G2: an entry the lenient
 * reading left out was erased by the save that rewrote the list).
 */
async function readRecord(statsId: string, productId: string): Promise<{ raw: string | null; landings: CampaignLanding[] }> {
  const reply: unknown = await redisPipeline([["GET", landingKey(statsId, productId)]]);
  if (!Array.isArray(reply) || reply.length !== 1 || (reply[0] !== null && typeof reply[0] !== "string")) throw new LandingsUnreadable();
  const raw = reply[0] as string | null;
  if (raw === null) return { raw: null, landings: [] };
  if (raw.length > MAX_STORED_LANDINGS_BYTES) throw new LandingsUnreadable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LandingsUnreadable();
  }
  if (!Array.isArray(parsed)) throw new LandingsUnreadable();
  // parseLandings leaves out what it cannot confirm (a broken entry, a campaign twice, one past MAX_LANDINGS): any
  // left out means the save cannot rewrite the list without erasing it.
  const landings = parseLandings(parsed);
  if (landings.length !== parsed.length) throw new LandingsUnreadable();
  return { raw, landings };
}

/** A product's landings, or none when it has none (or they cannot be read). */
export async function readLandings(statsId: string | null, productId: string): Promise<CampaignLanding[]> {
  // An id no write accepts (changeLandings) holds nothing, and never names another key of the family.
  if (!statsId || !isRedisConfigured() || !LANDING_ID.test(productId)) return [];
  const [raw] = await redisPipeline([["GET", landingKey(statsId, productId)]]);
  return landingsOf(raw);
}

/** The landing for one campaign, or null: what the product's page reads when a visit carries its utm_campaign. */
export async function landingFor(statsId: string | null, productId: string, campaign: string): Promise<CampaignLanding | null> {
  if (!CAMPAIGN_TAG.test(campaign)) return null;
  return (await readLandings(statsId, productId)).find((landing) => landing.campaign === campaign) ?? null;
}

/** The list with this campaign's landing put in, in place of the one it had. Refused when the list is full of other campaigns. */
export function withLanding(landings: readonly CampaignLanding[], landing: CampaignLanding): CampaignLanding[] | null {
  const at = landings.findIndex((one) => one.campaign === landing.campaign);
  if (at >= 0) return landings.map((one, i) => (i === at ? landing : one));
  if (landings.length >= MAX_LANDINGS) return null;
  return [...landings, landing];
}

/**
 * The data room's own steps (TAKE_DATA) for one product's slot, set to `size`, inside a script whose KEYS[1] is the room
 * and KEYS[2] the record.
 */
const LANDINGS_ROOM = `local function landingsRoom(limit, always, month, slot, size)
  local KEYS = {KEYS[1]}
  local ARGV = {limit, always, month, 's', slot, size}
${TAKE_DATA}
end`;

/**
 * Writes a product's landings (ARGV[6], "" to delete them) only over the record that was read (ARGV[5], "" for none),
 * and sets its slot to their size in the same step: answers {4, 0} when they were dropped with their page (KEYS[3]
 * held), {3, 0} when the record changed since it was read, the data room's own answer otherwise ({1, total} written,
 * {0, total} full and nothing written). Modelled by lib/redis-memory.ts.
 */
export const WRITE_LANDINGS = `-- marktmorgen:landings-write:v2
${LANDINGS_ROOM}
if redis.call('EXISTS', KEYS[3]) == 1 then return {4, 0} end
local held = redis.call('GET', KEYS[2])
if (held or '') ~= ARGV[5] then return {3, 0} end
local size = ARGV[6] == '' and '0' or ARGV[4]
local taken = landingsRoom(ARGV[1], ARGV[6] == '' and '1' or '0', ARGV[2], ARGV[3], size)
if taken[1] ~= 1 then return taken end
if ARGV[6] == '' then redis.call('DEL', KEYS[2]) else redis.call('SET', KEYS[2], ARGV[6]) end
return taken`;

/**
 * Deletes a product's landings, sets its slot to nothing and marks them gone (KEYS[3], for ARGV[4] seconds) in one
 * step, whatever was kept: the mark is what refuses a save that read the record before (WRITE_LANDINGS' {4, 0}).
 * Answers the data room's own answer, {1, total} when done. Modelled by lib/redis-memory.ts.
 */
export const DROP_LANDINGS = `-- marktmorgen:landings-drop:v2
${LANDINGS_ROOM}
local taken = landingsRoom(ARGV[1], '1', ARGV[2], ARGV[3], '0')
if taken[1] ~= 1 then return taken end
redis.call('DEL', KEYS[2])
redis.call('SET', KEYS[3], '1', 'EX', ARGV[4])
return taken`;

/** How many times a change is tried again when another change landed between its read and its write. */
const WRITE_TRIES = 3;

/**
 * WRITE_LANDINGS' answer, read exactly: a pipeline of that one script answering {state, total}, the state the number
 * 0 (full), 1 (written), 3 (changed since it was read) or 4 (dropped with the page), the total a whole number of
 * bytes, 0 or more. Anything else (a true for 1, a total missing, negative, fractional or past what a number holds
 * exactly, an extra item) is no receipt: null, and the save is LandingsWriteUnconfirmed (Codex J, #1950).
 */
function landingsReceipt(reply: unknown): { state: 0 | 1 | 3 | 4; total: number } | null {
  if (!Array.isArray(reply) || reply.length !== 1) return null;
  const answer = reply[0];
  if (!Array.isArray(answer) || answer.length !== 2) return null;
  const [state, total] = answer;
  if (state !== 0 && state !== 1 && state !== 3 && state !== 4) return null;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) return null;
  return { state, total };
}

/**
 * Reads the record, works out the new list, and writes it only over what was read, its room set in the same step
 * (WRITE_LANDINGS); read again and tried again when another change came in between. The answer is checked exactly:
 * written, full (DataRoomError, nothing written), changed, or dropped with the page (LandingsGone, nothing written,
 * however many reads ago the save began); anything else is LandingsWriteUnconfirmed, and no room is given back for it.
 */
/** A landing id that is not one (see LANDING_ID): nothing is ever written under it, so nothing can be kept to delete. */
export class LandingIdInvalid extends Error {
  constructor() {
    super("That is not a product's or a page's id, so no landing is kept under it.");
    this.name = "LandingIdInvalid";
  }
}

async function changeLandings(statsId: string, productId: string, room: DataStore, change: (landings: CampaignLanding[]) => CampaignLanding[] | "full" | "same"): Promise<"saved" | "full" | "same"> {
  // The one gate for writes (Revisor 2, #1947): an id the deletions would not touch is never written either, so a
  // read or a deletion of one answers truthfully that nothing is kept under it.
  if (!LANDING_ID.test(productId)) throw new LandingIdInvalid();
  const key = dataKey(room);
  if (!key || !isRedisConfigured()) throw new LandingsUnreadable();
  for (let tries = 0; tries < WRITE_TRIES; tries += 1) {
    const { raw, landings } = await readRecord(statsId, productId);
    const next = change(landings);
    if (next === "full" || next === "same") return next;
    const json = next.length ? JSON.stringify(next) : "";
    const now = Date.now();
    const reply: unknown = await redisPipeline([["EVAL", WRITE_LANDINGS, 3, key, landingKey(statsId, productId), goneKey(statsId, productId), contentRoomFor(room, now / 1000), monthOf(now), LANDING_SLOT(productId), json ? dataBytes([json], 1) : 0, raw ?? "", json]]);
    const receipt = landingsReceipt(reply);
    if (!receipt) throw new LandingsWriteUnconfirmed();
    const { state, total } = receipt;
    if (state === 4) throw new LandingsGone();
    if (state === 3) continue;
    if (state === 1) return "saved";
    const limit = dataRoomFor(room, now / 1000);
    throw new DataRoomError({ ok: false, reason: "full", used: total, room: limit, message: dataFullWords(total, limit, largerPlanFor(room, now / 1000)) });
  }
  throw new LandingsWriteUnconfirmed();
}

/** Keeps a campaign's landing, in place of the one it had. "full" when MAX_LANDINGS other campaigns have one. */
export async function saveLanding(statsId: string, productId: string, landing: CampaignLanding, room: DataStore): Promise<"saved" | "full"> {
  const done = await changeLandings(statsId, productId, room, (landings) => withLanding(landings, landing) ?? "full");
  return done === "full" ? "full" : "saved";
}

/** Forgets a campaign's landing; forgetting one that is gone is not an error. */
export async function removeLanding(statsId: string, productId: string, campaign: string, room: DataStore): Promise<void> {
  await changeLandings(statsId, productId, room, (landings) => {
    const next = landings.filter((one) => one.campaign !== campaign);
    return next.length === landings.length ? "same" : next;
  });
}

/** DROP_LANDINGS' answer, read exactly: a pipeline of that one script answering {1, total}, the total a whole number of bytes. */
function dropped(reply: unknown): boolean {
  if (!Array.isArray(reply) || reply.length !== 1) return false;
  const answer = reply[0];
  if (!Array.isArray(answer) || answer.length !== 2) return false;
  const [state, total] = answer;
  return state === 1 && typeof total === "number" && Number.isSafeInteger(total) && total >= 0;
}

/**
 * Forgets every landing of a product that is gone, gives back its room and closes them to saves, in one step. The
 * step is the same whatever was kept, so it is tried again when its answer is not the exact one; when no try is
 * confirmed it throws LandingsDropUnconfirmed: the landings may still be there and their room stays counted, never
 * said to be gone (Codex G2, #1947).
 */
/**
 * Finishes the deletion of a removed product's landings that could not be
 * confirmed when it was removed (Codex G, #1947): "dropped" once they are
 * confirmed gone, "none" when Redis confirms there are none; anything else
 * throws LandingsDropUnconfirmed. Used when the same removal is asked again
 * for a product that is no longer in the catalog.
 */
export async function finishLandingsDrop(statsId: string | null, productId: string, room: DataStore): Promise<"dropped" | "none"> {
  if (!statsId || !isRedisConfigured() || !LANDING_ID.test(productId)) return "none";
  const reply: unknown = await redisPipeline([["EXISTS", landingKey(statsId, productId)]]).catch(() => null);
  const held = Array.isArray(reply) && reply.length === 1 && (reply[0] === 0 || reply[0] === 1) ? reply[0] : null;
  if (held === null) throw new LandingsDropUnconfirmed();
  if (held === 0) return "none";
  await dropLandings(statsId, productId, room);
  return "dropped";
}

export async function dropLandings(statsId: string | null, productId: string, room: DataStore): Promise<void> {
  const key = dataKey(room);
  if (!statsId || !key || !isRedisConfigured() || !LANDING_ID.test(productId)) return;
  for (let tries = 0; tries < WRITE_TRIES; tries += 1) {
    const now = Date.now();
    const reply: unknown = await redisPipeline([["EVAL", DROP_LANDINGS, 3, key, landingKey(statsId, productId), goneKey(statsId, productId), contentRoomFor(room, now / 1000), monthOf(now), LANDING_SLOT(productId), LANDINGS_GONE_SECONDS]]).catch(() => null);
    if (dropped(reply)) return;
  }
  throw new LandingsDropUnconfirmed();
}
