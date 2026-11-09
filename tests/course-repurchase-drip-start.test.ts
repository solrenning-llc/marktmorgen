// A one-off course written down on the thanks page (recordEnrollment) opens its drip modules from the purchase that
// stands at Stripe: bought again after a purchase refunded in full, the day written down for the refunded purchase
// no longer gives the day. A single purchase still opens from the day written down, and its cached answer keeps
// the same bytes; a cached answer of an unknown shape is read again from Stripe, never taken as "nothing refunded".
import { isOpen } from "@/lib/course";
import { paidCourses, recordEnrollment } from "@/lib/learn";
import type { Course } from "@/lib/course";
import type { Listing, Store } from "@/lib/store";
import { catalog } from "./course-repurchase-catalog-world";
import { stripe } from "./course-repurchase-stripe-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const courseId = "8".repeat(32);
const lesson = (id: string) => ({ id, title: id, preview: false, video: null, files: [], link: null, hasBody: false, quiz: null });
const course: Course = {
  id: courseId, certificate: false, startsAt: null,
  modules: [
    { id: "module000001", title: "Week 1", dripDays: 0, lessons: [lesson("lesson000001")] },
    { id: "module000002", title: "Month 2", dripDays: 30, lessons: [lesson("lesson000002")] },
  ],
};
const product = { id: "prod_again01", title: "Drip course", priceCents: 4900, course: { id: courseId, lessons: 2 } } as unknown as Listing;
const store = { handle: "again-school", previousHandles: [], name: "Again School", email: "owner@example.test", statsId: "4".repeat(32), sid: "3".repeat(32), language: "en", stripeAccountId: "acct_synthetic01" } as unknown as Store;
const buyer = "buyer-again@example.test";
const at = (m: number, d: number) => Math.floor(Date.UTC(2026, m, d, 12) / 1000);
const first = at(0, 1);
const second = at(4, 1);

const session = (id: string, created: number, refunded: boolean) => ({
  id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created,
  metadata: { store: store.handle, product: product.id },
  payment_intent: { object: "payment_intent", latest_charge: { object: "charge", amount: 4900, amount_refunded: refunded ? 4900 : 0, refunded } },
});

const cacheKey = () => redis.keys().find((k) => k.startsWith("nl:learn:paid:"));
const cached = async () => {
  const key = cacheKey();
  return key ? ((await redis.pipeline([["GET", key]]))[0] as string | null) : null;
};

function fresh(sessions: Record<string, unknown>[]) {
  redis.clear();
  catalog.listings = [product];
  stripe.sessions = sessions;
  stripe.asked = [];
}

async function main() {
  part("Bought again four months after a full refund");
  fresh([session("cs_test_second", second, false), session("cs_test_first", first, true)]);
  // The first purchase was written down on its thanks page, then refunded in full.
  await recordEnrollment(store, buyer, product.id, first);
  const start = (await paidCourses(store, buyer)).get(product.id);
  is("the course opens from the purchase that stands", start, second);
  is("so the 30-day module is still shut the day after buying again", isOpen(course, course.modules[1], start ?? 0, second + 86_400), false);
  is("and it opens 30 days after buying again", isOpen(course, course.modules[1], start ?? 0, second + 30 * 86_400), true);
  stripe.asked = [];
  is("the cached answer gives the same day", (await paidCourses(store, buyer)).get(product.id), second);
  is("without asking Stripe again", stripe.asked.length, 0);

  part("A cached answer of an unknown shape");
  for (const shape of ['"a":"prod_again01"', '"a":[1]', '"a":{}', '"a":null']) {
    await redis.pipeline([["SET", cacheKey() as string, `{"p":{"prod_again01":${second}},"x":[],"r":[],${shape}}`]]);
    stripe.asked = [];
    const read = (await paidCourses(store, buyer)).get(product.id);
    is(`${shape}: Stripe is asked again`, stripe.asked.length > 0, true);
    is(`${shape}: never read as nothing refunded`, read, second);
  }

  part("One purchase, written down on its thanks page (unchanged)");
  fresh([session("cs_test_once", first, false)]);
  await recordEnrollment(store, buyer, product.id, first + 7);
  is("the course opens from the day written down", (await paidCourses(store, buyer)).get(product.id), first + 7);
  is("the cached answer keeps the same bytes", await cached(), `{"p":{"prod_again01":${first}},"x":[],"r":[]}`);

  part("Refunded in full and not bought again (unchanged)");
  fresh([session("cs_test_gone", first, true)]);
  await recordEnrollment(store, buyer, product.id, first);
  is("the course stays closed", (await paidCourses(store, buyer)).has(product.id), false);
  is("the cached answer keeps the same bytes", await cached(), `{"p":{},"x":[],"r":["prod_again01"]}`);

  part("Bought twice, neither refunded (unchanged)");
  fresh([session("cs_test_later", second, false), session("cs_test_earlier", first, false)]);
  await recordEnrollment(store, buyer, product.id, first + 7);
  is("the course opens from the day written down", (await paidCourses(store, buyer)).get(product.id), first + 7);
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
