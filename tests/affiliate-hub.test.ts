/**
 * An affiliate's page across every store (lib/affiliate-hub.ts, added
 * 13 October 2026). What is checked:
 *
 *   - joining a store's program puts that store on the address's page,
 *     under a hash of the address and nothing else;
 *   - the link is emailed only to an address that is somebody's affiliate,
 *     the answer is the same either way, and it opens the page for that
 *     address only;
 *   - from the page, each store's own page opens with a sign-in made on the
 *     spot, and never for an address the store does not have.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { affiliateByEmail, joinAsBuyer, linkEmail, signInLinkFor } from "@/lib/affiliates";
import { hubOwner, requestHubLink, storesPromoted } from "@/lib/affiliate-hub";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { runAfterTasks } from "./next-server-after-world";

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

  part("Joining puts the store on the page");
  is("nobody's page before", await storesPromoted("dana@example.com"), []);
  is("Dana joins Harbor", (await joinAsBuyer(harbor, "cs_test_hubharbor0001")).ok, true);
  is("Dana joins Lantern", (await joinAsBuyer(lantern, "cs_test_hublantern001")).ok, true);
  is("both stores, by id", (await storesPromoted("DANA@example.com")).sort(), [harbor.sid, lantern.sid].sort());
  const keys = [...(redis as unknown as { data: Map<string, unknown> }).data.keys()].filter((k) => k.startsWith("nl:affhub:"));
  is("and the address itself is nowhere in the key", keys.some((k) => k.includes("dana")), false);

  part("Signing in by email");
  // The stores, the link and its email run after the answer (lib/after-answer.ts): each ask runs them before reading what was sent.
  const ask = async (email: string) => {
    const answer = await requestHubLink({ email, ip: "203.0.113.1", origin: "https://marktmorgen.com" });
    await runAfterTasks();
    return answer;
  };
  is("an address that is nobody's affiliate: the same answer, and no email", [await ask("nobody@example.com"), sent.length], ["sent", 0]);
  is("not an address", await requestHubLink({ email: "nope", ip: "203.0.113.1", origin: "https://marktmorgen.com" }), "email");
  is("an affiliate: a link to their page", [await ask("dana@example.com"), sent.at(-1)?.to, sent.at(-1)?.text.includes("2 stores")], ["sent", "dana@example.com", true]);
  const token = sent.at(-1)?.text.match(/token=([0-9a-f]{64})/)?.[1] ?? "";
  is("it opens the page for that address, and a made-up one for nobody", [await hubOwner(token), await hubOwner("0".repeat(64))], ["dana@example.com", null]);

  part("Each store's own page, from here");
  const open = await signInLinkFor(harbor, "dana@example.com", "https://marktmorgen.com");
  const storeToken = open?.match(/token=([0-9a-f]{64})/)?.[1] ?? "";
  is("a sign-in to Harbor's page, for Dana", [open?.startsWith("https://marktmorgen.com/@harbor/affiliates?token="), await linkEmail(harbor, storeToken)], [true, "dana@example.com"]);
  is("never for an address the store does not have", await signInLinkFor(harbor, "stranger@example.com", "https://marktmorgen.com"), null);
  is("and the stranger has not become an applicant", await affiliateByEmail(harbor, "stranger@example.com"), null);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
