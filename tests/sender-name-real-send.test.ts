/**
 * A real send with a disguised store name (Claude 7's security read 3rjdf, point 6): the emailed link to read a
 * members-only email (lib/letter-access.ts, sendLetterLink) goes out through the code that sends it, with Resend
 * mocked, and the From it hands to Resend never shows the store's name when that name holds an address, a domain or
 * claims to be a payment brand. A plain name still goes out as it is. Synthetic store, Stripe and Resend only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import type { Broadcast } from "@/lib/broadcasts";
import { publishLetter } from "@/lib/letters";
import type { Letter } from "@/lib/letter-rules";
import { requestLetterLink } from "@/lib/letter-access";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_sender_name_real_send";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
const OWNER = "sender-name-send@example.com";
const HANDLE = "maraspoof";
const NOW = Math.floor(Date.now() / 1000);
let club = "";
const mails: { to: string; from: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; from: string };
    mails.push({ to: [body.to].flat()[0], from: body.from });
    return answer({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const who = url.searchParams.get("customer_details[email]") ?? "";
  if (path === "/checkout/sessions" && /^member\d+@example\.com$/.test(who)) {
    const n = who.replace(/\D/g, "").padStart(3, "0");
    return answer({ object: "list", has_more: false, data: [{ id: `cs_test_grant00000${n}`, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", created: NOW - 86_400, customer: `cus_TestGrant${n}`, metadata: { store: HANDLE, product: club }, payment_intent: { id: `pi_grant00000${n}`, latest_charge: { object: "charge", amount: 4900, amount_refunded: 0, refunded: false } } }] });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;


function broadcast(store: Store, id: string): Broadcast {
  const b: Broadcast = { id: id.padStart(24, "0"), listId: store.listId!, handle: store.handle, subject: "October for members", body: "secret", productId: null, notProductId: null, who: "all", narrow: null, status: "sent", createdAt: 1_760_000_000, sendAt: 1_760_000_100, finishedAt: 1_760_000_200, total: 12, sent: 12, note: "", failures: 0, listed: true, tagged: true, test: null };
  redis.run(["SET", `nl:mail:bc:${b.id}`, JSON.stringify(b)]);
  return b;
}
const settle = () => new Promise((r) => setTimeout(r, 200));

async function sentFrom(name: string, n: number): Promise<string> {
  redis.clear();
  mails.length = 0;
  await claimHandle(OWNER, HANDLE, name, "");
  await ensureStatsId(OWNER); await ensureStoreId(OWNER); await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: `cus_${HANDLE}`, subscriptionId: `sub_${HANDLE}`, active: true, tier: "pro", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_1TestSpoofSnd", true);
  const made = await addProduct(OWNER, "Butter Club", "", "49", null);
  if (!made.ok) throw new Error("no product");
  club = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const published = await publishLetter(store, broadcast(store, `b${n}`), Date.now(), [club]);
  if (!published.ok) throw new Error(published.message);
  is(`${name}: asked`, await requestLetterLink({ store, letter: published.letter, email: "member1@example.com", ip: `203.0.113.${n}`, origin: "https://marktmorgen.com" }), "sent");
  await settle();
  is(`${name}: one email went out`, mails.length, 1);
  return mails[0]?.from ?? "";
}

async function main(): Promise<void> {
  part("A plain store name goes out as it is");
  is("the From shows the store's name", (await sentFrom("Mara's Club", 11)).startsWith(`"Mara's Club via Marktmorgen" <`), true);

  part("A disguised store name never reaches Resend");
  let n = 20;
  for (const bad of ["support＠paypal．com", "PayPal Security", "Marktm0rgen", "Stripe Billing", "Mailer-Daemon"]) {
    const from = await sentFrom(bad, ++n);
    is(`${bad}: the From is the safe stand-in`, from.startsWith(`"A store via Marktmorgen" <`), true);
  }
  done();
}

void main();
