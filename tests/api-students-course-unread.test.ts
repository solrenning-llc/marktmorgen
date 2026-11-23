/**
 * Issue #4068 (Codex C2, MEDIUM): GET /api/v1/students read a course with readCourse, which answers null for a value
 * that does not read (a number, broken JSON, or a well-formed course under another id) as well as for a confirmed
 * absence, and the route turned that null into 404 not_a_course. An integration could take a storage reply it could
 * not read for a course that is gone, and stop syncing it.
 *
 * Now the course is read exactly (readCourseExact): a confirmed absence is still 404 not_a_course; a reply that does
 * not read is 502 unavailable, never "not a course". Synthetic store, key and Redis only.
 */
import { makeKey } from "@/lib/api-keys";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeForEmail } from "@/lib/store";
import { GET as studentsRead } from "@/app/api/v1/students/route";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "students-unread@example.com";

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle(OWNER, "students-unread", "Students Unread", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_StudentsUnread01", subscriptionId: "sub_StudentsUnread01", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const product = await addProduct(OWNER, "Bread School", "", "50");
  if (!product.ok) throw new Error("no product");
  let made = emptyCourse();
  const added = editCourse(made, { op: "lesson-add", moduleId: made.modules[0].id, title: "One" });
  if (!added.ok) throw new Error("no lesson");
  made = added.course;
  await saveCourse(made, ROOM);
  await setProductCourse(OWNER, product.product.id, { id: made.id, lessons: 1 });
  const key = await makeKey((await storeForEmail(OWNER))!.sid, "Synthetic sync");
  if (!key.ok) throw new Error("no key");
  const courseKey = `nl:course:${made.id}`;
  const saved = redis.run(["GET", courseKey]) as string;
  const ask = async () => {
    const res = await studentsRead(new Request(`https://marktmorgen.com/api/v1/students?product=${product.product.id}`, { headers: { Authorization: `Bearer ${key.key}` } }));
    const body = (await res.json()) as { error?: { code?: string } | string; data?: unknown[] };
    const code = typeof body.error === "object" ? body.error?.code : body.error;
    return [res.status, code ?? null];
  };

  part("Control: a course that reads is answered");
  is("200, no error", await ask(), [200, null]);

  part("A course whose stored value does not read is unavailable, never 'not a course'");
  const otherId = JSON.stringify({ ...JSON.parse(saved), id: "c_someoneelse01" });
  for (const [label, value] of [
    ["broken JSON", "{\"id\":"],
    ["a number", "7"],
    ["a well-formed course under another id", otherId],
  ] as [string, string][]) {
    redis.run(["SET", courseKey, value]);
    is(`${label}: 502 unavailable`, await ask(), [502, "unavailable"]);
  }

  part("A course confirmed absent is still not a course");
  redis.run(["DEL", courseKey]);
  is("404 not_a_course", await ask(), [404, "not_a_course"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
