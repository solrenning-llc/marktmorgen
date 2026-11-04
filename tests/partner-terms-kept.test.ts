/**
 * 630 [HN6](39), unit 2: a partner's agreement kept on their record. A new
 * share starts at once; ending one that runs until revoked applies at once;
 * any other change waits for the partner, who says yes (cap checked again)
 * or no; an unanswered change lapses after 30 days; saving the share in force
 * withdraws a waiting change; every step is in the history. Synthetic store.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { answerShareChange, changeIdentity, decide, decideMany, proposePartnerShare, readAffiliate } from "@/lib/affiliates";
import { CHANGE_WAITS_SECONDS } from "@/lib/partner-terms-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const A = "prodaaaaaa";
const B = "prodbbbbbb";
const DAY = 86400;
const NOW = Date.UTC(2026, 10, 3, 12) / 1000;

async function main(): Promise<void> {
  redis.clear();
  const owner = "partnerterms@example.com";
  await claimHandle(owner, "partnerterms", "Partner Terms", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Termsxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_terms", subscriptionId: "sub_terms", active: true, tier: "creator", period: paidPeriod() });
  const person = (id: string) => ({ id, email: `${id}@example.com`, code: `c${id}`, status: "approved", appliedAt: 1, decidedAt: 5, note: "", rate: null, paypal: "", share: null, cleared: null, by: null });
  const [p, q] = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  for (const one of [person(p), person(q)]) await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, one.id, JSON.stringify(one)]]);
  const store = async () => (await storeForEmail(owner))!;
  const read = async (id: string) => (await readAffiliate(await store(), id))!;
  const yes = async () => true;
  // What the partner's page sends with an answer: the identity of the change it showed.
  const seen = async (id: string) => {
    const change = (await read(id)).terms?.change;
    return change ? changeIdentity(change) : "";
  };

  part("Starting and ending a share that runs until revoked");
  is("an unknown partner", await proposePartnerShare(await store(), "cccccccccccc", null, NOW), { ok: false, reason: "unknown" });
  is("a new share starts at once", await proposePartnerShare(await store(), p, { percent: 30, products: [A] }, NOW), { ok: true, state: "started" });
  is("it is in force", (await read(p)).share, { percent: 30, products: [A] });
  is("saving it again changes nothing", await proposePartnerShare(await store(), p, { percent: 30, products: [A] }, NOW + 1), { ok: true, state: "same" });
  is("ending it applies at once", await proposePartnerShare(await store(), p, null, NOW + 2), { ok: true, state: "applied" });
  const ended = await read(p);
  is("no share, and the history says started then ended", [ended.share, ended.terms?.history.map((s) => `${s.kind}:${s.by}`)], [null, ["started:creator", "revoked:creator"]]);

  part("A change waits for the partner");
  const until = NOW + 200 * DAY;
  await proposePartnerShare(await store(), q, { percent: 40, products: [A, B], until }, NOW);
  is("lowering it waits", await proposePartnerShare(await store(), q, { percent: 20, products: [A, B], until }, NOW + 10), { ok: true, state: "waiting" });
  const waiting = await read(q);
  is("the share in force does not move", waiting.share, { percent: 40, products: [A, B], until });
  is("the change is kept with when it was asked", waiting.terms?.change, { share: { percent: 20, products: [A, B], until }, asked: NOW + 10 });
  is("the partner says no", await answerShareChange(await store(), q, false, await seen(q), NOW + 20, yes), { ok: true, state: "declined" });
  is("the terms before it hold", [(await read(q)).share?.percent, (await read(q)).terms?.change], [40, null]);
  is("nothing left to answer", await answerShareChange(await store(), q, true, await seen(q), NOW + 21, yes), { ok: false, reason: "none" });

  part("Ending a dated share early needs a yes too, and the cap is checked again");
  is("ending it waits", await proposePartnerShare(await store(), q, null, NOW + 30), { ok: true, state: "waiting" });
  is("still in force meanwhile", (await read(q)).share?.percent, 40);
  is("yes ends it", await answerShareChange(await store(), q, true, await seen(q), NOW + 40, yes), { ok: true, state: "changed" });
  is("ended", (await read(q)).share, null);
  await proposePartnerShare(await store(), q, { percent: 10, products: [A] }, NOW + 50);
  await proposePartnerShare(await store(), q, { percent: 60, products: [A] }, NOW + 60);
  is("a yes the cap no longer allows is refused, and the change stays", [await answerShareChange(await store(), q, true, await seen(q), NOW + 70, async () => false), (await read(q)).share?.percent, Boolean((await read(q)).terms?.change)], [{ ok: false, reason: "cap" }, 10, true]);
  is("saving the share in force withdraws the change", [await proposePartnerShare(await store(), q, { percent: 10, products: [A] }, NOW + 80), (await read(q)).terms?.change], [{ ok: true, state: "same" }, null]);

  part("An unanswered change lapses after 30 days");
  await proposePartnerShare(await store(), q, { percent: 15, products: [A] }, NOW + 90);
  is("too late to answer", await answerShareChange(await store(), q, true, await seen(q), NOW + 90 + CHANGE_WAITS_SECONDS, yes), { ok: false, reason: "none" });
  const lapsed = await read(q);
  is("the share stays, and the lapse is written down", [lapsed.share?.percent, lapsed.terms?.change, lapsed.terms?.history.at(-1)?.kind], [10, null, "lapsed"]);
  is("the history in order", lapsed.terms?.history.map((s) => s.kind), ["started", "asked", "declined", "asked", "changed", "started", "asked", "withdrawn", "asked", "lapsed"]);
  part("A yes applies only to the change the partner read");
  const r = "cccccccccccc";
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, r, JSON.stringify(person(r))]]);
  await proposePartnerShare(await store(), r, { percent: 10, products: [A], until }, NOW);
  await proposePartnerShare(await store(), r, { percent: 30, products: [A], until }, NOW + 100);
  const read30 = await seen(r);
  await proposePartnerShare(await store(), r, { percent: 5, products: [A], until }, NOW + 100);
  is("the store replaced its 30% request with 5% in the same second", (await read(r)).terms?.change?.share?.percent, 5);
  is("a yes to the 30% the partner read is refused", await answerShareChange(await store(), r, true, read30, NOW + 110, yes), { ok: false, reason: "none" });
  is("a no to it is refused too", await answerShareChange(await store(), r, false, read30, NOW + 110, yes), { ok: false, reason: "none" });
  is("and nothing changed", [(await read(r)).share?.percent, (await read(r)).terms?.change?.share?.percent], [10, 5]);
  is("an answer with no identity is refused", await answerShareChange(await store(), r, true, "", NOW + 111, yes), { ok: false, reason: "none" });
  is("a yes to the 5% now shown applies 5%", [await answerShareChange(await store(), r, true, await seen(r), NOW + 120, yes), (await read(r)).share?.percent], [{ ok: true, state: "changed" }, 5]);

  part("A dated share in force is not removed by the store alone");
  const [d, u, x] = ["dddddddddddd", "eeeeeeeeeeee", "ffffffffffff"];
  for (const id of [d, u, x]) await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, id, JSON.stringify(person(id))]]);
  const T = Math.floor(Date.now() / 1000);
  await proposePartnerShare(await store(), d, { percent: 20, products: [A], until: T + 60 * DAY }, T);
  await proposePartnerShare(await store(), u, { percent: 20, products: [B] }, T);
  await proposePartnerShare(await store(), x, { percent: 20, products: [B], until: T + 60 * DAY }, T);
  is("remove is refused", await decide(await store(), d, "remove", T + 1), null);
  is("decline is refused too", await decide(await store(), d, "decline", T + 1), null);
  is("they stay approved, with their share and no new step", [(await read(d)).status, (await read(d)).share?.percent, (await read(d)).terms?.history.length], ["approved", 20, 1]);
  is("in bulk it is never touched either", [await decideMany(await store(), [d], "decline"), (await read(d)).status], [[], "approved"]);
  const untilRevoked = await decide(await store(), u, "remove", T + 2);
  is("a share until revoked can be removed", [untilRevoked?.status, untilRevoked?.share], ["removed", null]);
  is("and the history says the store ended it", (await read(u)).terms?.history.map((s) => `${s.kind}:${s.by}`), ["started:creator", "revoked:creator"]);
  const after = await decide(await store(), x, "remove", T + 61 * DAY);
  is("after the end date it can be removed", [after?.status, after?.share], ["removed", null]);
  is("with the step in its history", (await read(x)).terms?.history.at(-1)?.kind, "revoked");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
