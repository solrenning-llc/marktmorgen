/**
 * A student's quiz tries, results and passes are reported deleted only when
 * Redis gives the exact one-slot DEL count. Any other reply leaves this
 * erasure part unknown so the aggregate eraser can report it for a safe retry
 * (CX-123 rule 24), never a finished part that deleted nothing.
 */
import { forgetQuizPerson } from "@/lib/quiz";
import { ERASERS } from "@/lib/person-erasure";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const EMAIL = "quiz-erasure@example.com";
const who = emailKey(EMAIL);
const COURSES = [
  { courseId: "course_quiz_a", lessonIds: ["lesson_1"] },
  { courseId: "course_quiz_b", lessonIds: [] as string[] },
];
const keys = [
  `nl:course:course_quiz_a:passed:${who}`,
  `nl:course:course_quiz_a:quiz:lesson_1:tries:${who}`,
  `nl:course:course_quiz_a:quiz:lesson_1:result:${who}`,
  `nl:course:course_quiz_b:passed:${who}`,
];

function seed(): void {
  for (const key of keys) redis.run(["SET", key, "1"]);
}

function kept(): number {
  return keys.filter((key) => redis.run(["GET", key]) === "1").length;
}

async function main(): Promise<void> {
  const original = redis.pipeline.bind(redis);
  let getterReads = 0;
  const inherited = Object.setPrototypeOf(new Array(1), [4]);
  const getter = Object.defineProperty(new Array(1), "0", {
    configurable: true,
    get() {
      getterReads += 1;
      return 4;
    },
  });
  const cases: [string, unknown][] = [
    ["missing reply", []],
    ["undefined slot", [undefined]],
    ["null slot", [null]],
    ["numeric text", ["4"]],
    ["object reply", [{}]],
    ["negative count", [-1]],
    ["fractional count", [1.5]],
    ["count above the distinct key bound", [5]],
    ["maximum safe count above the distinct key bound", [Number.MAX_SAFE_INTEGER]],
    ["unsafe count", [Number.MAX_SAFE_INTEGER + 1]],
    ["infinite count", [Number.POSITIVE_INFINITY]],
    ["not-a-number count", [Number.NaN]],
    ["extra reply", [4, 0]],
    ["sparse slot", new Array(1)],
    ["inherited slot", inherited],
    ["getter slot", getter],
    ["not a list", { 0: 4 }],
  ];

  part("Unknown DEL replies cannot finish the quiz part of erasure");
  for (const [label, reply] of cases) {
    redis.clear();
    seed();
    redis.pipeline = (async (commands) => {
      if (commands.length === 1 && commands[0]?.[0] === "DEL") return reply as never;
      return original(commands);
    }) as typeof redis.pipeline;
    let refused = false;
    try {
      await forgetQuizPerson(COURSES, who);
    } catch {
      refused = true;
    } finally {
      redis.pipeline = original;
    }
    is(`${label}: unknown evidence refuses this erasure part`, refused, true);
    is(`${label}: every quiz record remains for a safe retry`, kept(), keys.length);
    is(`${label}: a healthy retry removes the exact four records`, await forgetQuizPerson(COURSES, who), keys.length);
  }
  is("a reply getter is never used as deletion evidence", getterReads, 0);

  part("The aggregate eraser must see an unknown reply as incomplete");
  redis.clear();
  seed();
  const eraser = ERASERS.find((entry) => entry.module === "lib/quiz.ts")!;
  const subject = { courses: COURSES, learner: who, email: EMAIL } as never;
  redis.pipeline = (async (commands) => {
    if (commands.length === 1 && commands[0]?.[0] === "DEL") return ["1"];
    return original(commands);
  }) as typeof redis.pipeline;
  let aggregateRefused = false;
  try {
    await eraser.run(subject, [], new Set());
  } catch {
    aggregateRefused = true;
  } finally {
    redis.pipeline = original;
  }
  is("the aggregate eraser receives a failure, not a successful count", aggregateRefused, true);
  is("aggregate unknown leaves every quiz record for retry", kept(), keys.length);
  is("the same aggregate part succeeds on the restored exact reply", await eraser.run(subject, [], new Set()), keys.length);

  part("Exact Redis results retain their existing meaning");
  redis.clear();
  is("confirmed absence is zero", await forgetQuizPerson(COURSES, who), 0);
  seed();
  redis.run(["DEL", keys[0], keys[1]]);
  is("the exact remaining count is returned", await forgetQuizPerson(COURSES, who), keys.length - 2);
  is("nothing remains after the confirmed deletion", kept(), 0);
  seed();
  is(
    "duplicate courses and lessons retain the distinct-key deletion bound",
    await forgetQuizPerson([COURSES[0], COURSES[0], { courseId: "course_quiz_a", lessonIds: ["lesson_1", "lesson_1"] }, COURSES[1]], who),
    keys.length,
  );
  is("an empty course list remains a known no-op", await forgetQuizPerson([], who), 0);

  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
