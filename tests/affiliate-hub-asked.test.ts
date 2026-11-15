/**
 * MM-SA-47 (route security audit, third pass; 506 [SG1]), the affiliate-hub part: the email with the link to an
 * affiliate's page across stores (lib/affiliate-hub.ts requestHubLink) goes to whatever address a visitor types, and
 * was paid from the first store's access emails ("transactional") in full, not only from the share that
 * confirmations to typed addresses may take (MM-SA-05, askedCeiling). Typing a known affiliate's address from many
 * connections could spend the figure buyers' own links are sent from. Now it is metered as `asked`: once that share
 * is spent, no hub link goes, and the rest of the figure stays for buyers.
 *
 * Synthetic only (the set-up of tests/affiliate-hub.test.ts): the in-memory Redis stand-in, stand-ins for Stripe and
 * the email provider, no real email.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { joinAsBuyer } from "@/lib/affiliates";
import { requestHubLink } from "@/lib/affiliate-hub";
import { allowanceFor, askedCeiling } from "@/lib/store-allowance-rules";
import { takeAllowance } from "@/lib/store-allowance";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sent: { to: string; text: string }[] = [];
const sessions = new Map<string, Record<string, unknown>>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    sent.push({ to: [body.to].flat()[0], text: body.text });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  const m = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
  const found = m ? sessions.get(m[1]) : undefined;
  return new Response(JSON.stringify(found ?? { error: { message: "No such checkout.session" } }), { status: found ? 200 : 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_hub_only_a_stand_in";
  process.env.STRIPE_SECRET_KEY = "sk_test_hub_only_a_stand_in";
  for (const [email, handle, name, account] of [
    ["one@example.com", "harbor", "Harbor Kitchen", "acct_1TestHarbor0001"],
    ["two@example.com", "lantern", "Lantern Press", "acct_1TestLantern001"],
  ] as const) {
    if (!(await claimHandle(email, handle, name, "")).ok) throw new Error("no store");
    await ensureStoreId(email);
    await ensureStatsId(email);
    await setStripeAccount(email, account, true);
    await setAffiliateSetting(email, { ...NO_AFFILIATES, enabled: true, buyers: true, rates: {} });
  }
  const harbor = (await storeForEmail("one@example.com"))!;
  const lantern = (await storeForEmail("two@example.com"))!;
  const order = (id: string, handle: string) =>
    sessions.set(id, {
      id,
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      amount_total: 2700,
      currency: "usd",
      created: Math.floor(Date.now() / 1000),
      customer_details: { email: "Dana@Example.com" },
      metadata: { store: handle, product: "p8w2m4q9zz" },
    });
  order("cs_test_hubharbor0001", "harbor");
  order("cs_test_hublantern001", "lantern");

  is("Dana joins Harbor", (await joinAsBuyer(harbor, "cs_test_hubharbor0001")).ok, true);
  void lantern;

  part("Control: with room in the store's access emails, the hub link is sent");
  const first = sent.length;
  is("sent", await requestHubLink({ email: "dana@example.com", ip: "203.0.113.1", origin: "https://marktmorgen.com" }), "sent");
  is("one email, to the affiliate", sent.slice(first).map((m) => m.to), ["dana@example.com"]);

  part("The share for typed addresses spent: no hub link, and the buyers' part of the figure stays");
  const whole = allowanceFor(harbor, "transactional");
  const share = askedCeiling(whole);
  is(`the store's figure (${whole}) has a part beyond the typed-address share (${share})`, whole > share, true);
  // Take the rest of the share: everything Harbor sent so far counted against the same figure.
  for (let i = 0; i < share; i += 1) {
    const room = await takeAllowance(harbor, "transactional", 1, Date.now(), true);
    if (!room.ok) break;
  }
  const before = sent.length;
  const answer = await requestHubLink({ email: "dana@example.com", ip: "203.0.113.2", origin: "https://marktmorgen.com" });
  is("no hub link is sent past the share", sent.length - before, 0);
  is("and it is not said as sent", answer === "sent", false);
  const buyer = await takeAllowance(harbor, "transactional", 1);
  is("a buyer's own link still finds room in the figure", buyer.ok, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
