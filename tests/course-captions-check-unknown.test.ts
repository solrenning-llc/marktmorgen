/**
 * Rule 24 on the studio's course page (VR item 2): "Can everyone follow your lessons?". When the lesson videos'
 * captions, or the AI captions being written, cannot be read, the check does not say that every video has no
 * captions (which points the creator at paid AI captions for videos that may already have them): it says it could
 * not check. lib/auto-captions.ts autoWriting reads each record exactly. Known readings are unchanged (controls).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { autoWriting } from "@/lib/auto-captions";
import { lessonCaptionCheck } from "@/lib/course-access-check";
import { UnknownReplyError } from "@/lib/redis-reply";
import { streamPath } from "@/lib/stream-rules";
import { CourseAccessCheck } from "@/components/course-access-check";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "d".repeat(32);
const VIDEO = "4b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const PATH = streamPath(FOLDER, "lesson000001", VIDEO);
const course = { id: "course1", modules: [{ title: "One", lessons: [{ id: "lesson000001", title: "Welcome", video: { pathname: PATH } }] }] } as never;
const UNREAD = /We could not check your lesson videos for captions just now\. Reload the page in a minute to try again\./;
/** Rendered check, or "crash" where the check itself throws on an unread argument (as on main before the fix). */
const render = (make: () => ReturnType<typeof lessonCaptionCheck>) => {
  try {
    const check = make();
    return renderToStaticMarkup(createElement(CourseAccessCheck, { check, productId: "p1", hrefOf: (id: string) => `/studio/course/p1?lesson=${id}`, canWrite: true, canReupload: true }));
  } catch {
    return "crash";
  }
};
const thrown = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "answered";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "other";
  }
};

async function main(): Promise<void> {
  part("the check, with captions or AI writing unread");
  const states = { [PATH]: "ready" as const };
  const unreadCaptions = render(() => lessonCaptionCheck(course, states, null as never, {}));
  is("unread captions: said in words", UNREAD.test(unreadCaptions), true);
  is("unread captions: never 'has no captions'", /has no captions|have no captions/.test(unreadCaptions), false);
  is("unread captions: no link to add captions", /Add captions to/.test(unreadCaptions), false);
  const unreadWriting = render(() => lessonCaptionCheck(course, states, {}, null as never));
  is("unread AI writing: said in words, never 'has no captions'", UNREAD.test(unreadWriting) && !/has no captions/.test(unreadWriting), true);
  const missing = render(() => lessonCaptionCheck(course, states, {}, {}));
  is("control: known none says 1 lesson video has no captions", /1 lesson video has no captions/.test(missing) && !UNREAD.test(missing), true);
  const all = render(() => lessonCaptionCheck(course, states, { [PATH]: [{ lang: "en", label: "English" }] } as never, {}));
  is("control: known captions says every video has them", /Every lesson video has captions\./.test(all) && !UNREAD.test(all), true);

  part("captions being written, read exactly");
  const pending = (langs: string[]) => JSON.stringify({ langs, got: [], at: 1_000, cents: 3500, pi: "pi_Captions000010", path: PATH });
  redis.run(["SET", `nl:stream:auto:${VIDEO}`, pending(["es"]), "EX", 3600]);
  is("control: a readable request is listed", await autoWriting([PATH]), { [PATH]: ["es"] });
  redis.run(["SET", `nl:stream:auto:${VIDEO}`, "{not json", "EX", 3600]);
  is("a request that is there but does not read is unknown, never 'not being written'", await thrown(() => autoWriting([PATH])), "unknown");
  redis.run(["DEL", `nl:stream:auto:${VIDEO}`]);
  is("control: no request is nothing being written", await autoWriting([PATH]), {});

  const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  is("the page never reads unknown captions as none", /streamCaptions\(videoPaths\)\.catch\(\(\) => null\)/.test(page) && !/streamCaptions\(videoPaths\)\.catch\(\(\) => \(\{\}\)\)/.test(page), true);
  is("the page never reads unknown AI writing as none", /autoWriting\(videoPaths\)\.catch\(\(\) => null\)/.test(page) && !/autoWriting\(videoPaths\)\.catch\(\(\) => \(\{\}\)\)/.test(page), true);

  done();
}

void main();
