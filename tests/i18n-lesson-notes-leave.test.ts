/**
 * A student's notes on a lesson (components/lesson-notes.tsx) are in the
 * store's language, and leaving the lesson with notes not yet saved asks
 * first (components/leave-guard.ts). That question was always English:
 * a student of a German store, following a link to the next lesson with an
 * unsaved note, was asked "You have changes that are not saved. Leave
 * without saving them?". It is asked in the store's language now; English
 * stays word for word as it was, and the studio's editors keep it.
 *
 * The component's real code runs under tests/client-hooks.ts; the browser's
 * window, document and confirm are synthetic stand-ins. Nothing is sent.
 */
import { LessonNotes } from "@/components/lesson-notes";
import { LESSON_NOTES_WORDS } from "@/lib/buyer-words/lesson-notes";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { find, mount } from "./client-hooks";
import { done, is, part } from "./check";

const ENGLISH_ASK = "You have changes that are not saved. Leave without saving them?";
const ORIGIN = "https://marktmorgen.com";
const HERE = `${ORIGIN}/@kueche/course/brot/lesson-1`;

type Listener = (event: unknown) => void;
const clickListeners: Listener[] = [];
const asked: string[] = [];

class FakeElement {}
const g = globalThis as Record<string, unknown>;
g.Element = FakeElement;
g.window = {
  location: { href: HERE, origin: ORIGIN, pathname: "/@kueche/course/brot/lesson-1", search: "" },
  addEventListener: () => {},
  removeEventListener: () => {},
  confirm: (question: string) => {
    asked.push(question);
    return false;
  },
  setTimeout,
  clearTimeout,
};
g.document = {
  addEventListener: (type: string, listener: Listener) => {
    if (type === "click") clickListeners.push(listener);
  },
  removeEventListener: (type: string, listener: Listener) => {
    const at = clickListeners.indexOf(listener);
    if (type === "click" && at >= 0) clickListeners.splice(at, 1);
  },
};

/** A click on a link to the next lesson, inside the store. */
function clickNextLesson(): void {
  const link = { href: `${ORIGIN}/@kueche/course/brot/lesson-2`, target: "", hasAttribute: () => false };
  const target = Object.assign(new FakeElement(), { closest: () => link });
  const event = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target, preventDefault() {}, stopPropagation() {} };
  for (const listener of [...clickListeners]) listener(event);
}

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

async function askedIn(language: LanguageCode): Promise<string | undefined> {
  asked.length = 0;
  const box = await mount(LessonNotes as never, { initial: { state: "kept", text: "Mehl" }, where: { handle: "kueche", product: "brot", lesson: "lesson-1" }, language } as never);
  const area = find(box.tree(), (n: Node) => n.type === "textarea")[0] as Node | undefined;
  (area?.props?.onChange as ((e: unknown) => void) | undefined)?.({ target: { value: "Mehl und Wasser" } });
  await box.settle();
  clickNextLesson();
  box.unmount();
  return asked[0];
}

async function main(): Promise<void> {
  part("English: the question is word for word as it was (control)");
  is("asked once, in English", await askedIn("en"), ENGLISH_ASK);

  part("Every other language of the store asks in that language");
  for (const code of LANGUAGE_CODES) {
    if (code === "en") continue;
    const question = await askedIn(code);
    is(`${code}: a question is asked before leaving unsaved notes`, typeof question === "string" && question.length > 0, true);
    is(`${code}: it is not the English one`, question === ENGLISH_ASK, false);
    is(`${code}: it is this language's own words for it`, question, (LESSON_NOTES_WORDS[code] as Record<string, unknown>).leaveAsk);
  }
  done();
}

void main();
