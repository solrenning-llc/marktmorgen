/**
 * Claude 6 sweep of components/ (CX-123 rule 24, client side): the lesson
 * text editor in components/course-editor.tsx.
 *
 * "Edit the text" reads the lesson's saved text before opening the box. When
 * that read fails (no connection, an error page, `{ ok: false }`), the box
 * opens EMPTY and the empty text counts as already saved, so nothing says
 * anything went wrong. A creator who sees an empty box writes the lesson again
 * and presses "Save text", and the route (`action: "body"`) replaces the saved
 * text with no check of what was read: the original lesson text is lost.
 *
 * The checks below say what an honest screen does: a failed read leaves the
 * box closed and says so. They fail on the current code.
 */
import { readFileSync } from "node:fs";
import { compile, cutBlock, fetchAnswering, recorder } from "./client-handler";
import { done, is, part } from "./check";

const FILE = "components/course-editor.tsx";
const make = compile<() => Promise<void>>(
  cutBlock(FILE, "async function loadText() {"),
  ["fetch", "productId", "lesson", "setLoadingText", "setText", "setSavedText", "onError"],
  "loadText",
);

async function open(answer: typeof fetch) {
  const text = recorder<string | null>();
  const saved = recorder<string | null>();
  const errors = recorder<string | null>();
  const loadText = make({
    fetch: answer,
    productId: "p_synthetic",
    lesson: { id: "l1", hasBody: true },
    setLoadingText: () => {},
    setText: text.set,
    setSavedText: saved.set,
    onError: errors.set,
  });
  await loadText();
  return { text: text.last ?? null, saved: saved.last ?? null, error: errors.seen.find((e) => typeof e === "string" && e.length > 0) ?? null };
}

async function main() {
  part("A read that worked opens the box with the saved text (control)");
  const read = await open(fetchAnswering({ ok: true, text: "Step 1. Mix the flour." }));
  is("the saved text is in the box", read.text, "Step 1. Mix the flour.");
  is("and counts as saved", read.saved, "Step 1. Mix the flour.");
  const blank = await open(fetchAnswering({ ok: true, text: "" }));
  is("a lesson with no text yet opens an empty box", blank.text, "");

  for (const [what, answer] of [
    ["no connection", fetchAnswering(new TypeError("Failed to fetch"))],
    ["an error page that is not JSON", fetchAnswering("<html>502</html>", 502)],
    ["a refusal", fetchAnswering({ ok: false, error: "server_error" }, 500)],
  ] as const) {
    part(`A read that failed (${what})`);
    const failed = await open(answer);
    is(`${what}: the box is not opened empty over the saved text`, failed.text, null);
    is(`${what}: the creator is told the text could not be read`, failed.error !== null, true);
  }

  part("Why an empty box loses work");
  const source = readFileSync(FILE, "utf8");
  is("Save text sends the box as the whole new text", source.includes('run({ action: "body", lessonId: lesson.id, text })'), true);
  const route = readFileSync("app/api/store/course/route.ts", "utf8");
  is("and the route saves it over what was there, with no check of what was read", /if \(action === "body"\) \{[\s\S]{0,300}await saveBody\(course\.id, lessonId, cleaned, store\);/.test(route), true);

  done();
}

void main();
