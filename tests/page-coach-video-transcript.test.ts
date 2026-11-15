/**
 * AX274 Part A item 6 (ATAG 2.0 Part B: the studio helps the creator make accessible content, and never changes it
 * without their approval), for the videos on a sales page: WCAG 1.2.2 Captions, and 1.2.8 Media Alternative (AAA).
 *
 * A page's videos are kept at YouTube, Vimeo or Loom (lib/sales-page.ts, Video). Marktmorgen cannot add captions there
 * or know whether they are on, and an unknown is never called fine, so the coach asks the creator to turn captions on
 * where the video is kept and to put what is said and shown in a transcript right under it: a "text" block headed
 * "Transcript". A video counts as answered only when that transcript has words. The fix offered adds the empty
 * transcript block under the video, opened for the creator to write; nothing is written for them, and nothing is
 * saved until they save. The course editor's caption check (lib/course-access-check.ts) is the model.
 *
 * What fails here: a page with a video and no such check; a video with a transcript left unanswered; an empty
 * transcript counted as done; a page with no video asked about videos; the hero's video, a video block or a video in
 * a row's column left out; the fix pointing at the wrong block.
 */
import { coachChecks, type CoachInput } from "@/lib/page-coach";
import { TRANSCRIPT_HEADING, pageVideos } from "@/lib/page-video-check";
import type { PageBlock, Video } from "@/lib/sales-page";
import { done, is, part } from "./check";

const yt: Video = { provider: "youtube", id: "dQw4w9WgXcQ", hash: "" };
const loom: Video = { provider: "loom", id: "0123456789abcdef0123456789abcdef", hash: "" };
const hero = (video: Video | null): PageBlock => ({ id: "hero0001", kind: "hero", headline: "Bread basics", sub: "", media: video ? "video" : "picture", video });
const videoBlock = (id: string, heading: string, video: Video): PageBlock => ({ id, kind: "video", heading, video, caption: "" });
const text = (id: string, heading: string, body: string): PageBlock => ({ id, kind: "text", heading, body });
const row = (id: string): PageBlock => ({ id, kind: "row", columns: [[{ kind: "video-window", video: loom, title: "A tour", label: "Watch the tour" }], [{ kind: "paragraph", text: "Words" } as never]] });

const input = (blocks: PageBlock[]): CoachInput => ({ page: { blocks, seoDescription: "", test: null }, productTitle: "Bread basics", free: false, picture: false, pictureAlt: "", facts: {} });
const check = (blocks: PageBlock[]) => coachChecks(input(blocks)).find((c) => c.id === "video_alternatives");

part("A page with no video is not asked about videos");
is("no video: no such check", check([hero(null), text("text0001", "Why", "Because.")]), undefined);

part("Every video is found, wherever it sits");
const page = [hero(yt), videoBlock("vide0001", "See it made", yt), row("row00001"), text("text0001", "Why", "Because.")];
is("the hero's video, a video block and a video in a row's column", pageVideos(page).map((v) => [v.blockId, v.provider, v.transcript]), [["hero0001", "youtube", "none"], ["vide0001", "youtube", "none"], ["row00001", "loom", "none"]]);
is("the check is asked, and not done", [check(page)?.done, check(page)?.label], [false, "Every video has captions and a transcript (3 have no transcript)"]);
is("why: captions where the video is kept, and a transcript under it", /captions/i.test(check(page)?.why ?? "") && /transcript/i.test(check(page)?.why ?? "") && /YouTube, Vimeo or Loom/.test(check(page)?.why ?? ""), true);
is("the fix points under the first video with no transcript", check(page)?.transcriptFor, "hero0001");

part("A transcript counts only with words in it");
const empty = [videoBlock("vide0001", "See it made", yt), text("text0001", TRANSCRIPT_HEADING, "")];
is("an empty transcript under the video: seen, not done, and no second one offered", [pageVideos(empty)[0].transcript, check(empty)?.done, check(empty)?.transcriptFor, check(empty)?.label], ["empty", false, undefined, "Every video has captions and a transcript (1 transcript is empty)"]);
const written = [videoBlock("vide0001", "See it made", yt), text("text0001", "Transcript of the video", "We mix the flour and the water, then wait an hour.")];
is("a written transcript right under it: done", [pageVideos(written)[0].transcript, check(written)?.done, check(written)?.label], ["written", true, "Every video has captions and a transcript"]);
const apart = [videoBlock("vide0001", "See it made", yt), text("text0002", "Why", "Because."), text("text0001", TRANSCRIPT_HEADING, "Words.")];
is("a transcript further down is not this video's", pageVideos(apart)[0].transcript, "none");

done();
