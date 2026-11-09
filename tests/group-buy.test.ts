/**
 * One product bought for several people (lib/group-buy.ts): the buyer pays
 * once, and one link hands out the places.
 *
 * Measured before it was built (7 October 2026): Kajabi's checkout can charge
 * for several, and only the buyer is given access; the creator grants the
 * rest by hand from a list. What is checked:
 *
 *   - what can be bought this way, and how the number typed is read: never
 *     rounded, never clamped;
 *   - the checkout is one payment of the price times the people, marked, with
 *     nothing added and no offer after it;
 *   - the buyer's own checkout opens nothing (deliveredIds);
 *   - once paid, the buyer's receipt carries the link, once;
 *   - typing an address takes nothing: the place is taken when the emailed
 *     link is opened, on that address, with a course dated from that day;
 *   - never one place more than was paid for, even for a link sent while a
 *     place was still open;
 *   - an address that already has the product uses no place;
 *   - the list of purchases says what it is, and a full refund takes back
 *     what this purchase gave and nothing else;
 *   - a product with price options is bought for everybody at the one the
 *     buyer picked: that price times the people, and that option's link.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { MAX_PEOPLE, canGroup, payable, placesWords, readPeople } from "@/lib/group-rules";
import { askPlace, groupJob, groupTitle, openGroup, placesHeld, placesTaken, readGroup, revokeRefundedGroups, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { ADMITTED_FIELD, OPEN_HOURS } from "@/lib/order-admission";
import { allowanceWindow } from "@/lib/allowance-window";
import { paidOrdersLimitFor } from "@/lib/order-rules";
import { storeFolder, storeRef } from "@/lib/store";
import { deliveredIds } from "@/lib/bundle-rules";
import { grantImported, importedFor } from "@/lib/imported-purchases";
import { purchasesFor } from "@/lib/buyer-orders";
import { createCheckout } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[]; subject: string; text: string };
const emails: Sent[] = [];
const checkouts: URLSearchParams[] = [];
let refunds: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"t".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === "/refunds") return answer({ object: "list", data: refunds, has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const base = (over: Partial<Listing>): Listing =>
  ({ id: "x", priceCents: 2900, recurring: null, call: null, pwyw: null, keys: null, options: [], file: null, link: "https://example.com", course: null, bundle: null, stock: null, ...over }) as Listing;

const BASE = "https://marktmorgen.com/@harbor";
const FROM = '"Harbor Kitchen" <hello@marktmorgen.com>';

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_groups_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_groups_only";

  part("What can be bought for several");
  is("a paid download", canGroup(base({})), true);
  is("not what cannot be given", [canGroup(base({ priceCents: 0 })), canGroup(base({ options: [{}] as Listing["options"] })), canGroup(base({ recurring: { interval: "month" } as Listing["recurring"] }))], [false, false, false]);
  is("not a limited quantity", canGroup(base({ stock: 50 })), false);
  is("not a private podcast", canGroup(base({ podcast: {} as Listing["podcast"] })), false);

  part("How many people");
  is("a whole number in range", [readPeople("5"), readPeople(" 12 "), readPeople(String(MAX_PEOPLE))], [5, 12, MAX_PEOPLE]);
  is("one is an ordinary purchase", readPeople("1"), null);
  is("never clamped, rounded or guessed", [readPeople(String(MAX_PEOPLE + 1)), readPeople("2.5"), readPeople("-3"), readPeople("five"), readPeople(""), readPeople(null)], [null, null, null, null, null, null]);
  is("a payment Stripe can take", [payable(2900, 200), payable(900_000, 200), payable(0, 5)], [true, false, false]);
  is("what the page says is left", [placesWords(5, 2), placesWords(5, 4), placesWords(5, 5)], ["3 of 5 places are still open.", "1 of 5 places is still open.", "All 5 places have been taken."]);

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/course");
  let store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;

  part("Before the checkout");
  const bad = await startGroup(store, product, "1");
  is("a number that is not one", bad.ok ? "started" : bad.reason, "people");
  const started = await startGroup(store, product, "2");
  if (!started.ok) throw new Error("no purchase for several");
  const id = started.group.id;
  is("written down with its number", started.group.people, 2);
  is("not open before it is paid", await openGroup(store, id), null);

  part("Its checkout");
  const full = (await readProduct(store, product.id))!;
  await createCheckout(store, full, "https://marktmorgen.com", "", { group: { id, people: 2 }, bumps: ["yes"], plan: true, upsellKey: "f".repeat(40), buyerKey: "b".repeat(40), digitalConsent: TEST_CONSENT });
  const sent = checkouts[0];
  is("the price, that many times, on one line", [sent.get("line_items[0][quantity]"), sent.get("line_items[0][price_data][unit_amount]")], ["2", "4900"]);
  is("marked", [sent.get("metadata[group]"), sent.get("metadata[people]"), sent.get("payment_intent_data[metadata][group]")], [id, "2", id]);
  is("named for what it is", sent.get("metadata[title]"), "Sourdough Course (for 2 people)");
  is("one payment, nothing added, no offer after, nothing opened for the buyer", [sent.get("mode"), sent.get("line_items[1][quantity]"), sent.get("metadata[upsell_key]"), sent.get("metadata[buyer_key]")], ["payment", null, null, null]);
  let refused = "";
  await createCheckout(store, { ...full, stock: 10 }, "https://marktmorgen.com", "", { group: { id, people: 2 }, digitalConsent: TEST_CONSENT }).catch((error: Error) => (refused = error.message));
  is("refused where the charge is built, too", refused, "This cannot be bought for several people");
  await createCheckout(store, full, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT });
  is("an ordinary checkout is still for one", [checkouts.at(-1)!.get("line_items[0][quantity]"), checkouts.at(-1)!.get("metadata[group]")], ["1", null]);

  part("The buyer's own checkout");
  const meta = { store: "harbor", product: product.id, group: id, people: "2" };
  is("opens nothing for whoever paid", deliveredIds(meta), []);

  part("Once paid");
  const session = {
    id: "cs_test_" + "t".repeat(24),
    created: 1_900_000_000,
    amount_total: 9800,
    currency: "usd",
    payment_intent: "pi_Group000001",
    metadata: meta,
    customer_details: { email: "buyer@example.com" },
  };
  const settle = () => settleGroup({ store, session, product, base: BASE, from: FROM });
  is("settled", await settle(), "settled");
  is("twice is once", await settle(), "already");
  const receipt = emails.find((e) => e.to[0] === "buyer@example.com");
  is("the receipt: how many, what was paid, the link", Boolean(receipt?.text.includes("for 2 people") && receipt.text.includes("$98") && receipt.text.includes(`${BASE}/group/${id}`)), true);
  is("one email so far", emails.length, 1);
  is("open now, with its payment", (await openGroup(store, id))?.pi, "pi_Group000001");

  part("Asking for a place");
  const starts: string[] = [];
  const ask = (email: unknown) => askPlace({ store, id, email, product, base: BASE, from: FROM, ordersLink: async (address) => `${BASE}/orders?token=${"a".repeat(64)}&for=${address}` });
  const take = (token: string) => takePlace({ store, token, recordStart: async (email, productId, start) => void starts.push(`${email}|${productId}|${start > 0}`) });
  const tokenFor = (address: string) => emails.filter((e) => e.to[0] === address).at(-1)?.text.match(/\?take=([0-9a-f]{64})/)?.[1] ?? "";
  is("an address that is not one", await ask("nope"), "email");
  is("a link is sent", await ask("Ana@Example.com"), "sent");
  is("to the address as one, with the way to take it", tokenFor("ana@example.com").length, 64);
  is("and nothing is taken by typing", await placesTaken(id), 0);
  // The month's access emails cannot be read: no email goes, and the person is told to try again, never "sent".
  for (const [label, reply] of [["a lost reply", "lost"], ["a missing reply", []], ["a word", ["many"]], ["a negative count", ["-1"]]] as [string, unknown[] | "lost"][]) {
    const original = redis.pipeline;
    redis.pipeline = async (commands) => {
      if (!(commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:allow:transactional:"))) return original(commands);
      if (reply === "lost") throw new Error("synthetic lost reply");
      return [...reply];
    };
    const mailsBefore = emails.length;
    let answer: unknown;
    try {
      answer = await ask(`unread.${label.length}@example.com`);
    } finally {
      redis.pipeline = original;
    }
    is(`the month's access emails unread (${label}): unavailable, nothing sent`, [answer, emails.length - mailsBefore], ["unavailable", 0]);
  }
  // Two more ask while both places are still open.
  await ask("ben@example.com");
  await ask("cy@example.com");

  part("Taking it");
  const first = await take(tokenFor("ana@example.com"));
  is("taken, on that address", [first.outcome, "email" in first ? first.email : ""], ["taken", "ana@example.com"]);
  store = (await storeForEmail("owner@example.com"))!;
  is("it is theirs", (await importedFor(store, "ana@example.com")).map((p) => [p.productId, p.job]), [[product.id, groupJob(id)]]);
  is("a course would be dated from that day", starts, [`ana@example.com|${product.id}|true`]);
  is("opening the link again takes nothing more", [(await take(tokenFor("ana@example.com"))).outcome, await placesTaken(id)], ["already", 1]);
  is("a link nobody was sent", (await take("0".repeat(64))).outcome, "gone");
  is("the second place", (await take(tokenFor("ben@example.com"))).outcome, "taken");
  is("never one more than was paid for", [(await take(tokenFor("cy@example.com"))).outcome, await placesTaken(id)], ["full", 2]);
  is("and nothing was handed to the third", (await importedFor(store, "cy@example.com")).length, 0);
  is("a new address is told so", await ask("dee@example.com"), "full");
  const before = emails.length;
  is("someone with a place is sent the way in again", [await ask("ana@example.com"), emails.length - before, emails.at(-1)?.text.includes("/orders?token=")], ["sent", 1, true]);

  part("On the list of purchases");
  const listed = await purchasesFor({ ...store, stripeAccountId: null }, "ana@example.com");
  is("a place, not something brought over or a gift", listed.map((p) => [p.title, p.place, p.giftFrom]), [["Sourdough Course", true, null]]);

  part("An address that already has it");
  const other = await startGroup(store, product, "3");
  if (!other.ok) throw new Error("no second purchase");
  const otherMeta = { ...meta, group: other.group.id, people: "3" };
  await settleGroup({ store, session: { ...session, id: "cs_test_" + "u".repeat(24), payment_intent: "pi_Group000002", metadata: otherMeta }, product, base: BASE, from: FROM });
  const askOther = (email: string) => askPlace({ store, id: other.group.id, email, product, base: BASE, from: FROM, ordersLink: async () => null });
  await askOther("ana@example.com");
  is("uses no place", [(await take(tokenFor("ana@example.com"))).outcome, await placesTaken(other.group.id)], ["has", 0]);
  await askOther("eve@example.com");
  is("someone new takes one", (await take(tokenFor("eve@example.com"))).outcome, "taken");

  part("A link cannot be used to fill inboxes");
  const answers: string[] = [];
  for (let i = 0; i < 25; i += 1) answers.push(await askOther(`flood${i}@example.com`));
  is("it stops sending after a generous number a day", [answers.filter((a) => a === "sent").length < 25, answers.at(-1)], [true, "slow"]);

  part("A refund");
  const dropped: string[] = [];
  // Somebody else has the product from the creator's own import: that stays.
  await grantImported(store.statsId!, "import_1", [{ email: "zed@example.com", productId: product.id, items: null }]);
  // Rule 23: the refund and its charge now carry their amounts, as Stripe lists them: since the owner's decision 18 (9 November
  // 2026) a succeeded refund takes the places back only when its amount covers the charge, or the charge's refunds add up.
  refunds = [{ id: "re_1", created: Math.floor(Date.now() / 1000), status: "succeeded", amount: 4900, payment_intent: "pi_Group000001", charge: { refunded: true, amount: 4900 } }];
  is("a full refund takes every place back", await revokeRefundedGroups(store, Date.now() + 10_000, async (email, productId) => void dropped.push(`${email}|${productId}`)), 2);
  is("from each address", [(await importedFor(store, "ana@example.com")).length, (await importedFor(store, "ben@example.com")).length], [0, 0]);
  is("and their courses", dropped.sort(), [`ana@example.com|${product.id}`, `ben@example.com|${product.id}`]);
  is("the other purchase's place is untouched", (await importedFor(store, "eve@example.com")).length, 1);
  is("and so is what an import gave", (await importedFor(store, "zed@example.com")).length, 1);
  is("closed for good", [await openGroup(store, id), Boolean((await readGroup(id))?.revoked)], [null, true]);
  is("read once", await revokeRefundedGroups(store, Date.now() + 10_000, async () => {}), 0);

  part("At one of several prices");
  const pack = await addProduct("owner@example.com", "Meal Planner", "", "27", null);
  if (!pack.ok) throw new Error("no second product");
  const one = await addOption("owner@example.com", pack.product.id, "1 week", "27");
  const five = await addOption("owner@example.com", pack.product.id, "5 weeks", "39");
  if (!one.ok || !five.ok) throw new Error("no options");
  store = (await storeForEmail("owner@example.com"))!;
  let planner = (await readProduct(store, pack.product.id))!;
  const [week, weeks] = planner.options;
  await setProductLink("owner@example.com", week.id, "https://example.com/one-week");
  await setProductLink("owner@example.com", weeks.id, "https://example.com/five-weeks");
  store = (await storeForEmail("owner@example.com"))!;
  planner = (await readProduct(store, pack.product.id))!;
  is("it can be bought for several", canGroup(planner), true);
  const unnamed = await startGroup(store, planner, "3");
  is("no option named: refused, never guessed", unnamed.ok ? "started" : unnamed.reason, "option");
  const picked = await startGroup(store, planner, "3", weeks.id);
  if (!picked.ok) throw new Error("no purchase at an option");
  is("the option is kept with it, and named", [picked.group.o, groupTitle(planner, picked.group)], [weeks.id, "Meal Planner (5 weeks)"]);
  await createCheckout(store, planner, "https://marktmorgen.com", weeks.id, { group: { id: picked.group.id, people: 3 }, digitalConsent: TEST_CONSENT });
  const optioned = checkouts.at(-1)!;
  is("that option's price, times the people", [optioned.get("line_items[0][price_data][unit_amount]"), optioned.get("line_items[0][quantity]"), optioned.get("metadata[option]")], ["3900", "3", weeks.id]);
  is("named for all of it", optioned.get("metadata[title]"), "Meal Planner (5 weeks) (for 3 people)");
  const optionMeta = { store: "harbor", product: planner.id, option: weeks.id, group: picked.group.id, people: "3" };
  emails.length = 0;
  await settleGroup({ store, session: { ...session, id: "cs_test_" + "v".repeat(24), payment_intent: "pi_Group000003", amount_total: 11_700, metadata: optionMeta }, product: planner, base: BASE, from: FROM });
  is("the receipt names it", emails.at(-1)?.subject, "Your 3 places: Meal Planner (5 weeks)");
  await askPlace({ store, id: picked.group.id, email: "gil@example.com", product: planner, base: BASE, from: FROM, ordersLink: async () => null });
  is("someone takes a place", (await take(tokenFor("gil@example.com"))).outcome, "taken");
  const theirs = await purchasesFor({ ...store, stripeAccountId: null }, "gil@example.com");
  is("and opens that option, and no other", theirs.map((p) => [p.title, p.option, p.place, p.main?.link]), [["Meal Planner", "5 weeks", true, "https://example.com/five-weeks"]]);

  part("Each place is one of the month's orders (18 October 2026)");
  const folder = await storeFolder(storeRef(store));
  const openKey = `nl:orders:open:${folder}`;
  const hourNow = Math.floor(Date.now() / 3_600_000);
  // A purchase whose checkout held room for its places this hour (lib/order-admission.ts).
  const heldGroup = await startGroup(store, product, "2");
  if (!heldGroup.ok) throw new Error("no held purchase");
  await redis.pipeline([["HSET", openKey, String(hourNow), 3]]);
  await settleGroup({ store, session: { ...session, id: "cs_test_" + "w".repeat(24), payment_intent: "pi_Group000004", metadata: { ...meta, group: heldGroup.group.id, [ADMITTED_FIELD]: String(hourNow) } }, product, base: BASE, from: FROM });
  const heldNow = (await readGroup(heldGroup.group.id))!;
  is("it knows the hour its checkout held room in, and that the room is held", [heldNow.h, placesHeld(heldNow), placesHeld(heldNow, (hourNow + OPEN_HOURS) * 3_600_000)], [hourNow, true, false]);
  await askPlace({ store, id: heldGroup.group.id, email: "hal@example.com", product, base: BASE, from: FROM, ordersLink: async () => null });
  is("a place taken in that day uses what was held, and gives it back as it is counted", [(await take(tokenFor("hal@example.com"))).outcome, Number((await redis.pipeline([["HGET", openKey, String(hourNow)]]))[0])], ["taken", 2]);
  // Later: the hold is long gone, and the month's orders are all used.
  const lateGroup = await startGroup(store, product, "2");
  if (!lateGroup.ok) throw new Error("no late purchase");
  await settleGroup({ store, session: { ...session, id: "cs_test_" + "x".repeat(24), payment_intent: "pi_Group000005", metadata: { ...meta, group: lateGroup.group.id, [ADMITTED_FIELD]: String(hourNow - 2 * OPEN_HOURS) } }, product, base: BASE, from: FROM });
  await redis.pipeline([["DEL", openKey], ["SET", `nl:orders:n:${folder}:${allowanceWindow(store)!.id}`, paidOrdersLimitFor(store)!]]);
  await askPlace({ store, id: lateGroup.group.id, email: "ida@example.com", product, base: BASE, from: FROM, ordersLink: async () => null });
  const late = await take(tokenFor("ida@example.com"));
  is("taken after its day, a place is admitted like a new order: with none left, nothing is handed over and the place stays open", [late.outcome, await placesTaken(lateGroup.group.id), (await importedFor(store, "ida@example.com")).length], ["resting", 0, 0]);
  await redis.pipeline([["SET", `nl:orders:n:${folder}:${allowanceWindow(store)!.id}`, 0]]);
  await askPlace({ store, id: lateGroup.group.id, email: "ida@example.com", product, base: BASE, from: FROM, ordersLink: async () => null });
  is("with room in the month, the same person takes it", [(await take(tokenFor("ida@example.com"))).outcome, await placesTaken(lateGroup.group.id)], ["taken", 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
