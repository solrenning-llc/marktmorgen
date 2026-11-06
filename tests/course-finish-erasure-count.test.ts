/**
 * A person's course-open and course-finish marks are deleted only when Redis
 * gives the exact one-slot DEL count. Any other reply leaves this erasure
 * part unknown so the aggregate eraser can report it for a safe retry.
 */
import { forgetFinishPerson } from "@/lib/course-finish";
import { ERASERS } from "@/lib/person-erasure";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const EMAIL = "course-erasure@example.com";
const COURSES = ["course_event_a", "course_event_b"];
const learner = emailKey(EMAIL);
const keys = COURSES.flatMap((course) => [
  `nl:course:${course}:fin:${learner}`,
  `nl:course:${course}:open:${learner}`,
]);

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
    ["negative count", [-1]],
    ["fractional count", [1.5]],
    ["count above the distinct key bound", [5]],
    ["far-above-bound count", [99]],
    ["maximum safe count above the distinct key bound", [Number.MAX_SAFE_INTEGER]],
    ["unsafe count", [Number.MAX_SAFE_INTEGER + 1]],
    ["infinite count", [Number.POSITIVE_INFINITY]],
    ["not-a-number count", [Number.NaN]],
    ["extra reply", [4, 0]],
    ["sparse slot", new Array(1)],
    ["inherited slot", inherited],
    ["getter slot", getter],
  ];

  part("Unknown DEL replies cannot finish the course-event part of erasure");
  for (const [label, reply] of cases) {
    redis.clear();
    seed();
    redis.pipeline = (async (commands) => {
      if (commands.length === 1 && commands[0]?.[0] === "DEL") return reply as never;
      return original(commands);
    }) as typeof redis.pipeline;
    let refused = false;
    try {
      await forgetFinishPerson(COURSES, EMAIL);
    } catch {
      refused = true;
    } finally {
      redis.pipeline = original;
    }
    is(`${label}: unknown evidence refuses this erasure part`, refused, true);
    is(`${label}: all marks remain for a safe retry`, kept(), keys.length);
    is(`${label}: a healthy retry removes the exact four marks`, await forgetFinishPerson(COURSES, EMAIL), keys.length);
  }
  is("a reply getter is never used as deletion evidence", getterReads, 0);

  part("The aggregate eraser must see an unknown reply as incomplete");
  redis.clear();
  seed();
  const eraser = ERASERS.find((entry) => entry.module === "lib/course-finish.ts")!;
  redis.pipeline = (async (commands) => {
    if (commands.length === 1 && commands[0]?.[0] === "DEL") return [];
    return original(commands);
  }) as typeof redis.pipeline;
  let aggregateRefused = false;
  try {
    await eraser.run({ courses: COURSES.map((courseId) => ({ courseId })), email: EMAIL } as never, [], new Set());
  } catch {
    aggregateRefused = true;
  } finally {
    redis.pipeline = original;
  }
  is("the aggregate eraser receives a failure, not a successful zero", aggregateRefused, true);
  is("aggregate unknown leaves every mark for retry", kept(), keys.length);
  is("the same aggregate part succeeds on the restored exact reply", await eraser.run({ courses: COURSES.map((courseId) => ({ courseId })), email: EMAIL } as never, [], new Set()), keys.length);

  part("Exact Redis results retain their existing meaning");
  redis.clear();
  is("confirmed absence is zero", await forgetFinishPerson(COURSES, EMAIL), 0);
  seed();
  redis.run(["DEL", keys[0], keys[1]]);
  is("the exact remaining count is returned", await forgetFinishPerson(COURSES, EMAIL), keys.length - 2);
  is("nothing remains after the confirmed deletion", kept(), 0);
  seed();
  is(
    "duplicate course ids retain the distinct-key deletion bound",
    await forgetFinishPerson([COURSES[0], COURSES[0], COURSES[1]], EMAIL),
    keys.length,
  );
  is("an empty course list remains a known no-op", await forgetFinishPerson([], EMAIL), 0);

  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
