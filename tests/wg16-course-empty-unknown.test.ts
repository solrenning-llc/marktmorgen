/**
 * 656 [WG16] unit 6, rule 23 / rule 24 (CX-123): the two lists this unit
 * gives an empty state (a course's students and its certificates) are read by
 * studentsOf (lib/learn.ts) and certificatesFor (lib/certificate.ts). Each
 * read a reply in an unknown shape as "none", so the studio would say "No
 * students yet" or "No certificates yet" while there were some.
 *
 * Now a reply of another shape, a cut envelope or a count of replies that
 * does not match what was sent is unknown (null), never an empty list; only
 * Redis's own empty answer is "none". A record that is itself malformed is
 * still skipped, as before: one broken certificate must not hide the rest.
 * The course page says the list could not be read instead of the empty state, and
 * the course's drip schedule skips a course whose students it could not read
 * this round instead of acting on an unknown list of blocked students.
 *
 * Synthetic records, in-memory Redis (tests/redis-stub.ts).
 */
import { readFileSync } from "node:fs";
import type { Course } from "@/lib/course";
import { emailKey, studentsOf } from "@/lib/learn";
import { certificatesFor } from "@/lib/certificate";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const realPipeline = redis.pipeline.bind(redis);
type Answer = (commands: (string | number)[][], real: unknown[]) => unknown;
let shape: Answer | null = null;
(redis as unknown as { pipeline: typeof realPipeline }).pipeline = async (commands) => {
  const real = await realPipeline(commands);
  return (shape ? shape(commands, real) : real) as Awaited<ReturnType<typeof realPipeline>>;
};
/** Answers the first command named `name` with `reply`, everything else as Redis does. */
const replace = (name: string, reply: unknown): Answer => (commands, real) => commands.map((c, i) => (String(c[0]) === name ? reply : real[i]));
const safely = async <T>(read: () => Promise<T>): Promise<T | "threw"> => {
  try {
    return await read();
  } catch {
    return "threw";
  }
};

const course = { id: "c0ffee00c0ffee00", certificate: true, modules: [{ id: "m1", title: "Start", dripDays: 0, lessons: [{ id: "l1", title: "One" }, { id: "l2", title: "Two" }] }] } as unknown as Course;
const emptyCourse = { ...course, id: "deadbeefdeadbeef" } as Course;
const student = "learner@example.com";

async function main(): Promise<void> {
  redis.clear();
  redis.run(["HSET", `nl:course:${course.id}:students`, emailKey(student), JSON.stringify({ e: student, s: 1_760_000_000, l: 1_760_000_500 })]);
  redis.run(["SADD", `nl:course:${course.id}:done:${emailKey(student)}`, "l1"]);
  const certId = "abcdefgh12345678";
  redis.run(["SET", `nl:cert:${certId}`, JSON.stringify({ id: certId, name: "Ana", title: "Start", store: "harbor", productId: "p1", courseId: course.id, issuedAt: 1_760_000_600, withdrawnAt: 0 })]);
  redis.run(["SADD", `nl:course:${course.id}:certs:all`, certId]);

  part("Read whole: the lists as kept, and Redis's own empty answer is none");
  is("the student is listed, with one lesson done", (await studentsOf(course))?.students.map((s) => [s.email, s.done]), [[student, 1]]);
  is("a course nobody opened: an empty list", await studentsOf(emptyCourse), { total: 0, students: [] });
  is("the certificate is listed", (await certificatesFor(course.id))?.list.map((c) => c.id), [certId]);
  is("a course with no certificate: an empty list", await certificatesFor(emptyCourse.id), { list: [], total: 0 });

  part("Students: an unknown reply is unknown (null), never none");
  for (const [name, answer] of [
    ["the list answered as a number", replace("HGETALL", 5)],
    ["the list cut short (an odd number of fields)", replace("HGETALL", ["only-a-field"])],
    ["the list with numbers where strings belong", replace("HGETALL", [1, 2])],
    ["the blocked list answered as text", replace("SMEMBERS", "x")],
    ["no reply at all to the first read", ((commands, real) => (String(commands[0][0]) === "HGETALL" ? [] : real)) as Answer],
  ] as [string, Answer][]) {
    shape = answer;
    is(`${name}: null`, await safely(() => studentsOf(course)), null);
    shape = null;
  }
  shape = (commands, real) => (commands.every((c) => String(c[0]) === "SMEMBERS") && commands.length === 1 && String(commands[0][1]).includes(":done:") ? ["l1"] : real);
  is("a student's lessons done answered as text: null, never 0 done", await safely(() => studentsOf(course)), null);
  shape = null;
  is("read whole again once Redis answers", (await studentsOf(course))?.total, 1);

  part("Certificates: an unknown reply is unknown (null), never none");
  for (const [name, answer] of [
    ["the ids answered as a number", replace("SMEMBERS", 7)],
    ["a certificate answered as a number", replace("GET", 3)],
    ["no reply to the certificates' read", ((commands, real) => (String(commands[0][0]) === "GET" ? [] : real)) as Answer],
  ] as [string, Answer][]) {
    shape = answer;
    is(`${name}: null`, await safely(() => certificatesFor(course.id)), null);
    shape = null;
  }
  redis.run(["SET", "nl:cert:zzzzzzzz00000000", "{not json"]);
  redis.run(["SADD", `nl:course:${course.id}:certs:all`, "zzzzzzzz00000000"]);
  is("a malformed certificate is skipped, as before; the rest still listed", (await certificatesFor(course.id))?.list.map((c) => c.id), [certId]);
  redis.run(["SADD", `nl:course:${course.id}:certs:all`, "0000000000000000"]);
  is("a certificate that is gone (nil) is skipped", (await certificatesFor(course.id))?.list.map((c) => c.id), [certId]);

  part("The pages say the list could not be read, instead of the empty state");
  const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  is("the course page keeps an unknown read of the students apart", page.includes("const studentsRead = await studentsOf(course, 500).catch(() => null);"), true);
  is("and of the certificates", page.includes("const certificates = await certificatesFor(course.id).catch(() => null);"), true);
  is(
    "students unread: a status note, not the empty state or the counts",
    page.includes('{studentsRead === null ? (\n            <p role="status" className="notice mt-5">\n              The students could not be read just now. Reload this page in a moment; this does not mean nobody has opened the course.\n            </p>\n          ) : students.length === 0 ? ('),
    true,
  );
  is(
    "certificates unread: a status note, not the empty state",
    page.includes('{certificates === null ? (\n            <p role="status" className="notice mt-3">\n              The certificates could not be read just now. Reload this page in a moment; this does not mean none were issued.\n            </p>\n          ) : certificates.list.length === 0 ? ('),
    true,
  );
  const learn = readFileSync("lib/learn.ts", "utf8");
  is("the drip schedule skips a course whose students it could not read this round, says so, and does not count it", /const read = await studentsOf\(course, 5000\);\n    if \(!read\) \{\n[^}]*console\.error\([^}]*\n      continue;\n    \}\n    counts\.courses \+= 1;/.test(learn), true);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
