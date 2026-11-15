import { createHash } from "node:crypto";
import { noteIfFinished, noteIfOpened } from "@/lib/course-finish";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, markLesson } from "@/lib/learn";
import { upsertContact } from "@/lib/contacts";
import { readFlows, saveFlow } from "@/lib/flows";
import { normaliseEmail } from "@/lib/auth";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

/**
 * Review of #4301 (Codex G and Codex X5, MEDIUM; Claude 7, MÉDIO). The course moment's mark is let go when enroll
 * fails, but startFlows claimed each person and sequence for 400 days before the run's record and its place in the
 * queue were written: a failure between them (the run's record, or the queue's ZADD, not written) left a 400-day claim
 * with no run, so the next course moment found the sequence "already started" and the student never got it. Now the
 * claim is "pending" for an hour and becomes the 400-day mark in the same atomic step that queues the run; a pending
 * claim found by a later moment is not a start, so the moment's own mark is let go too, and after the hour the
 * sequence starts once. A lost reply of that atomic step that did apply leaves the 400-day mark: never twice.
 * And enroll read the contact (isMailable) loosely: a reply that is not the contact's own shape read as "not mailable"
 * and enroll said it went through, so the moment's mark was kept 400 days with nothing started. Synthetic data only.
 */
async function main() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("No external transport in this test"); };
  const original = redis.pipeline.bind(redis);
  const originalError = console.error;
  console.error = () => {};
  try {
    redis.clear();
    const owner = "course-enrolled@example.com";
    await claimHandle(owner, "courseenrolled", "Course enrolled", "");
    await ensureStatsId(owner);
    await ensureListId(owner);
    await setMailSettings(owner, { fromName: "Course enrolled", address: "Synthetic test address" });
    await setStripeAccount(owner, "acct_EnrolledTest", true);
    await setSubscription(owner, { customerId: "cus_EnrolledTest", subscriptionId: "sub_EnrolledTest", active: true, tier: "pro", period: paidPeriod() });
    const made = await addProduct(owner, "Enrolled proof", "A synthetic course", "49", null);
    if (!made.ok) throw Error("Synthetic product was not created");
    const product = made.product;
    const base = emptyCourse();
    const built = editCourse(base, { op: "lesson-add", moduleId: base.modules[0].id, title: "Enrolled lesson" });
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
    const flows = await readFlows(store.listId);
    const flowOf = (kind: "open" | "fin") => flows.find((f) => f.trigger === (kind === "open" ? "started" : "finished"))!.id;
    const enrolled = (kind: "open" | "fin", email: string) =>
      `nl:mail:enr:${flowOf(kind)}:${createHash("sha256").update(`nimbus-flow:${normaliseEmail(email)}`).digest("hex").slice(0, 32)}`;
    let serial = 0;
    const student = async (kind: "open" | "fin") => {
      const email = `enrolled${serial++}@example.com`;
      await upsertContact(store.listId!, email, { agreed: true, explicit: true, productId: product.id, title: product.title, source: "buyer" }, ROOM);
      if (kind === "fin") await markLesson(course.id, email, lesson, true, ROOM);
      return email;
    };
    const queuedFor = async (email: string) => ((await original([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]))[0] as string[]).filter((item) => item.endsWith(`|${email}`)).length;
    const ttlOf = async (key: string) => (await original([["TTL", key]]))[0] as number;
    const isRunRecord = (c: (string | number)[]) => c[0] === "HSET" && String(c[1]).startsWith("nl:wf:run:") && c.includes("running");
    const isQueueing = (c: (string | number)[]) => (c[0] === "ZADD" && c[1] === "nl:mail:flowq") || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:flow-queued:v1\n"));

    const failures: [string, (c: (string | number)[]) => boolean][] = [
      ["the run's record", isRunRecord],
      ["the queue's entry", isQueueing],
    ];
    for (const [what, hit] of failures) {
      for (const kind of ["open", "fin"] as const) {
        part(`${kind}: writing ${what} fails after the person's claim, then the moment comes again`);
        const note = kind === "open" ? noteIfOpened : noteIfFinished;
        const email = await student(kind);
        const mark = `nl:course:${course.id}:${kind}:${emailKey(email)}`;
        let failed = false;
        redis.pipeline = async (commands) => {
          // Redis is not reached: nothing of this batch is written.
          if (!failed && commands.some(hit)) {
            failed = true;
            throw Error("Synthetic Redis failure");
          }
          return original(commands);
        };
        await note(store, product.id, course.id, email);
        redis.pipeline = original;
        is(`${kind}, ${what}: the failure was injected`, failed, true);
        is(`${kind}, ${what}: nothing was queued`, await queuedFor(email), 0);
        is(`${kind}, ${what}: the person's claim holds an hour at the most, never 400 days`, (await ttlOf(enrolled(kind, email))) <= 3_600, true);
        // The moment again within that hour: nothing starts yet, and its own mark is not kept 400 days for it.
        await note(store, product.id, course.id, email);
        is(`${kind}, ${what}: a pending claim is not a start`, await queuedFor(email), 0);
        is(`${kind}, ${what}: so the moment's mark is not kept 400 days`, (await ttlOf(mark)) <= 3_600, true);
        await original([["DEL", enrolled(kind, email)]]); // the hour passes
        await note(store, product.id, course.id, email);
        is(`${kind}, ${what}: after it the student's sequence starts`, await queuedFor(email), 1);
        is(`${kind}, ${what}: the started run keeps its claim 400 days`, (await ttlOf(enrolled(kind, email))) > 399 * 86_400, true);
        await original([["DEL", mark]]);
        await note(store, product.id, course.id, email);
        is(`${kind}, ${what}: and never twice`, await queuedFor(email), 1);
      }
    }

    for (const kind of ["open", "fin"] as const) {
      part(`${kind}: the queue's entry is written but its reply is lost`);
      const note = kind === "open" ? noteIfOpened : noteIfFinished;
      const email = await student(kind);
      let lost = false;
      redis.pipeline = async (commands) => {
        if (!lost && commands.some(isQueueing)) {
          lost = true;
          await original(commands);
          return [] as never;
        }
        return original(commands);
      };
      await note(store, product.id, course.id, email);
      redis.pipeline = original;
      is(`${kind}, lost reply: injected`, lost, true);
      is(`${kind}, lost reply: queued once`, await queuedFor(email), 1);
      await original([["DEL", `nl:course:${course.id}:${kind}:${emailKey(email)}`]]); // the moment's hour passes
      await note(store, product.id, course.id, email);
      is(`${kind}, lost reply: the moment again never starts it twice`, await queuedFor(email), 1);
    }

    for (const kind of ["open", "fin"] as const) {
      part(`${kind}: the student's contact answers in a shape that is not its own, once`);
      const note = kind === "open" ? noteIfOpened : noteIfFinished;
      const email = await student(kind);
      const mark = `nl:course:${course.id}:${kind}:${emailKey(email)}`;
      let odd = false;
      redis.pipeline = async (commands) => {
        if (!odd && commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === `nl:store:leads:${store.listId}`) {
          odd = true;
          return [42] as never;
        }
        return original(commands);
      };
      await note(store, product.id, course.id, email);
      redis.pipeline = original;
      is(`${kind}, contact: injected`, odd, true);
      is(`${kind}, contact: the moment's mark is not kept 400 days on an unread contact`, (await ttlOf(mark)) <= 3_600, true);
      await note(store, product.id, course.id, email);
      is(`${kind}, contact: the moment again starts the sequence`, await queuedFor(email), 1);
    }
  } finally { redis.pipeline = original; globalThis.fetch = originalFetch; console.error = originalError; }
  done();
}
void main().catch(error => { console.error(error); process.exit(1); });
