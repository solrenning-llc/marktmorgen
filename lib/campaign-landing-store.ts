/**
 * Where a product's campaign landing pages are kept: 632 [AA2] (m), unit 2.
 * lib/campaign-landing.ts says what one is (the ad's checked words over the
 * product's own sales page); the page is never stored twice, only the words.
 *
 *   nl:product:landing:<statsId>:<productId> -> the product's landings, as JSON:
 *                                               a list of CampaignLanding, at most
 *                                               MAX_LANDINGS, one per campaign
 *
 * The record takes room in the store's data room (lib/store-data.ts) before it
 * is written, one slot per product, so a save that does not fit is refused and
 * the landings stay as they were. It goes with the product's page
 * (dropPage, lib/sales-page-store.ts) and with the store.
 *
 * Whatever is read back is checked again (parseLandings): a tag or words that
 * no longer fit their place are left out, never cut.
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

/** A write whose answer was not the one expected: it may or may not have landed, and no room is given back for it. */
export class LandingsWriteUnconfirmed extends Error {
  constructor() {
    super("We could not confirm the landing pages were saved. Reload the page to see what they are now.");
  }
}

/**
 * The record exactly as kept: its text, or null when the product has none.
 * Only Redis's exact answer counts (one GET: a text or null), and a text
 * must be valid JSON; anything else throws LandingsUnreadable, never "none"
 * (Codex G and J: an empty or broken read let the next save erase the others).
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
  return { raw, landings: parseLandings(parsed) };
}

/** A product's landings, or none when it has none (or they cannot be read). */
export async function readLandings(statsId: string | null, productId: string): Promise<CampaignLanding[]> {
  if (!statsId || !isRedisConfigured()) return [];
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
 * and sets its slot to their size in the same step: answers {3, 0} when the record changed since it was read, the
 * data room's own answer otherwise ({1, total} written, {0, total} full and nothing written). Modelled by
 * lib/redis-memory.ts.
 */
export const WRITE_LANDINGS = `-- marktmorgen:landings-write:v1
${LANDINGS_ROOM}
local held = redis.call('GET', KEYS[2])
if (held or '') ~= ARGV[5] then return {3, 0} end
local size = ARGV[6] == '' and '0' or ARGV[4]
local taken = landingsRoom(ARGV[1], ARGV[6] == '' and '1' or '0', ARGV[2], ARGV[3], size)
if taken[1] ~= 1 then return taken end
if ARGV[6] == '' then redis.call('DEL', KEYS[2]) else redis.call('SET', KEYS[2], ARGV[6]) end
return taken`;

/** Deletes a product's landings and sets its slot to nothing in one step, whatever was kept. Modelled by lib/redis-memory.ts. */
export const DROP_LANDINGS = `-- marktmorgen:landings-drop:v1
${LANDINGS_ROOM}
redis.call('DEL', KEYS[2])
return landingsRoom(ARGV[1], '1', ARGV[2], ARGV[3], '0')`;

/** How many times a change is tried again when another change landed between its read and its write. */
const WRITE_TRIES = 3;

/**
 * Reads the record, works out the new list, and writes it only over what was read, its room set in the same step
 * (WRITE_LANDINGS); read again and tried again when another change came in between. The answer is checked exactly:
 * written, full (DataRoomError, nothing written) or changed; anything else is LandingsWriteUnconfirmed, and no room is
 * given back for it.
 */
async function changeLandings(statsId: string, productId: string, room: DataStore, change: (landings: CampaignLanding[]) => CampaignLanding[] | "full" | "same"): Promise<"saved" | "full" | "same"> {
  const key = dataKey(room);
  if (!key || !isRedisConfigured()) throw new LandingsUnreadable();
  for (let tries = 0; tries < WRITE_TRIES; tries += 1) {
    const { raw, landings } = await readRecord(statsId, productId);
    const next = change(landings);
    if (next === "full" || next === "same") return next;
    const json = next.length ? JSON.stringify(next) : "";
    const now = Date.now();
    const reply: unknown = await redisPipeline([["EVAL", WRITE_LANDINGS, 2, key, landingKey(statsId, productId), contentRoomFor(room, now / 1000), monthOf(now), LANDING_SLOT(productId), json ? dataBytes([json], 1) : 0, raw ?? "", json]]);
    const answer = Array.isArray(reply) && reply.length === 1 ? reply[0] : undefined;
    const [state, total] = Array.isArray(answer) && answer.length === 2 ? answer.map(Number) : [NaN, NaN];
    if (state === 3) continue;
    if (state === 1 && Number.isFinite(total)) return "saved";
    if (state === 0 && Number.isFinite(total)) {
      const limit = dataRoomFor(room, now / 1000);
      throw new DataRoomError({ ok: false, reason: "full", used: total, room: limit, message: dataFullWords(total, limit, largerPlanFor(room, now / 1000)) });
    }
    throw new LandingsWriteUnconfirmed();
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

/** Forgets every landing of a product that is gone, and gives back its room. */
export async function dropLandings(statsId: string | null, productId: string, room: DataStore): Promise<void> {
  const key = dataKey(room);
  if (!statsId || !key || !isRedisConfigured()) return;
  const now = Date.now();
  await redisPipeline([["EVAL", DROP_LANDINGS, 2, key, landingKey(statsId, productId), contentRoomFor(room, now / 1000), monthOf(now), LANDING_SLOT(productId)]]);
}
