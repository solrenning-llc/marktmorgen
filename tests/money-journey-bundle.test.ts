/**
 * Money journey, end to end: a bundle, from the creator putting it together
 * to what each buyer is handed, before and after the creator changes it
 * (C2-159 item 4, part 2). The other tests check the pieces on their own
 * (tests/pick-bundle.test.ts, tests/cart-bundle.test.ts); this one walks a
 * buyer through every step, with the real code at each and only Stripe and
 * the email sender simulated:
 *
 *   1. the creator makes a $59 Starter Kit of three products sold on their
 *      own for $20, $30 and $40;
 *   2. a buyer pays for it through the real checkout route
 *      (POST /api/store/checkout): one line of $59, and the three products
 *      written on the order as it is now;
 *   3. Stripe takes the $59: readOrder hands over all three, each with its
 *      own link, and the confirmation names what is inside, once, for the
 *      $59 paid;
 *   4. the creator takes the video out of the kit: the buyer who already
 *      paid keeps all three, and the next buyer is sold and handed the two
 *      still in it;
 *   5. the first buyer is refunded in full: their order hands over nothing.
 *
 * Each step reads what the one before wrote, so a break anywhere fails the
 * journey. Synthetic data only: no real Stripe, email or Redis.
 */
import { NextRequest } from "next/server";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { confirmPurchase } from "@/lib/purchase-email";
import { readOrder } from "@/lib/store-checkout";
import { addProduct, claimHandle, ensureStatsId, setProductBundle, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { withConsent } from "./digital-consent-fixture";

const OWNER = "pottery@example.com";
const HANDLE = "wheelhouse";
const ACCOUNT = "acct_1TestWheel00001";

const opened: { id: string; body: URLSearchParams; account: string | null }[] = [];
const sessions = new Map<string, Record<string, unknown>>();
const emails: { to: string[]; subject: string; text: string }[] = [];
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** As Stripe answers: the payment is only its id unless the request expanded it. */
const asAsked = (session: Record<string, unknown>, url: URL) => {
  const pi = session.payment_intent as { id?: string } | string | undefined;
  const expanded = url.searchParams.getAll("expand[]").some((field) => field.startsWith("payment_intent"));
  return pi && typeof pi === "object" && !expanded ? { ...session, payment_intent: pi.id } : session;
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return answer({ id: `email_${emails.length}` });
  }
  if (url.hostname !== "api.stripe.com") return answer({}, 404);
  if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
    const id = `cs_test_journeykit${String(opened.length + 1).padStart(6, "0")}`;
    opened.push({ id, body: new URLSearchParams(String(init?.body)), account: new Headers(init?.headers).get("Stripe-Account") });
    sessions.set(id, { id, object: "checkout.session", status: "open", payment_status: "unpaid" });
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (one && method === "GET") {
    const found = sessions.get(decodeURIComponent(one[1]));
    return found ? answer(asAsked(found, url)) : answer({ error: { message: "No such checkout.session" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** What was sent as `metadata[...]` on a checkout, as Stripe hands it back. */
function metadataOf(body: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of body) {
    const name = /^metadata\[([^\]]+)\]$/.exec(key);
    if (name) out[name[1]] = value;
  }
  return out;
}

/** Stripe takes the payment for an opened checkout, for what its line says. */
function stripePays(id: string, email: string): void {
  const made = opened.find((entry) => entry.id === id);
  if (!made) throw new Error(`no checkout ${id}`);
  const total = Number(made.body.get("line_items[0][price_data][unit_amount]"));
  sessions.set(id, {
    id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", currency: "usd",
    amount_subtotal: total, amount_total: total, total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    created: Math.floor(Date.now() / 1000), customer_details: { email }, metadata: metadataOf(made.body),
    payment_intent: { id: `pi_test_journeykit${id.slice(-6)}`, object: "payment_intent", status: "succeeded", latest_charge: { id: `ch_test_journeykit${id.slice(-6)}`, object: "charge", amount: total, amount_refunded: 0, refunded: false, disputed: false }, payment_method: { type: "card" } },
  });
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_journey_kit_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  part("1. The creator puts the kit together");
  await claimHandle(OWNER, HANDLE, "Wheel House", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Wheel000001", subscriptionId: "sub_Wheel000001", active: true, period: paidPeriod() });
  const ids: Record<string, string> = {};
  for (const [title, price] of [["Glaze Guide", "20"], ["Kiln Templates", "30"], ["Throwing Video", "40"]] as const) {
    const added = await addProduct(OWNER, title, "", price, null);
    if (!added.ok) throw new Error(`no ${title}`);
    ids[title] = added.product.id;
    await setProductLink(OWNER, added.product.id, `https://example.com/${added.product.id}`);
  }
  const kit = await addProduct(OWNER, "Starter Kit", "", "59", null);
  if (!kit.ok) throw new Error("no kit");
  const made = await setProductBundle(OWNER, kit.product.id, [ids["Glaze Guide"], ids["Kiln Templates"], ids["Throwing Video"]]);
  is("the kit holds the three products", made.ok ? made.product.bundle : made.reason, [ids["Glaze Guide"], ids["Kiln Templates"], ids["Throwing Video"]]);
  const store = async () => (await storeForEmail(OWNER))!;
  const buy = async () => {
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("product", kit.product.id);
    const before = opened.length;
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(form), headers: { host: "marktmorgen.com" } }));
    return { stripe: new URL(response.headers.get("location") ?? "https://x/").hostname === "checkout.stripe.com", made: opened.slice(before) };
  };
  const handed = async (id: string) => {
    const order = await readOrder(await store(), id);
    return order.state === "paid" ? order.items?.items.map((item) => [item.title, item.link]) ?? [] : order.state;
  };

  part("2. A buyer pays for the kit");
  const first = await buy();
  is("sent to Stripe, one checkout on the creator's account", [first.stripe, first.made.length, first.made[0]?.account], [true, 1, ACCOUNT]);
  const checkout = first.made[0];
  is("one line, the kit's own $59, not the $90 of its parts", [checkout.body.get("line_items[0][price_data][unit_amount]"), checkout.body.get("line_items[1][quantity]")], ["5900", null]);
  is("the order names the kit", metadataOf(checkout.body).product, kit.product.id);

  part("3. Paid: all three are handed over");
  stripePays(checkout.id, "potter@example.com");
  const everything = [["Glaze Guide", `https://example.com/${ids["Glaze Guide"]}`], ["Kiln Templates", `https://example.com/${ids["Kiln Templates"]}`], ["Throwing Video", `https://example.com/${ids["Throwing Video"]}`]];
  is("readOrder hands over the three, each with its own link", await handed(checkout.id), everything);
  const order = await readOrder(await store(), checkout.id);
  is("for the $59 paid", order.state === "paid" ? order.amount : order.state, 5900);
  is("the confirmation is sent", await confirmPurchase(await store(), checkout.id), "sent");
  const mine = emails.filter((email) => email.to.includes("potter@example.com"));
  is("one email, naming the kit and each thing inside it", [mine.length, ["Starter Kit", "Glaze Guide", "Kiln Templates", "Throwing Video"].every((title) => mine[0]?.text.includes(title))], [1, true]);
  is("and the $59 paid", (mine[0]?.text ?? "").split("\n").find((line) => line.startsWith("Paid:")), "Paid: $59");
  is("a second try sends nothing more", await confirmPurchase(await store(), checkout.id), "already");

  part("4. The creator takes the video out of the kit");
  const changed = await setProductBundle(OWNER, kit.product.id, [ids["Glaze Guide"], ids["Kiln Templates"]]);
  is("the kit now holds two", changed.ok ? changed.product.bundle?.length : changed.reason, 2);
  is("the buyer who already paid keeps all three", await handed(checkout.id), everything);
  const second = await buy();
  stripePays(second.made[0].id, "newcomer@example.com");
  is("the next buyer is handed the two still in it", await handed(second.made[0].id), everything.slice(0, 2));

  part("5. The first buyer is refunded in full");
  const paid = sessions.get(checkout.id)!;
  const intent = paid.payment_intent as Record<string, unknown>;
  sessions.set(checkout.id, { ...paid, payment_intent: { ...intent, latest_charge: { ...(intent.latest_charge as Record<string, unknown>), amount_refunded: 5900, refunded: true } } });
  is("their order hands over nothing", await handed(checkout.id), "refunded");
  is("the other buyer's order is untouched", (await handed(second.made[0].id)).length, 2);

  done();
}

void main();
