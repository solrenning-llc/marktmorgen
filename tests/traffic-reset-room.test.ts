/**
 * Claude 1's MEDIUM on #3380: admission and the plan's limit read a store's
 * visits as people + floor(parts / PARTS_PER_VISIT) (lib/traffic.ts,
 * trafficForAdmission), so a reset that reads and lowers only the people
 * counter can answer "lowered to 1,200" while the store still rests. The
 * reset reads and reports the admission total, lowers the people counter by
 * what is over the figure asked for, and refuses with "room" when the live
 * room alone is above it (the room is never touched). Synthetic store and
 * the in-memory Redis.
 */
import { readTrafficLog, resetVisits } from "@/lib/traffic-reset";
import { trafficForAdmission } from "@/lib/traffic";
import { allowanceWindow } from "@/lib/allowance-window";
import { storeFolder, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const shop = { sid: "s1shop0002", handle: "shoproom", email: "room@example.com" } as unknown as Store;

async function main(): Promise<void> {
  const window = allowanceWindow(shop, NOW);
  const folder = await storeFolder(storeRef(shop));
  const people = `nl:traffic:n:${folder}:${window?.id}`;
  const parts = `nl:traffic:x:${folder}:${window?.id}`;
  const admitted = async () => (await trafficForAdmission(folder, window?.id))?.visits;

  part("The figure asked for is the figure admission reads");
  redis.clear();
  redis.run(["SET", people, "3400", "EX", 1000]);
  redis.run(["SET", parts, "50000", "EX", 1000]);
  is("before: 3,400 people and 500 visits of the live room are 3,900 visits", await admitted(), 3900);
  is("the reset reports the admission total before and after", await resetVisits({ store: shop, to: 1200, now: NOW }), { ok: true, window: window?.id, before: 3900, after: 1200 });
  is("admission then reads the figure asked for", await admitted(), 1200);
  is("only the people counter was lowered, by what was over the figure", [redis.run(["GET", people]), redis.run(["GET", parts])], ["700", "50000"]);
  is("the record says the admission total", [(await readTrafficLog())?.[0]?.before, (await readTrafficLog())?.[0]?.after], [3900, 1200]);

  part("The live room alone above the figure: refused, nothing changes (Claude 1's scenario)");
  redis.clear();
  redis.run(["SET", people, "3400", "EX", 1000]);
  redis.run(["SET", parts, "250000", "EX", 1000]);
  is("refused with the room's reason and the admission total", await resetVisits({ store: shop, to: 1200, now: NOW }), { ok: false, reason: "room", before: 5900 });
  is("nothing changed and nothing was recorded", [redis.run(["GET", people]), redis.run(["GET", parts]), redis.run(["LLEN", "nl:operator:traffic-log"])], ["3400", "250000", 0]);
  is("the room's own figure is reachable: 2,500 is taken", await resetVisits({ store: shop, to: 2500, now: NOW }), { ok: true, window: window?.id, before: 5900, after: 2500 });
  is("admission reads 2,500", await admitted(), 2500);

  part("The live room in another shape: unknown, nothing written");
  redis.clear();
  redis.run(["SET", people, "3400", "EX", 1000]);
  redis.run(["SET", parts, "not a number", "EX", 1000]);
  is("unknown", await resetVisits({ store: shop, to: 0, now: NOW }), { ok: false, reason: "unknown" });
  is("people untouched, no record", [redis.run(["GET", people]), redis.run(["LLEN", "nl:operator:traffic-log"])], ["3400", 0]);

  done();
}

void main();
