/**
 * The lesson text editor (components/course-editor.tsx, `loadText`): a read
 * of the lesson's saved text that did not come back in its exact shape is
 * never shown as an empty text (CX-123 rule 24, client side; the proof was
 * tests/c6-lesson-text-read.proof.ts).
 *
 * Before: a failed read opened the box EMPTY and counted the empty text as
 * saved, with no notice. "Save text" then sent the empty box as the whole
 * text, and the route (`action: "body"`) saved it over what was there, so the
 * lesson's original text was lost.
 *
 * Now: only `{ ok: true, text: <string> }` on a successful response opens the
 * box. Anything else leaves it closed (so there is no "Save text" to press),
 * says so in the studio's alert, and keeps "Edit the text" as the retry.
 */
import { readFileSync } from "node:fs";
import { compile, cutBlock, fetchAnswering, recorder } from "./client-handler";
import { done, is, part } from "./check";

const FILE = "components/course-editor.tsx";
const NOTICE = "The lesson's text could not be read just now, so it is not shown and nothing was changed. Try again in a moment.";

const make = compile<() => Promise<void>>(
  cutBlock(FILE, "async function loadText() {"),
  ["fetch", "productId", "lesson", "setLoadingText", "setText", "setSavedText", "onError"],
  "loadText",
);

function screen(answers: (typeof fetch)[]) {
  const text = recorder<string | null>();
  const saved = recorder<string | null>();
  const errors = recorder<string | null>();
  const loading = recorder<boolean>();
  let call = 0;
  const loadText = make({
    fetch: ((...args: Parameters<typeof fetch>) => answers[Math.min(call++, answers.length - 1)](...args)) as typeof fetch,
    productId: "p_synthetic",
    lesson: { id: "l1", hasBody: true },
    setLoadingText: loading.set,
    setText: text.set,
    setSavedText: saved.set,
    onError: errors.set,
  });
  return { loadText, text, saved, errors, loading };
}

const notices = (seen: (string | null)[]) => seen.filter((e) => typeof e === "string" && e.length > 0);

async function main() {
  part("A read that worked opens the box with the saved text (control, unchanged)");
  const read = screen([fetchAnswering({ ok: true, text: "Step 1. Mix the flour." })]);
  await read.loadText();
  is("the saved text is in the box", read.text.last, "Step 1. Mix the flour.");
  is("and counts as saved", read.saved.last, "Step 1. Mix the flour.");
  is("no notice is shown", notices(read.errors.seen), []);
  is("the button is busy while reading, then free", read.loading.seen, [true, false]);

  const blank = screen([fetchAnswering({ ok: true, text: "" })]);
  await blank.loadText();
  is("a lesson with no text yet (a confirmed empty text) opens an empty box", blank.text.last, "");
  is("and that empty text counts as saved", blank.saved.last, "");
  is("with no notice", notices(blank.errors.seen), []);

  for (const [what, answer] of [
    ["no connection", fetchAnswering(new TypeError("Failed to fetch"))],
    ["an error page that is not JSON", fetchAnswering("<html>502</html>", 502)],
    ["a refusal", fetchAnswering({ ok: false, error: "server_error" }, 500)],
    ["a refusal with a text in it", fetchAnswering({ ok: false, text: "" }, 200)],
    ["an answer with no text", fetchAnswering({ ok: true }, 200)],
    ["an answer whose text is not a string", fetchAnswering({ ok: true, text: 42 }, 200)],
    ["an answer of null", fetchAnswering(null, 200)],
    ["a failed response that says ok", fetchAnswering({ ok: true, text: "" }, 500)],
  ] as const) {
    part(`A read that did not come back in its exact shape (${what})`);
    const failed = screen([answer]);
    await failed.loadText();
    is(`${what}: the box is not opened (no text is put in it)`, failed.text.seen, []);
    is(`${what}: nothing counts as saved`, failed.saved.seen, []);
    is(`${what}: the creator is told, in the studio's words`, notices(failed.errors.seen), [NOTICE]);
    is(`${what}: the button is free again, to try again`, failed.loading.last, false);
  }

  part("Trying again after a failed read");
  const again = screen([fetchAnswering(new TypeError("Failed to fetch")), fetchAnswering({ ok: true, text: "Step 1. Mix the flour." })]);
  await again.loadText();
  is("the first read shows the notice", again.errors.last, NOTICE);
  await again.loadText();
  is("a second read that works opens the box with the saved text", again.text.last, "Step 1. Mix the flour.");
  is("and counts it as saved", again.saved.last, "Step 1. Mix the flour.");
  is("and takes the notice away", again.errors.last, null);

  part("Why the box must stay closed: Save text sends it as the whole text");
  const source = readFileSync(FILE, "utf8");
  const save = source.indexOf('run({ action: "body", lessonId: lesson.id, text })');
  is("Save text sends the box as the whole new text", save > 0, true);
  const closed = source.lastIndexOf("{text === null ? (", save);
  is("and is drawn only once a text was read (the box is closed while text is null)", closed > 0 && source.slice(closed, save).includes("Edit the text"), true);
  const route = readFileSync("app/api/store/course/route.ts", "utf8");
  is("the route saves it over what was there, with no check of what was read", /if \(action === "body"\) \{[\s\S]{0,300}await saveBody\(course\.id, lessonId, cleaned, store\);/.test(route), true);

  done();
}

void main();
