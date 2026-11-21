/**
 * A payment plan read by settlePlans before its store's erasure began cannot come back after it (Codex
 * L-20261120-2008, MEDIUM, lib/plans.ts moveTo).
 *
 * settlePlans reads a member of nl:plans:pending or nl:plans:retry, then waits on Stripe. Meanwhile the closing walk
 * can write the store's erasing mark, delete its identity and prune the plan lists of the members naming its store id.
 * moveTo then wrote a plain ZADD to nl:plans:retry: the member (the creator's Stripe account, the checkout session, the
 * store and product ids) was back after the erasure, and on the stuck path its creator could still be emailed.
 *
 * Checked with the real settlePlans on the in-memory Redis and a stand-in Stripe, the closing write interleaved just
 * before the plan's ZADD; synthetic store, accounts and addresses, Resend stubbed, nothing leaves.
 */
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, setStripeAccount, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { PLAN_GIVE_UP_DAYS, settlePlans } from "@/lib/plans";
import { PENDING, memberOf } from "@/lib/plan-remember";
import { PLAN_SETTLE_RUN } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_fence";
// A synthetic credential the Resend fixture knows (tests/resend-fixture-credentials.ts).
process.env.RESEND_API_KEY = "re_test_store_alerts_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const RETRY = "nl:plans:retry";
const DAY = 86_400;
const OWNER = "plan-fence-owner@example.com";
const ACCOUNT = "acct_planFence01";
/** How each Stripe call on the connected account answers: 500 (Stripe down) or 403 (the account refuses us). */
let stripeStatus = 500;
let emailsSent = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    emailsSent += 1;
    return answer({ id: `email_${emailsSent}` });
  }
  if (url.hostname === "api.stripe.com") return answer({ error: { message: "synthetic" } }, stripeStatus);
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

const retryMembers = () => (redis.run(["ZRANGE", RETRY, 0, -1]) as string[]) ?? [];
const pendingMembers = () => (redis.run(["SMEMBERS", PENDING]) as string[]) ?? [];

/** Runs `then` once, just before the first write that adds to the line of plans tried. */
function beforeRetryWrite(then: () => Promise<unknown>): () => void {
  const original = redis.pipeline.bind(redis);
  let fired = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!fired && commands.some((command) => command.map(String).includes(RETRY) && command.map(String).some((word) => word === "ZADD" || word.includes("ZADD")))) {
      fired = true;
      await then();
    }
    return original(commands);
  }) as typeof redis.pipeline;
  return () => { redis.pipeline = original; };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "planfence", "Plan Fence", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const store = (await storeForEmail(OWNER))!;
  const now = Math.floor(Date.now() / 1000);
  const member = (session: string, since: number) =>
    memberOf({ account: ACCOUNT, session, since, sid: store.sid, product: "prod00000001", told: false, owed: 0, owedTold: false });
  const erasing = await erasingField(storeRef(store));
  const [, idKey] = storeIdCommand(store.sid);
  const idValue = String(redis.run(["GET", idKey]));
  /** The closing walk as it happens: the erasing mark, the identity gone, the plan lists pruned of the store's members. */
  const erase = async (members: string[]) => {
    await redis.pipeline([["HSET", ERASING_KEY, erasing, String(Date.now())], ["DEL", idKey], ["SREM", PENDING, ...members], ["ZREM", RETRY, ...members]]);
  };
  const restore = async () => {
    await redis.pipeline([["HDEL", ERASING_KEY, erasing], ["SET", idKey, idValue], ["DEL", RETRY, PENDING]]);
  };

  part("A live store: a plan Stripe could not settle is put back in the line of plans tried");
  stripeStatus = 500;
  const live = member("cs_test_planfencelive01", now);
  await redis.pipeline([["SADD", PENDING, live]]);
  await settlePlans(10);
  is("it is in the line of plans tried", retryMembers().length, 1);
  is("and no longer pending", pendingMembers().length, 0);
  await restore();

  part("The erasure begins while Stripe is asked: the plan is not put back");
  const late = member("cs_test_planfencelate01", now);
  await redis.pipeline([["SADD", PENDING, late]]);
  let undo = beforeRetryWrite(() => erase([late]));
  await settlePlans(10);
  undo();
  is("nothing of the erased store is in the line of plans tried", retryMembers(), []);
  is("nothing is pending", pendingMembers(), []);
  await restore();

  part("A plan refused for its give-up days, then erased: not put back, its creator not emailed");
  stripeStatus = 403;
  const stuck = member("cs_test_planfencestuck1", now - (PLAN_GIVE_UP_DAYS + 1) * DAY);
  await redis.pipeline([["ZADD", RETRY, now - 1, stuck]]);
  const before = emailsSent;
  undo = beforeRetryWrite(() => erase([stuck]));
  await settlePlans(10);
  undo();
  is("nothing of the erased store is in the line of plans tried", retryMembers(), []);
  is("its creator is not emailed about it", emailsSent - before, 0);
  await restore();

  part("A plan naming its store, put back: its commands stay within the registry's figures (PLAN_SETTLE_RUN)");
  stripeStatus = 500;
  const counted = member("cs_test_planfencecost01", now);
  await redis.pipeline([["SADD", PENDING, counted]]);
  const real = redis.pipeline.bind(redis);
  let commands = 0;
  redis.pipeline = (async (sent: (string | number)[][]) => {
    // A script counts as one command plus the calls inside it (tests/plan-cost-registry.ts): MOVE_IF_LIVE's GET, HGET, ZADD.
    commands += sent.reduce((n, c) => n + (String(c[1] ?? "").startsWith("-- marktmorgen:plan-move-if-live:v1") ? 4 : 1), 0);
    return real(sent);
  }) as typeof redis.pipeline;
  await settlePlans(10);
  redis.pipeline = real;
  is("it is put back", retryMembers().length, 1);
  is("within readCommandsPerRun + ownCommandsPerPlanTried", commands <= PLAN_SETTLE_RUN.readCommandsPerRun + PLAN_SETTLE_RUN.ownCommandsPerPlanTried, true);
  await restore();

  part("The same stuck plan on a live store is still kept and its creator still told");
  stripeStatus = 403;
  const kept = member("cs_test_planfencekept01", now - (PLAN_GIVE_UP_DAYS + 1) * DAY);
  await redis.pipeline([["ZADD", RETRY, now - 1, kept]]);
  const sentBefore = emailsSent;
  await settlePlans(10);
  is("it is kept in the line, marked told", retryMembers().map((m) => m.endsWith("|told")), [true]);
  is("its creator is emailed once", emailsSent - sentBefore, 1);

  done();
}

main();
