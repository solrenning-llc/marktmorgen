/**
 * A store whose plan runs again is never erased by the closing walk (Claude 5's MEDIUM on #3643).
 *
 * A closing store's preparation can stop after its walk entry is confirmed (the addresses' hold answered with nothing),
 * and the entry's taking-out can stay unconfirmed too: the entry stays in the batch with the store's record still
 * there. If the store's plan then runs again, lib/plan-closing.ts closeOne takes it out of line (unmarkDue), but the
 * walk's start (startableBatch) read the record as the store's own and put it back in line, and the next run prepared
 * it: the record and the data of a store whose plan runs were gone.
 *
 * Now, before anything of a store is touched, a plan read as running (paid or in trial, as closeOne's "running") takes
 * it out of line without preparing it, unless its closing day has begun (FINAL_INDEX: a closing day is seen through,
 * whatever happens to the plan since, as closeOne does); the same is read again under the store's lock right before
 * the record goes, so a plan started meanwhile keeps the record. A place in the final line that does not read is
 * neither (rule 24): the store stays in line, untouched, moved back a walk. Synthetic stores, in-memory Redis.
 *
 * Codex X4's MEDIUM on #3643: the second read, under the lock, came after the preparation had already taken the
 * store's calendar claims, team, API keys, webhooks, email sync, phones, path and host calendar: a plan started in
 * between kept the record but left the live store partly wiped. Nothing of the store is deleted before that read.
 */
import { BATCH_KEY, DUE_KEY, WALK_GAP_MS, eraseClosed, markDue, unmarkDue } from "@/lib/closed-store-data";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { claimsKey, hostId } from "@/lib/host-claims";
import { hostCalendarKeys } from "@/lib/host-calendar";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { closeForErasure, recordRemoved } from "./closed-for-erasure";
import { done, is, part } from "./check";

// The addresses' hold and the id's release before the record goes answered [] with nothing done.
let releaseLost = false;
// How many takings-out of a walk entry (WITHDRAW_ENTRY) answer what EVAL never says, from now.
let withdrawUnknown = 0;
// The store's place in the final closing line answered with what ZSCORE never says.
let finalUnknown = false;
// Run when the walk's entry is first written (HSET BATCH_KEY), after the walk's first read and before the record's going.
let inWindow: (() => Promise<void>) | null = null;
// Run when the store's team is first read (GET nl:team:<sid>): after the walk's first read of the plan and before
// anything of the store is deleted (Codex X4's MEDIUM on #3643).
let onTeamRead: (() => Promise<void>) | null = null;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = async (commands: (string | number)[][]) => {
  if (withdrawUnknown > 0 && commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:closing-withdraw-entry:v1")) {
    withdrawUnknown -= 1;
    return [null];
  }
  // The walk reads the store's place in the final line first in dueForErasure (beside its closing record), and
  // prepareStore reads it again: the first such read is the one answered with what ZSCORE never says.
  const finalAt = commands.findIndex((c) => c[0] === "ZSCORE" && c[1] === FINAL_INDEX);
  if (finalUnknown && finalAt >= 0) {
    finalUnknown = false;
    const replies = await realPipeline(commands);
    replies[finalAt] = "QUEUED";
    return replies;
  }
  if (onTeamRead && commands.some((c) => c[0] === "GET" && /^nl:team:[^:]+$/.test(String(c[1])))) {
    const run = onTeamRead;
    onTeamRead = null;
    await run();
  }
  if (inWindow && commands.some((c) => c[0] === "HSET" && c[1] === BATCH_KEY)) {
    const run = inWindow;
    inWindow = null;
    await run();
  }
  // The addresses' hold, made bare before, or as one of the record's closing changes in the step that reads the store's
  // lock (lib/redis-lock.ts applyIfHeld, CLOSING_FENCED, on #3156): answered with nothing, and not run.
  const holdsAddress = (c: (string | number)[]) =>
    (c[0] === "SET" && String(c[1]).startsWith("nl:store:handle:") && String(c[2]).startsWith("released:")) ||
    (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:closing-fenced:v1\n") && c.slice(3, 3 + Number(c[2])).some((k) => String(k).startsWith("nl:store:handle:")));
  if (releaseLost && commands.some(holdsAddress)) {
    releaseLost = false;
    return [];
  }
  return realPipeline(commands);
};

async function makeStore(email: string, handle: string): Promise<Store> {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  const store = await storeForEmail(email);
  if (!store) throw new Error(`setup: ${handle}`);
  return store;
}

/** The plan ended: a subscription the store had, no longer active (planEndedAt written). */
async function endPlan(email: string, n: string): Promise<void> {
  await setSubscription(email, { customerId: `cus_restart${n}`, subscriptionId: `sub_restart${n}`, active: true });
  await setSubscription(email, { active: false });
}

/** The plan runs again, as closeOne finds it: the store paid again, taken out of the walk's line. */
async function restartPlan(email: string, n: string): Promise<void> {
  await setSubscription(email, { customerId: `cus_restart${n}`, subscriptionId: `sub_restart${n}`, active: true });
  await unmarkDue(email);
}

async function erase(now: number) {
  return eraseClosed(Date.now() + 30_000, async () => {}, now);
}

const dataOf = (store: Store) => redis.run(["GET", `nl:zz:${store.statsId}:data`]);

/**
 * The live state the preparation takes away before the record goes, seeded raw: a calendar claim held for the store,
 * its team's log, its API keys, its webhooks, its email sync, its phones, its owner's path and the host's calendar.
 * Answers each key (with its claim field) and whether it is there now.
 */
function seedLive(store: Store): () => [string, boolean][] {
  const claims = claimsKey(hostId(store.email));
  const claimField = "k000000000000000000000001";
  redis.run(["HSET", claims, claimField, `1|2|0|${store.sid}`]);
  const keys = [
    `nl:team:log:${store.sid}`,
    `nl:api:keys:${store.sid}`,
    `nl:hooks:cfg:${store.statsId}`,
    `nl:esync:cfg:${store.statsId}`,
    `nl:phone:cfg:${store.statsId}`,
    `nl:phone:st:${store.statsId}`,
    hostCalendarKeys(hostId(store.email))[0],
  ];
  for (const key of keys) {
    if (key.startsWith("nl:api:keys:")) redis.run(["HSET", key, "k1", "x"]);
    else redis.run(["SET", key, "x"]);
  }
  return () => [[`${claims} ${claimField}`, redis.run(["HEXISTS", claims, claimField]) === 1], ...keys.map((key): [string, boolean] => [key, redis.run(["EXISTS", key]) === 1])];
}

async function main(): Promise<void> {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

  part("Claude 5's MEDIUM on #3643: a store whose plan runs again after a preparation that stopped is never erased");
  redis.clear();
  {
    const email = "restarted@example.com";
    const store = await makeStore(email, "restartedplan");
    await endPlan(email, "0001");
    redis.run(["SET", `nl:zz:${store.statsId}:data`, "z"]);
    releaseLost = true;
    withdrawUnknown = 100;
    const T = Date.now();
    await closeForErasure(email);
    await markDue(email, T - 1000);
    const first = await erase(T);
    is("setup: the preparation stopped with the record there", [first.stores, (await storeForEmail(email))?.sid ?? null], [0, store.sid]);
    await restartPlan(email, "0001");
    const stores: number[] = [];
    for (let n = 1; n <= 2; n++) stores.push((await erase(T + n * (WALK_GAP_MS + 1))).stores);
    is("its record is still there", (await storeForEmail(email))?.sid ?? null, store.sid);
    is("its data is not erased", dataOf(store), "z");
    is("it is never prepared", stores, [0, 0]);
    withdrawUnknown = 0;
    for (let n = 3; n <= 4; n++) await erase(T + n * (WALK_GAP_MS + 1));
    is("once its entry is confirmed out, it is out of the batch and out of line", [redis.run(["HGET", BATCH_KEY, email]), redis.run(["ZSCORE", DUE_KEY, email])], [null, null]);
    is("and its record and data still stand", [(await storeForEmail(email))?.sid ?? null, dataOf(store)], [store.sid, "z"]);
  }

  part("A plan started while the store is being prepared keeps its record: it is read again under the store's lock");
  redis.clear();
  {
    const email = "window@example.com";
    const store = await makeStore(email, "windowplan");
    await endPlan(email, "0002");
    redis.run(["SET", `nl:zz:${store.statsId}:data`, "w"]);
    inWindow = async () => {
      await setSubscription(email, { customerId: "cus_restart0002", subscriptionId: "sub_restart0002", active: true });
    };
    const T = Date.now();
    await closeForErasure(email);
    await markDue(email, T - 1000);
    const report = await erase(T);
    is("the plan started in the window", inWindow, null);
    is("the store is not prepared", [report.stores, report.started, report.finished], [0, false, 0]);
    is("its record and data still stand", [(await storeForEmail(email))?.sid ?? null, dataOf(store)], [store.sid, "w"]);
    is("it is out of line, and its pending entry out of the batch", [redis.run(["ZSCORE", DUE_KEY, email]), redis.run(["HGET", BATCH_KEY, email])], [null, null]);
  }

  part("Codex X4's MEDIUM on #3643: a plan started after the first read and before anything is deleted leaves the live store whole");
  redis.clear();
  {
    const email = "partlywiped@example.com";
    const store = await makeStore(email, "partlywiped");
    await endPlan(email, "0006");
    redis.run(["SET", `nl:zz:${store.statsId}:data`, "p"]);
    const live = seedLive(store);
    onTeamRead = async () => {
      await setSubscription(email, { customerId: "cus_restart0006", subscriptionId: "sub_restart0006", active: true });
    };
    const T = Date.now();
    await closeForErasure(email);
    await markDue(email, T - 1000);
    const report = await erase(T);
    is("the plan started before anything was deleted", onTeamRead, null);
    is("the store is not prepared", [report.stores, report.started, report.finished], [0, false, 0]);
    is("its record and data still stand", [(await storeForEmail(email))?.sid ?? null, dataOf(store)], [store.sid, "p"]);
    is("its claim, team, API keys, webhooks, email sync, phones and calendar are all still there", live().filter(([, there]) => !there).map(([key]) => key), []);
    is("it is out of line, and its pending entry out of the batch", [redis.run(["ZSCORE", DUE_KEY, email]), redis.run(["HGET", BATCH_KEY, email])], [null, null]);
  }

  part("Control for the above: the same live state goes with a store whose plan stays ended");
  redis.clear();
  {
    const email = "wiped@example.com";
    const store = await makeStore(email, "wipedplan");
    await endPlan(email, "0007");
    const live = seedLive(store);
    const T = Date.now();
    await closeForErasure(email);
    await markDue(email, T - 1000);
    const report = await erase(T);
    is("it is prepared, walked and finished", [report.stores, report.finished], [1, 1]);
    is("every seeded key is gone", live().filter(([, there]) => there).map(([key]) => key), []);
  }

  part("A closing day that has begun is seen through: a plan paid on it does not keep the store (as closeOne)");
  redis.clear();
  {
    const email = "final@example.com";
    const store = await makeStore(email, "finalplan");
    redis.run(["SET", `nl:zz:${store.statsId}:data`, "f"]);
    const T = Date.now();
    redis.run(["ZADD", FINAL_INDEX, T - 5000, email]);
    await setSubscription(email, { customerId: "cus_restart0003", subscriptionId: "sub_restart0003", active: true });
    await recordRemoved(email, T - 5000);
    await markDue(email, T - 1000);
    const report = await erase(T);
    is("it is prepared, walked and finished", [report.stores, report.finished], [1, 1]);
    is("its record and data are gone", [await storeForEmail(email), dataOf(store)], [null, null]);
  }

  part("Rule 24: a running plan's place in the final line that does not read leaves the store in line, untouched");
  redis.clear();
  {
    const email = "unknownfinal@example.com";
    const store = await makeStore(email, "unknownfinal");
    redis.run(["SET", `nl:zz:${store.statsId}:data`, "u"]);
    await setSubscription(email, { customerId: "cus_restart0004", subscriptionId: "sub_restart0004", active: true });
    finalUnknown = true;
    const T = Date.now();
    await markDue(email, T - 1000);
    const report = await erase(T);
    const score = redis.run(["ZSCORE", DUE_KEY, email]);
    is("the final line was answered with what ZSCORE never says", finalUnknown, false);
    is("nothing is prepared", report.stores, 0);
    is("its record and data still stand, and no entry is written", [(await storeForEmail(email))?.sid ?? null, dataOf(store), redis.run(["HGET", BATCH_KEY, email])], [store.sid, "u", null]);
    is("it stays in line, moved back a walk", score !== null && Number(score) >= T + WALK_GAP_MS, true);
  }

  part("Control: a store whose plan ended is erased as before");
  redis.clear();
  {
    const email = "ended@example.com";
    const store = await makeStore(email, "endedplan");
    await endPlan(email, "0005");
    redis.run(["SET", `nl:zz:${store.statsId}:data`, "e"]);
    const T = Date.now();
    await closeForErasure(email);
    await markDue(email, T - 1000);
    const report = await erase(T);
    is("it is prepared, walked and finished", [report.stores, report.finished], [1, 1]);
    is("its record and data are gone", [await storeForEmail(email), dataOf(store)], [null, null]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
