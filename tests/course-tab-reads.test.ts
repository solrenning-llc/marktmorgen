/**
 * Issue #4304, unit A (shape decided by the coordinator, 13/11/2026): each tab of the studio's course page reads
 * only what it shows, a page at a time, and its worst case fits what the page is counted at: STUDIO_PAGE_UNITS
 * studio requests of 20 commands and 50 KB each (tests/plan-cost-registry.ts, UNIT_COST.studio), less the reads
 * every load makes whatever the tab (the listing, the course, the store's folder: FIXED_COMMANDS).
 *
 * Each tab's real reading code runs against a Redis that answers every command at its largest: the longest
 * pieces of work, comments and certificate records, ids for every row asked for and a count past the last page.
 * The commands sent and the bytes answered are added up and held against the figure. A tab that goes past it
 * fails here. Two limits are reported, not held, and stay open for unit C: the students tab reads the whole
 * students hash and the certificates tab the whole set of ids, whose bytes grow with the course.
 */
import { readFileSync } from "node:fs";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { COURSE_TAB_PAGE, MAX_TAB_PAGES, MAX_WORK_PAGES, certificatesTab, commentsTab, studentsTab, workTab } from "@/lib/studio-course-tabs";
import { MAX_ANSWER_TEXT, MAX_FEEDBACK } from "@/lib/assignment-rules";
import { MAX_LESSON_COMMENT } from "@/lib/lesson-comments-rules";
import { MAX_LESSONS, type Course } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const realPipeline = redis.pipeline.bind(redis);

const STUDIO_COMMANDS = 20;
const STUDIO_BYTES = 50_000;
/** The listing, the course and the store's folder, read on every load of the page. */
const FIXED_COMMANDS = 8;
const COMMANDS = STUDIO_PAGE_UNITS * STUDIO_COMMANDS - FIXED_COMMANDS;
const BYTES = STUDIO_PAGE_UNITS * STUDIO_BYTES;

const WIDE = "\u{10FFFF}"; // four bytes in UTF-8, the widest a character can be
const whoOf = (i: number) => i.toString(16).padStart(32, "0");
const lessonIds = Array.from({ length: MAX_LESSONS }, (_, i) => `lesson${String(i).padStart(6, "0")}`);
const course = {
  id: "c".repeat(32),
  certificate: true,
  startsAt: null,
  modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: lessonIds.map((id) => ({ id, title: id, preview: false, video: null, files: [], link: null, hasBody: false, quiz: { questions: 3, pass: 2, tries: 3, required: true } })) }],
} as unknown as Course;

/** Every command answered at its largest, as the tab's real code asks it. */
function largest(command: (string | number)[]): unknown {
  const [name, , ...rest] = command;
  const asked = (from: number, to: number) => Math.max(0, to - from + 1);
  switch (name) {
    case "ZRANGEBYSCORE": {
      const limit = Number(rest[rest.indexOf("LIMIT") + 2]);
      const offset = Number(rest[rest.indexOf("LIMIT") + 1]);
      return Array.from({ length: limit }, (_, i) => [`${lessonIds[0]}|${whoOf(offset + i)}`, "1800000000"]).flat();
    }
    case "ZREVRANGE": {
      const n = asked(Number(rest[0]), Number(rest[1]));
      return rest.includes("WITHSCORES") ? Array.from({ length: n }, (_, i) => [`${lessonIds[0]}|${whoOf(i)}`, "1800000000"]).flat() : Array.from({ length: n }, (_, i) => `cmt${String(i).padStart(9, "0")}`);
    }
    case "ZCARD":
    case "ZCOUNT":
      return 1_000_000;
    case "GET": {
      const key = String(command[1]);
      // A piece of work at its longest: the answer and the creator's feedback in the widest characters.
      if (key.includes(":sub:")) return JSON.stringify({ text: WIDE.repeat(MAX_ANSWER_TEXT), feedback: WIDE.repeat(MAX_FEEDBACK), files: [] });
      // A certificate at its longest: the name, the title, the creator and the address.
      if (key.startsWith("nl:cert:")) return JSON.stringify({ name: WIDE.repeat(80), title: WIDE.repeat(200), creator: WIDE.repeat(200), email: `${"e".repeat(240)}@example.com` });
      return "1800000000";
    }
    case "HGET":
      return JSON.stringify({ e: `${"e".repeat(240)}@example.com`, s: 1, l: 1 });
    case "HMGET":
      return rest.map(() => JSON.stringify({ text: WIDE.repeat(MAX_LESSON_COMMENT), name: WIDE.repeat(40) }));
    case "SMEMBERS":
      // A course's certificates set: every page's ids (its bytes grow with the course, unit C); else lesson ids.
      return String(command[1]).endsWith(":certs:all") ? Array.from({ length: COURSE_TAB_PAGE.certificates * MAX_TAB_PAGES }, (_, i) => i.toString(36).padStart(16, "0")) : lessonIds;
    case "HGETALL":
      return Array.from({ length: COURSE_TAB_PAGE.students * MAX_TAB_PAGES }, (_, i) => [whoOf(i), JSON.stringify({ e: `s${i}@example.com`, s: 1, l: i })]).flat();
    default:
      return null;
  }
}

async function measure(run: () => Promise<unknown>): Promise<{ commands: number; bytes: number }> {
  let commands = 0;
  let bytes = 0;
  redis.pipeline = async (batch: Commands) => {
    commands += batch.length;
    const replies = batch.map(largest);
    bytes += Buffer.byteLength(JSON.stringify(replies));
    return replies;
  };
  try {
    await run().catch(() => undefined);
  } finally {
    redis.pipeline = realPipeline;
  }
  return { commands, bytes };
}

async function main(): Promise<void> {
  part("The figure held against is the one the cost registry prices");
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  is("UNIT_COST.studio is 20 commands and 50 KB a request", registry.includes(`studio: request("studio", ${STUDIO_COMMANDS} + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, 50_000)`), true);

  for (const page of [1, MAX_TAB_PAGES]) {
    part(`Page ${page} of each tab, at its worst`);
    for (const [tab, run] of [
      ["work", () => workTab(course.id, Math.min(page, MAX_WORK_PAGES), true)],
      ["work waiting", () => workTab(course.id, Math.min(page, MAX_WORK_PAGES), false)],
      ["comments", () => commentsTab(course.id, page)],
    ] as const) {
      const used = await measure(run);
      console.log(`  ${tab} page ${page}: ${used.commands} commands, ${used.bytes} bytes`);
      is(`${tab}: within ${COMMANDS} commands`, used.commands <= COMMANDS, true);
      is(`${tab}: within ${BYTES} bytes`, used.bytes <= BYTES, true);
    }
    for (const [tab, run] of [
      ["students", () => studentsTab(course, page)],
      ["certificates", () => certificatesTab(course.id, page)],
    ] as const) {
      const used = await measure(run);
      console.log(`  ${tab} page ${page}: ${used.commands} commands, ${used.bytes} bytes (bytes grow with the course: unit C)`);
      is(`${tab}: within ${COMMANDS} commands`, used.commands <= COMMANDS, true);
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
