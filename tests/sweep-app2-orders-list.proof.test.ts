/**
 * Sweep APP2 proof (CX-123 rules 24 and 30), synthetic only: app/api/store/orders/route.ts with lib/buyer-orders.ts.
 *
 * lib/buyer-orders.ts:497-499 `rows` reads every Stripe list (the address's checkouts in checkoutsOf, :569; the
 * payments taken in one click, :830) as `Array.isArray(listed.data) ? data : []`, the shape lib/stripe-list.ts was made
 * to refuse. A checkouts list answered in another shape reads as "this address bought nothing": purchasesFor answers
 * [], and the "Email me my purchases" form (requestOrdersLink, :1027) answers "sent" while sendLink (:1081) sends no
 * email; the buyer who paid never gets the link to their files. The proof counts the link's grant, which sendLink
 * writes only once it found something bought and right before it hands the email to the sender (whether the
 * synthetic sender then delivers is not this defect's part, and is not asserted).
 */
import { paidPeriod } from "./billing-period-fixture";
import { purchasesFor, requestOrdersLink } from "@/lib/buyer-orders";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "olive@example.com";
const BUYER = "ana@example.com";
let sessions: unknown = null;
let mails = 0;
/** Grants written for an emailed link (lib/buyer-orders.ts sendLink): written only once something bought was found, just before the email. */
let grants = 0;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const c of commands) if (c[0] === "SET" && String(c[1]).startsWith("nl:orders:link:")) grants += 1;
  return pipeline(commands);
}) as typeof redis.pipeline;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (url.hostname.includes("resend")) {
    mails += 1;
    return answer({ id: "00000000-0000-4000-8000-000000000000" });
  }
  if (path === "/checkout/sessions" && (init?.method ?? "GET") === "GET") return answer(sessions);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function settle(): Promise<void> {
  // requestOrdersLink answers at once and reads, grants and emails after the answer (afterAnswer).
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_sweep_app2_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_sweep_app2_only_a_stand_in";
  redis.clear();
  await claimHandle(OWNER, "olive", "Olive Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestOlive00001", true);
  await setSubscription(OWNER, { customerId: "cus_olive00001", subscriptionId: "sub_olive00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "The Guide", "", "20", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide");
  const store = (await storeForEmail(OWNER)) as Store;
  const paid = {
    id: `cs_test_${"1".padStart(24, "0")}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    created: Math.floor(Date.now() / 1000) - 60,
    metadata: { store: "olive", product: made.product.id },
    customer_details: { email: BUYER },
    payment_intent: { id: "pi_test0000000001", status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
  };

  part("Healthy control: the buyer's purchase is found and a link is made to email them");
  sessions = { object: "list", data: [paid], has_more: false };
  is("purchasesFor finds the one purchase", (await purchasesFor(store, BUYER)).map((p) => p.title), ["The Guide"]);
  grants = 0;
  is("the form answers sent", await requestOrdersLink({ store, email: BUYER, ip: "203.0.113.1", origin: "https://marktmorgen.com" }), "sent");
  await settle();
  is("and the link's grant is written, the email handed to the sender", grants, 1);

  part("DEFECT: the checkouts list answered in an unknown shape reads as 'bought nothing'");
  for (const [label, page, ip] of [
    ["no data", { object: "list", has_more: false }, "203.0.113.2"],
    ["data as an object", { object: "list", data: { 0: paid }, has_more: false }, "203.0.113.3"],
  ] as const) {
    sessions = page;
    is(`DEFECT (${label}): purchasesFor answers [] instead of throwing`, await purchasesFor(store, BUYER), []);
    grants = 0;
    mails = 0;
    const said = await requestOrdersLink({ store, email: BUYER, ip, origin: "https://marktmorgen.com" });
    await settle();
    is(`DEFECT (${label}): the buyer is told sent, and no grant is written and no email handed over`, [said, grants, mails], ["sent", 0, 0]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
