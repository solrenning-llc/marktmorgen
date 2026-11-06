/**
 * Sweep app1 proof (CX-123 rules 24 and 30), synthetic only, through app/api/store/affiliates/route.ts.
 *
 * Part 1 (ALTO, money). The cap on what a sale may promise (partners plus the affiliate commission, at most
 * MAX_COMMITTED_SHARE = 90%, lib/partner-share.ts:119-138) is checked against `listPartners(store)` at route lines
 * 236 (invite) and 275 (share). listPartners is listAffiliates (lib/affiliates.ts:526-533), whose `pairs`
 * (:519-524) reads a reply that is not an array as no affiliates at all. An unknown HGETALL therefore checks the cap
 * against nobody, and a second partner is given 80% of a product that already promises 80% to another: every sale
 * then credits 160% of itself to partners, owed by the creator.
 *
 * Part 2 (MÉDIO). Saving the program's terms re-reads the store at route line 106
 * `const before = (await storeForEmail(guarded.ref))?.affiliates ?? null;` although the guard already read it
 * (guarded.store). An unknown read (storeForEmail answers null, lib/store.ts:1087-1100, root already in
 * claude5/sweep-a5) makes `before` null, and the plan at :109-111 takes the cut at once with nothing pending: the
 * notice the affiliates were promised (630 [HN6](2)) is skipped.
 *
 * Part 3 (MÉDIO, rule 30 caller of the storeForId root in claude5/sweep-a5 finding 3). Answering an invitation,
 * route lines 219-222: `storeForId(invite.sid).catch(() => null)`; on null the invitation is deleted (answerInvite,
 * HDEL) and the invited creator is told "gone", although the inviting store is there. The offer cannot be answered
 * again.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { acceptPartnership, listAffiliates, readAffiliate } from "@/lib/affiliates";
import { offerPartnership, waitingFor } from "@/lib/partner-invites";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
let breakWhat: "none" | "people" | "reread" | "storeid-lost" | "storeid-throws" = "none";
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (breakWhat === "people" && one?.[0] === "HGETALL" && String(one[1]).startsWith("nl:aff:")) { await real(commands); return ["QUEUED"]; }
  if (breakWhat === "reread" && one?.[0] === "GET" && String(one[1]).startsWith("nl:store:owner:") && /storeForEmail[^\n]*\n\s+at async POST/.test(new Error().stack ?? "")) return [];
  if (breakWhat.startsWith("storeid") && one?.[0] === "GET" && String(one[1]).startsWith("nl:store:id:")) {
    if (breakWhat === "storeid-throws") throw new Error("Synthetic Redis failure reading the store id");
    return [];
  }
  return real(commands);
}) as typeof redis.pipeline;

async function shop(owner: string, handle: string) {
  await claimHandle(owner, handle, `${handle} store`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1${handle.padEnd(15, "x").slice(0, 15)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(owner);
  const post = async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; accepted?: boolean } };
  };
  return { post };
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "partners@example.com";
  const a = await shop(owner, "partnershop");
  const made = await addProduct(owner, "Knife Skills", "", "40");
  const product = made.ok ? made.product.id : "";
  const terms = { action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 5, days: 60, rates: {} as Record<string, number> };
  is("(the program is on, 5% to affiliates)", (await a.post(terms)).body.ok, true);
  const store = (await storeForEmail(owner))!;
  const first = await acceptPartnership(store, "first@example.com", { percent: 80, products: [product] });
  const second = await acceptPartnership(store, "second@example.com", { percent: 1, products: [product] });
  if (!first.ok || !second.ok) throw new Error("no partners");

  part("1. Healthy control: a second partner cannot be promised 80% of a product already promising 80%");
  const refused = await a.post({ action: "share", id: second.affiliate.id, percent: 80, products: [product] });
  is("refused by the cap", [refused.status, refused.body.error], [400, "share_committed"]);
  is("the second partner keeps 1%", (await readAffiliate(store, second.affiliate.id))?.share?.percent, 1);

  part("1. DEFECT: the list of partners answered in an unknown shape");
  breakWhat = "people";
  is("DEFECT: the list reads as nobody", (await listAffiliates(store)).length, 0);
  const saved = await a.post({ action: "share", id: second.affiliate.id, percent: 80, products: [product] });
  breakWhat = "none";
  is("DEFECT: the share is saved", [saved.status, saved.body.ok], [200, true]);
  const promised = (await listAffiliates(store)).reduce((sum, p) => sum + (p.share?.products.includes(product) ? p.share.percent : 0), 0);
  is("DEFECT: every sale of the product now promises partners 160% of itself (plus 5% commission)", promised, 160);

  part("2. Healthy control: a cut saved with 30 days' notice waits");
  await a.post({ ...terms, percent: 30, notice: 30 });
  is("saved with notice", (await a.post({ ...terms, percent: 10, notice: 30 })).body.ok, true);
  const waiting = (await storeForEmail(owner))!.affiliates;
  is("today 30%, 10% pending", [waiting.percent, waiting.pending?.percent], [30, 10]);

  part("2. DEFECT: the route's second read of the store is lost");
  await a.post({ ...terms, percent: 30, notice: 30 });
  is("(back to 30%, nothing pending)", [(await storeForEmail(owner))!.affiliates.percent, (await storeForEmail(owner))!.affiliates.pending ?? null], [30, null]);
  breakWhat = "reread";
  const cut = await a.post({ ...terms, percent: 10, notice: 30 });
  breakWhat = "none";
  const now = (await storeForEmail(owner))!.affiliates;
  is("DEFECT: saved", cut.body.ok, true);
  is("DEFECT: the cut is in force at once, nothing pending, the promised notice skipped", [now.percent, now.pending ?? null], [10, null]);

  part("3. Healthy control and DEFECT: answering an invitation while the inviting store's id read is lost or fails");
  const invited = "guest@example.com";
  const b = await shop(invited, "guestshop");
  const offer = async () => {
    const o = await offerPartnership(invited, { sid: store.sid, storeName: store.name, handle: store.handle, share: { percent: 5, products: [product] }, titles: ["Knife Skills"] });
    if (!o.ok) throw new Error("no offer");
    return o.id;
  };
  const decline = await b.post({ action: "answer", invite: await offer(), accept: false });
  is("control: a declined offer is answered and taken out", [decline.body.ok, (await waitingFor(invited)).length], [true, 0]);
  for (const as of ["storeid-lost", "storeid-throws"] as const) {
    const id = await offer();
    breakWhat = as;
    const answered = await b.post({ action: "answer", invite: id, accept: true });
    breakWhat = "none";
    is(`DEFECT (${as}): the creator accepting is told the offer is gone`, [answered.status, answered.body.error], [400, "gone"]);
    is(`DEFECT (${as}): and the offer is deleted, so it cannot be accepted again`, (await waitingFor(invited)).length, 0);
  }
  is("while the inviting store is there", (await storeForEmail(owner))?.sid, store.sid);
  done();
}
main();
