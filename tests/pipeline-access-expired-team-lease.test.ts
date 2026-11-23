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
import { dataKey } from "@/lib/store-data";
import { store as redis, advance } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "pacc-lease@example.com";
const SAM = "sam@example.com";
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
  const session = await openSession(OWNER);
  const post = async () => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/pipeline-access", {
      method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ email: SAM, pipeline: "sales0", access: "view" }),
    }));
    return { status: response.status, body: await response.json() as { ok?: boolean; error?: string } };
  };
  return { store, post, key: `nl:crm:pacc:${store.statsId}`, lock: `nl:team:lock:${store.sid}` };
}

async function main(): Promise<void> {
  part("Healthy lease: the real route saves its restriction");
  {
    const { post, key } = await setup();
    const answer = await post();
    is("saved", [answer.status, answer.body.ok], [200, true]);
    is("the real field is kept", (await redis.pipeline([["HGET", key, SAM]]))[0], JSON.stringify({ sales0: "view" }));
  }

  for (const replacement of [false, true]) {
    part(`A removed teammate stays forgotten; replacement lease ${replacement}`);
    const { store, post, key, lock } = await setup();
    const real = redis.pipeline.bind(redis);
    let crossed = false;
    let removed = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!crossed && commands.some((c) => commitFor(c, key))) {
        crossed = true;
        // Advance only the synthetic Redis clock. The inner access lock is
        // still within its ten seconds, but the outer team lease has expired.
        advance(6_000);
        removed = await removeMember(store, SAM);
        if (replacement) await real([["SET", lock, "successor-team-lease", "EX", 30]]);
      }
      return real(commands);
    }) as typeof redis.pipeline;
    // The access slot of the store's data room (lib/pipeline-access.ts ACCESS_SLOT) before the request.
    const slot = async () => Number((await real([["HGET", dataKey(store)!, "crm:pacc"]]))[0] ?? 0);
    const slotBefore = await slot();
    let answer: Awaited<ReturnType<typeof post>>;
    try { answer = await post(); }
    finally { redis.pipeline = real; }
    is("crossed the real commit and completed the real removal", [crossed, removed], [true, true]);
    is("the teammate is gone", (await readTeam(store.sid)).members.some((m) => m.email === SAM), false);
    is("the removed person's access field is never recreated", (await real([["HGET", key, SAM]]))[0], null);
    is("the stale request never reports success", [answer.status, answer.body.ok, answer.body.error], [503, false, "unavailable"]);
    is("an earlier release never deletes a successor's team lease", (await real([["GET", lock]]))[0],
      replacement ? "successor-team-lease" : null);
    // Claude 3's LEVE on #5111: the lease lost means nothing was written, for certain, so the room the write took back.
    is("the data room taken for the field that was never written is given back", await slot(), slotBefore);
  }
}

main().then(done, (error) => { console.error(error); process.exitCode = 1; }).finally(() => { globalThis.fetch = realFetch; });
