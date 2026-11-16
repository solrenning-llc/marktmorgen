/**
 * The store page's reach beacons can never crowd a day's views out of the store's numbers (#4608).
 *
 * app/api/store/read takes a token printed on every store page, needs no account, and let a caller name up to
 * 1,000 reach fields ("sr:<n>.<item>>") on the day's record nl:stats:<statsId>:<day>. That record holds at most
 * DAY_FIELDS_MAX fields (lib/stats.ts); past it every new field is counted under "~". A hundred junk beacons just
 * after midnight filled it, so the day's first view, its sources and countries all went to "~", the studio showed
 * no views, and the day's record never got its end (the first view sets it). Reach fields now stop at
 * REACH_FIELDS_MAX, below the day's most, so the rest stays free for what the day counts. Same one command.
 *
 * Synthetic store; MemoryRedis; the real route and recordHit.
 */
import { readToken, STORE_SCOPE } from "@/lib/page-read";
import { DAY_FIELDS_MAX, recordHit } from "@/lib/stats";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { POST as readRoute } from "@/app/api/store/read/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "reach-room@example.com";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const send = (body: Record<string, unknown>) =>
  readRoute(new Request("https://marktmorgen.com/api/store/read", { method: "POST", headers: { "user-agent": PHONE }, body: JSON.stringify(body) }) as never);

async function main(): Promise<void> {
  part("A hundred and fifty junk reach beacons, then the day's first view");
  redis.clear();
  await claimHandle(OWNER, "reachroom", "Reach Room", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const token = readToken(store.statsId!, STORE_SCOPE);
  for (let n = 0; n < 150; n += 1) await send({ k: "s", t: token, n, b: "p:x", c: "" });
  await recordHit(store, { kind: "view", source: "instagram", ip: "192.0.2.10", userAgent: PHONE });
  const key = `nl:stats:${store.statsId}:${new Date().toISOString().slice(0, 10)}`;
  const [flat, ttl] = await redis.pipeline([["HGETALL", key], ["TTL", key]]);
  const day = new Map<string, string>();
  for (let i = 0; Array.isArray(flat) && i + 1 < flat.length; i += 2) day.set(String(flat[i]), String(flat[i + 1]));
  const reach = [...day.keys()].filter((f) => f.startsWith("sr:")).length;
  is("reach fields stop below the day's most, leaving room for what else the day counts", reach < DAY_FIELDS_MAX - 10, true);
  is("the day's first view is counted as a view, not under '~'", day.get("v"), "1");
  is("and it gives the day's record its end", typeof ttl === "number" && ttl > 0, true);

  part("Control: a real visitor's reach beacon is still counted");
  redis.clear();
  await claimHandle(OWNER, "reachroom", "Reach Room", "");
  await ensureStatsId(OWNER);
  const again = (await storeForEmail(OWNER))!;
  await send({ k: "s", t: readToken(again.statsId!, STORE_SCOPE), n: 2, b: "p:prod000001", c: "" });
  const [one] = await redis.pipeline([["HGET", `nl:stats:${again.statsId}:${new Date().toISOString().slice(0, 10)}`, "sr:2.p:prod000001>"]]);
  is("counted under its own field", one, "1");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
