/**
 * The 90% cap on what one sale may promise (partners plus the affiliate commission, lib/partner-share.ts) is checked
 * again when the COMMISSION goes up, not only when a share is set, accepted or approved (#2995 follow-up, money).
 * Synthetic only: the in-memory Redis double, through the real route app/api/store/affiliates/route.ts.
 *
 * Before: a partner held 80% of a product with the program at 5%; raising the program's commission to 15%, that
 * product's own commission to 20%, or one affiliate's own share to 30% was saved, and the product promised 95% to
 * 110% of each sale. An affiliate's own share was not counted at all, so a share set on a product an affiliate
 * already earned 30% on passed with the program's 5%.
 *
 * Now: the cap counts, on each product, the highest commission any affiliate can earn there (the program's, the
 * product's, or one affiliate's own, except on a product set to 0%). Every change that raises it is checked under the
 * program's partner lock, against the people and the store read exactly now: over the cap, 409 share_committed and
 * nothing saved; an unknown reply or the lock held elsewhere, 503 unavailable and nothing saved. A change that lowers
 * the commission is never refused.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { acceptPartnership, openAffiliateLink, readAffiliate } from "@/lib/affiliates";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_partner_approve_only";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

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

type Reply = { status: number; body: { ok?: boolean; error?: string; rate?: number | null; before?: { id: string }[]; refused?: { id: string; email: string; why: string }[] } };

async function main(): Promise<void> {
  redis.clear();
  const owner = "baker@example.com";
  await claimHandle(owner, "bakershop", "Baker store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1bakershop0b36", true);
  await setSubscription(owner, { customerId: "cus_baker", subscriptionId: "sub_baker", active: true, tier: "creator", period: paidPeriod() });
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>): Promise<Reply> => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply["body"] };
  };
  const p = await addProduct(owner, "Bread Basics", "", "40");
  const q = await addProduct(owner, "Cake Basics", "", "40");
  const P = p.ok ? p.product.id : "";
  const Q = q.ok ? q.product.id : "";
  const terms = { action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 5, days: 60, rates: {} as Record<string, number> };
  is("(the program is on, 5% to affiliates)", (await post(terms)).body.ok, true);
  const store = async () => (await storeForEmail(owner))!;
  const setting = async () => {
    const s = (await store()).affiliates;
    return { percent: s.percent, rates: s.rates };
  };
  const rateOf = async (id: string) => (await readAffiliate(await store(), id))?.rate;
  let tokens = 0;
  const applicant = async (email: string) => {
    const token = String(++tokens).padStart(64, "a");
    await redis.pipeline([["SET", linkKey(token), JSON.stringify({ s: (await store()).statsId, e: email, n: "" }), "EX", 600]]);
    const opened = await openAffiliateLink(await store(), token);
    if (!opened.ok) throw new Error(`no application for ${email}`);
    is(`(${email} approved)`, (await post({ action: "approve", id: opened.affiliate.id })).body.ok, true);
    return opened.affiliate.id;
  };
  const A = await applicant("a@example.com");
  const B = await applicant("b@example.com");

  part("1. An affiliate's own share counts in the cap when a share is set (rule 30)");
  is("(A's own share 30%: nobody shares in anything yet)", (await post({ action: "rate", id: A, rate: 30 })).body.ok, true);
  const over = await acceptPartnership(await store(), "x@example.com", { percent: 70, products: [P] });
  is("a 70% partner on Bread, where A earns 30%, is refused (100%)", over.ok ? "accepted" : over.reason, "committed");
  const invite = await post({ action: "invite", email: "y@example.com", percent: 70, products: [P] });
  is("an invitation at 70% is refused before it goes out", [invite.status, invite.body.error], [400, "share_committed"]);
  is("(A back to the program's share)", (await post({ action: "rate", id: A, rate: null })).body.ok, true);
  const x = await acceptPartnership(await store(), "x@example.com", { percent: 80, products: [P] });
  is("(X accepted 80% of Bread: 80 + 5% = 85)", x.ok, true);

  part("2. Raising the program's commission, or one product's");
  const all = await post({ ...terms, percent: 15 });
  is("the program to 15% (80 + 15 = 95%) is refused by the cap", [all.status, all.body.error], [409, "share_committed"]);
  is("nothing saved", await setting(), { percent: 5, rates: {} });
  const bread = await post({ ...terms, rates: { [P]: 20 } });
  is("Bread alone to 20% (80 + 20 = 100%) is refused", [bread.status, bread.body.error], [409, "share_committed"]);
  is("nothing saved", await setting(), { percent: 5, rates: {} });
  const cake = await post({ ...terms, rates: { [Q]: 40 } });
  is("Cake to 40%, where nobody holds a share, is saved", [cake.status, cake.body.ok], [200, true]);
  const ten = await post({ ...terms, percent: 10, rates: { [Q]: 40 } });
  is("the program to 10% (80 + 10 = 90%) is saved", [ten.status, ten.body.ok], [200, true]);
  is("as asked", await setting(), { percent: 10, rates: { [Q]: 40 } });

  part("3. Raising one affiliate's own share");
  const eleven = await post({ action: "rate", id: A, rate: 11 });
  is("A to 11% (80 + 11 = 91% on Bread) is refused", [eleven.status, eleven.body.error], [409, "share_committed"]);
  is("A keeps the program's share", await rateOf(A), null);
  const tenA = await post({ action: "rate", id: A, rate: 10 });
  is("A to 10% (90%) is saved", [tenA.status, tenA.body.ok, await rateOf(A)], [200, true, 10]);
  const many = await post({ action: "bulk-rate", ids: [A, B], rate: 20 });
  is(
    "several at 20%: none saved, each named as refused by the cap",
    [many.status, many.body.ok, many.body.before, (many.body.refused ?? []).map((r) => [r.email, r.why]).sort()],
    [200, true, [], [["a@example.com", "cap"], ["b@example.com", "cap"]]],
  );
  is("A and B keep their shares", [await rateOf(A), await rateOf(B)], [10, null]);
  const undo = await post({ action: "bulk-rate-undo", before: [{ id: A, rate: 20 }], rate: 10 });
  is("an undo that would raise A to 20% puts nothing back", [undo.status, undo.body.ok, (undo.body as { undone?: number }).undone, await rateOf(A)], [200, true, 0, 10]);

  part("4. A product set to 0% stays out for everyone, an affiliate's own share included");
  is("(Bread set to 0%)", (await post({ ...terms, percent: 10, rates: { [P]: 0, [Q]: 40 } })).body.ok, true);
  const fifty = await post({ action: "rate", id: B, rate: 50 });
  is("B to 50% is saved: B earns nothing on Bread", [fifty.status, fifty.body.ok, await rateOf(B)], [200, true, 50]);
  const back = await post({ ...terms, percent: 10, rates: { [Q]: 40 } });
  is("Bread back into the program would make it 80 + 50 = 130%: refused", [back.status, back.body.error], [409, "share_committed"]);
  is("(B back to the program's share)", (await post({ action: "rate", id: B, rate: null })).body.ok, true);
  is("(Bread back in the program at 10%: 90%)", (await post({ ...terms, percent: 10, rates: { [Q]: 40 } })).body.ok, true);

  part("5. A change that lowers the commission is never refused, even over the cap");
  const people = `nl:aff:${(await store()).statsId}:people`;
  const raw = JSON.parse(String(await redis.pipeline([["HGET", people, x.ok ? x.affiliate.id : ""]]).then((r) => r[0])));
  await redis.pipeline([["HSET", people, raw.id, JSON.stringify({ ...raw, share: { percent: 85, products: [P] } })]]);
  const lower = await post({ ...terms, percent: 8, rates: { [Q]: 40 } });
  is("from 85 + 10 = 95% (left from before) down to 93%: saved", [lower.status, lower.body.ok, (await setting()).percent], [200, true, 8]);
  const lowerA = await post({ action: "rate", id: A, rate: 9 });
  is("A from 10% down to 9%: saved", [lowerA.status, lowerA.body.ok, await rateOf(A)], [200, true, 9]);
  await redis.pipeline([["HSET", people, raw.id, JSON.stringify({ ...raw, share: { percent: 80, products: [P] } })]]);

  part("6. On an unknown reply, or with the partner lock held elsewhere: nothing saved");
  peopleQueued = true;
  const blind = await post({ ...terms, percent: 10, rates: { [Q]: 40 } });
  const blindRate = await post({ action: "rate", id: B, rate: 10 });
  peopleQueued = false;
  is("the program up, people unread: 503", [blind.status, blind.body.error, (await setting()).percent], [503, "unavailable", 8]);
  is("B's own share up, people unread: 503", [blindRate.status, blindRate.body.error, await rateOf(B)], [503, "unavailable", null]);
  const lockKey = `nl:aff:${(await store()).statsId}:partners:lock`;
  await redis.pipeline([["SET", lockKey, "somebody-else", "EX", 60]]);
  const busy = await post({ ...terms, percent: 10, rates: { [Q]: 40 } });
  const busyRate = await post({ action: "rate", id: B, rate: 10 });
  await redis.pipeline([["DEL", lockKey]]);
  is("the program up, lock held: 503", [busy.status, busy.body.error, (await setting()).percent], [503, "unavailable", 8]);
  is("B's own share up, lock held: 503", [busyRate.status, busyRate.body.error, await rateOf(B)], [503, "unavailable", null]);
  const free = await post({ ...terms, percent: 10, rates: { [Q]: 40 } });
  is("read exactly and the lock free, the program to 10% (90%) is saved", [free.status, free.body.ok, (await setting()).percent], [200, true, 10]);
  done();
}
main();
