/**
 * Issue #4304, unit C: the studio's students and certificates tabs walk a cursor (HSCAN, SSCAN) instead of
 * reading a whole hash or set. Walking every page reaches every row once; a page that does not read is unknown
 * (rule 30: never the end of the walk); a page past the byte ceiling is flagged, never shown as the rest.
 *
 * Against the Redis stand-in only; nothing real is reached.
 */
import { allKey, certKey, certificatesPage } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { studentsPage, touchStudent } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const realPipeline = redis.pipeline.bind(redis);
const course = { id: "d".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [] }] } as unknown as Course;

async function main(): Promise<void> {
  redis.clear();
  const people = 60;
  for (let n = 0; n < people; n += 1) await touchStudent(course.id, `s${n}@example.com`, 1_800_000_000 + n, ROOM);
  for (let n = 0; n < people; n += 1) {
    const id = `cert${String(n).padStart(12, "0")}`;
    await realPipeline([["SET", certKey(id), JSON.stringify({ id, store: "storekey01", productId: "prod01", courseId: course.id, name: `S ${n}`, title: "T", creator: "C", email: `s${n}@example.com`, issuedAt: 1_800_000_000 + n, withdrawnAt: 0 })], ["SADD", allKey(course.id), id]]);
  }

  part("Walking every page reaches every row once, with the total from HLEN and SCARD");
  for (const [what, walk] of [
    ["students", (cursor: string) => studentsPage(course, cursor, 25, 200_000).then((p) => p && { rows: p.students.map((s) => s.email), next: p.next, total: p.total })],
    ["certificates", (cursor: string) => certificatesPage(course.id, cursor, 25, 200_000).then((p) => p && { rows: p.list.map((c) => c.id), next: p.next, total: p.total })],
  ] as const) {
    const seen: string[] = [];
    let cursor = "0";
    let totals = new Set<number>();
    for (let i = 0; i < 20; i += 1) {
      const page = await walk(cursor);
      if (!page) break;
      seen.push(...page.rows);
      totals.add(page.total);
      if (page.next === null) break;
      cursor = page.next;
    }
    is(`${what}: every one, once`, [seen.length, new Set(seen).size], [people, people]);
    is(`${what}: the total is the count of them`, [...totals], [people]);
    totals = new Set();
  }

  part("Rule 30: a page that does not read is unknown, never the end");
  for (const [what, command, run] of [
    ["students", "HSCAN", () => studentsPage(course, "0", 25, 200_000)],
    ["certificates", "SSCAN", () => certificatesPage(course.id, "0", 25, 200_000)],
  ] as const) {
    redis.pipeline = async (batch: Commands) => (batch[0][0] === command ? [["", []]] : realPipeline(batch));
    is(`${what}: a cursor that is not digits`, await run(), null);
    redis.pipeline = async (batch: Commands) => (batch[0][0] === command ? [["0", [1, 2]]] : realPipeline(batch));
    is(`${what}: items that are not strings`, await run(), null);
    redis.pipeline = realPipeline;
  }

  part("A page past the byte ceiling is flagged and not shown");
  const tiny = await studentsPage(course, "0", 25, 10);
  is("students: too big, nothing shown as the page", [tiny?.tooBig, tiny?.students.length], [true, 0]);
  const tinyCerts = await certificatesPage(course.id, "0", 25, 10);
  is("certificates: too big, nothing shown as the page", [tinyCerts?.tooBig, tinyCerts?.list.length], [true, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
