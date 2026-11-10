/**
 * 628 [HN4](b), unit 2: the course's "More from" shelf, read for a student
 * (lib/course-shelf.ts), chosen in the studio and shown on the course's
 * front page. Stripe is played by a stand-in for `fetch`. What is checked:
 *
 *   - only the creator's picks the store lists and sells today, in the
 *     creator's order, never the course itself or a draft;
 *   - never something the student already has: a checkout on the creator's
 *     Stripe account, or a PayPal purchase where the store sells by PayPal;
 *   - nothing on a guess: Stripe down, or the store's month of requests used,
 *     shows nothing, and the second never asks Stripe at all;
 *   - a course with no pick the store lists reads nothing and counts nothing;
 *   - the reading counts SHELF_REQUEST_UNITS requests before it reads;
 *   - the studio's action keeps only ids the store has; the page shows it only
 *     to a student, under a heading, each pick a link named by its title.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addProduct, claimHandle, ensureStatsId, setPayPalSeller, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SHELF_REQUEST_UNITS, shelfShown } from "@/lib/course-shelf";
import { NEXT_OFFER_REQUEST_UNITS } from "@/lib/next-offer-rules";
import { ownKey } from "@/lib/paypal-sales";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_course_shelf_only";

const OWNER = "shelf-owner@example.com";
const ACCOUNT = "acct_fixture008";
const STUDENT = "student@example.com";

const sessions: Record<string, Record<string, unknown>[]> = {};
let stripe: "up" | "down" = "up";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  stripeCalls += 1;
  if (stripe === "down") return answer({ error: { message: "down" } }, 500);
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [], has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  await claimHandle(OWNER, "shelfshop", "Shelf Shop", "Courses and guides.");
  await setSubscription(OWNER, { customerId: "cus_ShelfShop01", subscriptionId: "sub_ShelfPlan01", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(now) });
  await setStripeAccount(OWNER, ACCOUNT, true);
  await ensureStatsId(OWNER);
  const make = async (title: string, price: string) => {
    const made = await addProduct(OWNER, title, `About ${title}.`, price, null);
    if (!made.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const course = await make("Batch Cooking Course", "49");
  const guide = await make("Grocery Guide", "9");
  const planner = await make("Meal Planner", "27");
  const draft = await make("Draft Thing", "5");
  const spices = await make("Spice Chart", "12");
  await setProductHidden(OWNER, draft, true);
  let store = (await storeForEmail(OWNER))!;
  const shelf = [planner, course, draft, guide, "zzzz9999", spices];
  const shown = async (picks: string[] = shelf) => (await shelfShown(store, picks, course, STUDENT)).map((p) => p.id);

  part("What a student is shown");
  is("the picks the store lists and sells, in the creator's order, without the course, a draft or an id it does not have", await shown(), [planner, guide, spices]);
  is("each with the card's own title and price", (await shelfShown(store, [guide], course, STUDENT)).map((p) => [p.title, p.priceCents]), [["Grocery Guide", 900]]);

  part("Never something the student already has");
  sessions[STUDENT] = [{ id: "cs_test_shelfpaid00001", status: "complete", payment_status: "paid", customer: "cus_Student00001", metadata: { store: "shelfshop", product: guide } }];
  is("a product bought on the creator's Stripe account is left out", await shown(), [planner, spices]);
  // The store sells by PayPal too: a pick paid there is left out as well.
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AcoursesShelfPartner01";
  process.env.PAYPAL_PARTNER_SECRET = "EPshelfSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  await setPayPalSeller(OWNER, "SHELFSELLER01");
  store = (await storeForEmail(OWNER))!;
  await redis.pipeline([["SADD", ownKey(store.statsId!, STUDENT, spices), "PAYPALORDER0001"]]);
  is("and one bought by PayPal, where the store sells by PayPal", await shown(), [planner]);
  is("another student, with nothing bought, sees them all", (await shelfShown(store, shelf, course, "other@example.com")).map((p) => p.id), [planner, guide, spices]);

  part("Nothing on a guess");
  stripe = "down";
  is("Stripe cannot be asked: nothing is shown", await shown(), []);
  stripe = "up";
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: unknown[][]) => (commands.some((c) => c[0] === "SCARD") ? ["OK"] : original(commands as never))) as typeof redis.pipeline;
  is("its PayPal purchases unreadable: nothing is shown", await shown(), []);
  redis.pipeline = original;

  part("What it costs, and when it reads");
  is("counted as the next product after a purchase's requests", SHELF_REQUEST_UNITS, NEXT_OFFER_REQUEST_UNITS);
  const callsBefore = stripeCalls;
  is("a shelf with no pick the store lists shows nothing", [await shown([draft, "zzzz9999"]), await shown([]), (await shelfShown(store, undefined, course, STUDENT)).length], [[], [], 0]);
  is("and never asks Stripe", stripeCalls, callsBefore);
  is("counted before it is read, then what the student has read", /takeBuyerRead\(store, SHELF_REQUEST_UNITS\)\)\) return \[\];\s*try \{\s*const \[stripeOwned, listings\] = await Promise\.all\(\[ownedHere\(store, email\)/.test(read("lib/course-shelf.ts")), true);
  for (const key of redis.keys().filter((k) => k.startsWith("nl:traffic:r:"))) await redis.pipeline([["INCRBY", key, 100_000_000]]);
  const usedBefore = stripeCalls;
  is("the store's month of requests used: nothing is shown", await shown(), []);
  is("and Stripe is never asked", stripeCalls, usedBefore);

  part("The studio and the page");
  const route = read("app/api/store/course/route.ts");
  is("the studio's action keeps only ids the store has, and saves through the course's own edit", /action === "shelf"[\s\S]{0,400}hasProduct\(store, p\)[\s\S]{0,300}op: "shelf", products: asked, courseProductId: product\.id/.test(route), true);
  const studio = read("app/studio/course/[product]/page.tsx");
  is("the studio offers the store's listed products, the course left out, and says so when they cannot be read", [studio.includes("<CourseShelfStudio"), /visibleIds\(store\)\.filter\(\(pid\) => pid !== product\.id/.test(studio), studio.includes("Your products could not be read just now")], [true, true, true]);
  const editor = read("components/course-shelf-studio.tsx");
  is("the editor moves with buttons, never by dragging, and only saves when asked", [editor.includes("draggable"), editor.includes("Move ${p.title} up"), editor.includes("Undo changes"), editor.includes('action: "shelf"')], [false, true, true, true]);
  const page = read("app/[handle]/course/[product]/page.tsx");
  is("the page reads it only for a student, never for the owner or a visitor", page.includes("const shelf = studying ? await shelfShown(store, course.shelf, product.id, access.learner.email) : [];"), true);
  is("under a heading of its own, each pick a link named by its title", /aria-labelledby="course-shelf-title"[\s\S]{0,200}<h2 id="course-shelf-title"[\s\S]{0,700}href=\{productPath\(store, item\)\}[\s\S]{0,300}\{item\.title\}/.test(page), true);
  is("its heading in every buyer language, with the store's name", Object.values(COURSES_WORDS).every((w) => w.shelfTitle("Shelf Shop").includes("Shelf Shop")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
