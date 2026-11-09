/**
 * A8 proof (CX-123 rule 24), lib readers the buyer pages of app/[handle] call
 * directly: each one answers a reply out of shape with the same value it gives
 * for an absent key, so the page cannot tell "nothing there" from "not known"
 * and draws the first. Every check states the honest outcome (the reader
 * throws), so each FAILS on main today. LEVE: what follows on the pages is a
 * wrong display (no rating, no reviews, no search hits in the room, a form's
 * "done" page answered 404, the "where did you hear about us" question asked
 * of a store that turned it off, a coming-soon product's booking page open),
 * with no write, access or money decided by it in app/[handle].
 *
 * Synthetic store; one reply injected per reader; no network.
 */
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { readReview, summaries, summaryOf, visibleReviews } from "@/lib/reviews";
import { searchRoom } from "@/lib/community-chat";
import { readForm } from "@/lib/form-store";
import { heardOff } from "@/lib/heard";
import { isSoon } from "@/lib/waitlist";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let inject: { command: string; reply: unknown } | null = null;
let hits = 0;
redis.pipeline = (async (batch: Command[]) => {
  if (inject && batch.some((c) => c[0] === inject!.command)) {
    hits += 1;
    return batch.map((c) => (c[0] === inject!.command ? inject!.reply : null));
  }
  return real(batch);
}) as typeof redis.pipeline;

const outcome = (work: () => Promise<unknown>) =>
  work().then(
    (value) => JSON.stringify(value instanceof Map ? [...value] : value),
    () => "unknown",
  );

async function main(): Promise<void> {
  redis.clear();
  const owner = "a8-lib-reads@example.test";
  await claimHandle(owner, "a8libreads", "A8 Lib Reads", "");
  await ensureStatsId(owner);
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  const product = "a8product1";
  const review = "a".repeat(24);

  const readers: [string, string, () => Promise<unknown>, unknown[]][] = [
    ["summaryOf (product page rating)", "HGET", () => summaryOf(statsId, product), [7, "{\"count\":", ["x"]]],
    ["summaries (store and collection ratings)", "HGETALL", () => summaries(statsId), ["x", 7]],
    ["visibleReviews (product page reviews)", "ZREVRANGEBYSCORE", () => visibleReviews(statsId, product), ["x", 7]],
    ["readReview (thanks page: already reviewed?)", "HGET", () => readReview(statsId, product, review), [7, "{\"id\":", ["x"]]],
    ["searchRoom (community search, room tab)", "ZREVRANGE", () => searchRoom("a8community1", ["bread"]), ["x", 7]],
    ["readForm (form done page)", "HGET", () => readForm(statsId, "a8form0001"), [7, "{\"id\":", ["x"]]],
    ["heardOff (thanks page question)", "SMISMEMBER", () => heardOff(store), ["yes", 2, ["x"]]],
    ["isSoon (booking page open)", "SISMEMBER", () => isSoon(store, product), ["yes", 2, ["x"]]],
  ];
  for (const [name, command, read, replies] of readers) {
    part(name);
    const absent = await outcome(read);
    for (const reply of replies) {
      inject = { command, reply };
      hits = 0;
      const got = await outcome(read);
      inject = null;
      is(`the reader asked Redis with ${command} (the injected reply was read)`, hits > 0, true);
      is(`${command} answered ${JSON.stringify(reply)} is unknown, never the absent answer ${absent}`, got, "unknown");
    }
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
