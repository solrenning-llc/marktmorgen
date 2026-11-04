/**
 * 506 [SG1], the class of MM-SA-05: the public deletion form spent a store's
 * access emails without the cap a visitor's typed address has.
 *
 * /privacy/delete (lib/erasure-request.ts) emails a deletion link to an
 * address the store knows, and a store knows every address on its list. A
 * stranger with a catch-all domain puts forty there through the sign-up box
 * (its confirmations are already capped), then asks the deletion form for
 * each of them as often as its hourly limits allow. Those links came from
 * the same access emails as a buyer's link to their course, with no cap, so
 * the month's figure ran out and a buyer was sent nothing.
 *
 * Proved against a real Redis: forty confirmed sign-ups and one hour of
 * deletion asks on a creator store; a buyer's course link must still be sent.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setJoin, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { askToJoin, confirmJoin } from "@/lib/store-join";
import { requestErasureLink } from "@/lib/erasure-request";
import { sendCourseLink } from "@/lib/learn";
import { allowanceFor, askedCeiling } from "@/lib/store-allowance-rules";
import type { Listing } from "@/lib/catalog";
import { paidPeriod } from "../billing-period-fixture";
import { check, finish } from "./check";

const sent: { to: string; text: string }[] = [];
const real = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (String(url).startsWith(String(process.env.UPSTASH_REDIS_REST_URL))) return real(input as string, init);
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to?: unknown; text?: string };
    sent.push({ to: String(body.to), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this check: ${url.hostname}`);
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_security_journey_only_a_stand_in";
  const owner = "owner@erase-asked.example";
  await claimHandle(owner, "erase-asked", "Erase Asked", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1EraseAskedXXXX", true);
  await setSubscription(owner, { customerId: "cus_eraseasked", subscriptionId: "sub_eraseasked", active: true, tier: "creator", period: paidPeriod() });
  await setJoin(owner, { on: true });
  const store = (await storeForEmail(owner))!;
  const figure = allowanceFor(store, "transactional");

  // Forty made-up addresses on the list, each confirmed from a connection of its own.
  let joined = 0;
  for (let i = 0; i < 40; i += 1) {
    const from = sent.length;
    const answer = await askToJoin({ store, email: `x${i}@catchall.example`, ip: `198.18.0.${i}`, origin: "https://marktmorgen.com" });
    if (answer !== "sent") continue;
    const token = sent.slice(from).map((s) => /token=([0-9a-f]{48})/.exec(s.text)?.[1]).find(Boolean);
    if (token && (await confirmJoin(token, store)).ok) joined += 1;
  }
  check("the sign-ups were confirmed", joined, 40);
  const confirmations = sent.length;

  // One hour of the deletion form: three asks per address (its hourly limit), from connections
  // that each stay under theirs. That alone is more than what the confirmations left of the month.
  let links = 0;
  for (let i = 0; i < 40; i += 1) {
    for (let t = 0; t < 3; t += 1) {
      const from = sent.length;
      await requestErasureLink({ email: `x${i}@catchall.example`, ip: `203.0.113.${i * 3 + t}`, origin: "https://marktmorgen.com", handle: "erase-asked" });
      if (sent.length > from) links += 1;
    }
  }
  check("the sign-ups and one hour of deletion asks would be more than the month's figure", confirmations + 120 > figure, true);
  check("the deletion links took some of the store's access emails", links > 0, true);
  check("but, with the confirmations, no more than a visitor's share", confirmations + links <= askedCeiling(figure), true);

  // A buyer of a course asks for the way in.
  const course = { id: "c0urse0000", title: "Watercolor basics" } as unknown as Listing;
  const buyer = await sendCourseLink(store, course, "buyer@example.com", "https://marktmorgen.com");
  check("a buyer is still sent the link to their course", [buyer, sent.some((s) => s.to.includes("buyer@example.com"))], [true, true]);
  finish();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
