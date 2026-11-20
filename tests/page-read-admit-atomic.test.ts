/**
 * A reading is admitted in one atomic step (Codex G's MEDIUM on #2571, MQ-REV G position 44): the window's count never
 * goes past the token's ceiling, even on a server that just started and saw nothing, and one token is admitted exactly
 * once across servers, however many of its sends arrive at once. The real route, a real paying store, its real page
 * check and token (MemoryRedis); no outside request.
 *
 * What is checked:
 *   - at the ceiling, with what this server saw forgotten, 20 more readings leave the count exactly at the ceiling;
 *   - 200 sends of one token at once, on servers that saw nothing: its reading is counted once, and the window's count
 *     stays within the ceiling.
 */
import { POST as readRoute } from "@/app/api/store/read/route";
import { allowanceWindow } from "@/lib/allowance-window";
import { forgetReadingsSeen, noteReadStore, readSampled, readSlot, readToken, readTokenPass } from "@/lib/page-read";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const PRODUCT = "prod000001";
let seed = 0;
const drawn = () => {
  for (;;) {
    const n = `atomic${String((seed += 1)).padStart(10, "0")}`;
    if (readSampled(n)) return n;
  }
};
const sale = (t: string) => readRoute(new Request("https://marktmorgen.com/api/store/read", { method: "POST", headers: { "user-agent": PHONE }, body: JSON.stringify({ t, k: "d", p: PRODUCT, b: "blok0001", s: 42 }) }) as never);

async function main(): Promise<void> {
  redis.clear();
  forgetReadingsSeen();
  await claimHandle("atomic@example.test", "atomicreads", "Atomic Reads", "");
  await ensureStatsId("atomic@example.test");
  await setSubscription("atomic@example.test", { customerId: "cus_atomic0000", subscriptionId: "sub_atomic0000", active: true, tier: "creator", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail("atomic@example.test"))!;
  const now = Date.now();
  const window = allowanceWindow(store, now)!.id;
  let place = 0;
  const token = () => {
    do place += 1;
    while (!readSlot(window, place));
    noteReadStore(store.statsId, store, now, place);
    return readToken(store.statsId, PRODUCT, now, drawn());
  };
  const first = token();
  const pass = readTokenPass(first, PRODUCT)!;
  const meter = `nl:traffic:read:${store.statsId}:${pass.window}`;
  const count = () => Number(redis.run(["GET", meter]) ?? 0);

  part("Past the ceiling, a server that saw nothing never counts past it");
  redis.run(["SET", meter, String(pass.cap)]);
  for (let i = 0; i < 20; i += 1) {
    forgetReadingsSeen();
    await sale(token());
  }
  is("the count stays exactly at the ceiling", count(), pass.cap);

  part("A token refused at the ceiling is spent everywhere, at once (Codex X5's MEDIUM on #2571)");
  {
    // Its first refusal marks it in the same step, so a server that saw nothing finds it used before any count, and the
    // Redis work its retries can cost is the used token's, never a count and a take-back each time.
    redis.run(["SET", meter, String(pass.cap)]);
    forgetReadingsSeen();
    const late = token();
    const nonce = readTokenPass(late, PRODUCT)!.nonce;
    await sale(late);
    is("refused at the ceiling, and marked used in Redis", [count(), redis.run(["EXISTS", `nl:read:once:${nonce}`])], [pass.cap, 1]);
    redis.run(["SET", meter, "0"]);
    for (let i = 0; i < 20; i += 1) {
      forgetReadingsSeen();
      await sale(late);
    }
    is("sent again on servers that saw nothing, with room in the window now: never counted", count(), 0);
  }

  part("One token sent 200 times at once is admitted once");
  redis.run(["DEL", meter]);
  forgetReadingsSeen();
  /** Every count in the depth records (lib/page-depth.ts): one reading adds its block once, on the blocks' record. */
  const depthCounted = () =>
    redis.keys().filter((key) => /^nl:depth:/.test(key) && !key.endsWith(":t")).reduce((sum, key) => {
      const flat = redis.run(["HGETALL", key]) as unknown[];
      for (let i = 1; i < flat.length; i += 2) sum += Number(flat[i]);
      return sum;
    }, 0);
  const before = depthCounted();
  const once = token();
  forgetReadingsSeen();
  await Promise.all(Array.from({ length: 200 }, () => sale(once)));
  is("its reading is counted once", depthCounted() - before, 1);
  is("the window's count stays within the ceiling", count() <= pass.cap, true);
  is("and the token is marked used", redis.run(["EXISTS", `nl:read:once:${readTokenPass(once, PRODUCT)!.nonce}`]), 1);
  // A replay of the same token never takes another place in the window's count (Codex X2's MEDIUM on #2571): 200 sends
  // leave it at 1, not at up to the ceiling, and a second server that saw nothing leaves it at 1 too.
  is("the same token takes one place in the window's count", count(), 1);
  forgetReadingsSeen();
  await Promise.all(Array.from({ length: 50 }, () => sale(once)));
  is("replayed on a server that saw nothing, still one place", count(), 1);
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
