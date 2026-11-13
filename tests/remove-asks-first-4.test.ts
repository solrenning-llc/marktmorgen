/**
 * AX274, WCAG 3.3.6 Error Prevention (All) at AAA, in the course editor: a lesson's
 * video, one of its downloads and a language of captions were removed on the first
 * press, with no question and no undo. Each is a file kept on our side: putting a
 * video or a download back means finding it and uploading it again, and captions
 * written by AI are paid for by the minute, so removing them by mistake costs the
 * creator money to write again.
 *
 * Each now goes through ConfirmAction (components/confirm-action.tsx), as in
 * tests/remove-asks-first*.test.ts: the first press says what goes, only the
 * "Yes, remove" button does it, and "Keep it", focused, leaves it as it was.
 * An empty module (nothing in it but its name) and a cohort's start date (typed
 * again in a second) are left as they are.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const text = readFileSync("components/course-editor.tsx", "utf8");

part("A lesson's video, its downloads and its captions ask before they are removed");
is("the video's first press no longer removes it", /<button[\s\S]{0,200}?onClick=\{async \(\) => \{\s*const answer = await run\(\{ action: "edit", op: "media-remove", lessonId: lesson\.id, pathname: lesson\.video!\.pathname/.test(text), false);
is("a download's first press no longer removes it", /<button[\s\S]{0,200}?onClick=\{async \(\) => \{\s*const answer = await run\(\{ action: "edit", op: "media-remove", lessonId: lesson\.id, pathname: file\.pathname/.test(text), false);
is("captions' first press no longer removes them", /<button[\s\S]{0,260}?onClick=\{\(\) => send\(\{ action: "remove", lang: track\.lang \}/.test(text), false);
for (const question of ["Remove this video?", "Remove this download?", "Remove these captions?"]) {
  is(`asks "${question}", through ConfirmAction`, text.includes(question), true);
}
is("each says yes as \"Yes, remove\"", (text.match(/yes="Yes, remove"/g) ?? []).length >= 3, true);
is("imports the shared ConfirmAction", /import \{ ConfirmAction \} from "@\/components\/confirm-action";/.test(text), true);
done();
