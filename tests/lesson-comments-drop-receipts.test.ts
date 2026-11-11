/**
 * Dropping every comment in a course releases its data-room slot only after
 * Redis confirms every one-key DEL with one exact 0-or-1 receipt.
 */
import { dropComments } from "@/lib/lesson-comments";
import { store as redis } from "./redis-stub";
import { ROOM, roomOnly } from "./data-room";
import { done, is, part } from "./check";

const COURSE = "course_comment_drop";
const LESSONS = ["lesson_comment_a", "lesson_comment_b"];
const keys = [
  `nl:lc:${COURSE}:c`,
  `nl:lc:${COURSE}:all`,
  `nl:lc:${COURSE}:r`,
  `nl:lc:${COURSE}:names`,
  `nl:lc:${COURSE}:off`,
  `nl:lc:${COURSE}:seen`,
  ...LESSONS.map((lesson) => `nl:lc:${COURSE}:l:${lesson}`),
];

function seed(): void {
  for (const key of keys) redis.run(["SET", key, "held"]);
}

async function main(): Promise<void> {
  const original = redis.pipeline.bind(redis);
  let getterReads = 0;
  const inherited = Object.setPrototypeOf(Array(keys.length).fill(0), { 3: 0 });
  delete inherited[3];
  const getter = Array(keys.length).fill(0);
  Object.defineProperty(getter, "3", {
    configurable: true,
    get() {
      getterReads += 1;
      return 0;
    },
  });
  const sparse = Array(keys.length).fill(0);
  delete sparse[4];
  const cases: [string, unknown][] = [
    ["missing reply", []],
    ["short reply", Array(keys.length - 1).fill(0)],
    ["extra reply", [...Array(keys.length).fill(0), 0]],
    ["undefined receipt", [undefined, ...Array(keys.length - 1).fill(0)]],
    ["numeric text receipt", ["0", ...Array(keys.length - 1).fill(0)]],
    ["negative receipt", [-1, ...Array(keys.length - 1).fill(0)]],
    ["fractional receipt", [0.5, ...Array(keys.length - 1).fill(0)]],
    ["two-key receipt for one-key DEL", [2, ...Array(keys.length - 1).fill(0)]],
    ["unsafe receipt", [Number.MAX_SAFE_INTEGER + 1, ...Array(keys.length - 1).fill(0)]],
    ["sparse receipt", sparse],
    ["inherited receipt", inherited],
    ["getter receipt", getter],
  ];

  part("Unknown DEL receipts never release the course comments slot");
  for (const [label, reply] of cases) {
    redis.clear();
    seed();
    let roomWrites = 0;
    redis.pipeline = (async (commands) => {
      if (commands.every((command) => command[0] === "DEL")) return reply as never;
      if (roomOnly(commands)) roomWrites += 1;
      return original(commands);
    }) as typeof redis.pipeline;
    let refused = false;
    try {
      await dropComments(COURSE, LESSONS, ROOM);
    } catch {
      refused = true;
    } finally {
      redis.pipeline = original;
    }
    is(`${label}: the drop remains unknown`, refused, true);
    is(`${label}: no data-room release is attempted`, roomWrites, 0);
    is(`${label}: the keys remain available for a safe retry`, keys.filter((key) => redis.run(["GET", key]) === "held").length, keys.length);
  }
  is("a receipt getter is never used as deletion evidence", getterReads, 0);

  part("An applied deletion with a lost receipt is not certified");
  redis.clear();
  seed();
  let roomWrites = 0;
  redis.pipeline = (async (commands) => {
    if (commands.every((command) => command[0] === "DEL")) {
      await original(commands);
      return [] as never;
    }
    if (roomOnly(commands)) roomWrites += 1;
    return original(commands);
  }) as typeof redis.pipeline;
  let appliedUnknown = false;
  try {
    await dropComments(COURSE, LESSONS, ROOM);
  } catch {
    appliedUnknown = true;
  } finally {
    redis.pipeline = original;
  }
  is("the lost receipt remains unknown after the keys were deleted", appliedUnknown, true);
  is("the unknown result releases no room", roomWrites, 0);
  is("the applied deletion is not retried inside the call", keys.filter((key) => redis.run(["GET", key]) !== null).length, 0);

  part("Exact receipts retain the existing successful behavior");
  redis.pipeline = (async (commands) => {
    if (roomOnly(commands)) roomWrites += 1;
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    await dropComments(COURSE, LESSONS, ROOM);
  } finally {
    redis.pipeline = original;
  }
  is("a later exact retry releases the slot once", roomWrites, 1);

  redis.clear();
  seed();
  roomWrites = 0;
  redis.pipeline = (async (commands) => {
    if (roomOnly(commands)) roomWrites += 1;
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    await dropComments(COURSE, LESSONS, ROOM);
  } finally {
    redis.pipeline = original;
  }
  is("ordinary exact 1 receipts release the slot once", roomWrites, 1);
  is("ordinary exact deletion removes every course-comment key", keys.filter((key) => redis.run(["GET", key]) !== null).length, 0);

  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
