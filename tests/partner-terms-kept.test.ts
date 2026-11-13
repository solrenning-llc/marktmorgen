/**
 * 630 [HN6](39), unit 2: a partner's agreement kept on their record. A new
 * share starts at once; ending one that runs until revoked applies at once;
 * any other change waits for the partner, who says yes (cap checked again)
 * or no; an unanswered change lapses after 30 days; saving the share in force
 * withdraws a waiting change; every step is in the history. Synthetic store.
 *
 * Ported onto main's write path (#1924): answers are taken under the program's partner lock and checked against the
 * people read exactly (no `allowed` callback); a dated share in force refuses a removal with ShareTermError; taking a
 * partner out keeps their share on the record, as main does, and only takes back a change still waiting.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { ShareTermError, answerShareChange, changeIdentity, decide, decideMany, proposePartnerShare, readAffiliate, setPartnerShare, undoMany, withPartnerLock } from "@/lib/affiliates";
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
  // What the store refusing a removal answers (ShareTermError), as the studio route maps it.
  const decided = (id: string, decision: "remove" | "decline", at: number) =>
    decide(storeNow!, id, decision, undefined, at).then(
      (affiliate) => affiliate,
      (error: unknown) => (error instanceof ShareTermError ? ("term" as const) : Promise.reject(error)),
    );
  let storeNow: Awaited<ReturnType<typeof store>> | null = null;
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
  is("the partner says no", await answerShareChange(await store(), q, false, await seen(q), NOW + 20), { ok: true, state: "declined" });
  is("the terms before it hold", [(await read(q)).share?.percent, (await read(q)).terms?.change], [40, null]);
  is("nothing left to answer", await answerShareChange(await store(), q, true, await seen(q), NOW + 21), { ok: false, reason: "none" });

  part("Ending a dated share early needs a yes too, and the cap is checked again");
  is("ending it waits", await proposePartnerShare(await store(), q, null, NOW + 30), { ok: true, state: "waiting" });
  is("still in force meanwhile", (await read(q)).share?.percent, 40);
  is("yes ends it", await answerShareChange(await store(), q, true, await seen(q), NOW + 40), { ok: true, state: "changed" });
  is("ended", (await read(q)).share, null);
  await proposePartnerShare(await store(), q, { percent: 10, products: [A] }, NOW + 50);
  await proposePartnerShare(await store(), q, { percent: 60, products: [A] }, NOW + 60);
  // Another partner given 50% of A since: 60% + 50% passes the cap, read exactly under the partner lock.
  await setPartnerShare(await store(), p, { percent: 50, products: [A] });
  is("a yes the cap no longer allows is refused, and the change stays", [await answerShareChange(await store(), q, true, await seen(q), NOW + 70), (await read(q)).share?.percent, Boolean((await read(q)).terms?.change)], [{ ok: false, reason: "cap" }, 10, true]);
  await setPartnerShare(await store(), p, null);
  is("saving the share in force withdraws the change", [await proposePartnerShare(await store(), q, { percent: 10, products: [A] }, NOW + 80), (await read(q)).terms?.change], [{ ok: true, state: "same" }, null]);

  part("An unanswered change lapses after 30 days");
  await proposePartnerShare(await store(), q, { percent: 15, products: [A] }, NOW + 90);
  is("too late to answer", await answerShareChange(await store(), q, true, await seen(q), NOW + 90 + CHANGE_WAITS_SECONDS), { ok: false, reason: "none" });
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
  is("a yes to the 30% the partner read is refused", await answerShareChange(await store(), r, true, read30, NOW + 110), { ok: false, reason: "none" });
  is("a no to it is refused too", await answerShareChange(await store(), r, false, read30, NOW + 110), { ok: false, reason: "none" });
  is("and nothing changed", [(await read(r)).share?.percent, (await read(r)).terms?.change?.share?.percent], [10, 5]);
  is("an answer with no identity is refused", await answerShareChange(await store(), r, true, "", NOW + 111), { ok: false, reason: "none" });
  is("a yes to the 5% now shown applies 5%", [await answerShareChange(await store(), r, true, await seen(r), NOW + 120), (await read(r)).share?.percent], [{ ok: true, state: "changed" }, 5]);

  part("A dated share in force is not removed by the store alone");
  const [d, u, x] = ["dddddddddddd", "eeeeeeeeeeee", "ffffffffffff"];
  for (const id of [d, u, x]) await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, id, JSON.stringify(person(id))]]);
  const T = Math.floor(Date.now() / 1000);
  await proposePartnerShare(await store(), d, { percent: 20, products: [A], until: T + 60 * DAY }, T);
  await proposePartnerShare(await store(), u, { percent: 20, products: [B] }, T);
  await proposePartnerShare(await store(), x, { percent: 20, products: [B], until: T + 60 * DAY }, T);
  storeNow = await store();
  is("remove is refused", await decided(d, "remove", T + 1), "term");
  is("decline is refused too", await decided(d, "decline", T + 1), "term");
  is("they stay approved, with their share and no new step", [(await read(d)).status, (await read(d)).share?.percent, (await read(d)).terms?.history.length], ["approved", 20, 1]);
  is("in bulk it is never touched either (only those waiting are, and d is approved)", [(await decideMany(await store(), [d], "decline")).before, (await read(d)).status], [[], "approved"]);
  const untilRevoked = await decided(u, "remove", T + 2);
  // As main does: the share stays on the record, earning nothing while they are out (notePartners credits the
  // approved only), and checked against the cap again if they are let back in (decide).
  is("a share until revoked can be removed", [untilRevoked !== "term" && untilRevoked?.status, untilRevoked !== "term" && untilRevoked?.share?.percent], ["removed", 20]);
  is("and the history keeps only how it started", (await read(u)).terms?.history.map((s) => `${s.kind}:${s.by}`), ["started:creator"]);
  const after = await decided(x, "remove", T + 61 * DAY);
  is("after the end date it can be removed, the share left as it ended", [after !== "term" && after?.status, after !== "term" && after?.share?.until], ["removed", T + 60 * DAY]);
  is("with no step saying the store ended it: it ended on its date", (await read(x)).terms?.history.map((s) => s.kind), ["started"]);

  part("Refused under the lock, with its own reason, whatever the status");
  const w = "abababababab";
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, w, JSON.stringify({ ...person(w), status: "pending", share: { percent: 10, products: [A], until: T + 30 * DAY } })]]);
  is("somebody waiting who holds a dated share in force is not declined", await decided(w, "decline", T + 1), "term");
  is("nor in bulk: left out, and said why", (await decideMany(await store(), [w], "decline")).held.map((one) => one.why), ["term"]);
  is("the dated partner's removal says why", await decided(d, "remove", T + 1), "term");
  is("an unknown one is not there", await decided("acacacacacac", "remove", T + 1), null);

  part("An undo never sends a partner back to waiting");
  const v = "bcbcbcbcbcbc";
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, v, JSON.stringify({ ...person(v), status: "pending", decidedAt: 0 })]]);
  const before = (await decideMany(await store(), [v], "approve")).before;
  is("approved in bulk", (await read(v)).status, "approved");
  await proposePartnerShare(await store(), v, { percent: 15, products: [A], until: T + 60 * DAY }, T + 3);
  is("the undo leaves a partner given a dated share since as they are", [(await undoMany(await store(), before, "approve")).undone, (await read(v)).status], [0, "approved"]);
  is("so they cannot then be declined around their term", await decided(v, "decline", T + 4), "term");
  const v2 = "cdcdcdcdcdcd";
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, v2, JSON.stringify({ ...person(v2), status: "pending", decidedAt: 0 })]]);
  const before2 = (await decideMany(await store(), [v2], "approve")).before;
  is("an approval with nothing given since is still undone", [(await undoMany(await store(), before2, "approve")).undone, (await read(v2)).status], [1, "pending"]);

  part("Someone removed has nothing left to answer");
  const z = "dededededede";
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, z, JSON.stringify(person(z))]]);
  await proposePartnerShare(await store(), z, { percent: 20, products: [B], until: T + 60 * DAY }, T);
  await proposePartnerShare(await store(), z, { percent: 25, products: [B], until: T + 60 * DAY }, T + 5);
  const zSeen = await seen(z);
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, z, JSON.stringify({ ...(await read(z)), status: "removed" })]]);
  is("a yes from a removed partner is refused", await answerShareChange(await store(), z, true, zSeen, T + 6), { ok: false, reason: "none" });

  part("Two changes to one partner at the same instant: neither is lost");
  const c = "efefefefefef";
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, c, JSON.stringify(person(c))]]);
  await proposePartnerShare(await store(), c, { percent: 10, products: [B], until: T + 60 * DAY }, T);
  await proposePartnerShare(await store(), c, { percent: 30, products: [B], until: T + 60 * DAY }, T + 1);
  const cSeen = await seen(c);
  // The yes and a new request at the same instant, each under the program's partner lock as the routes take it.
  const shop = await store();
  const [answered, asked] = await Promise.all([
    answerShareChange(shop, c, true, cSeen, T + 2),
    withPartnerLock(shop, () => proposePartnerShare(shop, c, { percent: 50, products: [B], until: T + 60 * DAY }, T + 2)),
  ]);
  const cNow = await read(c);
  is("both done, one after the other", [answered.ok, asked.ok], [true, true]);
  is("the new request is still waiting, not dropped by the yes", cNow.terms?.change?.share?.percent, 50);
  is("and the yes took 30%", cNow.share?.percent, 30);
  // A share until revoked, a raise waiting, and the store removing them while they say yes.
  const e = "fafafafafafa";
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, e, JSON.stringify(person(e))]]);
  await proposePartnerShare(await store(), e, { percent: 10, products: [B] }, T);
  await proposePartnerShare(await store(), e, { percent: 40, products: [B] }, T + 1);
  const eSeen = await seen(e);
  await Promise.all([answerShareChange(shop, e, true, eSeen, T + 2), decide(shop, e, "remove", undefined, T + 2)]);
  const eEnd = await read(e);
  // Each writes over exactly the record it read (changeAffiliate): the yes never puts the removed partner back in.
  is("a removal racing a yes is never undone by it", eEnd.status, "removed");
  is("and nothing is left waiting for an answer", eEnd.terms?.change ?? null, null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
