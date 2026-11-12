/**
 * 279 [H3-4] unit 1: the students page pays for what it reads (Claude 1 cloud,
 * MEDIUM on #3035 @f9a1b40a5c). A page of the list reads each student's done
 * list and the course's blocked list (lib/learn.ts, studentPage): past
 * BLOCKED_READ_MAX blocked, one SISMEMBER a row, and each done list up to
 * MAX_LESSONS ids. A studio request is priced at 20 commands and 50,000 bytes
 * read (tests/plan-cost-registry.ts), so what is charged before the reads must
 * cover both, as the API's reader of the same page does (studentsPageWork).
 */
import { studentList } from "@/lib/student-bulk";
import { emailKey } from "@/lib/learn";
import { emptyCourse } from "@/lib/course";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STUDIO_COMMANDS = 20;
const STUDIO_BYTES = 50_000;

async function main(): Promise<void> {
  part("A page of 100 students, 201 taken off, 200 lessons done each");
  const course = emptyCourse();
  const now = Math.floor(Date.now() / 1000);
  const rows: (string | number)[] = [];
  const setup: (string | number)[][] = [];
  for (let i = 0; i < 100; i += 1) {
    const email = `s${i}@example.com`;
    rows.push(emailKey(email), JSON.stringify({ e: email, s: now, l: now }));
    setup.push(["SADD", `nl:course:${course.id}:done:${emailKey(email)}`, ...Array.from({ length: 200 }, (_, j) => `lesson-${String(j).padStart(26, "0")}`)]);
  }
  setup.push(["HSET", `nl:course:${course.id}:students`, ...rows]);
  setup.push(["SADD", `nl:course:${course.id}:blocked`, ...Array.from({ length: 201 }, (_, i) => emailKey(`gone${i}@example.com`))]);
  await redis.pipeline(setup);

  const pipeline = redis.pipeline.bind(redis);
  let charged: number | null = null;
  let commands = 0;
  let bytes = 0;
  redis.pipeline = (async (sent: (string | number)[][]) => {
    const replies = await pipeline(sent);
    if (charged !== null) {
      commands += sent.length;
      bytes += JSON.stringify(replies).length;
    }
    return replies;
  }) as typeof redis.pipeline;
  const read = await studentList({} as Store, course, "0", async (units) => ((charged = units), true), false);
  redis.pipeline = pipeline;
  const units = charged ?? 0;
  is("the page is read", [read?.lines.length, read?.total], [100, 100]);
  is("the commands sent after the charge fit in what was charged", commands <= units * STUDIO_COMMANDS, true);
  is("the bytes read after the charge fit in what was charged", bytes <= units * STUDIO_BYTES, true);

  part("Control: a small page with nobody taken off still takes at least one request");
  redis.clear();
  const small = emptyCourse();
  await redis.pipeline([["HSET", `nl:course:${small.id}:students`, emailKey("a@example.com"), JSON.stringify({ e: "a@example.com", s: now, l: now })]]);
  let smallCharge = -1;
  const smallRead = await studentList({} as Store, small, "0", async (u) => ((smallCharge = u), true), false);
  is("one student, one request at least", [smallRead?.lines.length, smallCharge >= 1], [1, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
