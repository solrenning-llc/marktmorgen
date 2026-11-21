/**
 * A trial nudge is never sent, and its mark never taken, for a store that was erased, deleted or moved while the job
 * still held its old Store (Codex X5, X5-20261120-2300-fix-main-trial-nudge-erasure.md; board #5010 row 4): the job
 * reads the store and its first sale, then takes nl:nudge:<sub>:<n>, so the mark is taken through
 * claimWhileStoreLive (lib/store-live-cache.ts), which checks the store's identity and its erasing field in the same
 * Redis step. The state changes just before the claim, as a slow read would let it. Synthetic store, the tests'
 * in-memory Redis, stubbed Stripe and email only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { claimHandle, ensureStatsId, ERASING_KEY, erasingField, moveAccount, ownerKey, setSubscription, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { sendTrialNudges } from "@/lib/trial-nudges";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_trial_live_claim_only";
process.env.RESEND_API_KEY = "re_test_trial_nudges_only";
const START = 1_791_000_000;
const DAY = 86_400;
const emails: string[] = [];
let trials: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/subscriptions") return Response.json({ data: trials, has_more: false });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body));
    emails.push(Array.isArray(body.to) ? body.to[0] : body.to);
    return Response.json({ id: "re_synthetic" });
  }
  throw new Error(`unexpected synthetic fetch ${url.hostname}${url.pathname}`);
}) as typeof fetch;

let sequence = 0;
async function setup(legacy = false) {
  redis.clear();
  emails.length = 0;
  sequence += 1;
  const email = `trial-live-${sequence}@example.invalid`;
  const handle = `triallive${sequence}`;
  const sub = `sub_TrialLive${String(sequence).padStart(6, "0")}`;
  await claimHandle(email, handle, "Synthetic trial", "");
  await ensureStatsId(email);
  await setSubscription(email, { subscriptionId: sub, active: true, tier: "creator", cycle: "month", trialEnds: START + 14 * DAY, period: paidPeriod() });
  let shop = (await storeForEmail(email))!;
  if (legacy) {
    const key = await ownerKey(storeRef(shop));
    const raw = JSON.parse(String(redis.run(["GET", key])));
    raw.sid = "";
    redis.run(["SET", key, JSON.stringify(raw)]);
    shop = (await storeForEmail(email))!;
    assert.equal(shop.sid, "");
  }
  trials = [{ id: sub, status: "trialing", trial_start: START, trial_end: START + 14 * DAY, cancel_at_period_end: false, metadata: { store: handle } }];
  return { shop, sub, mark: `nl:nudge:${sub}:0`, email };
}

/** The command that takes a nudge's mark: a bare SET NX before this fix, the store-live claim after it. */
const takesMark = (c: (string | number)[]) =>
  (c[0] === "SET" && String(c[1]).startsWith("nl:nudge:")) ||
  (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-claim-live:v1\n") && String(c[5]).startsWith("nl:nudge:"));

const run = () => sendTrialNudges(START + 3 * DAY, Date.now() + 15_000);

for (const mode of ["erasing", "deleted", "moved", "moved-erasing", "legacy-erasing", "legacy-deleted", "legacy-reused"]) {
  test(`${mode}: no nudge sent and no mark taken for the stale store`, async () => {
    const { shop, mark, email } = await setup(mode.startsWith("legacy"));
    const original = redis.pipeline.bind(redis);
    let cut = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!cut && commands.some(takesMark)) {
        cut = true;
        const key = await ownerKey(storeRef(shop));
        if (mode === "erasing" || mode === "legacy-erasing") await original([["HSET", ERASING_KEY, await erasingField(storeRef(shop)), "1"]]);
        else if (mode === "deleted") await original([["DEL", storeIdCommand(shop.sid)[1]]]);
        else if (mode === "moved" || mode === "moved-erasing") {
          const next = `trial-moved-${sequence}@example.invalid`;
          assert.equal((await moveAccount(email, next)).ok, true);
          if (mode === "moved-erasing") await original([["HSET", ERASING_KEY, await erasingField(next), "1"]]);
        } else if (mode === "legacy-deleted") await original([["DEL", key]]);
        else if (mode === "legacy-reused") await original([["SET", key, JSON.stringify({ statsId: "e".repeat(32) })]]);
      }
      return original(commands);
    }) as typeof redis.pipeline;
    let result;
    try {
      result = await run();
    } finally {
      redis.pipeline = original;
    }
    assert.equal(cut, true, "the claim was reached");
    assert.equal(result.sent, 0);
    assert.deepEqual(emails, []);
    assert.equal(redis.run(["EXISTS", mark]), 0, "no mark for the stale store");
  });
}

for (const legacy of [false, true]) {
  test(`${legacy ? "a store from before ids" : "a store with an id"}, live: the nudge goes once and its mark is kept 60 days`, async () => {
    const { email, mark } = await setup(legacy);
    assert.equal((await run()).sent, 1);
    assert.deepEqual(emails, [email]);
    assert.equal(redis.run(["TTL", mark]), 60 * DAY);
    assert.equal((await run()).sent, 0);
    assert.deepEqual(emails, [email]);
  });
}

for (const mode of ["lost-applied", "lost-other"]) {
  test(`${mode}: a claim whose reply is lost is read back by its value`, async () => {
    const { email, mark } = await setup();
    const original = redis.pipeline.bind(redis);
    let claims = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some(takesMark)) {
        claims += 1;
        if (mode === "lost-other") await original([["SET", mark, "another", "EX", 600]]);
        else await original(commands);
        return [];
      }
      return original(commands);
    }) as typeof redis.pipeline;
    let result;
    try {
      result = await run();
    } finally {
      redis.pipeline = original;
    }
    assert.equal(claims, 1, "the uncertain claim is not sent again");
    assert.equal(result.sent, mode === "lost-applied" ? 1 : 0);
    assert.deepEqual(emails, mode === "lost-applied" ? [email] : []);
    if (mode === "lost-other") assert.equal(redis.run(["GET", mark]), "another");
  });
}
