/**
 * 292 [SQ3]: the facts a course's sales page and its own page say about it,
 * worked out by the code and never typed by the creator.
 *
 *   - How many lessons: the course record's own count (already said).
 *   - How long its video runs: the sum of every lesson video's length as the
 *     video service measured it. One video whose length is not known (a file
 *     kept in the file store, a video still being read, one that failed)
 *     and the whole figure is left out: a total that leaves a video out is
 *     not the total, and an estimate is never shown.
 *   - The reads: one MGET for every video's record, whatever the course
 *     holds, and nothing at all when it has no video.
 *
 * "Last updated" is not said yet: no course keeps when its content last
 * changed, so there is nothing true to say (the next unit stamps it when the
 * content is saved). The creator's switch to hide the facts is the unit
 * after that.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COURSE_FACTS_COMMANDS, courseVideoLengths, courseVideoSeconds, readCourseFacts, videoTotalLine } from "@/lib/course-facts";
import { MAX_LESSONS, type Course, type Lesson } from "@/lib/course";
import { streamPath } from "@/lib/stream-rules";
import { redisPipeline } from "@/lib/redis";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
import { store as redis } from "./redis-stub";
import { COMMANDS } from "./traffic-cost";
import { REQUEST_COMMANDS } from "./plan-cost-registry";
import { done, is, part } from "./check";

const FOLDER = "0123456789abcdef0123456789abcdef";
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const lessonId = (n: number) => `lesson${n.toString().padStart(6, "0")}`;

function lesson(n: number, video: string | null): Lesson {
  return {
    id: lessonId(n),
    title: `Lesson ${n}`,
    preview: false,
    video: video ? { pathname: video, name: "v.mp4", bytes: 1000, contentType: "video/mp4", addedAt: "2026-10-01T00:00:00.000Z" } : null,
    files: [],
    link: null,
    hasBody: video === null,
    quiz: null,
  };
}

function course(lessons: Lesson[]): Course {
  return { id: "f".repeat(32), modules: [{ id: "module000001", title: "One", dripDays: 0, lessons }], certificate: false, startsAt: null };
}

const streamed = (n: number) => streamPath(FOLDER, lessonId(n), uuid(n));

async function record(n: number, state: string, seconds: number) {
  const id = uuid(n);
  await redisPipeline([["SET", `nl:stream:v:${id}`, JSON.stringify({ id, path: streamed(n), name: "v.mp4", type: "video/mp4", bytes: 1000, state, at: 1, seconds, width: 1280, height: 720, settled: true })]]);
}

let commands = 0;
/** When set, the database answers this instead (a reply of unknown shape), once. */
let forced: { reply: unknown } | null = null;
const real = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = ((list: (string | number)[][]) => {
  commands += list.length;
  if (forced) {
    const { reply } = forced;
    forced = null;
    return Promise.resolve(reply);
  }
  return real(list);
}) as typeof redis.pipeline;
async function counted<T>(work: () => Promise<T>): Promise<{ commands: number; value: T }> {
  commands = 0;
  const value = await work();
  return { commands, value };
}

async function main() {
  part("the total is the sum of measured lengths, and nothing when one is unknown");
  {
    const lengths = new Map([[streamed(1), 600], [streamed(2), 125.4]]);
    is("two measured videos and a text lesson", courseVideoSeconds(course([lesson(1, streamed(1)), lesson(2, streamed(2)), lesson(3, null)]), lengths), 725.4);
    is("a video the service has not measured leaves the total out", courseVideoSeconds(course([lesson(1, streamed(1)), lesson(4, streamed(4))]), lengths), null);
    is("a video kept in the file store has no known length: left out", courseVideoSeconds(course([lesson(1, streamed(1)), lesson(5, `stores/${FOLDER}/p/f.mp4`)]), lengths), null);
    is("a course with no video says nothing of video", courseVideoSeconds(course([lesson(3, null)]), lengths), null);
    is("a course with no lessons says nothing", courseVideoSeconds(course([]), lengths), null);
    is("no lengths read (no database): nothing", courseVideoSeconds(course([lesson(1, streamed(1))]), null), null);
  }

  part("the line, in plain words with no abbreviation");
  {
    is("hours and minutes", videoTotalLine(2 * 3600 + 15 * 60 + 10, "en"), "2 hours 15 minutes of video");
    is("one hour", videoTotalLine(3600, "en"), "1 hour of video");
    is("minutes rounded to the nearest", videoTotalLine(45 * 60 + 31, "en"), "46 minutes of video");
    is("one minute", videoTotalLine(61, "en"), "1 minute of video");
    is("under a minute is said so, never as zero", videoTotalLine(20, "en"), "under 1 minute of video");
    is("59 minutes 40 seconds rounds up to the hour", videoTotalLine(59 * 60 + 40, "en"), "1 hour of video");
    is("in the store's language", videoTotalLine(90 * 60, "pt"), "1 hora 30 minutos de vídeo");
    is("every language has the words", Object.values(COURSES_WORDS).every((w) => typeof w.videoTotal(1, 1) === "string" && typeof w.videoUnderMinute === "string"), true);
    is("an unknown language falls back to English", videoTotalLine(120, "xx"), "2 minutes of video");
  }

  part("read from the video records, in one command");
  {
    await record(1, "ready", 600);
    await record(2, "ready", 300);
    await record(4, "working", 0);
    await record(6, "failed", 400);
    const lengths = await courseVideoLengths([streamed(1), streamed(2), streamed(4), streamed(6), `stores/${FOLDER}/p/f.mp4`]);
    is("only ready, measured videos have a length", lengths && [...lengths.entries()].sort(), [[streamed(1), 600], [streamed(2), 300]]);
    const { commands: one, value } = await counted(() => readCourseFacts(course([lesson(1, streamed(1)), lesson(2, streamed(2)), lesson(3, null)])));
    is("the facts of a measured course", value, { lessons: 3, videoSeconds: 900 });
    is("one command for them", one, 1);
    const unknown = await readCourseFacts(course([lesson(1, streamed(1)), lesson(4, streamed(4))]));
    is("a video still being read: lessons only", unknown, { lessons: 2, videoSeconds: null });
    const failed = await readCourseFacts(course([lesson(1, streamed(1)), lesson(6, streamed(6))]));
    is("a failed video: lessons only", failed, { lessons: 2, videoSeconds: null });
    const { commands: none } = await counted(() => readCourseFacts(course([lesson(3, null)])));
    is("no video, no command", none, 0);
    // A record whose path is another lesson's is not this lesson's video.
    const id = uuid(7);
    await redisPipeline([["SET", `nl:stream:v:${id}`, JSON.stringify({ id, path: streamPath(FOLDER, lessonId(8), id), name: "v", type: "", bytes: 1, state: "ready", at: 1, seconds: 99, width: 1, height: 1, settled: true })]]);
    const mismatched = await readCourseFacts(course([lesson(7, streamPath(FOLDER, lessonId(7), id))]));
    is("a record for another path is not believed", mismatched.videoSeconds, null);
  }

  part("an MGET reply of unknown shape leaves the total out, never estimated (rule 24, LEVE on #3011)");
  {
    await record(1, "ready", 600);
    await record(2, "ready", 300);
    const two = course([lesson(1, streamed(1)), lesson(2, streamed(2))]);
    const row = async (n: number) => (await redisPipeline([["GET", `nl:stream:v:${uuid(n)}`]]))[0];
    const [one, other] = [await row(1), await row(2)];
    is("control: the exact reply gives the total", (await readCourseFacts(two)).videoSeconds, 900);
    const shapes: [string, unknown][] = [
      ["three rows for two keys", [[one, other, one]]],
      ["one row for two keys", [[one]]],
      ["a row that is a number", [[one, 600]]],
      ["a row that is an object", [[one, { seconds: 300 }]]],
      ["two replies for one command", [[one, other], [one, other]]],
      ["no reply", []],
      ["a reply that is not a list", [{ 0: one, 1: other, length: 2 }]],
      ["a pipeline that is not a list", { 0: [one, other] }],
      ["a row list with a hole", [Object.assign(new Array(2), { 0: one })]],
    ];
    for (const [name, reply] of shapes) {
      forced = { reply };
      const facts = await readCourseFacts(two).catch(() => null);
      is(`${name}: lessons only, no video figure`, facts, { lessons: 2, videoSeconds: null });
    }
    forced = { reply: [[one, null]] };
    is("a missing record (null) is read as not known: no figure", (await readCourseFacts(two)).videoSeconds, null);
  }

  part("the biggest course is still one command, inside a later page's budget");
  {
    const many = Array.from({ length: MAX_LESSONS }, (_, i) => lesson(1000 + i, streamed(1000 + i)));
    for (let i = 0; i < MAX_LESSONS; i += 1) await record(1000 + i, "ready", 60);
    const { commands: big, value } = await counted(() => readCourseFacts(course(many)));
    is("200 videos, one MGET", big, 1);
    is("200 minutes", value.videoSeconds, 200 * 60);
    is("the sales page reads the course and the lengths: two commands", COURSE_FACTS_COMMANDS, 2);
    // The later page measured 6 commands on 6 November 2026 (tests/traffic.test.ts, drawLater).
    is("with them a course's sales page stays inside the later-page model", 6 + COURSE_FACTS_COMMANDS <= COMMANDS.laterPage + REQUEST_COMMANDS, true);
  }

  part("both pages say it, from the code");
  {
    const root = process.cwd();
    const coursePage = readFileSync(join(root, "app/[handle]/course/[product]/page.tsx"), "utf8");
    const salesPage = readFileSync(join(root, "app/[handle]/p/[product]/page.tsx"), "utf8");
    const facts = readFileSync(join(root, "components/store-product.tsx"), "utf8");
    is("the course page reads the facts", /readCourseFacts\(course\)/.test(coursePage) && /videoTotalLine\(/.test(coursePage), true);
    is("the sales page reads them only for a course", /product\.course \? readCourse\(product\.course\.id\)/.test(salesPage) && /videoTotalLine\(/.test(salesPage), true);
    is("the facts line takes the video total from the page", /videoLine/.test(facts), true);
    is("nothing typed: no duration field in the course record", /duration|minutes/i.test(readFileSync(join(root, "lib/course.ts"), "utf8").match(/export type Course = \{[\s\S]*?\n\};/)?.[0] ?? ""), false);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
