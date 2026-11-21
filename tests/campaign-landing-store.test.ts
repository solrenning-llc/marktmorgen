/**
 * 632 [AA2] (m), unit 2: where a product's campaign landing pages are kept
 * (lib/campaign-landing-store.ts). One per campaign, at most ten a product,
 * room taken before writing, whatever is read back checked again, and gone
 * with the product's page.
 */
import { CAMPAIGN_TAG, type CampaignLanding } from "@/lib/campaign-landing";
import { LANDINGS_GONE_SECONDS, LandingsDropUnconfirmed, LandingsGone, LandingsUnreadable, MAX_LANDINGS, dropLandings, landingFor, parseLandings, readLandings, removeLanding, saveLanding, withLanding } from "@/lib/campaign-landing-store";
import { MAX_HEADLINE } from "@/lib/sales-page";
import { PageDropIncomplete, dropPage, picturesOfFailedDrop } from "@/lib/sales-page-store";
import { DataRoomError, dataKey, dataUsed, needData } from "@/lib/store-data";
import type { DataStore } from "@/lib/store-data";
import { advance, store as redis } from "./redis-stub";
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

  part("A save rewrites only a record it reads whole (Codex G2, #1947)");
  const caught = async (run: () => Promise<unknown>) => run().then((value) => value, (error: unknown) => error);
  for (const [what, entries] of [
    ["a campaign twice", [landing("one"), landing("one", "Repeated")]],
    ["an entry it cannot read", [landing("one"), { campaign: "two", headline: "", sub: "", button: "" }]],
    [`more than ${MAX_LANDINGS}`, Array.from({ length: MAX_LANDINGS + 1 }, (_, n) => landing(`k${n}`))],
  ] as const) {
    const raw = JSON.stringify(entries);
    await redis.pipeline([["SET", key("p7"), raw]]);
    const outcome = await caught(() => saveLanding(STATS, "p7", landing("new-one"), ROOM));
    is(`${what}: the save is refused`, outcome instanceof LandingsUnreadable, true);
    is(`${what}: and the record is as it was`, redis.run(["GET", key("p7")]), raw);
    is(`${what}: removing one is refused too`, (await caught(() => removeLanding(STATS, "p7", "one", ROOM))) instanceof LandingsUnreadable, true);
  }
  is("the page still shows what it can read", (await readLandings(STATS, "p7")).length, MAX_LANDINGS);

  part("Dropped with the page: closed to saves, in the same step (Codex G2, #1947)");
  await saveLanding(STATS, "p8", landing("launch"), ROOM);
  await dropLandings(STATS, "p8", ROOM);
  is("a save after the drop is refused", (await caught(() => saveLanding(STATS, "p8", landing("late"), ROOM))) instanceof LandingsGone, true);
  is("and writes nothing", [has(key("p8")), redis.run(["HGET", dataKey(ROOM)!, "al:p8"])], [false, null]);
  is("the mark lasts LANDINGS_GONE_SECONDS", redis.run(["TTL", `${key("p8")}:gone`]), LANDINGS_GONE_SECONDS);
  advance(LANDINGS_GONE_SECONDS * 1000 + 1);
  is("and then lapses", redis.run(["EXISTS", `${key("p8")}:gone`]), 0);

  part("A drop is done only on its exact answer (Codex G2, #1947)");
  await saveLanding(STATS, "p9", landing("launch"), ROOM);
  const slotBefore = redis.run(["HGET", dataKey(ROOM)!, "al:p9"]);
  const base = redis.pipeline.bind(redis);
  for (const reply of [[], [[1]], [[1, -1]], [[true, 0]], [[1, 0], [1, 0]], [[2, 0]]] as unknown[][]) {
    let tries = 0;
    redis.pipeline = async (batch) => (batch.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:landings-drop")) ? (tries += 1, reply) : base(batch));
    try {
      is(`answered ${JSON.stringify(reply)}: not done`, (await caught(() => dropLandings(STATS, "p9", ROOM))) instanceof LandingsDropUnconfirmed, true);
      is(`answered ${JSON.stringify(reply)}: tried three times`, tries, 3);
    } finally {
      redis.pipeline = base;
    }
  }
  is("the landings and their room are kept", [has(key("p9")), redis.run(["HGET", dataKey(ROOM)!, "al:p9"])], [true, slotBefore]);
  redis.pipeline = async (batch) => (batch.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:landings-drop")) ? [] : base(batch));
  let incomplete: unknown;
  try {
    incomplete = await caught(() => dropPage(STATS, "p9", ROOM));
  } finally {
    redis.pipeline = base;
  }
  is("dropPage says so: PageDropIncomplete", incomplete instanceof PageDropIncomplete, true);
  is("with the pictures it released, which the routes still delete", picturesOfFailedDrop(incomplete), []);
  is("another failure hands back none", picturesOfFailedDrop(new Error("down")), []);
  await dropLandings(STATS, "p9", ROOM);
  is("a confirmed drop then takes them, and gives back their room", [has(key("p9")), redis.run(["HGET", dataKey(ROOM)!, "al:p9"])], [false, null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
