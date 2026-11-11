/**
 * The public deletion form (/privacy/delete, lib/erasure-request.ts) emails a
 * link to whatever address a visitor types, when a store knows it, from that
 * store's access emails (506 [SG1], the class of MM-SA-05). A store knows
 * every address on its list, and a stranger with a catch-all domain can put
 * dozens there through the sign-up box. Without the cap that the sign-up
 * box, waitlists and the affiliate form have (`asked`, askedCeiling), those
 * links could spend the month's access emails, and a buyer then got no link
 * to their course.
 *
 * Checked on the in-memory Redis: forty confirmed sign-ups, then the deletion
 * form asked for each of them as often as its hourly limits allow, for six
 * hours; a buyer's course link must still be sent, and the deletion links
 * never take more than the share a visitor's address may take.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setJoin, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { askToJoin, confirmJoin } from "@/lib/store-join";
import { requestErasureLink } from "@/lib/erasure-request";
import { sendCourseLink } from "@/lib/learn";

import type { Listing } from "@/lib/catalog";
import { paidPeriod } from "./billing-period-fixture";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sent: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to?: unknown; text?: string };
    sent.push({ to: String(body.to), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_erasure_asked_only_a_stand_in";
  const owner = "owner@erase-asked.example";
  await claimHandle(owner, "erase-asked", "Erase Asked", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1EraseAskedXXXX", true);
  await setSubscription(owner, { customerId: "cus_eraseasked", subscriptionId: "sub_eraseasked", active: true, tier: "creator", period: paidPeriod() });
  await setJoin(owner, { on: true });
  const store = (await storeForEmail(owner))!;

  part("A stranger fills the list, then asks the deletion form for every address");
  let joined = 0;
  for (let i = 0; i < 40; i += 1) {
    const from = sent.length;
    const answer = await askToJoin({ store, email: `x${i}@catchall.example`, ip: `198.18.0.${i}`, origin: "https://marktmorgen.com" });
    if (answer !== "sent") continue;
    const token = sent.slice(from).map((s) => /token=([0-9a-f]{48})/.exec(s.text)?.[1]).find(Boolean);
    if (token && (await confirmJoin(token, store)).ok) joined += 1;
  }
  const confirmations = sent.length;
  is("the sign-ups are confirmed", joined, 40);
  let links = 0;
  for (let hour = 0; hour < 6; hour += 1) {
    for (let i = 0; i < 40; i += 1) {
      for (let t = 0; t < 3; t += 1) {
        const from = sent.length;
        await requestErasureLink({ email: `x${i}@catchall.example`, ip: `203.0.113.${((i * 3 + t) % 12) + hour * 12}`, origin: "https://marktmorgen.com", handle: "erase-asked" });
        if (sent.length > from) links += 1;
      }
    }
    advance(3_601_000);
  }
  is("some deletion links still go", links > 0, true);
  is("but confirmations and deletion links together stay within a visitor's share", confirmations + links <= 75, true);

  part("A buyer still gets their way in");
  const course = { id: "c0urse0000", title: "Course" } as unknown as Listing;
  const buyer = await sendCourseLink(store, course, "buyer@example.com", "https://marktmorgen.com");
  is("the buyer's course link is sent", [buyer, sent.some((s) => s.to.includes("buyer@example.com"))], [true, true]);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
