/**
 * A pipeline-access request admitted before a teammate's removal cannot put
 * their erased email field back after its five-second team lease expires.
 * Real POST, removeMember, data-room reservation and Redis model. No network.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/pipeline-access/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { putMember, readTeam, removeMember } from "@/lib/team";
import { dataKey, takeDataCommands } from "@/lib/store-data";
import * as access from "@/lib/pipeline-access";
import { store as redis, advance } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "pacc-lease@example.com";
const SAM = "sam@example.com";
/** A teammate already restricted, so the access slot holds a record before the request (Claude 5 ichw on #5111). */
const MIA = "mia@example.com";
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("No network in the pipeline-access lease fixture"); };

const commitFor = (c: (string | number)[], key: string) =>
  (c[0] === "HSET" && c[1] === key && c[2] === SAM) ||
  (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:closing-fenced:v1\n") &&
    c[4] === key && c[6] === "HSET" && c[9] === SAM);

async function setup() {
  redis.clear();
  await claimHandle(OWNER, "pacclease", "Pipeline lease", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPaccL", true);
  await setSubscription(OWNER, { customerId: "cus_PaccLease01", subscriptionId: "sub_PaccLease01",
    active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  await putMember(store, SAM, "support");
  await putMember(store, MIA, "support");
  const session = await openSession(OWNER);
  const post = async (email = SAM) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/pipeline-access", {
      method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ email, pipeline: "sales0", access: "view" }),
    }));
    return { status: response.status, body: await response.json() as { ok?: boolean; error?: string; message?: string } };
  };
  return { store, post, key: `nl:crm:pacc:${store.statsId}`, lock: `nl:team:lock:${store.sid}` };
}

/**
 * Commands as Upstash bills them (Claude 5 iYzLs on #5111): each command 1; the fence script 1 plus its GET, and its
 * HSET or HDEL only when it wrote; a store-data script at its dearest (takeDataCommands of its slots); the other
 * scripts the route runs as noted, and one this test does not know as never free.
 */
function billed(commands: (string | number)[][]): number {
  let total = 0;
  for (const c of commands) {
    const head = String(c[1] ?? "");
    if (c[0] !== "EVAL") total += 1;
    else if (head.startsWith("-- marktmorgen:store-data:")) total += takeDataCommands((c.length - 7) / 3);
    else if (head.startsWith("-- marktmorgen:closing-fenced:v1\n")) total += 1 + 1 + (wrote.has(c) ? 1 : 0);
    // The lease's release: its GET and its DEL at the most.
    else if (head.startsWith("-- marktmorgen:release:v1\n")) total += 1 + 2;
    // The team log line of a saved change runs only on the healthy path, the baseline below: counted at its EVAL alone,
    // which only lowers the baseline, so the check is stricter, never looser.
    else if (head.startsWith("-- marktmorgen:team-log-live:v1\n")) total += 1;
    else total += 1000; // a script this test does not know is not free
  }
  return total;
}
/** The fence scripts that wrote (answered 1), read off the real replies. */
const wrote = new Set<(string | number)[]>();
/** Bytes on the wire of the store-data scripts' EVALs, the largest seen. */
let dataEvalBytes = 0;
let measuring = false;
let measured = 0;
function counting(real: typeof redis.pipeline): typeof redis.pipeline {
  return (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    if (measuring) {
      commands.forEach((c, i) => {
        if (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:closing-fenced:v1\n") && replies[i] === 1) wrote.add(c);
        if (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:")) {
          dataEvalBytes = Math.max(dataEvalBytes, c.reduce<number>((n, w) => n + Buffer.byteLength(String(w)), 0));
        }
      });
      measured += billed(commands);
    }
    return replies;
  }) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  // What the line pipeline-access-team-fence funds a studio unit over the plain HSET or HDEL write.
  const funded = access.PIPELINE_ACCESS_FENCE_COMMANDS
    + ((access as { PIPELINE_ACCESS_GIVE_BACK_COMMANDS?: number }).PIPELINE_ACCESS_GIVE_BACK_COMMANDS ?? 0);
  const fundedBytes = (access as { PIPELINE_ACCESS_GIVE_BACK_BYTES?: number }).PIPELINE_ACCESS_GIVE_BACK_BYTES ?? 0;
  let healthyBilled = 0;
  part("Healthy lease: the real route saves its restriction");
  {
    const { post, key } = await setup();
    const real = redis.pipeline.bind(redis);
    redis.pipeline = counting(real);
    measuring = true;
    measured = 0;
    let answer: Awaited<ReturnType<typeof post>>;
    try { answer = await post(); }
    finally { measuring = false; redis.pipeline = real; }
    healthyBilled = measured;
    is("saved", [answer.status, answer.body.ok], [200, true]);
    is("the real field is kept", (await redis.pipeline([["HGET", key, SAM]]))[0], JSON.stringify({ sales0: "view" }));
  }

  for (const replacement of [false, true]) {
    part(`A removed teammate stays forgotten; replacement lease ${replacement}`);
    const { store, post, key, lock } = await setup();
    const real = redis.pipeline.bind(redis);
    const count = counting(real);
    let crossed = false;
    let removed = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!crossed && commands.some((c) => commitFor(c, key))) {
        crossed = true;
        // Advance only the synthetic Redis clock. The inner access lock is
        // still within its ten seconds, but the outer team lease has expired.
        advance(6_000);
        // The removal is billed to the removal, not to this request.
        measuring = false;
        removed = await removeMember(store, SAM);
        if (replacement) await real([["SET", lock, "successor-team-lease", "EX", 30]]);
        measuring = true;
      }
      return count(commands);
    }) as typeof redis.pipeline;
    // Another teammate restricted first, so the slot holds a record and over-giving shows (Claude 5 ichw on #5111).
    is("another teammate is restricted first", (await post(MIA)).body.ok, true);
    // The access slot of the store's data room (lib/pipeline-access.ts ACCESS_SLOT) and its total "#" before the request.
    const slot = async () => Number((await real([["HGET", dataKey(store)!, "crm:pacc"]]))[0] ?? 0);
    const total = async () => Number((await real([["HGET", dataKey(store)!, "#"]]))[0] ?? 0);
    const slotBefore = await slot();
    const totalBefore = await total();
    is("the slot holds the other teammate's record before the request", slotBefore > 0, true);
    let answer: Awaited<ReturnType<typeof post>>;
    measuring = true;
    measured = 0;
    dataEvalBytes = 0;
    try { answer = await post(); }
    finally { measuring = false; redis.pipeline = real; }
    is("crossed the real commit and completed the real removal", [crossed, removed], [true, true]);
    is("the teammate is gone", (await readTeam(store.sid)).members.some((m) => m.email === SAM), false);
    is("the removed person's access field is never recreated", (await real([["HGET", key, SAM]]))[0], null);
    is("the stale request never reports success", [answer.status, answer.body.ok, answer.body.error], [503, false, "unavailable"]);
    is("an earlier release never deletes a successor's team lease", (await real([["GET", lock]]))[0],
      replacement ? "successor-team-lease" : null);
    // Claude 3's LEVE on #5111: the lease lost means nothing was written, for certain, so the room the write took goes
    // back, exactly: neither kept nor given back twice (Claude 5 ichw on #5111).
    is("the data room taken for the field that was never written is given back, exactly", [await slot(), await total()], [slotBefore, totalBefore]);
    is("the creator is told it was not saved, never that it could not be confirmed",
      [/was not saved/.test(answer.body.message ?? ""), /could not confirm/.test(answer.body.message ?? "")], [true, false]);
    // Claude 5 iYzLs's LEVE on #5111: the give-back is priced. Over the plain write (the healthy path less its fence),
    // the refused path's billed commands are within what the line funds a studio unit, and the give-back's EVAL bytes
    // within its funded bytes.
    is("the refused path's billed commands are within the line pipeline-access-team-fence",
      measured - (healthyBilled - access.PIPELINE_ACCESS_FENCE_COMMANDS) <= funded, true);
    is("the give-back's script bytes are within the line's funded bytes", dataEvalBytes <= fundedBytes, true);
  }
}

main().then(done, (error) => { console.error(error); process.exitCode = 1; }).finally(() => { globalThis.fetch = realFetch; });
