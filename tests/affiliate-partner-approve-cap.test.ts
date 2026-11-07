/**
 * The 90% cap on what one sale may promise (partners plus the affiliate commission, lib/partner-share.ts) is checked
 * again whenever somebody holding a share becomes approved, not only when the share is set or accepted (#2995, rule
 * 30: the sibling paths of the acceptance fix in tests/affiliate-partner-accept-cap.test.ts). Synthetic only: the
 * in-memory Redis double and a stand-in for Stripe's checkout sessions, through the real route.
 *
 * The cap counts approved partners only, so a share on a removed or pending person is not counted. Before:
 *   - restoring a removed partner put their share back as it was, whatever the others held since;
 *   - approving a pending person who held a share (one at a time or in bulk) did the same;
 *   - a buyer taking their own link approved a pending person, share included.
 * Now each re-reads the program's people exactly and re-checks the cap under the program's partner lock: over it,
 * 409 (or, in bulk and for a buyer, left pending), nothing written; unknown reply or the lock held elsewhere, 503,
 * nothing written.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { acceptPartnership, joinAsBuyer, listAffiliates, openAffiliateLink, readAffiliate } from "@/lib/affiliates";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_partner_approve_only";
process.env.STRIPE_SECRET_KEY = "sk_test_partner_approve_only";
const sessions = new Map<string, Record<string, unknown>>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const m = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
  const found = m ? sessions.get(m[1]) : undefined;
  return new Response(JSON.stringify(found ?? { error: { message: "not here" } }), { status: found ? 200 : 404 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
let peopleQueued = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (peopleQueued && one?.[0] === "HGETALL" && /^nl:aff:[^:]+:people$/.test(String(one[1]))) {
    await real(commands);
    return ["QUEUED"];
  }
  return real(commands);
}) as typeof redis.pipeline;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  const owner = "keeper@example.com";
  await claimHandle(owner, "keepershop", "Keeper store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1keepershopx", true);
  await setSubscription(owner, { customerId: "cus_keeper", subscriptionId: "sub_keeper", active: true, tier: "creator", period: paidPeriod() });
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; before?: { id: string }[] } };
  };
  const made = await addProduct(owner, "Soup Course", "", "40");
  const product = made.ok ? made.product.id : "";
  const terms = { action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 5, days: 60, rates: {} as Record<string, number> };
  is("(the program is on, 5% to affiliates)", (await post(terms)).body.ok, true);
  const store = async () => (await storeForEmail(owner))!;
  await setAffiliateSetting(owner, { ...(await store()).affiliates, buyers: true });
  const statusOf = async (id: string) => (await readAffiliate(await store(), id))?.status;
  const promised = async () =>
    (await listAffiliates(await store()))
      .filter((p) => p.status === "approved")
      .reduce((sum, p) => sum + (p.share?.products.includes(product) ? p.share.percent : 0), 0);
  const accept = async (email: string, percent: number) => {
    const r = await acceptPartnership(await store(), email, { percent, products: [product] });
    if (!r.ok) throw new Error(`not accepted: ${r.reason}`);
    return r.affiliate.id;
  };

  part("1. Restoring a removed partner whose share no longer fits");
  const a = await accept("a@example.com", 80);
  is("(A removed)", (await post({ action: "remove", id: a })).body.ok, true);
  const b = await accept("b@example.com", 80);
  is("(B accepted 80% in the room A left)", await promised(), 80);
  const back = await post({ action: "restore", id: a });
  is("restoring A (80 + 80 + 5%) is refused by the cap", [back.status, back.body.error], [409, "share_committed"]);
  is("A stays removed", await statusOf(a), "removed");
  is("partners hold 80%, never 160%", await promised(), 80);

  part("2. Restoring on an unknown reply, or with the partner lock held elsewhere");
  is("(B removed, so the cap alone would allow A back)", (await post({ action: "remove", id: b })).body.ok, true);
  peopleQueued = true;
  const blind = await post({ action: "restore", id: a });
  peopleQueued = false;
  is("unknown reply: refused as unavailable", [blind.status, blind.body.error], [503, "unavailable"]);
  is("A stays removed", await statusOf(a), "removed");
  const lockKey = `nl:aff:${(await store()).statsId}:partners:lock`;
  await redis.pipeline([["SET", lockKey, "somebody-else", "EX", 60]]);
  const busy = await post({ action: "restore", id: a });
  await redis.pipeline([["DEL", lockKey]]);
  is("lock held elsewhere: refused as unavailable", [busy.status, busy.body.error], [503, "unavailable"]);
  is("A stays removed", await statusOf(a), "removed");
  const fine = await post({ action: "restore", id: a });
  is("with room, read exactly and the lock free, A is restored", [fine.status, fine.body.ok, await statusOf(a)], [200, true, "approved"]);
  is("partners hold 80%", await promised(), 80);

  part("3. Approving a pending person who holds a share");
  await post({ action: "remove", id: a });
  await accept("b@example.com", 80);
  const token = "f".repeat(64);
  await redis.pipeline([["SET", linkKey(token), JSON.stringify({ s: (await store()).statsId, e: "c@example.com", n: "" }), "EX", 600]]);
  const applied = await openAffiliateLink(await store(), token);
  if (!applied.ok) throw new Error("no application");
  const c = applied.affiliate.id;
  is("(C applied and waits)", await statusOf(c), "pending");
  const given = await post({ action: "share", id: c, percent: 5, products: [product] });
  is("(C, still pending, is given 5%: 80 + 5 + 5% fits)", given.body.ok, true);
  await accept("d@example.com", 5);
  is("(D accepted 5%: C, pending, is not counted)", await promised(), 85);
  part("3b. A buyer taking their own link does not approve a share over the cap");
  sessions.set("cs_test_cbuyer000000001", {
    id: "cs_test_cbuyer000000001", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    amount_total: 4000, currency: "usd", created: Math.floor(Date.now() / 1000), customer_details: { email: "c@example.com" },
    metadata: { store: "keepershop", product },
  });
  const joined = await joinAsBuyer(await store(), "cs_test_cbuyer000000001");
  is("(the order is read)", joined.ok, true);
  is("C still waits for the creator", await statusOf(c), "pending");
  is("partners hold 85%", await promised(), 85);

  part("3c. The creator approving C, one at a time and in bulk");
  const one = await post({ action: "approve", id: c });
  is("approving C (80 + 5 + 5 + 5%) is refused by the cap", [one.status, one.body.error], [409, "share_committed"]);
  is("C still waits", await statusOf(c), "pending");
  const bulk = await post({ action: "bulk", decision: "approve", ids: [c] });
  is("in bulk, C is left out", [bulk.status, (bulk.body.before ?? []).map((x) => x.id)], [200, []]);
  is("C still waits", await statusOf(c), "pending");
  is("partners hold 85%", await promised(), 85);

  part("4. With room, approving works as before");
  const d = (await listAffiliates(await store())).find((p) => p.email === "d@example.com")!.id;
  await post({ action: "remove", id: d });
  const ok = await post({ action: "approve", id: c });
  is("C approved once D is out (80 + 5 + 5% = 90)", [ok.status, ok.body.ok, await statusOf(c)], [200, true, "approved"]);
  is("partners hold 85%", await promised(), 85);
  done();
}
main();
