/**
 * One gate for a landing record's id (Revisor 2 on #1947, cycle 120): a write
 * refuses an id the deletions would not touch, so nothing is ever kept under
 * one, and a read or a deletion of it answers that nothing is there, without
 * naming another key of the family (such as a removed product's fence).
 */
import { LandingIdInvalid, dropLandings, finishLandingsDrop, readLandings, saveLanding } from "@/lib/campaign-landing-store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is } from "./check";

const STATS = "s".repeat(12);
const landing = { campaign: "spring-sale", headline: "Fresh bread", sub: "Baked this morning", button: "Read more" };

async function main(): Promise<void> {
  redis.clear();
  for (const bad of ["p1:gone", "p1:x", "P1", "p 1", "x".repeat(49)]) {
    const refused = await saveLanding(STATS, bad, landing, ROOM).then(() => null, (error: unknown) => error);
    is(`${JSON.stringify(bad)}: a save is refused as no id`, refused instanceof LandingIdInvalid, true);
    is(`${JSON.stringify(bad)}: nothing is read or finished under it`, [await readLandings(STATS, bad), await finishLandingsDrop(STATS, bad, ROOM)], [[], "none"]);
  }
  // A real record and its fence: a deletion asked under the fence's name touches neither.
  is("a product's landing is saved", await saveLanding(STATS, "p1", landing, ROOM), "saved");
  await dropLandings(STATS, "p1", ROOM);
  const fence = `nl:product:landing:${STATS}:p1:gone`;
  is("its drop leaves the deletion fence", Number((await redis.pipeline([["EXISTS", fence]]))[0]), 1);
  await dropLandings(STATS, "p1:gone", ROOM);
  is("a drop named after the fence never deletes it", Number((await redis.pipeline([["EXISTS", fence]]))[0]), 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
