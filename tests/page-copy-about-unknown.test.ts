/**
 * A store copy reads each product's long description before the step's
 * first write (B2, Claude 1's focal on #2840, rule 30): an unknown answer to
 * that read is never "no description".
 *
 *   - a description read in an unknown shape fails the step (500): no draft
 *     product is left in the other store, the copy stays where it was, and
 *     the copy is never finished with the description silently missing;
 *   - a description read that throws (network) leaves no draft product
 *     either;
 *   - the same copy, tried again with the read known, copies the words.
 *
 * Synthetic stores only; the malformed answers are made by the in-memory
 * Redis, for a lone GET of the first store's description keys.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, createStore, ensureStatsId, setProductAbout, setStripeAccount, setSubscription, storeForEmail, storeForId, storeRef, type Store } from "@/lib/store";
import { productIds } from "@/lib/catalog";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readAbout, writeAbout } from "@/lib/product-about";
import { idFor } from "@/lib/store-copy";
import { POST as copyRoute } from "@/app/api/store/store-copy/route";
import { store as redis } from "./redis-stub";

const original = redis.pipeline.bind(redis);
let bad: { prefix: string; reply: unknown } | null = null;
let fail: string | null = null;
(redis as unknown as { pipeline: typeof original }).pipeline = async (cmds) => {
  const [first] = cmds;
  const lone = cmds.length === 1 && first[0] === "GET";
  if (fail && lone && String(first[1]).startsWith(fail)) throw new Error("synthetic network failure");
  if (bad && lone && String(first[1]).startsWith(bad.prefix)) return [bad.reply];
  return original(cmds);
};
const raw = async (key: string) => (await original([["GET", key]]))[0];
const aboutPrefix = (statsId: string) => `nl:product:about:${statsId}:`;
const MALFORMED: [string, unknown][] = [["a number", 1], ["a list", ["x"]], ["an object", { text: "x" }], ["no reply", undefined]];

const OWNER = "copy-about-owner@example.test";
const TEXT = "Every fictional recipe takes half an hour.";
const paid = { active: true, tier: "creator" as const, cycle: "month" as const, subscriptionId: null, customerId: null, trialEnds: 0 };

redis.clear();
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.STRIPE_SECRET_KEY = "sk_test_platform_only_a_stand_in";
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

const fixture = (async () => {
  await claimHandle(OWNER, "copyaboutfirst", "Fictional First", "Synthetic.");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_fixture778", true);
  await setSubscription(OWNER, paid);
  const second = await createStore(OWNER, "copyaboutsecond", "Fictional Second", "");
  if (!second.ok) throw new Error("no second store");
  await ensureStatsId(storeRef(second.store));
  await setSubscription(storeRef(second.store), paid);
  const guide = await addProduct(OWNER, "Fictional Guide", "Thirty dinners.", "19", null);
  if (!guide.ok) throw new Error("no product");
  const first = (await storeForEmail(OWNER))!;
  await writeAbout(first.statsId!, guide.product.id, TEXT, first);
  await setProductAbout(OWNER, guide.product.id, true);
  const session = await openSession(OWNER);
  const copy = async (body: Record<string, unknown>) => {
    const response = await copyRoute(new NextRequest("https://marktmorgen.com/api/store/store-copy", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": first.sid, cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  return { first: (await storeForEmail(OWNER))!, to: second.store.sid, guide: guide.product.id, copy };
})();

const COPY = "6".repeat(32);
const targetOf = async (sid: string): Promise<Store> => (await storeForId(sid))!;
const progressOf = async (sid: string) => JSON.parse(String(await raw(`nl:copy:${sid}:${COPY}`))) as { phase: string; cursor: number };

test("a copy step whose description read throws leaves no draft product", async () => {
  const { first, to, copy } = await fixture;
  fail = aboutPrefix(first.statsId!);
  let answer;
  try { answer = await copy({ action: "step", to, copy: COPY }); }
  finally { fail = null; }
  assert.equal(answer.status, 500);
  assert.deepEqual(productIds(await targetOf(to)), [], "no draft product without its description is left in the other store");
  assert.deepEqual([(await progressOf(to)).phase, (await progressOf(to)).cursor], ["products", 0]);
});

test("a copy step whose description read is in an unknown shape fails and leaves no draft product", async () => {
  const { first, to, copy } = await fixture;
  for (const [label, reply] of MALFORMED) {
    bad = { prefix: aboutPrefix(first.statsId!), reply };
    let answer;
    try { answer = await copy({ action: "step", to, copy: COPY }); }
    finally { bad = null; }
    assert.equal(answer.status, 500, `${label}: the step is not answered done with the description missing`);
    assert.equal(answer.body.error, "server_error", label);
    assert.deepEqual(productIds(await targetOf(to)), [], `${label}: no draft product is left in the other store`);
    const progress = await progressOf(to);
    assert.deepEqual([progress.phase, progress.cursor], ["products", 0], `${label}: the copy stays before that product`);
  }
});

test("the same copy, tried again with the read known, copies the description", async () => {
  const { first, to, guide, copy } = await fixture;
  const answer = await copy({ action: "step", to, copy: COPY });
  assert.equal(answer.status, 200);
  const target = await targetOf(to);
  assert.equal(await readAbout(target.statsId, idFor(COPY, "p", guide)), TEXT);
  assert.equal(await readAbout(first.statsId, guide), TEXT, "the first store's description is as it was");
});
