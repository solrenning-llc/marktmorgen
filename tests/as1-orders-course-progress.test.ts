/**
 * 560 [AS1], point 3, on the store's list of purchases (app/[handle]/orders):
 * each course bought says how far the buyer is, "2 of 3 lessons done", in
 * words that describe the course's button and in a bar beside them.
 *
 *   - only the lessons the course has now count: a mark kept for a lesson
 *     since taken out never makes the share larger;
 *   - progress that could not be read, or the store's room for reading it, is
 *     said as such, never as "0 of 3" (CX-123 rule 24), and the purchases
 *     are still listed;
 *   - a course whose outline is gone, or with no lessons, shows nothing;
 *   - what is read is taken from the opening's meter first,
 *     ORDERS_PROGRESS_COMMANDS a course, once for a course bought twice.
 *
 * Synthetic records and a stand-in Stripe only: nothing real is charged, sent or read.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import OrdersPage from "@/app/[handle]/orders/page";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { OrdersBusy, type OrdersMeter, type Purchase, ordersLinkFor } from "@/lib/buyer-orders";
import { ORDERS_PROGRESS_COMMANDS, ORDERS_PROGRESS_MS, ORDERS_READ_MS } from "@/lib/buyer-orders-rules";
import { ordersWords } from "@/lib/buyer-words/orders";
import { type Course, saveCourse } from "@/lib/course";
import { lessonsDoneIn, markLesson } from "@/lib/learn";
import { coursesOf, extrasFor, progressOf } from "@/lib/purchase-cards";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { type Store, addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";

const OWNER = "progress-owner@example.test";
const BUYER = "progress-buyer@example.test";
const ACCOUNT = "acct_1TestProgress01";
const ORIGIN = "https://marktmorgen.com";
const NOW = Math.floor(Date.now() / 1000);
const COURSE = "a".repeat(32);
const LESSONS = ["lessonaaaaa1", "lessonaaaaa2", "lessonaaaaa3"];

let checkouts: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  assert.equal(url.hostname, "api.stripe.com");
  assert.equal(init?.method ?? "GET", "GET", "nothing is written to the creator's Stripe account");
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    if (url.searchParams.has("created[gte]")) return answer({ object: "list", data: [], has_more: false });
    if (url.searchParams.get("customer_details[email]") !== BUYER) return answer({ object: "list", data: [], has_more: false });
    return answer({ object: "list", data: checkouts, has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

beforeEach(() => {
  redis.clear();
  checkouts = [];
  process.env.STRIPE_SECRET_KEY = "sk_test_orders_progress_only";
});

const lesson = (id: string) => ({ id, title: `Lesson ${id.slice(-1)}`, preview: false, video: null, files: [], link: null, hasBody: false, quiz: null });
const outline = (ids: string[]): Course => ({ id: COURSE, modules: [{ id: "moduleaaaaa1", title: "Module 1", dripDays: 0, lessons: ids.map(lesson) }], certificate: false, startsAt: null });

/** A store selling one course of three lessons, bought by the buyer; returns the store and the course's product. */
async function shop(ids = LESSONS): Promise<{ store: Store; product: string }> {
  await claimHandle(OWNER, "progress", "Progress Studio", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_ProgressOwner1", subscriptionId: "sub_ProgressOwner1", active: true, tier: "scale", period: paidPeriod() });
  const added = await addProduct(OWNER, "Watercolor basics", "", "49", null);
  assert.ok(added.ok, JSON.stringify(added));
  const product = added.product.id;
  assert.ok((await setProductCourse(OWNER, product, { id: COURSE, lessons: ids.length })).ok);
  const store = (await storeForEmail(OWNER))!;
  await saveCourse(outline(ids), store, true);
  checkouts = [paid(1, product)];
  return { store, product };
}

function paid(index: number, product: string): Record<string, unknown> {
  return {
    object: "checkout.session",
    id: `cs_test_Progress${String(index).padStart(10, "0")}`,
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    created: NOW - 60 * index,
    amount_total: 4900,
    currency: "usd",
    customer: null,
    customer_details: { email: BUYER },
    payment_intent: { id: `pi_Progress${index}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
    metadata: { store: "progress", product },
  };
}

async function opened(store: Store): Promise<string> {
  const link = (await ordersLinkFor(store, BUYER, `${ORIGIN}/@${store.handle}`))!;
  const token = new URL(link).searchParams.get("token")!;
  return renderToStaticMarkup(await OrdersPage({ params: Promise.resolve({ handle: `@${store.handle}` }), searchParams: Promise.resolve({ token }) }));
}

test("a course on the list says how far the buyer is, in words that describe its button and in a bar, counting only the lessons it has now", async () => {
  const { store } = await shop();
  await markLesson(COURSE, BUYER, LESSONS[0], true, store, true);
  await markLesson(COURSE, BUYER, LESSONS[2], true, store, true);
  // A mark kept for a lesson since taken out of the course.
  await markLesson(COURSE, BUYER, "lessongone99", true, store, true);
  const html = await opened(store);
  const words = ordersWords("en");
  assert.equal(words.lessonsDone(2, 3), "2 of 3 lessons done");
  const said = new RegExp(`<p id="(cp[0-9a-f]{10})" class="st-muted text-sm">${words.lessonsDone(2, 3)}</p>`).exec(html);
  assert.ok(said, html);
  // The course's button is described by those words, so a screen reader says them with the course they are for.
  assert.match(html, new RegExp(`<a[^>]*aria-describedby="${said[1]}"[^>]*>${words.openTitle("Watercolor basics")}</a>`));
  // The bar shows the same share, hidden from screen readers, which have the words; rounded down, never showing done before it is.
  assert.match(html, /<div class="cm-progress mt-2" aria-hidden="true"><span style="width:66%"><\/span><\/div>/);
  assert.ok(!html.includes("of 4 lessons"), "a lesson taken out is not counted");
});

/** Answers every SMISMEMBER with `reply` (a value, or a thrown failure), the rest as the stand-in does. */
function lessonsAnswer(reply: (lessons: number) => unknown): () => void {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!commands.some((command) => command[0] === "SMISMEMBER")) return original(commands);
    return commands.map((command) => reply(command.length - 2));
  }) as typeof redis.pipeline;
  return () => {
    redis.pipeline = original;
  };
}

test("progress that cannot be read is said so, never as 0 done, and the purchase is still listed", async () => {
  const { store } = await shop();
  const words = ordersWords("en");
  // A reply with something else than a 0 or 1 for a lesson, a reply short of a lesson, and no reply at all.
  for (const reply of [(n: number) => [1, 2, ...Array(n - 2).fill(0)], (n: number) => Array(n - 1).fill(0), () => null]) {
    const restore = lessonsAnswer(reply);
    try {
      const html = await opened(store);
      assert.ok(html.includes(words.progressUnread), html);
      assert.ok(!/\d+ of 3 lessons done/.test(html), "never a count it could not read");
      assert.ok(!html.includes("cm-progress"), "no bar for a share not known");
      assert.ok(html.includes(words.openTitle("Watercolor basics")), "the course still opens from its card");
    } finally {
      restore();
    }
  }
  // Redis failing outright on that read: the same, and the list itself is still shown.
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => command[0] === "SMISMEMBER")) throw new Error("synthetic failure");
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    const html = await opened(store);
    assert.ok(html.includes(words.progressUnread) && html.includes(words.openTitle("Watercolor basics")), html);
  } finally {
    redis.pipeline = original;
  }
});

test("a course whose outline is gone, or that has no lessons, shows no progress at all", async () => {
  const empty = await shop([]);
  const none = await opened(empty.store);
  assert.ok(none.includes(ordersWords("en").openTitle("Watercolor basics")));
  assert.ok(!none.includes("lessons done") && !none.includes("lesson done") && !none.includes(ordersWords("en").progressUnread));

  redis.clear();
  const gone = await shop();
  await redis.pipeline([["DEL", `nl:course:${COURSE}`]]);
  const html = await opened(gone.store);
  assert.ok(!html.includes("lessons done") && !html.includes(ordersWords("en").progressUnread), "an outline confirmed gone is not unknown");
});

test("lessonsDoneIn asks only about the lessons the course has, and anything but one 0 or 1 a lesson is unknown", async () => {
  const { store } = await shop();
  await markLesson(COURSE, BUYER, LESSONS[1], true, store, true);
  assert.deepEqual([...(await lessonsDoneIn([outline(LESSONS)], BUYER))], [[COURSE, { done: 1, total: 3 }]]);
  assert.deepEqual([...(await lessonsDoneIn([outline([])], BUYER))], [], "a course with no lessons is left out");
  assert.deepEqual([...(await lessonsDoneIn([outline(LESSONS)], "nobody@example.test"))], [[COURSE, { done: 0, total: 3 }]], "a student who marked none: 0, read");
  const restore = lessonsAnswer((n) => [...Array(n - 1).fill(1), "1"]);
  try {
    assert.deepEqual([...(await lessonsDoneIn([outline(LESSONS)], BUYER))], [[COURSE, null]], "a reply in the wrong shape is unknown");
  } finally {
    restore();
  }
});

/** A meter that takes what is asked, and refuses the take named, as a store with no room left does (lib/buyer-orders.ts). */
function meterRefusing(refuse: (commands: number, nth: number) => boolean): { meter: OrdersMeter; takes: number[] } {
  const takes: number[] = [];
  const meter = {
    take: async (commands: number) => {
      takes.push(commands);
      if (refuse(commands, takes.length)) throw new OrdersBusy();
    },
  } as unknown as OrdersMeter;
  return { meter, takes };
}

const purchase = (product: string, reference: string, ended = false): Purchase =>
  ({ reference, productId: product, title: "Watercolor basics", kind: "payment", paidAt: NOW, courseProduct: product, podcastProduct: null, added: [], items: null, main: null, ended, option: null }) as unknown as Purchase;

test("the progress is taken from the meter before it is read, once a course, and a refused take is unknown, not a failed list", async () => {
  const { store, product } = await shop();
  await markLesson(COURSE, BUYER, LESSONS[0], true, store, true);
  const listed = [purchase(product, "cs_test_A"), purchase(product, "cs_test_B")];
  assert.deepEqual(coursesOf(listed), [product], "a course bought twice is read once");
  assert.deepEqual(coursesOf([purchase(product, "cs_test_C", true)]), [], "an ended purchase shows no progress");

  const paidFor = meterRefusing(() => false);
  const read = await extrasFor(store, BUYER, listed, paidFor.meter);
  assert.deepEqual(read.progress.get(product), { done: 1, total: 3 });
  assert.equal(paidFor.takes.at(-1), ORDERS_PROGRESS_COMMANDS, "one course's commands, taken last");

  // The store has no room for the progress: nothing of it is read, each course says it could not check.
  const refused = meterRefusing((commands) => commands === ORDERS_PROGRESS_COMMANDS);
  const answered = await extrasFor(store, BUYER, listed, refused.meter);
  assert.equal(answered.progress.get(product), "unknown");
});

test("every language says how far the buyer is, and that it could not be checked, in its own words", () => {
  for (const language of LANGUAGE_CODES) {
    const words = ordersWords(language);
    assert.match(words.lessonsDone(2, 12), /2/);
    assert.match(words.lessonsDone(2, 12), /12/);
    assert.ok(words.progressUnread.length > 20, language);
    if (language !== "en") {
      assert.notEqual(words.lessonsDone(2, 12), ordersWords("en").lessonsDone(2, 12), `${language}: not English`);
      assert.notEqual(words.progressUnread, ordersWords("en").progressUnread, `${language}: not English`);
    }
  }
  assert.equal(ordersWords("en").lessonsDone(1, 1), "1 of 1 lesson done", "one lesson in the singular");
});

test("a slow read of the outlines never holds the list: past its own short wait every course says it could not check", async () => {
  const { product } = await shop();
  assert.ok(ORDERS_PROGRESS_MS > 0 && ORDERS_PROGRESS_MS * 4 < ORDERS_READ_MS, "a wait of its own, well inside the opening's");
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => command[0] === "MGET")) await new Promise((resolve) => setTimeout(resolve, 400));
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    const meter = { take: async () => {} } as unknown as OrdersMeter;
    const started = Date.now();
    const read = await progressOf([{ productId: product, courseId: COURSE }], BUYER, meter, 50);
    assert.ok(Date.now() - started < 300, "answered at its own wait, not the read's");
    assert.equal(read.get(product), "unknown");
  } finally {
    redis.pipeline = original;
  }
  assert.deepEqual((await progressOf([{ productId: product, courseId: COURSE }], BUYER, { take: async () => {} } as unknown as OrdersMeter, 2_000)).get(product), { done: 0, total: 3 }, "without delay it reads");
  const source = (await import("node:fs")).readFileSync("lib/purchase-cards.ts", "utf8");
  assert.ok(source.includes("}), email, meter);"), "the list waits on the default ORDERS_PROGRESS_MS");
});
