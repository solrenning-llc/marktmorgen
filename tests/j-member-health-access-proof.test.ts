import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { memberHealth } from "@/lib/member-health";
import { nudgeStore } from "@/lib/member-nudge";
import { touchStudent } from "@/lib/learn";
import { upsertContact } from "@/lib/contacts";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setNudge, setProductCourse, setStripeAccount, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const pipeline = redis.pipeline.bind(redis), originalFetch = globalThis.fetch;
const person = "active-member@example.test", owner = "owner@example.test";
let shop: Store, courseId: string, now: number, subscriptions: unknown[], messages: unknown[];
beforeEach(async () => {
  redis.pipeline = pipeline; redis.clear(); messages = [];
  now = Math.floor(Date.now() / 1000);
  process.env.STRIPE_SECRET_KEY = "sk_test_health_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_health_only_a_stand_in";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.stripe.com" && url.pathname === "/v1/subscriptions") return Response.json({ object: "list", data: subscriptions, has_more: false });
    if (url.hostname === "api.resend.com") {
      messages.push(JSON.parse(String(init?.body)));
      return Response.json({ id: `synthetic_${messages.length}` });
    }
    throw new Error("No external provider allowed");
  };
  await claimHandle(owner, "jaccessproof", "Access Proof", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  const product = await addProduct(owner, "Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  assert.ok(product.ok);
  const initial = emptyCourse();
  const edited = editCourse(initial, { op: "lesson-add", moduleId: initial.modules[0].id, title: "One" });
  assert.ok(edited.ok);
  courseId = edited.course.id;
  await saveCourse(edited.course, ROOM);
  await setProductCourse(owner, product.product.id, { id: courseId, lessons: 1 });
  await setNudge(owner, { on: true, address: "1 Example Street, Example City" });
  shop = (await storeForEmail(owner))!;
  await upsertContact(shop.listId!, person, { agreed: true, explicit: true, source: "buyer", productId: product.product.id, title: "Club" }, ROOM);
  await touchStudent(courseId, person, now - 90 * 86400, ROOM);
  subscriptions = [{ id: "sub_JAccessProof", status: "active", currency: "usd", start_date: now - 90 * 86400,
    customer: { id: "cus_JAccessProof", email: person }, metadata: { store: shop.handle, product: product.product.id },
    items: { data: [{ quantity: 1, current_period_end: now + 86400, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] } }];
});
afterEach(() => { redis.pipeline = pipeline; globalThis.fetch = originalFetch; });
test("confirmed recent access is healthy and sends no come-back email", async () => {
  const health = (await memberHealth(shop, true, now * 1000))!;
  assert.deepEqual([health.complete, health.members[0].score, health.atRisk], [true, 100, 0]);
  assert.equal(await nudgeStore(shop, Date.now() + 20000, now * 1000), 0);
  assert.equal(messages.length, 0);
});
for (const failure of ["partial", "throw"] as const) test(`unknown course access (${failure}) cannot certify never-accessed or nudge an active member`, async () => {
  let reads = 0;
  redis.pipeline = async commands => {
    if (commands.some(c => c[0] === "HMGET" && c[1] === `nl:course:${courseId}:students`)) {
      reads += 1;
      if (failure === "throw") throw new Error("synthetic access read failure");
      return [];
    }
    return pipeline(commands);
  };
  let health;
  try { health = await memberHealth(shop, true, now * 1000); } catch { /* unavailable is acceptable */ }
  try { await nudgeStore(shop, Date.now() + 20000, now * 1000); } catch { /* closed before send is acceptable */ }
  assert.ok(reads >= 2, "both actual report and worker reached the access boundary");
  assert.deepEqual({ complete: health?.complete ?? false, cache: redis.run(["GET", `nl:health:${shop.statsId}`]), messages: messages.length },
    { complete: false, cache: null, messages: 0 }, "unknown access cannot manufacture a risk score, successful cache or come-back email");
});
