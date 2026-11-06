// Proof (read-only hunt, rule 24): tellStaysOpen reads HSCAN as "nobody on the told list" when the reply has an unknown shape,
// and answers true ("all of it went"), so releaseRestarted (lib/closing-holds.ts:435-441) runs forgetHeld and the
// buyers told the store closes are never told it stays open.
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { tellStaysOpen, toldKey } from "@/lib/closing-buyers";
import { storeFolder, storeRef, type Store } from "@/lib/store";
async function main() {
  process.env.COMPANY_POSTAL_ADDRESS = ""; // no address: a readable list can never answer "all went"
  const shop = { email: "hunt@example.com", sid: "", extra: false, handle: "hunt", name: "Hunt Shop", contact: { on: false } } as unknown as Store;
  const folder = await storeFolder(storeRef(shop));
  const seed = async () => { redis.clear(); await redis.pipeline([["HSET", toldKey(folder), "ana@buyers.example.com", "1730000000000"]]); };
  part("control: the told list read in its exact shape");
  await seed();
  is("control: with Ana on the list and no postal address, not done", await tellStaysOpen(shop, Date.now() + 60_000), false);
  let proven = 0;
  const shapes: unknown[] = [null, 42, "0", {}, ["0"], ["0", "x"], ["0", {}], [1, null]];
  for (const odd of shapes) {
    await seed();
    const real = redis.pipeline.bind(redis);
    (redis as unknown as { pipeline: typeof real }).pipeline = async (cmds) => (cmds[0][0] === "HSCAN" ? ([odd] as never) : real(cmds));
    let out: unknown;
    try { out = await tellStaysOpen(shop, Date.now() + 60_000); } catch (e) { out = "threw " + String(e).slice(0, 50); }
    (redis as unknown as { pipeline: typeof real }).pipeline = real;
    const left = (await real([["HGET", toldKey(folder), "ana@buyers.example.com"]]))[0];
    if (out === true && left !== null) proven += 1;
    is(`DEFECT HSCAN ${JSON.stringify(odd)}: answers true (released) while Ana is still on the told list, untold`, [out, left], [true, "1730000000000"]);
  }
  console.log(`proven shapes: ${proven}/${shapes.length}`);
  done();
}
main();
