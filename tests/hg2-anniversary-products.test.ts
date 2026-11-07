/**
 * 283 [HG2], unit 3: which products the anniversary email is sent for.
 *
 * Every product, by default, as before this unit; or only the products the
 * creator chooses. Stripe and the email sender are played by a stand-in for
 * `fetch`; no real email is sent. What is checked:
 *
 *   - the choice is read exactly: a setting saved before this unit means
 *     every product; anything that cannot be read whole is "unknown", and a
 *     store whose choice is unknown sends nothing (and reads nothing) that
 *     run, never every product;
 *   - saving is exact too: only products the store has, at least one when
 *     the email is on, never more than MAX_ANNIVERSARY_PRODUCTS; a save that
 *     does not name the choice keeps the one saved, never widens it;
 *   - only a purchase of a chosen product is written about; a person who
 *     bought a chosen and an unchosen product that day is written about the
 *     chosen one, once;
 *   - a product deleted from the store leaves the choice in the same write;
 *     when the last chosen one goes, nothing is sent (never "every product");
 *   - the studio lists the products a buyer pays for once (no free product,
 *     no membership), in the creator's order;
 *   - the protections of unit 1 stay: the box at checkout, the list, once
 *     per person per date, the store's email figure before sending;
 *   - the studio's editor says what is true: "On" and the month's count only
 *     while the email really goes out (anniversaryOn, a connected Stripe
 *     account and email in the plan), "On, but not sending" with the reason
 *     when switched on but stopped, and a warning when it is switched on with
 *     no product chosen, without changing the setting;
 *     a choice refused is said at the products, and the most that can be
 *     chosen is said beside the boxes it disables.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, removeProduct, setAnniversary, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { redisPipeline } from "@/lib/redis";
import * as rules from "@/lib/anniversary-rules";
import * as send from "@/lib/anniversary-send";
import * as studio from "@/lib/anniversary-choices";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnniversaryEditor } from "@/components/anniversary-editor";

const now = Date.UTC(2026, 10, 6, 12, 0, 0);
const yearAgo = Math.floor(Date.UTC(2025, 10, 6, 9, 0, 0) / 1000);
const OWNER = "owner@example.com";

type Sent = { to: string[]; subject: string; text: string };
const emails: Sent[] = [];
const sessions: Record<string, unknown>[] = [];
let listed = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${emails.length}` }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    listed += 1;
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    const found = sessions.map((s, i) => ({ s, i })).filter(({ s }) => Number(s.created) >= gte && Number(s.created) <= lte);
    found.sort((a, b) => Number(b.s.created) - Number(a.s.created) || b.i - a.i);
    return new Response(JSON.stringify({ object: "list", data: found.map(({ s }) => s), has_more: false }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

let n = 0;
/** A paid checkout as Stripe lists it, its charge expanded and untouched. */
function bought(email: string, product: string, created = yearAgo) {
  n += 1;
  const id = String(n).padStart(12, "0");
  sessions.push({
    id: `cs_test_hg3${id}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: 4900,
    created,
    customer_details: { email },
    metadata: { store: "harbor", product, news: "yes" },
    payment_intent: { id: `pi_test_hg3${id}`, latest_charge: { id: `ch_test_hg3${id}`, object: "charge", refunded: false, amount_refunded: 0, disputed: false } },
  });
}

/** Writes a value straight into the saved store record, as a garbled or older record would read. */
async function writeRaw(products: unknown): Promise<void> {
  const key = redis.keys().find((k) => /^nl:store:owner:[0-9a-f]+$/.test(k));
  if (!key) throw new Error("no store record");
  const [raw] = await redisPipeline([["GET", key]]);
  const record = JSON.parse(String(raw)) as Record<string, unknown>;
  const anniversary = { ...(record.anniversary as Record<string, unknown>) };
  if (products === undefined) delete anniversary.products;
  else anniversary.products = products;
  await redisPipeline([["SET", key, JSON.stringify({ ...record, anniversary })]]);
}

/** A daily run, at `at` (by default the test's moment). Each run reads on from where the last one stopped (unit 1). */
const run = (at = now) => send.sendAnniversaries(Date.now() + 30_000, at);
const HOUR = 3600;
/** A purchase a year before the test's moment plus `hours`, read by a run that late (a range not read before). */
const after = (hours: number) => Math.floor(Date.UTC(2025, 10, 6, 12, 0, 0) / 1000) + hours * HOUR - 1800;
const runAfter = (hours: number) => run(now + hours * HOUR * 1000);
const chosen = async () => (await storeForEmail(OWNER))?.anniversary as unknown as { products?: unknown };

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_hg3_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();
  const parse = rules.parseAnniversary as (raw: unknown) => rules.Anniversary & { products?: unknown };
  const covers = (rules as Record<string, unknown>).anniversaryCovers as ((setting: unknown, id: string) => boolean) | undefined;
  const max = (rules as Record<string, unknown>).MAX_ANNIVERSARY_PRODUCTS as number | undefined;
  const on = { on: true, message: "", address: "1 Main St, Portland, OR 97201" };

  part("The choice, read exactly");
  is("every product by default", (rules.NO_ANNIVERSARY as { products?: unknown }).products, "all");
  is("a setting saved before this unit means every product, as it did", parse(on).products, "all");
  is("every product, said so", parse({ ...on, products: "all" }).products, "all");
  is("a list of products, each once, in the order chosen", parse({ ...on, products: ["p2", "p1", "p2"] }).products, ["p2", "p1"]);
  is("a list emptied by deletions stays empty, never every product", parse({ ...on, products: [] }).products, []);
  is("a word that is not a choice is unknown", parse({ ...on, products: "some" }).products, "unknown");
  is("a list with something not an id in it is unknown, not the rest of it", parse({ ...on, products: ["p1", 7] }).products, "unknown");
  is("an id of the wrong shape is unknown", parse({ ...on, products: ["p1", "../x"] }).products, "unknown");
  is("a list longer than the bound is unknown, never cut", typeof max === "number" ? parse({ ...on, products: Array.from({ length: max + 1 }, (_, i) => `p${i}`) }).products : "no bound", "unknown");
  is("a number is unknown", parse({ ...on, products: 3 }).products, "unknown");
  is("on with every product", rules.anniversaryOn({ anniversary: parse({ ...on, products: "all" }) }), true);
  is("on with chosen products", rules.anniversaryOn({ anniversary: parse({ ...on, products: ["p1"] }) }), true);
  is("an unknown choice is not on: nothing is read or sent", rules.anniversaryOn({ anniversary: parse({ ...on, products: "x" }) }), false);
  is("no product left in the choice is not on", rules.anniversaryOn({ anniversary: parse({ ...on, products: [] }) }), false);
  is(
    "a purchase is covered only by every product or by its own being chosen",
    covers ? [covers(parse({ ...on, products: "all" }), "p9"), covers(parse({ ...on, products: ["p1"] }), "p1"), covers(parse({ ...on, products: ["p1"] }), "p9"), covers(parse({ ...on, products: "x" }), "p1")] : "missing",
    [true, true, false, false],
  );

  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0003", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00003", subscriptionId: "sub_Owner00003", active: true, tier: "pro", period: paidPeriod() });
  const course = await addProduct(OWNER, "Bread Basics", "", "49");
  const guide = await addProduct(OWNER, "Rye Guide", "", "19");
  const free = await addProduct(OWNER, "Free Starter", "", "0");
  const club = await addProduct(OWNER, "Bakers' Club", "", "10", { interval: "month", trialDays: 0, payments: 0 });
  const extra = await addProduct(OWNER, "Spelt Notes", "", "9");
  if (!course.ok || !guide.ok || !free.ok || !club.ok || !extra.ok) throw new Error("no product");
  const listId = (await storeForEmail(OWNER))?.listId;
  if (!listId) throw new Error("no list");
  const agreed = (email: string) => upsertContact(listId, email, { agreed: true, explicit: true, source: "buyer" }, ROOM);

  part("The studio lists what a buyer pays for once");
  const choices = (studio as Record<string, unknown>).anniversaryChoices as ((store: unknown) => Promise<{ id: string; title: string }[]>) | undefined;
  is(
    "paid products in the creator's order: no free product, no membership",
    choices ? (await choices(await storeForEmail(OWNER))).map((p) => p.title) : "missing",
    ["Bread Basics", "Rye Guide", "Spelt Notes"],
  );

  part("Saving the choice is exact");
  const refused = async (products: unknown, onToo = true) => {
    const result = await setAnniversary(OWNER, { ...on, on: onToo, products });
    return result.ok ? "saved" : result.reason;
  };
  is("a product the store does not have is refused, said why", await refused(["nothere123"]), "products");
  is("on with no product chosen is refused, said why", await refused([]), "products");
  is("a choice that cannot be read is refused", await refused("some"), "products");
  is("an id of the wrong shape is refused", await refused([guide.product.id, 5]), "products");
  const saved = await setAnniversary(OWNER, { ...on, products: [guide.product.id, guide.product.id] });
  is("chosen products are saved, each once", saved.ok ? (saved.store.anniversary as unknown as { products: unknown }).products : saved.reason, [guide.product.id]);
  await setAnniversary(OWNER, { ...on, message: "Thank you" });
  is("a save that does not name the choice keeps the one saved, never widens it", (await chosen())?.products, [guide.product.id]);

  part("Only purchases of the chosen products");
  bought("dana@example.com", course.product.id);
  bought("dana@example.com", guide.product.id);
  bought("eve@example.com", course.product.id);
  for (const who of ["dana", "eve"]) await agreed(`${who}@example.com`);
  await run();
  is("one email, to the buyer of a chosen product", emails.map((e) => e.to[0]), ["dana@example.com"]);
  is("about the chosen product, though she bought another first", emails[0]?.subject, "A year since you bought Rye Guide");
  await run();
  is("once per person per date, as before", emails.length, 1);

  part("An unknown choice sends nothing that run");
  bought("fay@example.com", guide.product.id);
  await agreed("fay@example.com");
  await writeRaw("garbled");
  const readBefore = listed;
  await run();
  is("nothing sent", emails.length, 1);
  is("and Stripe not even read", listed, readBefore);
  is("the studio is shown it could not be read", (await chosen())?.products, "unknown");

  part("Every product again");
  await writeRaw(undefined);
  is("a record from before this unit reads as every product", (await chosen())?.products, "all");
  bought("hal@example.com", course.product.id, after(2));
  bought("ivy@example.com", guide.product.id, after(2));
  for (const who of ["hal", "ivy"]) await agreed(`${who}@example.com`);
  await runAfter(2);
  is("the course's buyer and the guide's are both written to now", emails.map((e) => e.to[0]).sort(), ["dana@example.com", "hal@example.com", "ivy@example.com"]);
  is("a purchase already read while it was not chosen is not read again (unit 1 reads on from where it stopped)", emails.some((e) => ["eve@example.com", "fay@example.com"].includes(e.to[0])), false);

  part("A deleted product leaves the choice by itself");
  await setAnniversary(OWNER, { ...on, products: [guide.product.id, extra.product.id] });
  await removeProduct(OWNER, extra.product.id);
  is("taken out in the same write; the rest kept", (await chosen())?.products, [guide.product.id]);
  await removeProduct(OWNER, guide.product.id);
  is("the last one gone leaves none chosen, never every product", (await chosen())?.products, []);
  bought("gus@example.com", course.product.id, after(3));
  await agreed("gus@example.com");
  const before = emails.length;
  const readNow = listed;
  await runAfter(3);
  is("nothing sent with none chosen", [emails.length - before, listed - readNow], [0, 0]);

  part("The studio's editor says what is true");
  const draw = (setting: rules.Anniversary, choices: { id: string; title: string }[] | null = [], sentThisMonth = 3, connected = true, emailInPlan = true) =>
    renderToStaticMarkup(createElement(AnniversaryEditor, { setting, storeName: "Harbor", suggestedAddress: "", sent: sentThisMonth, choices, connected, emailInPlan }));
  const left = (await chosen()) as rules.Anniversary;
  is("the setting is left on, as the creator set it, with none chosen", [left.on, left.products], [true, []]);
  const emptyOn = draw(left);
  // Assertion changed (rule 23): the third value was `/>Off<\/span>/` expected true; switched on with none
  // chosen it now says "On, but not sending" (the box is checked, and nothing goes out), never "On" nor "Off".
  is("the editor does not say On while no email goes out", [rules.anniversaryOn({ anniversary: left }), />On<\/span>/.test(emptyOn), emptyOn.includes(">On, but not sending</span>")], [false, false, true]);
  is("nor counts the month as if it were sending", emptyOn.includes("Sent this month"), false);
  is("it says why nothing goes out, and what to do", emptyOn.includes("No product is chosen, so no email goes out. Choose at least one."), true);
  const choiceList = Array.from({ length: 201 }, (_, i) => ({ id: `prod${String(i).padStart(4, "0")}`, title: `Product ${i}` }));
  const sending = draw({ ...left, products: [choiceList[0].id] }, choiceList.slice(0, 2));
  is("with one chosen it says On and the month's count", [/>On<\/span>/.test(sending), sending.includes("Sent this month: 3")], [true, true]);
  is("and no warning", sending.includes("No product is chosen"), false);
  is("every product, on, says On without a warning", [/>On<\/span>/.test(draw({ ...left, products: "all" })), draw({ ...left, products: "all" }).includes("No product is chosen")], [true, false]);
  // Switched on and fully set, but nothing can go out (lib/anniversary-send.ts stops without a connected
  // Stripe account, and the store's email figure is zero on a plan without email): never "On".
  const notConnected = draw({ ...left, products: "all" }, [], 3, false, true);
  is("not connected to Stripe: not On, but on and not sending, with the reason and no month's count", [/>On<\/span>/.test(notConnected), notConnected.includes(">On, but not sending</span>"), notConnected.includes("Connect your Stripe account first."), notConnected.includes("Sent this month")], [false, true, true, false]);
  const noEmail = draw({ ...left, products: "all" }, [], 3, true, false);
  is("a plan without email: not On, but on and not sending, with the reason and no month's count", [/>On<\/span>/.test(noEmail), noEmail.includes(">On, but not sending</span>"), noEmail.includes("Your plan does not include email right now"), noEmail.includes("Sent this month")], [false, true, true, false]);
  is("switched off, it says Off whatever else is missing", />Off<\/span>/.test(draw({ ...left, on: false, products: "all" }, [], 3, false, false)), true);

  part("The most that can be chosen, said beside the boxes it disables");
  const full = draw({ ...left, products: choiceList.slice(0, rules.MAX_ANNIVERSARY_PRODUCTS).map((p) => p.id) }, choiceList);
  const fullWords = `You have chosen ${rules.MAX_ANNIVERSARY_PRODUCTS}, the most you can. To choose another, uncheck one first, or choose "Every product".`;
  is("the sentence is shown", full.includes(fullWords.replace(/"/g, "&quot;")), true);
  const lastBox = full.match(/<input[^>]*id="anniversary-product-prod0200"[^>]*>/)?.[0] ?? "";
  is("the box it disables is disabled and points to it", [/ disabled=""/.test(lastBox), /aria-describedby="anniversary-products-full"/.test(lastBox)], [true, true]);
  const notFull = draw({ ...left, products: [choiceList[0].id] }, choiceList);
  is("below the most, no such sentence", notFull.includes("the most you can"), false);

  part("A refused choice is said at the products, and focus goes there");
  const editor = readFileSync("components/anniversary-editor.tsx", "utf8");
  is("the products fieldset is marked invalid and described by the error", /aria-invalid=\{productsError \|\| undefined\}/.test(editor) && /anniversary-products-help\$\{productsError \? " anniversary-products-error" : ""\}/.test(editor), true);
  is("the error is drawn inside it, as an alert", /id="anniversary-products-error"[^>]*role="alert"/.test(editor), true);
  is("and focus moves to the first box there, or to the error", /productsRef\.current\?\.querySelector<HTMLElement>\("input:not\(\[disabled\]\)"\) \?\? productsErrorRef\.current\)\?\.focus\(\)/.test(editor), true);

  done();
}

void main();
