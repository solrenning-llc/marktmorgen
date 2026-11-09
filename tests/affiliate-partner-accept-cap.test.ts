/**
 * The 90% cap on what one sale may promise (partners plus the affiliate commission, lib/partner-share.ts) is checked
 * again when a partner ACCEPTS, not only when the creator invites (#2995 review, MÉDIO, money). Synthetic only: the
 * in-memory Redis double, through the real route app/api/store/affiliates/route.ts and openAffiliateLink.
 *
 * Before: the invitation was checked against the partners approved at that moment, and accepting it wrote the share
 * as it was. Two 80% invitations on one product were each inside the cap alone; both accepted, the product promised
 * partners 160% of each sale, on top of the 5% commission.
 *
 * Now: accepting re-reads the program's people exactly (listAffiliates) and re-checks the cap under the program's
 * partner lock, the same lock a share set from the studio takes, so two acceptances at once cannot both pass.
 * Over the cap: refused, the offer (or the emailed link) kept. Unknown reply, or the lock not taken: refused as
 * unavailable (503), the offer kept, nothing written.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { acceptPartnership, listAffiliates, openAffiliateLink } from "@/lib/affiliates";
import { offerPartnership, waitingFor } from "@/lib/partner-invites";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_partner_accept_only";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
let peopleQueued = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  const people = one?.[0] === "HGETALL" && /^nl:aff:[^:]+:people$/.test(String(one[1]));
  if (people && peopleQueued) {
    await real(commands);
    return ["QUEUED"];
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
  return async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; accepted?: boolean; waiting?: boolean } };
  };
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  const owner = "maker@example.com";
  const post = await shop(owner, "makershop");
  const made = await addProduct(owner, "Bread Basics", "", "40");
  const product = made.ok ? made.product.id : "";
  const terms = { action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 5, days: 60, rates: {} as Record<string, number> };
  is("(the program is on, 5% to affiliates)", (await post(terms)).body.ok, true);
  const store = async () => (await storeForEmail(owner))!;
  const promised = async () =>
    (await listAffiliates(await store()))
      .filter((p) => p.status === "approved")
      .reduce((sum, p) => sum + (p.share?.products.includes(product) ? p.share.percent : 0), 0);

  part("1. Two invitations, each inside the cap alone, both accepted from the invitees' studios");
  const one = await shop("one@example.com", "oneshop");
  const two = await shop("two@example.com", "twoshop");
  const first = await post({ action: "invite", email: "one@example.com", percent: 80, products: [product] });
  const second = await post({ action: "invite", email: "two@example.com", percent: 80, products: [product] });
  // Rule 23: the answer no longer says `waiting: true` for an address with a store (Claude 5's authentication audit, M4):
  // that the invitation waits in their studio is read from their studio's list instead.
  is("the first invitation waits in their studio", [first.status, first.body.waiting, (await waitingFor("one@example.com")).length], [200, undefined, 1]);
  is("the second invitation waits too: nobody has accepted yet", [second.status, second.body.waiting, (await waitingFor("two@example.com")).length], [200, undefined, 1]);
  const offerOne = (await waitingFor("one@example.com"))[0];
  const offerTwo = (await waitingFor("two@example.com"))[0];
  const yesOne = await one({ action: "answer", invite: offerOne.id, accept: true });
  is("the first acceptance is made", [yesOne.status, yesOne.body.accepted], [200, true]);
  const yesTwo = await two({ action: "answer", invite: offerTwo.id, accept: true });
  is("the second acceptance is refused by the cap", [yesTwo.status, yesTwo.body.error], [409, "offer_committed"]);
  is("the product promises partners 80%, never 160%", await promised(), 80);
  is("the refused offer is kept, so it can be accepted once the store lowers a share", (await waitingFor("two@example.com")).map((w) => w.id), [offerTwo.id]);
  is("no partner record was made for the refused one", (await listAffiliates(await store())).some((p) => p.email === "two@example.com"), false);

  part("2. The same through emailed links (openAffiliateLink)");
  const grant = (email: string, percent: number) => ({ s: "", e: email, n: "Invited as a partner", k: 1, p: { percent, products: [product] } });
  const link = async (token: string, email: string, percent: number) => {
    const now = await store();
    await redis.pipeline([["SET", linkKey(token), JSON.stringify({ ...grant(email, percent), s: now.statsId }), "EX", 600]]);
  };
  await link("c".repeat(64), "three@example.com", 10);
  const opened = await openAffiliateLink(await store(), "c".repeat(64));
  is("an emailed 10% over an 80% partner and 5% commission (95%) is refused", opened.ok ? "made" : opened.reason, "committed");
  is("the link is kept, not spent", (await redis.pipeline([["EXISTS", linkKey("c".repeat(64))]]))[0], 1);
  is("partners still hold 80%", await promised(), 80);
  await link("d".repeat(64), "four@example.com", 5);
  const fits = await openAffiliateLink(await store(), "d".repeat(64));
  is("an emailed 5% (80 + 5 + 5 = 90%) is made", fits.ok ? fits.affiliate.share?.percent : fits.reason, 5);
  is("partners hold 85% now, 90% with the commission", await promised(), 85);

  part("3. A partner accepting again is not counted against themselves");
  const again = await acceptPartnership(await store(), "one@example.com", { percent: 80, products: [product] });
  is("the 80% partner re-accepting 80% is made (their old share is replaced, not added)", again.ok, true);
  const raise = await acceptPartnership(await store(), "four@example.com", { percent: 6, products: [product] });
  is("the 5% partner accepting 6% (91%) is refused", raise.ok ? "made" : raise.reason, "committed");
  is("partners still hold 85%", await promised(), 85);

  part("4. Unknown reply for the program's people at acceptance: refused, offer kept");
  const five = await shop("five@example.com", "fiveshop");
  const left = await offerPartnership("five@example.com", { sid: (await store()).sid, storeName: "makershop store", handle: "makershop", share: { percent: 1, products: [product] }, titles: ["Bread Basics"] });
  if (!left.ok) throw new Error("no offer");
  peopleQueued = true;
  const blind = await five({ action: "answer", invite: left.id, accept: true });
  peopleQueued = false;
  is("refused as unavailable, never read as 'nobody'", [blind.status, blind.body.error], [503, "unavailable"]);
  is("the offer is kept", (await waitingFor("five@example.com")).map((w) => w.id), [left.id]);
  is("no partner record was made", (await listAffiliates(await store())).some((p) => p.email === "five@example.com"), false);
  await link("e".repeat(64), "six@example.com", 1);
  peopleQueued = true;
  const blindLink = await openAffiliateLink(await store(), "e".repeat(64)).then(
    (r) => (r.ok ? "made" : r.reason),
    (error: unknown) => (error instanceof Error ? error.name : "thrown"),
  );
  peopleQueued = false;
  is("an emailed link on an unknown reply stops on it, never read as 'nobody'", blindLink, "UnknownReplyError");
  is("and the link is kept", (await redis.pipeline([["EXISTS", linkKey("e".repeat(64))]]))[0], 1);
  is("partners still hold 85%", await promised(), 85);

  part("5. Two acceptances at the same instant cannot both pass");
  redis.clear();
  const post2 = await shop(owner, "makershop");
  const made2 = await addProduct(owner, "Bread Basics", "", "40");
  const product2 = made2.ok ? made2.product.id : "";
  await post2(terms);
  const both = await Promise.all([
    acceptPartnership(await store(), "seven@example.com", { percent: 80, products: [product2] }),
    acceptPartnership(await store(), "eight@example.com", { percent: 80, products: [product2] }),
  ]);
  const total = (await listAffiliates(await store()))
    .filter((p) => p.status === "approved")
    .reduce((sum, p) => sum + (p.share?.products.includes(product2) ? p.share.percent : 0), 0);
  is("only one of the two is made", both.filter((r) => r.ok).length, 1);
  is("the product promises at most 90% (partners 80% + 5% commission)", total <= 85, true);

  part("6. A share set from the studio and an acceptance at the same instant: the same lock");
  const small = (await listAffiliates(await store())).find((p) => p.share?.products.includes(product2));
  if (!small) throw new Error("no partner");
  await post2({ action: "share", id: small.id, percent: 1, products: [product2] });
  const raced = await Promise.all([
    post2({ action: "share", id: small.id, percent: 80, products: [product2] }),
    acceptPartnership(await store(), "nine@example.com", { percent: 80, products: [product2] }),
  ]);
  const after = (await listAffiliates(await store()))
    .filter((p) => p.status === "approved")
    .reduce((sum, p) => sum + (p.share?.products.includes(product2) ? p.share.percent : 0), 0);
  is("only one of the two lands", [raced[0].body.ok === true, raced[1].ok].filter(Boolean).length, 1);
  is("partners hold at most 85% (90% with the commission)", after <= 85, true);

  part("7. The partner lock held by somebody else past the wait: refused, offer kept, nothing written");
  const ten = await shop("ten@example.com", "tenshop");
  const parked = await offerPartnership("ten@example.com", { sid: (await store()).sid, storeName: "makershop store", handle: "makershop", share: { percent: 1, products: [product2] }, titles: ["Bread Basics"] });
  if (!parked.ok) throw new Error("no offer");
  await post2({ action: "share", id: small.id, percent: 1, products: [product2] });
  const lockKey = `nl:aff:${(await store()).statsId}:partners:lock`;
  await redis.pipeline([["SET", lockKey, "somebody-else", "EX", 60]]);
  const busy = await ten({ action: "answer", invite: parked.id, accept: true });
  const busyShare = await post2({ action: "share", id: small.id, percent: 2, products: [product2] });
  await redis.pipeline([["DEL", lockKey]]);
  is("the acceptance is refused as unavailable", [busy.status, busy.body.error], [503, "unavailable"]);
  is("the offer is kept", (await waitingFor("ten@example.com")).map((w) => w.id), [parked.id]);
  is("no partner record was made", (await listAffiliates(await store())).some((p) => p.email === "ten@example.com"), false);
  is("a share from the studio is refused as unavailable too", [busyShare.status, busyShare.body.error], [503, "unavailable"]);
  is("and the partner keeps 1%", (await listAffiliates(await store())).find((p) => p.id === small.id)?.share?.percent, 1);
  const free = await ten({ action: "answer", invite: parked.id, accept: true });
  is("once the lock is free, the acceptance is made", [free.status, free.body.accepted], [200, true]);
  done();
}
main();
