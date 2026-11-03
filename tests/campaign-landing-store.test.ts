/**
 * 632 [AA2] (m), unit 2: where a product's campaign landing pages are kept
 * (lib/campaign-landing-store.ts). One per campaign, at most ten a product,
 * room taken before writing, whatever is read back checked again, and gone
 * with the product's page.
 */
import { CAMPAIGN_TAG, type CampaignLanding } from "@/lib/campaign-landing";
import { MAX_LANDINGS, dropLandings, landingFor, parseLandings, readLandings, removeLanding, saveLanding, withLanding } from "@/lib/campaign-landing-store";
import { MAX_HEADLINE } from "@/lib/sales-page";
import { dropPage } from "@/lib/sales-page-store";
import { DataRoomError, dataUsed, needData } from "@/lib/store-data";
import type { DataStore } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const STATS = "l".repeat(16);
const landing = (campaign: string, headline = "Cook a real dinner in twenty minutes"): CampaignLanding => ({ campaign, headline, sub: "A short course on knife skills.", button: "" });
const key = (product: string) => `nl:product:landing:${STATS}:${product}`;
const has = (name: string) => redis.keys().includes(name);

async function main(): Promise<void> {
  redis.clear();

  part("One landing per campaign");
  is("a product with none", await readLandings(STATS, "p1"), []);
  is("saved", await saveLanding(STATS, "p1", landing("spring-sale"), ROOM), "saved");
  is("read back whole", await landingFor(STATS, "p1", "spring-sale"), landing("spring-sale"));
  is("saving the same campaign again replaces it", [await saveLanding(STATS, "p1", landing("spring-sale", "Dinner, sharper"), ROOM), (await readLandings(STATS, "p1")).map((one) => one.headline)], ["saved", ["Dinner, sharper"]]);
  is("another campaign beside it", [await saveLanding(STATS, "p1", landing("fall.retarget"), ROOM), (await readLandings(STATS, "p1")).map((one) => one.campaign)], ["saved", ["spring-sale", "fall.retarget"]]);
  is("a campaign with no landing", await landingFor(STATS, "p1", "winter"), null);
  is("a tag that is not one is never looked up", await landingFor(STATS, "p1", "Spring Sale"), null);
  is("another product's landings are its own", await readLandings(STATS, "p2"), []);
  is("no store: nothing", await readLandings(null, "p1"), []);

  part(`At most ${MAX_LANDINGS} a product`);
  let list: CampaignLanding[] = [];
  for (let n = 1; n <= MAX_LANDINGS; n += 1) list = withLanding(list, landing(`c${n}`)) ?? list;
  is("ten kept", list.length, MAX_LANDINGS);
  is("an eleventh campaign is refused", withLanding(list, landing("c11")), null);
  is("one already there can still change", withLanding(list, landing("c3", "Changed"))?.[2].headline, "Changed");
  for (let n = 1; n <= MAX_LANDINGS; n += 1) await saveLanding(STATS, "p3", landing(`c${n}`), ROOM);
  is("the store says full, and keeps the ten", [await saveLanding(STATS, "p3", landing("c11"), ROOM), (await readLandings(STATS, "p3")).length], ["full", MAX_LANDINGS]);

  part("Room in the store's data room, taken first");
  const tiny: DataStore = { ...ROOM, sid: "landing-tiny", tier: undefined, subscriptionActive: false, subscriptionId: "", trialEnds: 0, planEndedAt: "" };
  const before = (await dataUsed(ROOM))?.used ?? 0;
  is("what is kept is counted", before > 0, true);
  // Fill the small room so the next save cannot fit.
  await needData(tiny, [{ slot: "fill", bytes: 5_000_000 - 64, set: true }]);
  let thrown: unknown = null;
  try {
    await saveLanding(STATS, "full", landing("launch"), tiny);
  } catch (error) {
    thrown = error;
  }
  is("a save that does not fit is refused as a full store", thrown instanceof DataRoomError, true);
  is("and nothing is kept", has(key("full")), false);

  part("Taken off");
  await removeLanding(STATS, "p1", "spring-sale", ROOM);
  is("one campaign's landing removed", (await readLandings(STATS, "p1")).map((one) => one.campaign), ["fall.retarget"]);
  await removeLanding(STATS, "p1", "spring-sale", ROOM);
  is("removing one that is gone is fine", (await readLandings(STATS, "p1")).length, 1);
  await removeLanding(STATS, "p1", "fall.retarget", ROOM);
  is("the last one removed takes the record with it", has(key("p1")), false);

  part("Gone with the product's page");
  await saveLanding(STATS, "p4", landing("launch"), ROOM);
  const held = (await dataUsed(ROOM))?.used ?? 0;
  await dropPage(STATS, "p4", ROOM);
  is("the record is deleted", has(key("p4")), false);
  is("and its room given back", ((await dataUsed(ROOM))?.used ?? 0) < held, true);
  await saveLanding(STATS, "p5", landing("launch"), ROOM);
  await dropLandings(STATS, "p5", ROOM);
  is("dropLandings alone does the same", has(key("p5")), false);

  part("As kept: whatever is stored is checked again");
  is("broken entries, repeated campaigns and words too long dropped", parseLandings([
    landing("one"),
    landing("one", "Repeated"),
    { campaign: "Bad Tag", headline: "x", sub: "", button: "" },
    { campaign: "two", headline: "", sub: "", button: "" },
    { campaign: "three", headline: "h".repeat(MAX_HEADLINE + 1), sub: "", button: "" },
    { campaign: "four", headline: "Fine", sub: 4, button: "" },
    null,
    "text",
  ]), [landing("one")]);
  is("a missing button keeps the page's own", parseLandings([{ campaign: "five", headline: "Fine", sub: "" }]), [{ campaign: "five", headline: "Fine", sub: "", button: "" }]);
  is("not a list", parseLandings({}), []);
  await redis.pipeline([["SET", key("p6"), "{not json"]]);
  is("a record that cannot be read is none", await readLandings(STATS, "p6"), []);
  is("every kept tag is one the numbers count", (await readLandings(STATS, "p3")).every((one) => CAMPAIGN_TAG.test(one.campaign)), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
