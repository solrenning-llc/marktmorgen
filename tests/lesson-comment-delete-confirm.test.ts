/**
 * Deleting a lesson comment asks first (AX274; WCAG 3.3.4 AA, 3.3.6 AAA).
 *
 * Audit R21 finding B: "Delete" and "Delete with its answers" under a lesson
 * comment (components/lesson-comments.tsx) deleted on the first press, with no
 * question and no undo, while the store's community asks first with its own
 * words (lib/buyer-words/community.ts deleteCommentConfirm/deleteReplyConfirm).
 * Now the first press only opens a disclosure that says what will go and holds
 * the real "Delete"; pressing the first button again closes it and nothing is
 * sent. A plain details/summary: it works without a script, by keyboard and
 * with a screen reader (announced as expanded/collapsed), and makes no extra
 * request. What reaches the route (app/api/store/course/comment) is the same
 * post as before, so the route is unchanged.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LessonComments } from "@/components/lesson-comments";
import { CREATOR_AUTHOR, type Thread } from "@/lib/lesson-comments-rules";
import { communityWords } from "@/lib/buyer-words/community";
import { coursesWords } from "@/lib/buyer-words/courses";
import type { LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const MINE = "student-key";
const thread: Thread = {
  comment: { id: "aaaaaaaaaaaa", lesson: "l1", by: MINE, name: "Dana", text: "Question", at: 1, parent: null, hidden: false },
  replies: [{ id: "bbbbbbbbbbbb", lesson: "l1", by: MINE, name: "Dana", text: "Follow-up", at: 2, parent: "aaaaaaaaaaaa", hidden: false }],
};
const lone: Thread = {
  comment: { id: "cccccccccccc", lesson: "l1", by: "other-key", name: "Lee", text: "Thanks", at: 3, parent: null, hidden: false },
  replies: [],
};

function draw(reader: string, language: LanguageCode = "en"): string {
  return renderToStaticMarkup(createElement(LessonComments, {
    threads: [thread, lone], reader, storeName: "Shop", hidden: { handle: "shop", product: "c1", lesson: "l1" }, myName: "Dana", notice: "", now: 10, language,
  }));
}

/** The forms in some markup whose hidden action is `value`. */
function formsWithAction(html: string, value: string): string[] {
  return [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0]).filter((f) => f.includes(`name="action" value="${value}"`));
}
/** The closed disclosures (no `open`) holding a delete form: summary words, question, and the form. */
function deleteAsks(html: string): { summary: string; summaryTag: string; question: string; button: string; form: string }[] {
  return [...html.matchAll(/<details(?![^>]*\bopen\b)[^>]*>([\s\S]*?)<\/details>/g)]
    .map((m) => m[1])
    .filter((inner) => formsWithAction(inner, "delete").length === 1)
    .map((inner) => {
      const form = formsWithAction(inner, "delete")[0];
      return {
        summary: inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? "",
        summaryTag: inner.match(/<summary\b[^>]*>/)?.[0] ?? "",
        question: form.match(/role="group" aria-label="([^"]+)"/)?.[1] ?? "",
        button: form.match(/<button type="submit"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? "",
        form,
      };
    });
}
const unescape = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

async function main(): Promise<void> {
  const en = communityWords("en");
  const cw = coursesWords("en");

  part("A student's own comment and answer: the first press only asks");
  const student = draw(MINE);
  const studentDeletes = formsWithAction(student, "delete");
  is("the student has a delete form for the comment and for the answer", studentDeletes.length, 2);
  const asks = deleteAsks(student);
  is("every delete form sits in a closed disclosure (nothing is sent on the first press)", asks.length, studentDeletes.length);
  is("the comment's first button still says it takes the answers", asks[0]?.summary, cw.deleteWithAnswers);
  is("its question is the community's own words for a comment", unescape(asks[0]?.question ?? ""), en.deleteCommentConfirm);
  is("the question is also written out, not only a name", asks[0]?.form.includes(`>${asks[0]?.question}</p>`), true);
  is("only then does a plain \"Delete\" send it", asks[0]?.button, cw.delete);
  is("the answer's first button says \"Delete\"", asks[1]?.summary, cw.delete);
  is("its question is the community's words for a reply", unescape(asks[1]?.question ?? ""), en.deleteReplyConfirm);
  is("the post is the same as before: store, course, lesson, action and id", [
    /name="handle" value="shop"/.test(asks[0]?.form ?? ""),
    /name="product" value="c1"/.test(asks[0]?.form ?? ""),
    /name="lesson" value="l1"/.test(asks[0]?.form ?? ""),
    /name="id" value="aaaaaaaaaaaa"/.test(asks[0]?.form ?? ""),
    /action="\/api\/store\/course\/comment" method="post"/.test(asks[0]?.form ?? ""),
  ], [true, true, true, true, true]);
  is("a student sees no delete for someone else's comment", formsWithAction(student, "delete").some((f) => f.includes("cccccccccccc")), false);
  is("the button that sends is a 44 px target", /<button type="submit" class="[^"]*min-h-11/.test(asks[0]?.form ?? ""), true);
  // The lesson page is not inside [data-store-layout], so the store front's summary rule does not reach it: the
  // summary carries its own 44 px row (WCAG 2.5.5), by height and padding, and stays a list item (its triangle).
  is("every delete summary is a 44 px row of its own, and keeps its disclosure triangle", asks.map((a) => [
    /class="[^"]*\bmin-h-11\b/.test(a.summaryTag),
    /padding-block:calc\(\(2\.75rem - 1lh\) \/ 2\)/.test(a.summaryTag),
    /class="[^"]*\b(?:inline-)?flex\b/.test(a.summaryTag),
  ]), asks.map(() => [true, true, false]));

  part("The creator: hiding stays one press (it can be undone), deleting asks");
  const creator = draw(CREATOR_AUTHOR);
  const creatorAsks = deleteAsks(creator);
  is("the creator deletes three things, each behind a question", [formsWithAction(creator, "delete").length, creatorAsks.length], [3, 3]);
  is("a comment without answers says \"Delete\" and asks with the community's words", [creatorAsks[2]?.summary, unescape(creatorAsks[2]?.question ?? "")], [cw.delete, en.deleteCommentConfirm]);
  is("hide is still a plain form (it can be shown again)", formsWithAction(creator, "hide").length, 3);

  part("In the store's language");
  const es = deleteAsks(draw(MINE, "es"));
  is("Spanish: the question and the button", [unescape(es[0]?.question ?? ""), es[0]?.button], [communityWords("es").deleteCommentConfirm, coursesWords("es").delete]);

  part("No script needed, no extra request");
  const source = readFileSync("components/lesson-comments.tsx", "utf8");
  is("the component stays a server component (no \"use client\", no click handler, no window.confirm)", [/^"use client"/m.test(source), /onClick|window\.confirm/.test(source)], [false, false]);

  done();
}

void main();
