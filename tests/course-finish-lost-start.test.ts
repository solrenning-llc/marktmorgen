import { noteIfFinished, noteIfOpened } from "@/lib/course-finish";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, markLesson } from "@/lib/learn";
import { upsertContact } from "@/lib/contacts";
import { readFlows, saveFlow } from "@/lib/flows";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

/**
 * A course's "opened" and "finished" moments start their sequences once a student (lib/course-finish.ts). The mark
 * that says so is taken before the sequences are started; when starting them then fails (the store's list of
 * sequences could not be read, Redis failing for a moment), lib/flows.ts enroll logs it and returns, and the mark,
 * kept 400 days, still says it happened: the student's welcome or "you finished" sequence never starts, and nothing
 * tries again. A start is claimed per person and sequence (lib/flows.ts startFlows), so letting the mark go when
 * nothing was started can never start anybody twice. Synthetic data only.
 */
async function main() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("No external transport in this test"); };
  const original = redis.pipeline.bind(redis);
  const originalError = console.error;
  console.error = () => {};
  try {
    redis.clear();
    const owner = "course-claims@example.com";
    await claimHandle(owner, "courseclaims", "Course claims", "");
    await ensureStatsId(owner);
    await ensureListId(owner);
    await setMailSettings(owner, { fromName: "Course claims", address: "Synthetic test address" });
    await setStripeAccount(owner, "acct_ClaimTest", true);
    await setSubscription(owner, { customerId: "cus_ClaimTest", subscriptionId: "sub_ClaimTest", active: true, tier: "pro", period: paidPeriod() });
    const made = await addProduct(owner, "Claim proof", "A synthetic course", "49", null);
    if (!made.ok) throw Error("Synthetic product was not created");
    // Use the actual module identity, as the editor does.
    const product = made.product;
    const base = emptyCourse();
    const built = editCourse(base, { op: "lesson-add", moduleId: base.modules[0].id, title: "Claim lesson" });
    if (!built.ok) throw Error("Synthetic lesson was not created");
    const course = built.course, lesson = course.modules[0].lessons[0].id;
    await saveCourse(course, ROOM);
    const linked = await setProductCourse(owner, product.id, { id: course.id, lessons: 1 });
    if (!linked.ok) throw Error("Synthetic course was not linked");
    const store = (await storeForEmail(owner))!;
    for (const trigger of ["started", "finished"] as const) {
      const flow = await saveFlow(store, { name: trigger, trigger, productId: product.id, active: true, steps: [{ delayHours: 0, subject: "Course event", body: "Synthetic sequence" }] }, { activate: true });
      if (!flow.ok) throw Error(`Synthetic ${trigger} flow was not created: ${JSON.stringify(flow)}`);
    }
    is("both real sequences are active", (await readFlows(store.listId)).map(flow => [flow.trigger, flow.active]).sort(), [["finished", true], ["started", true]]);
    let serial = 0;
    for (const kind of ["open", "fin"] as const) {
      part(`${kind}: starting the sequences fails once, then the moment comes again`);
      const note = kind === "open" ? noteIfOpened : noteIfFinished;
      const email = `lost${serial++}@example.com`;
      await upsertContact(store.listId!, email, { agreed: true, explicit: true, productId: product.id, title: product.title, source: "buyer" }, ROOM);
      if (kind === "fin") await markLesson(course.id, email, lesson, true, ROOM);
      // The store's list of sequences answers in a shape that is not its own, once: enroll logs it and starts nothing.
      let failed = false;
      redis.pipeline = async (commands) => {
        if (!failed && commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:mail:flows:"))) {
          failed = true;
          return [42] as never;
        }
        return original(commands);
      };
      await note(store, product.id, course.id, email);
      redis.pipeline = original;
      is(`${kind}: the failure was injected`, failed, true);
      const queuedFor = async () => ((await original([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]))[0] as string[]).filter((item) => item.endsWith(`|${email}`)).length;
      is(`${kind}: nothing was started for the student by the failed try`, await queuedFor(), 0);
      // The same moment again (a lesson opened again; a lesson marked done again): the sequence starts now.
      await note(store, product.id, course.id, email);
      is(`${kind}: the student's sequence starts once the failure has passed, never lost for 400 days`, await queuedFor(), 1);
      await note(store, product.id, course.id, email);
      is(`${kind}: and never twice`, await queuedFor(), 1);
    }
    for (const kind of ["open", "fin"] as const) {
      part(`${kind}: starting fails and the cleanup DEL answers in a shape that is not its own`);
      const note = kind === "open" ? noteIfOpened : noteIfFinished;
      const email = `lostdel${serial++}@example.com`;
      const mark = `nl:course:${course.id}:${kind}:${emailKey(email)}`;
      await upsertContact(store.listId!, email, { agreed: true, explicit: true, productId: product.id, title: product.title, source: "buyer" }, ROOM);
      if (kind === "fin") await markLesson(course.id, email, lesson, true, ROOM);
      let failed = false, lostDel = false;
      redis.pipeline = async (commands) => {
        if (!failed && commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:mail:flows:"))) {
          failed = true;
          return [42] as never;
        }
        // The DEL never reaches Redis and its reply is lost: the mark stays.
        if (!lostDel && commands.length === 1 && commands[0][0] === "DEL" && commands[0][1] === mark) {
          lostDel = true;
          return [] as never;
        }
        return original(commands);
      };
      await note(store, product.id, course.id, email);
      redis.pipeline = original;
      is(`${kind}: both failures were injected`, [failed, lostDel], [true, true]);
      const ttl = (await original([["TTL", mark]]))[0] as number;
      // A mark left behind by an unconfirmed cleanup holds the moment for an hour at the most, never 400 days.
      is(`${kind}: the mark left by the lost cleanup lives an hour at the most`, ttl > 0 && ttl <= 3600, true);
      await original([["DEL", mark]]); // the hour passes
      const queuedFor = async () => ((await original([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]))[0] as string[]).filter((item) => item.endsWith(`|${email}`)).length;
      await note(store, product.id, course.id, email);
      is(`${kind}: after that hour the sequence starts`, await queuedFor(), 1);
      const kept = (await original([["TTL", mark]]))[0] as number;
      is(`${kind}: a start that went through keeps the mark 400 days`, kept > 399 * 86_400, true);
      await note(store, product.id, course.id, email);
      is(`${kind}: and never twice`, await queuedFor(), 1);
    }
  } finally { redis.pipeline = original; globalThis.fetch = originalFetch; console.error = originalError; }
  done();
}
void main().catch(error => { console.error(error); process.exit(1); });
