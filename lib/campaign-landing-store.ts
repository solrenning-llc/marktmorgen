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
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

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

async function writeLandings(statsId: string, productId: string, landings: CampaignLanding[], room: DataStore): Promise<void> {
  const json = JSON.stringify(landings);
  const bytes = landings.length ? dataBytes([json], 1) : 0;
  // Room first: a save that does not fit throws DataRoomError and nothing is written.
  await needData(room, [{ slot: LANDING_SLOT(productId), bytes, set: true }]);
  await redisPipeline([landings.length ? ["SET", landingKey(statsId, productId), json] : ["DEL", landingKey(statsId, productId)]]);
}

/** Keeps a campaign's landing, in place of the one it had. "full" when MAX_LANDINGS other campaigns have one. */
export async function saveLanding(statsId: string, productId: string, landing: CampaignLanding, room: DataStore): Promise<"saved" | "full"> {
  const next = withLanding(await readLandings(statsId, productId), landing);
  if (!next) return "full";
  await writeLandings(statsId, productId, next, room);
  return "saved";
}

/** Forgets a campaign's landing; forgetting one that is gone is not an error. */
export async function removeLanding(statsId: string, productId: string, campaign: string, room: DataStore): Promise<void> {
  const landings = await readLandings(statsId, productId);
  const next = landings.filter((one) => one.campaign !== campaign);
  if (next.length === landings.length) return;
  await writeLandings(statsId, productId, next, room);
}

/** Forgets every landing of a product that is gone, and gives back its room. */
export async function dropLandings(statsId: string | null, productId: string, room: DataStore): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  await redisPipeline([["DEL", landingKey(statsId, productId)]]);
  await giveData(room, [{ slot: LANDING_SLOT(productId), bytes: 0, set: true }]);
}
