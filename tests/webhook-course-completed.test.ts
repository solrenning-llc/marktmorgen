/**
 * The webhook event course.completed (378 [TB4] complement WG (a)): sent once
 * when a student finishes every lesson of a course, under the same once-only
 * claim that starts the "when someone finishes" sequences (lib/course-finish.ts,
 * noteIfFinished). What is checked, with synthetic stores and courses:
 *
 *   - nothing while a lesson is left;
 *   - on the last lesson, one message: the student's address, the product
 *     with its title, how many lessons, and when;
 *   - asked again (a lesson undone and done again, or the same press twice),
 *     nothing more;
 *   - only to endpoints that listen for it; it is an event a store can
 *     listen for, listed in the studio.
 */
import { readFileSync } from "node:fs";
import { noteIfFinished } from "@/lib/course-finish";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { markLesson } from "@/lib/learn";
import { WEBHOOK_EVENTS, addEndpoint, recentMessages, setSendHooksForTests } from "@/lib/webhooks";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductCourse, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });
console.error = () => {};

async function main(): Promise<void> {
  redis.clear();
  const owner = "course-hook@example.com";
  await claimHandle(owner, "coursehook", "Course Hook", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_CourseHook01", subscriptionId: "sub_CourseHook01", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Sourdough at Home", "A synthetic course", "49", null);
  if (!made.ok) throw new Error("no product");
  const base = emptyCourse();
  const one = editCourse(base, { op: "lesson-add", moduleId: base.modules[0].id, title: "Starter" });
  if (!one.ok) throw new Error("no lesson");
  const two = editCourse(one.course, { op: "lesson-add", moduleId: base.modules[0].id, title: "Bake" });
  if (!two.ok) throw new Error("no lesson");
  const course = two.course;
  const [first, second] = course.modules[0].lessons.map((l) => l.id);
  await saveCourse(course, ROOM);
  if (!(await setProductCourse(owner, made.product.id, { id: course.id, lessons: 2 })).ok) throw new Error("not linked");
  let store = (await storeForEmail(owner))!;
  const listening = await addEndpoint(store, "https://hooks.example.com/courses", ["course.completed"]);
  const deaf = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!listening.ok || !deaf.ok) throw new Error("no endpoints");
  store = (await storeForEmail(owner))!;
  const email = "ada@example.com";

  part("An event a store can listen for, in the studio's list");
  is("course.completed is one of the events", (WEBHOOK_EVENTS as readonly string[]).includes("course.completed"), true);
  is("the studio lists it with what it means", readFileSync("components/webhook-editor.tsx", "utf8").includes('key: "course.completed", label: "Course completed"'), true);

  part("Nothing while a lesson is left; one message on the last");
  await markLesson(course.id, email, first, true, ROOM);
  is("one lesson of two: not finished", await noteIfFinished(store, made.product.id, course.id, email), false);
  is("nothing sent", (await recentMessages(store, "course.completed", 10)).length, 0);
  await markLesson(course.id, email, second, true, ROOM);
  is("the last lesson: finished", await noteIfFinished(store, made.product.id, course.id, email), true);
  const sent = await recentMessages(store, "course.completed", 10);
  const data = (sent[0]?.data ?? {}) as Record<string, unknown>;
  is("one message", sent.length, 1);
  is("the address, the product with its title, how many lessons, and when", [data.email, data.product, data.lessons, typeof data.completed_at === "string" && !Number.isNaN(Date.parse(String(data.completed_at)))], [email, { id: made.product.id, title: "Sourdough at Home" }, 2, true]);

  part("Once for each student");
  await markLesson(course.id, email, second, false, ROOM);
  await markLesson(course.id, email, second, true, ROOM);
  is("undone and done again: not a second finish", await noteIfFinished(store, made.product.id, course.id, email), false);
  is("the same again: not a second finish", await noteIfFinished(store, made.product.id, course.id, email), false);
  is("nothing more sent", (await recentMessages(store, "course.completed", 10)).length, 1);

  part("Only to the endpoint that listens");
  const log = await redis.pipeline([["LRANGE", `nl:hooks:log:${store.statsId}`, 0, -1]]);
  const rows = (await redis.pipeline(((log[0] as string[]) ?? []).map((id) => ["GET", `nl:hooks:d:${id}`]))) as string[];
  const to = rows.map((raw) => JSON.parse(raw) as { endpoint: string; type: string }).filter((d) => d.type === "course.completed").map((d) => d.endpoint);
  is("one delivery, to it", to, [listening.view.endpoints.find((e) => e.where.endsWith("/courses"))!.id]);

  done();
}

void main();
