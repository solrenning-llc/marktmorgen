/**
 * A membership that ends by itself after a set number of payments is written down to be ended (lib/plans.ts,
 * rememberPlan → nl:plans:pending) by whatever opened its checkout, not only by the buy button's route.
 *
 * The defect this file was written around: only app/api/store/checkout/route.ts called rememberPlan. The welcome
 * offer (lib/welcome-offer-send.ts openWelcome), the come-back offer (lib/winback-send.ts openWinBack) and the
 * moved-members link (lib/move-members.ts openMove) open the same checkout through createCheckout, which writes
 * `ends_after` on it, but nothing put it on the list the plans job settles. Its end (`cancel_at`) was then given only
 * when the buyer came back to the thanks page; a buyer who closed the tab first, or a thanks page whose finishPlan
 * failed, left a "3 monthly payments of $50" membership charging $50 every month after the third. Now createCheckout
 * writes it down itself, right after Stripe opens the session, whichever door opened it.
 *
 * Checked: each of the three doors opens its checkout with createCheckout; createCheckout, called as each door calls
 * it (the welcome coupon; no trial for the come-back offer; no trial and a moved first charge for the moved-members
 * link), puts a three-payment membership on the list; a membership with no set number of payments, and a one-off
 * product, are not put there (controls). Stripe is a stand-in.
 */
import { readFileSync } from "node:fs";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_fixed_payments_stand_in";

const OWNER = "fixed-payments@example.com";
const ACCOUNT = "acct_1TestFixedPay01";
let opened = 0;
const sessionId = () => `cs_test_${String(opened).padStart(24, "0")}`;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    opened += 1;
    return answer({ id: sessionId(), object: "checkout.session", url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const add = async (title: string, price: string, recurring: Parameters<typeof addProduct>[4]) => {
    const made = await addProduct(OWNER, title, "", price, recurring);
    if (!made.ok) throw new Error(`no product ${title}`);
    return made.product.id;
  };
  const three = await add("Three months of letters", "50", { interval: "month", trialDays: 0, payments: 3 });
  const open = await add("Letters until cancelled", "50", { interval: "month", trialDays: 0, payments: 0 });
  const once = await add("One guide", "50", null);
  const store = (await storeForEmail(OWNER))!;
  const pending = async () => (await redis.pipeline([["SMEMBERS", "nl:plans:pending"]]))[0] as string[];
  const remembered = async (id: string) => (await pending()).some((entry) => entry.startsWith(`${ACCOUNT}|${id}|`));
  const product = async (id: string) => (await readProduct(store, id))!;

  part("The three doors open their checkout through createCheckout");
  for (const [door, file] of [["the welcome offer", "lib/welcome-offer-send.ts"], ["the come-back offer", "lib/winback-send.ts"], ["the moved-members link", "lib/move-members.ts"]]) {
    const source = readFileSync(file, "utf8");
    is(`${door} (${file}) opens it with createCheckout and does not write the plan down itself`, [/createCheckout\(store, product, origin/.test(source), source.includes("rememberPlan")], [true, false]);
  }

  part("createCheckout, called as each door calls it");
  await createCheckout(store, await product(three), "https://marktmorgen.com", undefined, { coupon: "c_welcome25", email: "buyer@example.com", welcome: true, digitalConsent: TEST_CONSENT });
  is("as the welcome offer calls it: on the plans list", await remembered(sessionId()), true);
  await createCheckout(store, await product(three), "https://marktmorgen.com", undefined, { coupon: "c_back", email: "buyer@example.com", noTrial: true, digitalConsent: TEST_CONSENT });
  is("as the come-back offer calls it: on the plans list", await remembered(sessionId()), true);
  await createCheckout(store, await product(three), "https://marktmorgen.com", undefined, { email: "buyer@example.com", noTrial: true, moved: { firstChargeAt: Math.floor(Date.now() / 1000) + 30 * 86_400 }, digitalConsent: TEST_CONSENT });
  is("as the moved-members link calls it: on the plans list", await remembered(sessionId()), true);

  part("Controls: nothing to end, nothing written");
  const before = (await pending()).length;
  await createCheckout(store, await product(open), "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT });
  await createCheckout(store, await product(once), "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT });
  is("a membership until cancelled and a one-off product: the list is as it was", (await pending()).length, before);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
