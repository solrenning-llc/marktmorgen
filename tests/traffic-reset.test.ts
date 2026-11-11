/**
 * TODOS-51 D, the reset: the person who runs the site can lower a store's
 * count of visits in its current window, never raise it and never touch its
 * requests, and every reset leaves a record of when, which store, which window,
 * the count before and the count asked for (lib/traffic-reset.ts). Synthetic
 * stores and the in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { TRAFFIC_LOG_DAYS, TRAFFIC_LOG_KEEP, readTrafficLog, resetVisits } from "@/lib/traffic-reset";
import { trafficForAdmission } from "@/lib/traffic";
import { allowanceWindow } from "@/lib/allowance-window";
import { storeFolder, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const shop = { sid: "s1shop0001", handle: "shop", email: "creator@example.com" } as unknown as Store;

async function main(): Promise<void> {
  const window = allowanceWindow(shop, NOW);
  is("the synthetic store has a window", Boolean(window), true);
  const folder = await storeFolder(storeRef(shop));
  const visits = `nl:traffic:n:${folder}:${window?.id}`;
  const requests = `nl:traffic:r:${folder}:${window?.id}`;
  const parts = `nl:traffic:x:${folder}:${window?.id}`;

  part("Lowered, never raised; requests and the live room untouched");
  redis.clear();
  redis.run(["SET", visits, "3400", "EX", 1000]);
  redis.run(["SET", requests, "90000", "EX", 1000]);
  redis.run(["SET", parts, "500", "EX", 1000]);
  const lowered = await resetVisits({ store: shop, to: 1200, now: NOW });
  // The visits are what admission reads: the people plus the live room's hundredths (3,400 + 5).
  is("a lower figure is taken, before and after as admission reads them", lowered, { ok: true, window: window?.id, before: 3405, after: 1200 });
  is("the visits are the figure asked for", (await trafficForAdmission(folder, window?.id))?.visits, 1200);
  is("only the people were lowered", redis.run(["GET", visits]), "1195");
  is("the visits keep their time to live", Number(redis.run(["TTL", visits])) > 0, true);
  is("the requests are not touched", redis.run(["GET", requests]), "90000");
  is("the live room is not touched", redis.run(["GET", parts]), "500");
  is("a higher figure is refused, and nothing changes", [await resetVisits({ store: shop, to: 1201, now: NOW }), redis.run(["GET", visits])], [{ ok: false, reason: "above", before: 1200 }, "1195"]);
  is("the same figure changes nothing", [await resetVisits({ store: shop, to: 1200, now: NOW }), redis.run(["GET", visits])], [{ ok: false, reason: "same", before: 1200 }, "1195"]);
  is("a figure that is not a whole number from zero up is refused", await Promise.all([-1, 1.5, Number.NaN, 2 ** 60].map((to) => resetVisits({ store: shop, to, now: NOW }))), Array(4).fill({ ok: false, reason: "invalid" }));
  is("a store with no visits yet has nothing to lower", [await resetVisits({ store: { ...shop, sid: "s1empty001", handle: "empty", email: "empty@example.com" } as Store, to: 0, now: NOW })], [{ ok: false, reason: "same", before: 0 }]);

  part("Every reset is written down first, the newest first, at most TRAFFIC_LOG_KEEP");
  const log = await readTrafficLog();
  is("one record, for the one change made", log?.length, 1);
  // Claude 1's LOW on #3380: the record names stores (a handle is often a person's name), so it does not outlive
  // TRAFFIC_LOG_DAYS from its last reset.
  const ttl = Number(redis.run(["TTL", "nl:operator:traffic-log"]));
  is("the record expires TRAFFIC_LOG_DAYS after its last reset", ttl > 0 && ttl <= TRAFFIC_LOG_DAYS * 86_400, true);
  is("when, which store, which window, before and after; no address", log?.[0], { at: NOW, sid: "s1shop0001", handle: "shop", window: window?.id, before: 3405, after: 1200 });
  redis.run(["DEL", parts]); // people only here, so every figure down to 0 can be reached
  redis.run(["SET", visits, String(TRAFFIC_LOG_KEEP + 10), "EX", 1000]);
  for (let i = TRAFFIC_LOG_KEEP + 9; i >= 0; i -= 1) await resetVisits({ store: shop, to: i, now: NOW + i });
  const kept = await readTrafficLog();
  is("kept to TRAFFIC_LOG_KEEP, the newest first", [kept?.length, kept?.[0]?.after], [TRAFFIC_LOG_KEEP, 0]);

  part("The figure is the visits admission reads, live room included (Claude 1's MEDIUM on #3380)");
  redis.clear();
  redis.run(["SET", visits, "3400", "EX", 1000]);
  redis.run(["SET", parts, "250000", "EX", 1000]);
  is("3,400 people and 2,500 visits from the live room: 5,900 visits", (await trafficForAdmission(folder, window?.id))?.visits, 5900);
  is("lowered to 4,000: said as admission reads it", await resetVisits({ store: shop, to: 4000, now: NOW }), { ok: true, window: window?.id, before: 5900, after: 4000 });
  is("admission now reads 4,000", (await trafficForAdmission(folder, window?.id))?.visits, 4000);
  is("the people lowered by the difference, the live room untouched", [redis.run(["GET", visits]), redis.run(["GET", parts])], ["1500", "250000"]);
  is("the record says the same figures", (await readTrafficLog())?.[0], { at: NOW, sid: "s1shop0001", handle: "shop", window: window?.id, before: 5900, after: 4000 });
  // Below what the live room alone holds: the room is never given back here, so the figure cannot be reached.
  is("a figure below the live room's own visits is refused, never said done", [await resetVisits({ store: shop, to: 1200, now: NOW }), redis.run(["GET", visits]), redis.run(["GET", parts])], [{ ok: false, reason: "room", before: 4000 }, "1500", "250000"]);
  is("nothing recorded for the refusal", (await readTrafficLog())?.length, 1);
  redis.run(["SET", parts, "not a number", "EX", 1000]);
  is("a live room in another shape: unknown, nothing written", [await resetVisits({ store: shop, to: 1600, now: NOW }), redis.run(["GET", visits]), (await readTrafficLog())?.length], [{ ok: false, reason: "unknown" }, "1500", 1]);

  part("A reply that does not read is unknown, never a reset");
  redis.clear();
  redis.run(["SET", visits, "not a number", "EX", 1000]);
  is("a count in another shape: unknown, nothing written", [await resetVisits({ store: shop, to: 0, now: NOW }), redis.run(["GET", visits]), redis.run(["LLEN", "nl:operator:traffic-log"])], [{ ok: false, reason: "unknown" }, "not a number", 0]);
  redis.run(["SET", visits, "50", "EX", 1000]);
  const base = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await base(commands);
    return commands.some((command) => command[0] === "DECRBY" || (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:traffic-reset:v"))) ? answer.map(() => "garbled") : answer;
  }) as typeof redis.pipeline;
  is("a change whose answer is lost: unknown, never said done", await resetVisits({ store: shop, to: 10, now: NOW }), { ok: false, reason: "unknown" });
  redis.pipeline = base;
  is("its record went first, so the change is never unrecorded", (await readTrafficLog())?.[0]?.before, 50);
  redis.run(["SET", "nl:operator:traffic-reset:lock", "1", "EX", 30]);
  is("a reset already running: busy, nothing written", [await resetVisits({ store: shop, to: 0, now: NOW }), redis.run(["GET", visits])], [{ ok: false, reason: "busy" }, "10"]);

  part("No change without its record, and none from a reset whose lock was lost (Codex M on #3380)");
  redis.clear();
  redis.run(["SET", visits, "100", "EX", 1000]);
  // The record cannot be written (a key of another type): the visits must stay as they were.
  redis.run(["SET", "nl:operator:traffic-log", "not a list"]);
  const unrecorded = await resetVisits({ store: shop, to: 10, now: NOW }).catch(() => ({ ok: false, reason: "thrown" }));
  is("a record that cannot be written: not done, and the visits not lowered", [unrecorded.ok, redis.run(["GET", visits])], [false, "100"]);
  redis.run(["DEL", "nl:operator:traffic-log"]);
  // A reset that waited past its lock: another reset took the lock and lowered the visits meanwhile.
  const plain = redis.pipeline.bind(redis);
  let overtaken = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const writes = commands.some((command) => command[0] === "EVAL" || command[0] === "DECRBY");
    if (writes && !overtaken) {
      overtaken = true;
      redis.run(["DEL", "nl:operator:traffic-reset:lock"]);
      redis.run(["SET", "nl:operator:traffic-reset:lock", "someone-else", "EX", 30]);
      redis.run(["SET", visits, "20", "EX", 1000]);
    }
    return plain(commands);
  }) as typeof redis.pipeline;
  const stale = await resetVisits({ store: shop, to: 10, now: NOW }).catch(() => ({ ok: false, reason: "thrown" }));
  redis.pipeline = plain;
  is("a reset that lost its lock changes nothing: the visits stay as the later one left them", [stale.ok, redis.run(["GET", visits])], [false, "20"]);
  is("and it never lets go of the lock it no longer holds", redis.run(["GET", "nl:operator:traffic-reset:lock"]), "someone-else");
  redis.run(["DEL", "nl:operator:traffic-reset:lock"]);

  part("Only the operator, answered as if the door did not exist for anybody else");
  const route = readFileSync("app/api/operator/traffic-reset/route.ts", "utf8");
  is("refused from another site and for anybody but the operator, as a 404", /fromAnotherSite\(request\)\) return notFound/.test(route) && /if \(!isOperator\(email\)\) return notFound/.test(route), true);
  is("it lowers visits only: requests are never reset here", /resetVisits\(/.test(route) && !/requestsKey|nl:traffic:r:/.test(route + readFileSync("lib/traffic-reset.ts", "utf8")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
