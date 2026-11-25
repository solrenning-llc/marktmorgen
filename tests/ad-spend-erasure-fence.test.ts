/**
 * A manual ad-spend add whose write lands after the store's erasure began never writes the store's private campaign
 * lines back (Codex L-20261119-1621, row 100 of #5010). Both writers (the operation-id add's HSETNX and an older
 * page's HSET) are one step with the store's fence, by the rule of lib/live-fence.ts (store-cache-live:v3): the
 * erasing field absent, and the id key holding this store's own ref, or, for a store kept from before ids, the
 * owner's record still carrying its statsId. Synthetic stores and the in-memory Redis only.
 */
import { addSpend } from "@/lib/ad-spend";
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, ownerKey, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const today = new Date().toISOString().slice(0, 10);
const LINE = { channel: "instagram", campaign: "spring", cents: 1200, from: today, to: today };
const OP = "a".repeat(32);
const spendKey = (store: Store) => `nl:stats:${store.statsId}:spend`;
type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

async function shop(email: string, handle: string): Promise<Store> {
  await claimHandle(email, handle, "Spend shop", "");
  await ensureStoreId(email);
  await ensureStatsId(email);
  return (await storeForEmail(email))!;
}

/** The store's spend lines in Redis, and whether the hash is there at all. */
const kept = (store: Store) => ({ exists: redis.run(["EXISTS", spendKey(store)]), fields: Number(redis.run(["HLEN", spendKey(store)])) });

/**
 * Runs the add with `erase` done just before its write is sent (after the add read the lines already kept): the
 * window in which a whole-store erasure can pass.
 */
async function eraseBeforeTheWrite<T>(erase: () => void, run: () => Promise<T>): Promise<T> {
  let done = false;
  redis.pipeline = (async (commands: Command[]) => {
    const write = commands.some((c) => c[0] === "HSET" || c[0] === "HSETNX" || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:ad-spend-live:")));
    if (write && !done) {
      done = true;
      erase();
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

/** The add's answer, or "threw" when it threw (an unknown outcome is never "saved"). */
const outcome = (p: Promise<{ ok: boolean }>) => p.then((r) => (r.ok ? "saved" : "refused"), () => "threw");

async function main(): Promise<void> {
  redis.clear();

  part("A live store: both kinds of add are kept, as before");
  const live = await shop("spend-live@example.com", "spendlive");
  is("an add with the studio's operation id is saved", await outcome(addSpend(live.statsId!, { ...LINE, op: OP }, Date.now(), live)), "saved");
  is("an older page's add is saved", await outcome(addSpend(live.statsId!, LINE, Date.now(), live)), "saved");
  is("two lines kept, with their expiry", [kept(live).fields, Number(redis.run(["TTL", spendKey(live)])) > 0], [2, true]);

  for (const [what, line] of [["an add with the studio's operation id", { ...LINE, op: OP }], ["an older page's add", LINE]] as const) {
    part(`${what}: the store's erasure begins before the write lands`);
    const erasing = await shop(`spend-erasing-${line === LINE ? "a" : "b"}@example.com`, `spenderasing${line === LINE ? "a" : "b"}`);
    const field = await erasingField(storeRef(erasing));
    const answer = await eraseBeforeTheWrite(() => {
      redis.run(["HSET", ERASING_KEY, field, String(Date.now())]);
      redis.run(["DEL", spendKey(erasing)]);
    }, () => outcome(addSpend(erasing.statsId!, line, Date.now(), erasing)));
    is(`${what}: never saved`, answer === "saved", false);
    is(`${what}: no line written back`, kept(erasing).exists, 0);

    part(`${what}: the store's erasure ends before the write lands (its id key gone)`);
    const erased = await shop(`spend-erased-${line === LINE ? "a" : "b"}@example.com`, `spenderased${line === LINE ? "a" : "b"}`);
    const answer2 = await eraseBeforeTheWrite(() => {
      redis.run(["DEL", storeIdCommand(erased.sid)[1]]);
      redis.run(["DEL", spendKey(erased)]);
    }, () => outcome(addSpend(erased.statsId!, line, Date.now(), erased)));
    is(`${what}: never saved`, answer2 === "saved", false);
    is(`${what}: no line written back`, kept(erased).exists, 0);

    part(`${what}: its id key names another ref by then (an account moved)`);
    const moved = await shop(`spend-moved-${line === LINE ? "a" : "b"}@example.com`, `spendmoved${line === LINE ? "a" : "b"}`);
    const answer3 = await eraseBeforeTheWrite(() => {
      redis.run(["SET", storeIdCommand(moved.sid)[1], "someone-else@example.com"]);
    }, () => outcome(addSpend(moved.statsId!, line, Date.now(), moved)));
    is(`${what}: never saved`, answer3 === "saved", false);
    is(`${what}: no line written`, kept(moved).exists, 0);
  }

  part("A store from before ids: its owner's record must still be its own");
  const made = await shop("spend-legacy@example.com", "spendlegacy");
  const legacy: Store = { ...made, sid: "", extra: false };
  is("its own record: saved", await outcome(addSpend(legacy.statsId!, LINE, Date.now(), legacy)), "saved");
  redis.run(["DEL", spendKey(legacy)]);
  const owner = await ownerKey(storeRef(legacy));
  const record = JSON.parse(String(redis.run(["GET", owner]))) as Record<string, unknown>;
  redis.run(["SET", owner, JSON.stringify({ ...record, statsId: "s_another_store_0001" })]);
  is("another store's record under the same key: never saved", (await outcome(addSpend(legacy.statsId!, LINE, Date.now(), legacy))) === "saved", false);
  is("no line written", kept(legacy).exists, 0);
  done();
}

void main();
