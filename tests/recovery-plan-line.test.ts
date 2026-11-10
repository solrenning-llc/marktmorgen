/**
 * 630 [HN6](15): the checkout reminder (lib/checkout-recovery.ts), sent only
 * to a buyer whose checkout recorded their yes, says the payment plan the
 * product already offers on its page, as the page says it, at today's
 * amounts. What is checked:
 *
 *   - a product with a plan: the reminder names it, after the price;
 *   - a product without one, or whose plan is paused (it no longer covers
 *     the price): no plan line at all, never a plan it does not offer;
 *   - the sentence in every buyer language carries the plan as given.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setLanguage, setProductExtras, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { remindAbandoned } from "@/lib/checkout-recovery";
import { readListing } from "@/lib/catalog";
import { activePlan } from "@/lib/product-extras";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { speechFor } from "@/lib/buyer-words";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_recovery_plan_only";
// One of the synthetic keys the Resend fixture accepts (tests/resend-fixture-credentials.ts).
process.env.RESEND_API_KEY = "re_test_recovery_journey_only";

const OWNER = "planner@example.com";
const emails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    emails.push({ to: [body.to].flat()[0], text: body.text });
    return answer({ id: `email_${emails.length}` });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "plannedshop", "Planned Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPlan00001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00009", subscriptionId: "sub_Owner00009", active: true, period: paidPeriod() });
  await setRecovery(OWNER, { enabled: true, address: "9 Kiln Road, Portland, OR 97201", asks: true });
  const add = async (title: string, price: string) => {
    const made = await addProduct(OWNER, title, "", price, null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const course = await add("Pottery Course", "24");
  const plain = await add("Glaze Chart", "12");
  const paused = await add("Kiln Guide", "30");
  const set = await setProductExtras(OWNER, course, { plan: { payments: 3, interval: "month", amountCents: 900 } });
  is("the plan is saved on the product", set.ok, true);
  const kept = await setProductExtras(OWNER, paused, { plan: { payments: 3, interval: "month", amountCents: 1000 } });
  is("and one on the guide too", kept.ok, true);
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  const left = (product: string, email: string) =>
    ({
      id: `cs_test_plan${String((n += 1)).padStart(12, "0")}`,
      object: "checkout.session",
      status: "expired",
      payment_status: "unpaid",
      created: now - 3700,
      expires_at: now - 100,
      consent: { promotions: "opt_in" },
      customer_details: { email },
      metadata: { store: "plannedshop", product },
    }) as never;
  const load = async () => (await storeForEmail(OWNER))!;
  const plan = speechFor("en", "usd").w.planWords(3, "month", "$9");

  part("A product with a plan");
  is("sent", await remindAbandoned(await load(), left(course, "ana@example.com")), "sent");
  const mail = emails.at(-1)!.text;
  is("names the plan as the page says it, after the price", [mail.includes(GIVING_WORDS.en.recoverPlan(plan)), mail.indexOf("$24") < mail.indexOf(plan)], [true, true]);
  is("in plain words", GIVING_WORDS.en.recoverPlan(plan), "You can also pay in parts: 3 monthly payments of $9. Choose it on the same page before you pay.");

  part("Never a plan the page does not offer");
  is("a product without a plan: sent, with no plan line", [await remindAbandoned(await load(), left(plain, "ben@example.com")), emails.at(-1)!.text.includes("pay in parts")], ["sent", false]);
  // The guide's price raised over what its payments add up to: the plan is paused, so the page no longer offers it.
  const { editProduct } = await import("@/lib/store");
  await editProduct(OWNER, paused, "Kiln Guide", "", "40", null, null);
  const guide = (await readListing(await load(), paused))!;
  is("the guide keeps its plan, which no longer covers the price: paused", [guide.priceCents, guide.plan !== null, activePlan(guide)], [4000, true, null]);
  is("a plan paused since: sent, with no plan line", [await remindAbandoned(await load(), left(paused, "cy@example.com")), emails.at(-1)!.text.includes("pay in parts")], ["sent", false]);

  part("In every buyer language");
  is("each carries the plan as given", LANGUAGE_CODES.filter((code) => !GIVING_WORDS[code].recoverPlan("«plan»").includes("«plan»")), []);
  is("each its own words", new Set(LANGUAGE_CODES.map((code) => GIVING_WORDS[code].recoverPlan("x"))).size, LANGUAGE_CODES.length);
  await setLanguage(OWNER, "de");
  is("a German store's reminder says it in German", [await remindAbandoned(await load(), left(course, "dee@example.com")), emails.at(-1)!.text.includes(GIVING_WORDS.de.recoverPlan(speechFor("de", "usd").w.planWords(3, "month", speechFor("de", "usd").money(900))))], ["sent", true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
