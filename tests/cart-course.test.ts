/**
 * A course anywhere in a cart opens as the first one does (513 [PF1], unit
 * 2a; lib/order-courses.ts; added 2 November 2026). Checked:
 *
 *   - the courses an order hands over: the product bought, each one added
 *     (a cart's other products), and each bundle's, once each, in that order;
 *   - "Start the course" opens the one named only when the order hands it
 *     over, else the product bought when it is a course, else none; through
 *     its route, never for a gift, a group purchase, a pre-order or a refund;
 *   - the buyer's list of purchases lists a course that was not the cart's
 *     first, with its own way in, beside the products with a link, and not
 *     a gift's;
 *   - the thanks page, its route and the list read these, and the page draws
 *     the course's button where it said nothing was attached.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as startCourse } from "@/app/api/store/course/start/route";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { courseToStart, orderCourses } from "@/lib/order-courses";
import { purchasesFor } from "@/lib/buyer-orders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
let listed: Record<string, unknown>[] = [];
let one: Record<string, unknown> | null = null;
let stripeReads = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") stripeReads += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/checkout/sessions" && method === "GET") return answer({ object: "list", data: listed, has_more: false });
  if (path.startsWith("/checkout/sessions/") && method === "GET") return one ? answer(one) : new Response("{}", { status: 404 });
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const p = (id: string, course = false) => ({ id, course: course ? { id: `c_${id}`, lessons: 3 } : null });

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_cart_course_only_a_stand_in";

  part("The courses an order hands over");
  const cart = {
    product: p("guide"),
    items: null,
    bumps: [{ product: p("course1", true), items: null }, { product: p("bundle"), items: { items: [p("course2", true), p("sheet")] } }],
  };
  is("each one added and each bundle's, once each", orderCourses(cart).map((x) => x.id), ["course1", "course2"]);
  is("the product bought first", orderCourses({ product: p("main", true), items: { items: [p("main", true)] }, bumps: [{ product: p("course1", true), items: null }] }).map((x) => x.id), ["main", "course1"]);
  is("none when nothing is a course", orderCourses({ product: p("a"), items: null, bumps: [{ product: p("b"), items: null }] }), []);

  part("Which course a press opens");
  is("the one named, added to a cart", courseToStart(cart, "course1")?.id, "course1");
  is("or inside a bundle added to it", courseToStart(cart, "course2")?.id, "course2");
  is("never one the order does not hand over, nor a product that is no course", [courseToStart(cart, "other"), courseToStart(cart, "sheet"), courseToStart(cart, "")], [null, null, null]);
  const mainCourse = { product: p("main", true), items: null, bumps: [] };
  is("with nothing named, or a name it does not hold, the product bought when it is a course", [courseToStart(mainCourse, "")?.id, courseToStart(mainCourse, "other")?.id], ["main", "main"]);

  part("The buyer's list of purchases");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Guide", "", "19", null);
  const course = await addProduct(OWNER, "Bread course", "", "49", null);
  const sheet = await addProduct(OWNER, "Sheet", "", "9", null);
  if (!guide.ok || !course.ok || !sheet.ok) throw new Error("no products");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  await setProductLink(OWNER, sheet.product.id, "https://example.com/sheet");
  const made = await setProductCourse(OWNER, course.product.id, { id: "c".repeat(32), lessons: 4 });
  if (!made.ok) throw new Error(`no course: ${made.reason}`);
  const store = (await storeForEmail(OWNER))!;
  listed = [
    {
      id: "cs_test_" + "d".repeat(24),
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      created: Math.floor(Date.now() / 1000),
      amount_total: 7700,
      currency: "usd",
      metadata: { store: "harbor", product: guide.product.id, cart: "yes", bump: course.product.id, bump2: sheet.product.id },
      customer_details: { email: "buyer@example.com" },
      payment_intent: { id: "pi_1", status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
    },
  ];
  const bought = ((await purchasesFor(store, "buyer@example.com")) ?? []).find((x) => x.productId === guide.product.id);
  listed = [{ ...listed[0], id: "cs_test_" + "e".repeat(24), metadata: { ...(listed[0] as { metadata: Record<string, string> }).metadata, gift: "gft_" + "a".repeat(24) } }, listed[0]];
  const lists = (await purchasesFor(store, "buyer@example.com")) ?? [];
  is("a gift's course is not on the payer's list", lists.filter((x) => x.added.some((a) => a.courseProduct)).map((x) => x.reference), ["cs_test_" + "d".repeat(24)]);
  listed = listed.slice(1);
  is("the course after the first is listed, with its own way in, beside the one with a link", bought?.added.map((a) => [a.key, a.title, a.courseProduct, a.delivery?.link ?? null]), [
    ["bump", "Bread course", course.product.id, null],
    ["bump2", "Sheet", null, "https://example.com/sheet"],
  ]);

  part("The thanks page's Start the course");
  const paid = listed[0];
  const start = async (session: Record<string, unknown>, asked: string) => {
    one = session;
    const form = new URLSearchParams({ handle: "harbor", session_id: String(session.id), product: asked });
    const answer = await startCourse(new NextRequest("https://marktmorgen.com/api/store/course/start", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }));
    return [answer.status, new URL(answer.headers.get("location") ?? "https://x/").pathname + new URL(answer.headers.get("location") ?? "https://x/").search];
  };
  const noEmail = { ...paid, customer_details: { email: null } };
  is("opens a course that was not the cart's first", await start(noEmail, course.product.id), [303, `/@harbor/course/${course.product.id}?link=ask`]);
  is("never a product of the order that is no course, nor one the order does not hold", [await start(noEmail, sheet.product.id), await start(noEmail, "other00001")], [[303, "/@harbor"], [303, "/@harbor"]]);
  const meta = (paid as { metadata: Record<string, string> }).metadata;
  is("never for a gift, a group purchase or a pre-order", [
    await start({ ...noEmail, metadata: { ...meta, gift: "gft_" + "a".repeat(24) } }, course.product.id),
    await start({ ...noEmail, metadata: { ...meta, group: "grp_" + "b".repeat(24) } }, course.product.id),
    await start({ ...noEmail, metadata: { ...meta, preorder: "yes" } }, course.product.id),
  ].map(([status, where]) => `${status} ${where}`), ["303 /@harbor", "303 /@harbor", "303 /@harbor"]);
  is("nor once the order was refunded", await start({ ...noEmail, payment_intent: { id: "pi_1", status: "succeeded", latest_charge: { refunded: true, amount_refunded: 7700 } } }, course.product.id), [303, "/@harbor"]);

  part("The email counter only when an email goes (Claude 5 LOW 2 on #2608)");
  {
    // Redis throws on this order's course-start-order counter only, or it is filled past any limit.
    const real = redis.pipeline.bind(redis);
    const on = (mode: "unknown" | "full") => {
      redis.pipeline = (async (commands: (string | number)[][]) => {
        const hit = commands.find((c) => String(c[1] ?? "").startsWith("nl:rl:course-start-order:"));
        if (hit && mode === "unknown") throw new Error("Redis timed out (synthetic)");
        if (hit) await real([["SET", String(hit[1]), "1000000000", "EX", 3600]]);
        return real(commands);
      }) as typeof redis.pipeline;
    };
    try {
      on("unknown");
      is("an unreadable count still opens the course page, saying the link could not go", await start(paid, course.product.id), [303, `/@harbor/course/${course.product.id}?link=error`]);
      on("full");
      const before = stripeReads;
      is("past the order's limit it goes back to the store, as before", await start(paid, course.product.id), [303, "/@harbor"]);
      is("and stops before the order is read from Stripe or the enrollment written (Revisor 2 LEVE)", stripeReads - before, 0);
      on("unknown");
      is("an unreadable count never blocks an order with no address to email", await start(noEmail, course.product.id), [303, `/@harbor/course/${course.product.id}?link=ask`]);
    } finally {
      redis.pipeline = real;
    }
  }

  part("Where it is read");
  const route = readFileSync("app/api/store/course/start/route.ts", "utf8");
  const thanks = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  // The list of purchases draws each purchase from lib/purchase-cards.ts (cardOf), on the page and in a batch of older ones.
  const orders = readFileSync("lib/purchase-cards.ts", "utf8");
  is("the route opens only what courseToStart allows", [route.includes("courseToStart(order, asked)"), route.includes("order.items?.items")], [true, false]);
  is("the thanks page writes every course down as bought", thanks.includes("for (const course of orderCourses(order))"), true);
  const box = thanks.slice(thanks.indexOf("{t.alsoYours}"));
  is("and draws an added course's button before saying nothing is attached", box.indexOf('name="product" value={added.product.id}') > 0 && box.indexOf('name="product" value={added.product.id}') < box.indexOf("nothingAttached"), true);
  is("the list of purchases names its button", orders.includes("href: `/@${handle}/course/${added.courseProduct}`, label: words.openTitle(added.title)"), true);

  done();
}

void main();
