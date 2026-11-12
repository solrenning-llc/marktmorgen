/**
 * #4045: an invitation made BEFORE the creator removed or declined somebody does not let them back in.
 *
 * Through the real routes (app/api/store/affiliates/route.ts for the studio offer and the creator's decisions,
 * app/api/store/affiliates/open/route.ts for the emailed link): a partner removed after the creator invited them who
 * then accepts the old studio offer, or opens the old emailed link, stays removed with no share, and the old offer is
 * taken out. An invitation made AFTER the removal is the creator changing their mind and still lets them back in.
 * Synthetic records only; @/lib/redis is the in-memory stub.
 */
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { affiliateByEmail } from "@/lib/affiliates";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { offerPartnership, waitingOne } from "@/lib/partner-invites";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { POST as openRoute } from "@/app/api/store/affiliates/open/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_invite_after_removal";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;
const later = () => new Promise((resolve) => setTimeout(resolve, 5));

async function main(): Promise<void> {
  redis.clear();
  const owner = "carver@example.com";
  await claimHandle(owner, "carvershop", "Carver store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1carversho9537", true);
  await setSubscription(owner, { customerId: "cus_carver", subscriptionId: "sub_carver", active: true, tier: "scale", period: paidPeriod() });
  const q = await addProduct(owner, "Knife Course", "", "40");
  const Q = q.ok ? q.product.id : "";
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, percent: 5, days: 60, rule: "last", payday: 0, hold: 0, rates: {} }));
  const store = async () => (await storeForEmail(owner))!;
  const statsId = (await store()).statsId as string;
  const share = { percent: 10, products: [Q] };

  const ownerCookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (cookie: string, body: Record<string, unknown>) => {
    const response = await affiliatesRoute(
      new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }),
    );
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const decideBy = async (email: string, action: "remove" | "decline") => {
    const id = (await affiliateByEmail(await store(), email))?.id ?? "";
    return post(ownerCookie, { action, id });
  };
  const open = async (token: string) =>
    openRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/open", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `handle=carvershop&token=${token}` }));

  // A partner who has a store of their own: invitations reach them in their studio.
  const invitee = "whittler@example.com";
  await claimHandle(invitee, "whittlershop", "Whittler store", "");
  await ensureStoreId(invitee);
  await setSubscription(invitee, { customerId: "cus_whittler", subscriptionId: "sub_whittler", active: true, tier: "creator", period: paidPeriod() });
  const inviteeCookie = `${SESSION_COOKIE}=${await openSession(invitee)}`;
  const offer = async () => {
    const made = await offerPartnership(invitee, { sid: (await store()).sid as string, storeName: "Carver store", handle: "carvershop", share, titles: ["Knife Course"] });
    if (!made.ok) throw new Error("no offer");
    return made.id;
  };
  const answer = (invite: string) => post(inviteeCookie, { action: "answer", invite, accept: true });

  part("1. Studio offer made before the removal: accepting it keeps the partner removed");
  const first = await offer();
  is("accepted while approved", (await answer(first)).status, 200);
  is("approved with the share", [(await affiliateByEmail(await store(), invitee))?.status, (await affiliateByEmail(await store(), invitee))?.share?.percent], ["approved", 10]);
  const stale = await offer();
  await later();
  is("the creator removes them", (await decideBy(invitee, "remove")).status, 200);
  const late = await answer(stale);
  const afterStale = await affiliateByEmail(await store(), invitee);
  is("the old offer is refused as gone", [late.status, late.body.error], [400, "gone"]);
  is("still removed after accepting the old offer", afterStale?.status, "removed");
  is("the old offer is taken out", await waitingOne(invitee, stale), null);

  part("2. Studio offer made after the removal: the creator changed their mind, it lets them back in");
  await later();
  const fresh = await offer();
  is("accepted", (await answer(fresh)).status, 200);
  is("approved again with the share", [(await affiliateByEmail(await store(), invitee))?.status, (await affiliateByEmail(await store(), invitee))?.share?.percent], ["approved", 10]);

  part("3. Studio offer made before a decline: accepting it keeps them declined");
  const pending = "pending@example.com";
  await claimHandle(pending, "pendingshop", "Pending store", "");
  await ensureStoreId(pending);
  // Applied through a plain emailed link (no invitation): pending.
  const applyToken = "a".repeat(64);
  await redis.pipeline([["SET", linkKey(applyToken), JSON.stringify({ s: statsId, e: pending, n: "" }), "EX", 600]]);
  await open(applyToken);
  is("pending application", (await affiliateByEmail(await store(), pending))?.status, "pending");
  const pendingOffer = await offerPartnership(pending, { sid: (await store()).sid as string, storeName: "Carver store", handle: "carvershop", share, titles: ["Knife Course"] });
  if (!pendingOffer.ok) throw new Error("no offer");
  await later();
  is("the creator declines them", (await decideBy(pending, "decline")).status, 200);
  const pendingAnswer = await post(`${SESSION_COOKIE}=${await openSession(pending)}`, { action: "answer", invite: pendingOffer.id, accept: true });
  is("refused as gone", [pendingAnswer.status, pendingAnswer.body.error], [400, "gone"]);
  is("still declined, no share", [(await affiliateByEmail(await store(), pending))?.status, (await affiliateByEmail(await store(), pending))?.share ?? null], ["declined", null]);

  part("4. Emailed partner link (k:1) made before the removal: opening it keeps them removed");
  const outsider = "outsider@example.com";
  // The invitation exactly as the route's invitePartner wrote it (the link's grant), put under a token the test
  // knows, as the invitee's email would carry it. The send itself is not what is checked here (no mail service).
  const seen = new Set<string>();
  let tokens = 0;
  const invite = async () => {
    await post(ownerCookie, { action: "invite", email: outsider, percent: 10, products: [Q] });
    const [, keys] = (await redis.pipeline([["SCAN", "0", "MATCH", "nl:aff:link:*"]]))[0] as [string, string[]];
    const fresh = keys.filter((k) => !seen.has(k));
    keys.forEach((k) => seen.add(k));
    const grants = (await redis.pipeline(fresh.map((k) => ["GET", k]))).map((raw) => JSON.parse(String(raw)) as { e?: string; k?: number });
    const grant = grants.find((g) => g.e === outsider && g.k === 1);
    if (!grant) throw new Error("no invitation was written");
    const token = String(++tokens).padStart(64, "f");
    await redis.pipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", 600]]);
    seen.add(linkKey(token));
    return token;
  };
  const firstLink = await invite();
  await open(firstLink);
  is("approved by the first invitation", [(await affiliateByEmail(await store(), outsider))?.status, (await affiliateByEmail(await store(), outsider))?.share?.percent], ["approved", 10]);
  const oldLink = await invite();
  await later();
  is("the creator removes them", (await decideBy(outsider, "remove")).status, 200);
  const opened = await open(oldLink);
  is("the old link says it has expired", (opened.headers.get("location") ?? "").includes("status=expired"), true);
  is("still removed after opening the old link", (await affiliateByEmail(await store(), outsider))?.status, "removed");

  part("5. An invitation link with no time on it (written before this change) never lets a removed partner back in");
  const untimed = "d".repeat(64);
  seen.add(linkKey(untimed));
  await redis.pipeline([["SET", linkKey(untimed), JSON.stringify({ s: statsId, e: outsider, n: "Invited as a partner", k: 1, p: share }), "EX", 600]]);
  const openedUntimed = await open(untimed);
  is("the link says it has expired", (openedUntimed.headers.get("location") ?? "").includes("status=expired"), true);
  is("still removed", (await affiliateByEmail(await store(), outsider))?.status, "removed");

  part("6. Emailed partner link made after the removal: lets them back in");
  await later();
  const newLink = await invite();
  const reopened = await open(newLink);
  is("signed in", (reopened.headers.get("location") ?? "").includes("status=welcome"), true);
  is("approved again with the share", [(await affiliateByEmail(await store(), outsider))?.status, (await affiliateByEmail(await store(), outsider))?.share?.percent], ["approved", 10]);

  done();
}

void main();
