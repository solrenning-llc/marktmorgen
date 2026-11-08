/**
 * A lead's write read in its exact shape (CX-123 rule 24, audit round 7, finding 4). recordLead takes the lead's
 * room in the store's data room first, then writes it with HSETNX. It used to read the reply as Number(won) !== 1:
 * a reply of another shape (one that may well have written the lead) gave the room back and answered "duplicate",
 * so a lead that exists, and earns its affiliate a commission, was left out of what the store's room counts. Now
 * only 1 is "recorded" and only 0 is "duplicate" (the room given back); anything else keeps the room and answers
 * "unavailable", the answer recordLead already gives when a lead cannot be written. Synthetic only: the in-memory
 * Redis double, through the real lib/affiliate-leads.ts and lib/store-data.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { claimHandle, ensureStatsId, setAffiliateSetting, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { readLeads, recordLead } from "@/lib/affiliate-leads";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "lead-owner@example.com";
const ANA = "aaaaaaaaaaaa";
const NOW = Math.floor(Date.now() / 1000);

const real = redis.pipeline.bind(redis);
let hsetnxReply: { reply: unknown } | null = null;
let hsetnxSeen = 0;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (hsetnxReply && one?.[0] === "HSETNX" && /^nl:aff:[^:]+:leads$/.test(String(one[1]))) {
    hsetnxSeen += 1;
    // The write lands; only its reply is of another shape.
    await real(commands);
    return hsetnxReply.reply as unknown[];
  }
  return real(commands);
}) as typeof redis.pipeline;

let ready: Promise<Store> | null = null;
function program(): Promise<Store> {
  ready ??= (async () => {
    redis.clear();
    await claimHandle(OWNER, "leadroom", "Lead Room", "");
    await ensureStatsId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_LeadRoom0001", subscriptionId: "sub_LeadRoom0001", active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
    await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, lead: { kind: "signup", cents: 300, hold: 14, daily: 5, budget: 10_000 } });
    const store = (await storeForEmail(OWNER))!;
    const person = { id: ANA, email: "ana@affiliate.example", code: "ana", status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" };
    await redis.pipeline([
      ["HSET", `nl:aff:${store.statsId}:people`, ANA, JSON.stringify(person)],
      ["HSET", `nl:aff:${store.statsId}:codes`, "ana", ANA],
    ]);
    return store;
  })();
  return ready;
}

async function used(store: Store): Promise<number> {
  const room = await dataUsed(store);
  assert.ok(room, "the store's room reads");
  return room.used;
}

let n = 0;
const UNKNOWN: [string, unknown][] = [
  ["the text \"1\"", ["1"]],
  ["true", [true]],
  ["nil", [null]],
  ["an undefined slot", [undefined]],
  ["no slot", []],
  ["two slots", [1, 1]],
  ["2", [2]],
  ["a list", [[1]]],
  ["a pipeline that is not a list", "OK"],
];

for (const [label, reply] of UNKNOWN) {
  test(`recordLead keeps the room and answers "unavailable" when HSETNX answers ${label}`, async () => {
    const store = await program();
    const before = await used(store);
    hsetnxReply = { reply };
    hsetnxSeen = 0;
    let result: string;
    try {
      result = await recordLead(store, { aff: ANA, kind: "signup", email: `unknown${(n += 1)}@buyer.example` });
    } finally {
      hsetnxReply = null;
    }
    assert.equal(hsetnxSeen, 1, "the lead's write is exercised");
    assert.equal(result, "unavailable", "never \"duplicate\" on a write that may have landed");
    assert.ok((await used(store)) > before, "the room taken for the lead is kept, never given back for a lead that may exist");
  });
}

test("a new lead is still recorded and counted, and the same person again is a duplicate whose room is given back (control)", async () => {
  const store = await program();
  const before = await used(store);
  assert.equal(await recordLead(store, { aff: ANA, kind: "signup", email: "fresh@buyer.example" }), "recorded");
  const after = await used(store);
  assert.ok(after > before, "the recorded lead is counted");
  assert.equal(await recordLead(store, { aff: ANA, kind: "signup", email: "fresh@buyer.example" }), "duplicate");
  assert.equal(await used(store), after, "a duplicate's room is given back");
  assert.ok((await readLeads(store)).some((lead) => lead.email === "fresh@buyer.example"));
});
