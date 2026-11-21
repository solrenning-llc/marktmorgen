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
 * product, are not put there (controls). And (Codex X4) the checkout is handed out only once that write is confirmed:
 * a Stripe answer whose id is not a checkout session id, or a Redis reply to the SADD that is not exactly 0 or 1,
 * refuses it, since the plans job could not end that membership. Stripe is a stand-in.
 */
import { readFileSync } from "node:fs";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { rememberPlan } from "@/lib/plans";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_fixed_payments_stand_in";

const OWNER = "fixed-payments@example.com";
const ACCOUNT = "acct_1TestFixedPay01";
let opened = 0;
const sessionId = () => `cs_test_${String(opened).padStart(24, "0")}`;
/** When set, the id the Stripe stand-in answers a new checkout with, in place of a well-formed one (Codex X4). */
let answeredId: unknown;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    opened += 1;
    return answer({ id: answeredId === undefined ? sessionId() : answeredId, object: "checkout.session", url: "https://checkout.stripe.com/c/pay/test" });
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
  const open = await add("Letters until canceled", "50", { interval: "month", trialDays: 0, payments: 0 });
  const once = await add("One guide", "50", null);
  const store = (await storeForEmail(OWNER))!;
  const pending = async () => (await redis.pipeline([["SMEMBERS", "nl:plans:pending"]]))[0] as string[];
  const remembered = async (id: string) => (await pending()).some((entry) => entry.startsWith(`${ACCOUNT}|${id}|`));
  const product = async (id: string) => (await readProduct(store, id))!;

  part("The three doors open their checkout through createCheckout");
  for (const [door, file] of [["the welcome offer", "lib/welcome-offer-send.ts"], ["the come-back offer", "lib/winback-send.ts"], ["the moved-members link", "lib/move-members.ts"]]) {
    const source = readFileSync(file, "utf8");
    is(`${door} (${file}) opens it with createCheckout (or createCheckoutUnlessHeld, which calls it) and does not write the plan down itself`, [/createCheckout(?:UnlessHeld)?\(store, product, origin/.test(source), source.includes("rememberPlan")], [true, false]);
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
  is("a membership until canceled and a one-off product: the list is as it was", (await pending()).length, before);

  // Codex X4 on #4493 (MEDIUM): createCheckout took any string as the session id, and rememberPlan silently skipped
  // one that is not a Stripe checkout session id, so a 200 with a usable URL and an odd id sent the buyer to pay a
  // three-payment membership that the plans job would never end. Now the checkout is only handed out once its end is
  // written down: an id the job cannot follow, or a Redis reply that does not confirm the write, refuses it.
  part("A Stripe answer the plans job cannot follow is refused before the buyer is sent on");
  const product3 = await product(three);
  const refused = async (call: () => Promise<unknown>) => {
    try {
      await call();
      return false;
    } catch {
      return true;
    }
  };
  for (const [name, id] of [["a word", "not-a-checkout-session"], ["an empty id", ""], ["a short id", "cs_test_short"], ["another object's id", "sub_1TestFixedPay0000000000"]] as const) {
    answeredId = id;
    const listed = (await pending()).length;
    is(`a three-payment membership answered with ${name}: refused, and nothing is written`, [await refused(() => createCheckout(store, product3, "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT })), (await pending()).length], [true, listed]);
  }
  answeredId = undefined;

  part("Redis must confirm the write (an integer 0 or 1) before the checkout is handed out");
  const real = redis.pipeline.bind(redis);
  for (const [name, reply] of [["no reply", []], ["a null", [null]], ["a word", ["OK"]], ["a count above one", [2]], ["a numeric string", ["1"]]] as const) {
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.some((command) => command[0] === "SADD" && command[1] === "nl:plans:pending") ? [...reply] : real(commands)) as typeof redis.pipeline;
    is(`SADD answered with ${name}: the checkout is refused`, await refused(() => createCheckout(store, product3, "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT })), true);
    redis.pipeline = real;
  }
  await createCheckout(store, product3, "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT });
  is("control: SADD answered with 1 hands the checkout out, on the list", await remembered(sessionId()), true);

  part("rememberPlan itself never reports a write it did not make");
  is("an account that is not a Stripe account: refused", await refused(() => rememberPlan("not-an-account", "cs_test_000000000000000000000001")), true);
  is("a session that is not a checkout session: refused", await refused(() => rememberPlan(ACCOUNT, "cs_test_x")), true);
  redis.pipeline = (async () => [0]) as typeof redis.pipeline;
  is("SADD answered with 0 (already on the list) is a confirmed write", await refused(() => rememberPlan(ACCOUNT, "cs_test_000000000000000000000002")), false);
  redis.pipeline = real;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
