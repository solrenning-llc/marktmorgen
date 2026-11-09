/**
 * TODOS-51 D, the reset: the person who runs the site can lower a store's
 * count of visits in its current window, never raise it and never touch its
 * requests, and every reset leaves a record of when, which store, which window,
 * the count before and the count asked for (lib/traffic-reset.ts). Synthetic
 * stores and the in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { TRAFFIC_LOG_KEEP, readTrafficLog, resetVisits } from "@/lib/traffic-reset";
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
  is("a lower figure is taken", lowered, { ok: true, window: window?.id, before: 3400, after: 1200 });
  is("the visits are the figure asked for", redis.run(["GET", visits]), "1200");
  is("the visits keep their time to live", Number(redis.run(["TTL", visits])) > 0, true);
  is("the requests are not touched", redis.run(["GET", requests]), "90000");
  is("the live room is not touched", redis.run(["GET", parts]), "500");
  is("a higher figure is refused, and nothing changes", [await resetVisits({ store: shop, to: 1201, now: NOW }), redis.run(["GET", visits])], [{ ok: false, reason: "above", before: 1200 }, "1200"]);
  is("the same figure changes nothing", [await resetVisits({ store: shop, to: 1200, now: NOW }), redis.run(["GET", visits])], [{ ok: false, reason: "same", before: 1200 }, "1200"]);
  is("a figure that is not a whole number from zero up is refused", await Promise.all([-1, 1.5, Number.NaN, 2 ** 60].map((to) => resetVisits({ store: shop, to, now: NOW }))), Array(4).fill({ ok: false, reason: "invalid" }));
  is("a store with no visits yet has nothing to lower", [await resetVisits({ store: { ...shop, sid: "s1empty001", handle: "empty", email: "empty@example.com" } as Store, to: 0, now: NOW })], [{ ok: false, reason: "same", before: 0 }]);

  part("Every reset is written down first, the newest first, at most TRAFFIC_LOG_KEEP");
  const log = await readTrafficLog();
  is("one record, for the one change made", log?.length, 1);
  is("when, which store, which window, before and after; no address", log?.[0], { at: NOW, sid: "s1shop0001", handle: "shop", window: window?.id, before: 3400, after: 1200 });
  redis.run(["SET", visits, String(TRAFFIC_LOG_KEEP + 10), "EX", 1000]);
  for (let i = TRAFFIC_LOG_KEEP + 9; i >= 0; i -= 1) await resetVisits({ store: shop, to: i, now: NOW + i });
  const kept = await readTrafficLog();
  is("kept to TRAFFIC_LOG_KEEP, the newest first", [kept?.length, kept?.[0]?.after], [TRAFFIC_LOG_KEEP, 0]);

  part("A reply that does not read is unknown, never a reset");
  redis.clear();
  redis.run(["SET", visits, "not a number", "EX", 1000]);
  is("a count in another shape: unknown, nothing written", [await resetVisits({ store: shop, to: 0, now: NOW }), redis.run(["GET", visits]), redis.run(["LLEN", "nl:operator:traffic-log"])], [{ ok: false, reason: "unknown" }, "not a number", 0]);
  redis.run(["SET", visits, "50", "EX", 1000]);
  const base = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await base(commands);
    return commands.some((command) => command[0] === "DECRBY") ? answer.map(() => "garbled") : answer;
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
