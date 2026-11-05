import assert from "node:assert/strict";
import test, { after } from "node:test";
import { noteIfFinished, noteIfOpened } from "@/lib/course-finish";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, markLesson } from "@/lib/learn";
import { upsertContact } from "@/lib/contacts";
import { saveFlow } from "@/lib/flows";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("No external transport in this proof"); };
after(() => { globalThis.fetch = originalFetch; });

async function setup() {
  redis.clear();
  const owner = "claim-proof@example.com";
  await claimHandle(owner, "claimproof", "Claim proof", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setMailSettings(owner, { fromName: "Claim proof", address: "Synthetic test address" });
  await setStripeAccount(owner, "acct_ClaimTest", true);
  await setSubscription(owner, { customerId: "cus_ClaimTest", subscriptionId: "sub_ClaimTest", active: true, tier: "pro", period: paidPeriod() });
  const product = await addProduct(owner, "Claim proof", "Synthetic course", "49", null);
  assert.ok(product.ok);
  const base = emptyCourse(), edited = editCourse(base, { op: "lesson-add", moduleId: base.modules[0].id, title: "Lesson" });
  assert.ok(edited.ok);
  await saveCourse(edited.course, ROOM);
  assert.ok((await setProductCourse(owner, product.product.id, { id: edited.course.id, lessons: 1 })).ok);
  const store = (await storeForEmail(owner))!;
  for (const trigger of ["started", "finished"] as const) {
    assert.ok((await saveFlow(store, { name: trigger, trigger, productId: product.product.id, active: true,
      steps: [{ delayHours: 0, subject: "Event", body: "Synthetic sequence" }] }, { activate: true })).ok);
  }
  return { store, course: edited.course, product: product.product };
}
const ready = setup();

for (const kind of ["open", "fin"] as const) {
  for (const mode of ["known", "duplicate", "accessor", "accessor-with-inherited-descriptor-value"] as const) {
    test(`${kind}: ${mode}`, async () => {
      const { store, course, product } = await ready;
      const email = `${kind}-${mode}@example.com`;
      await upsertContact(store.listId!, email, { agreed: true, explicit: true, productId: product.id, source: "buyer" }, ROOM);
      if (kind === "fin") await markLesson(course.id, email, course.modules[0].lessons[0].id, true, ROOM);
      const key = `nl:course:${course.id}:${kind}:${emailKey(email)}`, original = redis.pipeline.bind(redis);
      const previousValue = Object.getOwnPropertyDescriptor(Object.prototype, "value");
      assert.equal(previousValue, undefined, "the standalone proof starts without prototype pollution");
      let getters = 0, claims = 0, following = 0;
      const receipt = mode === "duplicate" ? [null] : mode === "known" ? ["OK"]
        : Object.defineProperty(new Array(1), "0", { get() { getters++; return "not-confirmed"; } });
      const clean = () => { Reflect.deleteProperty(Object.prototype, "value"); };
      redis.pipeline = async commands => {
        if (commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === key) {
          claims++;
          if (mode === "known") return original(commands);
          if (mode === "accessor-with-inherited-descriptor-value") {
            Object.defineProperty(Object.prototype, "value", { value: "OK", configurable: true });
          }
          return receipt;
        }
        if (claims) { clean(); following += commands.length; }
        return original(commands);
      };
      let result: boolean;
      try { result = await (kind === "open" ? noteIfOpened : noteIfFinished)(store, product.id, course.id, email); }
      finally { clean(); redis.pipeline = original; }
      const queued = (await original([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]))[0] as string[];
      const entries = queued.filter(item => item.endsWith(`|${email}`));
      assert.equal(claims, 1);
      assert.equal(getters, 0);
      assert.equal(result, mode === "known", JSON.stringify({ result, following, queued: entries.length, claim: (await original([["GET", key]]))[0] }));
      assert.equal(entries.length, mode === "known" ? 1 : 0);
      if (mode !== "known") assert.equal(following, 0);
    });
  }
}
