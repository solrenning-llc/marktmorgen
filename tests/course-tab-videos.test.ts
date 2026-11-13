/**
 * Issue #4304, unit B (shape decided by the coordinator, 13/11/2026): the lessons tab of the studio's course page
 * no longer reads every lesson video's state, captions and AI captions on each load (3 commands a video, up to
 * MAX_LESSONS videos). The editor reads one lesson's video when that lesson is opened, in a request of its own;
 * the captions check moves to a Videos tab that reads VIDEO_BLOCK lessons at a time.
 *
 * Against the Redis stand-in and the source; nothing real is reached.
 */
import { readFileSync } from "node:fs";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { VIDEO_BLOCK, videosTab } from "@/lib/studio-course-tabs";
import { MAX_LESSONS, type Course } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const realPipeline = redis.pipeline.bind(redis);
const COMMANDS = STUDIO_PAGE_UNITS * 20 - 8;

const course = {
  id: "c".repeat(32),
  certificate: false,
  startsAt: null,
  modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: Array.from({ length: MAX_LESSONS }, (_, i) => ({ id: `lesson${String(i).padStart(6, "0")}`, title: `L${i}`, preview: false, video: { pathname: `stream/${"a".repeat(32)}/lesson${String(i).padStart(6, "0")}/${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`, name: "v.mp4", bytes: 1 }, files: [], link: null, hasBody: false, quiz: null })) }],
} as unknown as Course;

async function main(): Promise<void> {
  part("The Videos tab reads a block of lessons, never every video");
  let commands = 0;
  redis.pipeline = async (batch: Commands) => {
    commands += batch.length;
    return realPipeline(batch);
  };
  const first = await videosTab(course, 1);
  const firstCommands = commands;
  commands = 0;
  const last = await videosTab(course, 999);
  redis.pipeline = realPipeline;
  is(`a block within ${COMMANDS} commands, at ${MAX_LESSONS} videos`, firstCommands <= COMMANDS && commands <= COMMANDS, true);
  is("it says which lessons of how many it checked", [first?.from, first?.to, first?.total], [1, VIDEO_BLOCK, MAX_LESSONS]);
  is("past the last block: the last one", [last?.to, last?.total], [MAX_LESSONS, MAX_LESSONS]);

  part("The lessons tab reads no video's state; the editor asks for one lesson's when it is opened");
  const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  is("no streamStates on the lessons tab", /onCourse \? await streamStates/.test(page), false);
  is("the Videos tab is its own address", page.includes('["videos", "Videos"]'), true);
  const route = readFileSync("app/api/store/course/route.ts", "utf8");
  is("the course route answers one lesson's video", /searchParams\.get\("video"\) === "1"/.test(route), true);
  const editor = readFileSync("components/course-editor.tsx", "utf8");
  is("the editor never says a state it has not read", editor.includes('streams.states[lesson.video.pathname] ?? "working"'), false);
  is("it says it is checking, in a live region", editor.includes("Checking this lesson&apos;s video") || editor.includes("Checking this lesson's video"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
