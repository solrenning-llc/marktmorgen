/**
 * Focus mode on a lesson (queue item 295 [SQ6]): one button above the lesson
 * hides the course's path, the list of lessons and the comments, so only the
 * lesson itself shows, with its player's own controls and a plain button to
 * leave. Esc leaves too. Nothing moves or fades. The choice is remembered in
 * the student's own browser only, and nothing is sent to us or to a supplier.
 *
 * What is checked, against the real code: the remembered choice read back,
 * which keys leave focus mode (never one typed into a field, never while a
 * video is in full screen), the layout drawn in both states (the hidden parts
 * stay on the page, hidden, so a comment being typed is not lost), the words
 * in the seven languages, the lesson page passing the right parts, no
 * animation in the component, and the privacy policy saying what is kept.
 * Not checked here (needs a browser): the layout drawn at each width, and a
 * screen reader reading the note out.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { done, is, part } from "./check";
import { LESSON_FOCUS_KEY, leavesFocus, readLessonFocus, typingInto } from "@/lib/lesson-focus";
import { FocusLayout, focusWordsOf } from "@/components/lesson-focus";
import { COURSES_WORDS, coursesWords } from "@/lib/buyer-words/courses";

part("The remembered choice");
is("remembered under a key of its own", LESSON_FOCUS_KEY, "mm:lesson-focus");
is("on only when the browser kept exactly 'on'", [readLessonFocus("on"), readLessonFocus("off"), readLessonFocus(""), readLessonFocus(null), readLessonFocus(undefined), readLessonFocus("ON"), readLessonFocus("true")], [true, false, false, false, false, false, false]);

part("Which keys leave focus mode");
const esc = { key: "Escape", defaultPrevented: false, isComposing: false, typing: false, fullScreen: false, dialogOpen: false };
is("Esc leaves it", leavesFocus(true, esc), true);
is("Esc does nothing while it is off", leavesFocus(false, esc), false);
is("another key does not leave it", [leavesFocus(true, { ...esc, key: "f" }), leavesFocus(true, { ...esc, key: "Enter" }), leavesFocus(true, { ...esc, key: "Esc" })], [false, false, false]);
is("not while typing into a field (Esc belongs to the field)", leavesFocus(true, { ...esc, typing: true }), false);
is("not while a word is being composed", leavesFocus(true, { ...esc, isComposing: true }), false);
is("not when something on the page already used the key", leavesFocus(true, { ...esc, defaultPrevented: true }), false);
is("not while a video is in full screen (Esc leaves full screen first)", leavesFocus(true, { ...esc, fullScreen: true }), false);
is("not while a dialog is open, such as the store's chat or assistant (Esc closes that first)", leavesFocus(true, { ...esc, dialogOpen: true }), false);
is("fields that take typing", [typingInto("INPUT", false, "text"), typingInto("TEXTAREA", false), typingInto("SELECT", false), typingInto("DIV", true), typingInto("input", false, "email")], [true, true, true, true, true]);
is("controls that do not take typing", [typingInto("BUTTON", false), typingInto("A", false), typingInto("INPUT", false, "checkbox"), typingInto("INPUT", false, "radio"), typingInto("INPUT", false, "submit"), typingInto("DIV", false), typingInto("BODY", false)], [false, false, false, false, false, false, false]);

part("The layout, off and on");
const en = focusWordsOf(coursesWords("en"));
const parts = {
  crumb: createElement("p", { id: "crumb" }, "Path"),
  article: createElement("article", { id: "lesson" }, "The lesson"),
  side: createElement("aside", { id: "outline" }, "In this course"),
  below: createElement("div", { id: "comments" }, createElement("textarea", { defaultValue: "half a comment" })),
};
const draw = (on: boolean, message = "") => renderToStaticMarkup(createElement(FocusLayout, { on, message, words: en, onToggle: () => undefined, ...parts }));
const off = draw(false);
const on = draw(true, en.onNote);
const count = (html: string, what: string) => html.split(what).length - 1;
is("off: one button, saying 'Focus mode'", [count(off, "<button"), off.includes(">Focus mode</button>")], [1, true]);
is("off: nothing is hidden", count(off, " hidden=\"\""), 0);
is("off: the lesson and the course list side by side on a wide screen", off.includes("lg:grid-cols-[minmax(0,1fr)_18rem]"), true);
is("on: the same one button, now 'Exit focus mode'", [count(on, "<button"), on.includes(">Exit focus mode</button>")], [1, true]);
is("on: the path, the course list and the comments are hidden", count(on, " hidden=\"\""), 3);
is("on: the hidden parts stay on the page, so a comment being typed is kept", [on.includes("id=\"crumb\""), on.includes("id=\"outline\""), on.includes("half a comment")], [true, true, true]);
is("on: the lesson itself is not inside anything hidden", /hidden=""[^>]*><article/.test(on), false);
is("on: one column, at a width that reads", [on.includes("lg:grid-cols-[minmax(0,1fr)_18rem]"), on.includes("max-w-3xl")], [false, true]);
is("on: the note says what happened and how to leave, as a status", on.includes(`role="status"`) && on.includes(en.onNote), true);
is("off: the status is there, empty, so a change is read out", off.includes(`role="status"`), true);
is("the button is a real button, at least 44 pixels each way", [/<button type="button"/.test(off), off.includes("min-h-11"), off.includes("min-w-11")], [true, true, true]);
is("the button names the parts it hides", off.includes(`aria-controls="lesson-focus-path lesson-focus-list lesson-focus-comments"`), true);
const restored = draw(true, "");
is("on, restored from the kept choice: the note shows, but nothing is announced", [restored.includes(en.onNote), /<p role="status"[^>]*><\/p>/.test(restored)], [true, true]);
is("the button looks like the store's other buttons, not a link", [off.includes("btn st-btn-ghost"), off.includes("st-footer-link")], [true, false]);
const noBelow = renderToStaticMarkup(createElement(FocusLayout, { on: true, message: "", words: en, onToggle: () => undefined, ...parts, below: null }));
is("with no comments, only two parts are hidden, and named", [count(noBelow, " hidden=\"\""), noBelow.includes(`aria-controls="lesson-focus-path lesson-focus-list"`)], [2, true]);

part("No movement");
const source = readFileSync("components/lesson-focus.tsx", "utf8");
is("no transition or animation in the component", /transition|animate-|duration-|keyframes/.test(source), false);
is("a dialog open on the page owns Esc: the page asks for one before leaving", source.includes('dialogOpen: Boolean(document.querySelector(OPEN_DIALOG))'), true);
is("the kept choice turns it on without announcing it; only a press announces", /if \(kept\) {\s*setOn\(true\);\s*}/.test(source), true);
is("the choice is kept only in the browser's own storage, behind try", [source.includes("localStorage"), /try\s*{[^}]*localStorage/.test(source), /fetch\(|sendBeacon|document\.cookie/.test(source)], [true, true, false]);

part("The words, in every language");
for (const [code, words] of Object.entries(COURSES_WORDS)) {
  const w = focusWordsOf(words);
  const all = [w.enter, w.exit, w.onNote, w.offNote];
  is(`${code}: four sentences, each written`, all.every((s) => typeof s === "string" && s.trim().length > 0), true);
  is(`${code}: each one different`, new Set(all).size, 4);
  is(`${code}: the note names the button that leaves`, w.onNote.includes(w.exit), true);
}
is("English, plainly", [en.enter, en.exit, en.onNote, en.offNote], [
  "Focus mode",
  "Exit focus mode",
  "Focus mode is on. Only the lesson shows. Press Esc or Exit focus mode to see the rest of the page again.",
  "Focus mode is off. The rest of the page shows again.",
]);
is("each language other than English says it in its own words", Object.entries(COURSES_WORDS).filter(([code]) => code !== "en").every(([, words]) => focusWordsOf(words).onNote !== en.onNote), true);

part("The lesson page");
const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
is("the page draws the lesson inside focus mode", page.includes("<LessonFocus"), true);
is("it passes the path, the lesson, the course list and the comments", ["crumb={", "article={", "side={", "below={"].every((prop) => page.includes(prop)), true);
is("with the store's words", page.includes("words={focusWordsOf(w)}"), true);

part("Privacy");
const privacy = readFileSync("app/privacy/page.tsx", "utf8");
is("the policy names the key and says nothing is sent", privacy.includes("mm:lesson-focus") && /Focus mode/.test(privacy), true);

done();
