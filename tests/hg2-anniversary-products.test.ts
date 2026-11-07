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
 *     per person per date, the store's email figure before sending.
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

const DAY = 86_400;
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

const run = () => send.sendAnniversaries(Date.now() + 30_000, now);
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
  await run();
  is("the course's buyer and the guide's are both written to now", emails.map((e) => e.to[0]).sort(), ["dana@example.com", "eve@example.com", "fay@example.com"]);

  part("A deleted product leaves the choice by itself");
  await setAnniversary(OWNER, { ...on, products: [guide.product.id, extra.product.id] });
  await removeProduct(OWNER, extra.product.id);
  is("taken out in the same write; the rest kept", (await chosen())?.products, [guide.product.id]);
  await removeProduct(OWNER, guide.product.id);
  is("the last one gone leaves none chosen, never every product", (await chosen())?.products, []);
  bought("gus@example.com", course.product.id, yearAgo - DAY);
  await agreed("gus@example.com");
  const before = emails.length;
  const readNow = listed;
  await run();
  is("nothing sent with none chosen", [emails.length - before, listed - readNow], [0, 0]);

  done();
}

void main();
