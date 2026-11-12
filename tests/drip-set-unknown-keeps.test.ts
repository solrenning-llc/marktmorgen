/**
 * The daily drip job (lib/learn.ts sendDripEmails) takes a course out of the drip list (SREM nl:courses:drip) when
 * its store, its product or its course is not found. It read them with storeForHandle, readListing and readCourse,
 * which answer null for "not there" and for a reply that could not be read alike (CX-123 rule 24). So one Redis
 * reply off its shape in the daily run took the course out for good: its students never got another "a new module
 * is open" email, and nothing put it back until the creator saved the course again.
 *
 * Now nothing is taken out on a guess: before the SREM each is read exactly, an unknown answer leaves the course in
 * the list for the next run, and only a confirmed absence takes it out. Synthetic data only.
 */
import { registerDrip, sendDripEmails } from "@/lib/learn";
import { editCourse, emptyCourse, readCourse, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductCourse, storeForEmail, storeForHandle, storeHandleKey } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("No external transport in this test"); };
  const realError = console.error;
  console.error = () => {};
  const real = redis.pipeline.bind(redis);
  try {
    redis.clear();
    const owner = "drip-owner@example.com";
    await claimHandle(owner, "dripshop", "Drip shop", "");
    await ensureStatsId(owner);
    await ensureListId(owner);
    const made = await addProduct(owner, "Drip course", "A synthetic course", "49", null);
    if (!made.ok) throw Error("no product");
    const base = emptyCourse();
    const built = editCourse(base, { op: "lesson-add", moduleId: base.modules[0].id, title: "Lesson one" });
    if (!built.ok) throw Error("no lesson");
    const course = { ...built.course, modules: built.course.modules.map((m) => ({ ...m, dripDays: 7 })) };
    await saveCourse(course, ROOM);
    if (!(await setProductCourse(owner, made.product.id, { id: course.id, lessons: 1 })).ok) throw Error("not linked");
    const store = (await storeForEmail(owner))!;
    const product = { ...made.product, course: { id: course.id, lessons: 1 } };
    await registerDrip(store, product as never, course);
    const member = `${course.id}|${store.handle}|${made.product.id}`;
    const listed = () => real([["SISMEMBER", "nl:courses:drip", member]]).then((r) => r[0]);
    is("the course is on the drip list", await listed(), 1);

    part("The store's handle answers in a shape that is not its own, once");
    let off = false;
    redis.pipeline = async (commands) => {
      if (!off && commands.some((c) => c[0] === "GET" && c[1] === storeHandleKey(store.handle))) {
        off = true;
        return [42] as never;
      }
      return real(commands);
    };
    await sendDripEmails(storeForHandle, readCourse, "https://marktmorgen.com");
    redis.pipeline = real;
    is("the failure was injected", off, true);
    is("the course stays on the drip list for the next run: unknown is never 'gone'", await listed(), 1);

    part("Control: a store that is really gone takes its course off the list");
    await real([["DEL", storeHandleKey(store.handle)]]);
    await sendDripEmails(storeForHandle, readCourse, "https://marktmorgen.com");
    is("taken off once its store is confirmed gone", await listed(), 0);
  } finally {
    redis.pipeline = real;
    globalThis.fetch = originalFetch;
    console.error = realError;
  }
  done();
}

void main();
