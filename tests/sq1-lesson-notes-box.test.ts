/**
 * The box on the lesson page (components/lesson-notes.tsx), held to Claude 2's
 * second review of #3031 (comment 6702645688): its real code run under a
 * minimal hook runtime (useState, useRef, useEffect re-render on every set, as
 * React does; the handler keeps the closure of the render it was called
 * from). No browser: the leave guard is recorded, fetch is held by the test.
 * The harness is Claude 2's proof 3, kept as written.
 *
 *   M2  what is typed while a save is on its way stays in the box, and
 *       leaving the page stays guarded until it is saved;
 *   L5  a refusal that trying again cannot help (closed) says what to do;
 *   L6  deleting a whole note offers to undo it;
 *   L7  the count is not spoken before the student types;
 *   N3  on the ended course's page (components/lesson-notes-kept.tsx), focus
 *       never falls to the page while the course's notes are being deleted
 *       (Claude 6's LEVE N3 on #3031, comment 6732128148).
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, transpileModule } from "typescript";
import * as rules from "@/lib/lesson-notes-rules";
import * as words from "@/lib/buyer-words/lesson-notes";
import { done, is, part } from "./check";

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const compiled = transpileModule(readFileSync("components/lesson-notes.tsx", "utf8"), {
  compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
}).outputText;
const en = words.lessonNotesWords("en");

function mount(initial: unknown) {
  const slots: unknown[] = [];
  let at = 0;
  let pending: (() => void)[] = [];
  const guard: boolean[] = [];
  const timers: (() => void)[] = [];
  const posted: unknown[] = [];
  let answer: ((r: { status: number; json: () => Promise<unknown> }) => void) | null = null;
  const storage: string[] = [];
  const exports: { LessonNotes?: (props: unknown) => El } = {};
  const react = {
    useState(init: unknown) {
      const k = at++;
      if (!(k in slots)) slots[k] = init;
      return [slots[k], (next: unknown) => { slots[k] = typeof next === "function" ? (next as (v: unknown) => unknown)(slots[k]) : next; render(); }];
    },
    useRef(init: unknown) {
      const k = at++;
      if (!(k in slots)) slots[k] = { current: init };
      return slots[k];
    },
    useEffect(fn: () => unknown, deps: unknown[]) {
      const k = at++;
      const prev = slots[k] as { deps: unknown[]; cleanup?: unknown } | undefined;
      if (!prev || deps.some((d, j) => !Object.is(d, prev.deps[j]))) pending.push(() => {
        if (typeof prev?.cleanup === "function") (prev.cleanup as () => void)();
        slots[k] = { deps, cleanup: fn() };
      });
    },
  };
  runInNewContext(compiled, {
    exports,
    setTimeout: (f: () => void) => { timers.push(f); return timers.length; },
    clearTimeout: () => undefined,
    localStorage: { setItem: (k: string) => storage.push(k), getItem: () => null, removeItem: () => undefined },
    sessionStorage: { setItem: (k: string) => storage.push(k), getItem: () => null, removeItem: () => undefined },
    fetch: (_url: string, init: { body: string }) => {
      posted.push(JSON.parse(init.body));
      return new Promise((resolve) => { answer = resolve; });
    },
    require: (name: string) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") { const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props }); return { jsx, jsxs: jsx, Fragment: "fragment" }; }
      if (name === "@/lib/lesson-notes-rules") return rules;
      if (name === "@/lib/buyer-words/lesson-notes") return words;
      if (name === "@/components/leave-guard") return { useLeaveGuard: (on: boolean) => guard.push(on) };
      throw Error("Unexpected dependency " + name);
    },
  });
  let tree: El;
  function render() {
    at = 0;
    pending = [];
    tree = exports.LessonNotes!({ initial, where: { handle: "shop", product: "prod", lesson: "lessonone001" }, language: "en" });
    for (const run of pending) run();
  }
  render();
  const all = (node: unknown, out: El[] = []): El[] => {
    if (Array.isArray(node)) node.forEach((n) => all(n, out));
    else if (node && typeof node === "object" && "props" in node) { out.push(node as El); all((node as El).props.children, out); }
    return out;
  };
  const text = (node: unknown): string => Array.isArray(node) ? node.map(text).join("") : typeof node === "string" ? node : node && typeof node === "object" && "props" in node ? text((node as El).props.children) : "";
  return {
    guard, timers, posted, storage,
    find: (type: string) => all(tree).filter((e) => e.type === type),
    status: () => text(all(tree).find((e) => e.props.role === "status")?.props.children),
    live: () => text(all(tree).find((e) => e.props["aria-live"] === "polite")?.props.children),
    type(value: string) { (all(tree).find((e) => e.type === "textarea")!.props.onChange as (e: unknown) => void)({ target: { value } }); },
    value: () => all(tree).find((e) => e.type === "textarea")?.props.value,
    submit: () => (all(tree).find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {} }),
    answer: (status: number, body: unknown) => answer!({ status, json: async () => body }),
    all: () => all(tree),
  };
}

async function main() {
  part("Control: an ordinary save, nothing typed meanwhile");
  {
    const box = mount({ state: "none" });
    box.type("Proof twice.");
    const saving = box.submit();
    box.answer(200, { ok: true, text: "Proof twice." });
    await saving;
    is("control: the box keeps the saved words and says saved", [box.value(), box.status(), box.guard.at(-1)], ["Proof twice.", en.saved, false]);
  }

  part("Typing while a save is on its way");
  {
    const box = mount({ state: "none" });
    box.type("Step one: proof the dough.");
    const saving = box.submit();
    // The student keeps typing; the box is not disabled while it saves.
    box.type("Step one: proof the dough.\nStep two: shape it, typed while the first save was on its way.");
    is("while the save is on its way and the box holds unsaved words, leaving the page is still guarded", box.guard.at(-1), true);
    box.answer(200, { ok: true, text: "Step one: proof the dough." });
    await saving;
    is("what was typed during the save is still in the box after it answers", box.value(), "Step one: proof the dough.\nStep two: shape it, typed while the first save was on its way.");
    is("and leaving is still guarded, since it is not saved", box.guard.at(-1), true);
    is("and the status does not say the notes are saved, while the newer words are not", box.status() !== en.saved, true);
    is("the next save starts from what the server kept", (() => {
      void box.submit();
      return (box.posted.at(-1) as { was: string }).was;
    })(), "Step one: proof the dough.");
  }

  part("Emptying a note deletes it with no question and no way back (AX274 3.3.6, VR 4)");
  {
    const box = mount({ state: "kept", text: "Three pages of what the teacher said about lamination." });
    box.type("");
    const saving = box.submit();
    is("an empty box sent for deletion at once", (box.posted[0] as { text: string }).text, "");
    box.answer(200, { ok: true, text: "" });
    await saving;
    is("status says it was deleted", box.status(), en.cleared);
    const controls = box.all().filter((e) => e.type === "button" || (e.type === "a" && !("download" in e.props)));
    is("after deleting a whole note, the page offers a way to undo it (a control other than Save and the download)", controls.length > 1, true);
    const undo = controls.find((e) => e.type === "button" && e.props.type !== "submit");
    const back = undo ? (undo.props.onClick as () => Promise<void>)() : Promise.resolve();
    is("undo saves the deleted words again, as a new note", box.posted.at(-1), { handle: "shop", product: "prod", lesson: "lessonone001", text: "Three pages of what the teacher said about lamination.", was: "" });
    if (undo) box.answer(200, { ok: true, text: "Three pages of what the teacher said about lamination." });
    await back;
    is("and the box holds them again, saved", [box.value(), box.status()], ["Three pages of what the teacher said about lamination.", en.saved]);
  }

  part("The count is not spoken unasked");
  {
    const box = mount({ state: "kept", text: "Short." });
    for (const run of box.timers.splice(0)) run();
    is("a screen reader is told nothing on load, before the student types", box.live(), "");
    box.type("Short, then more.");
    for (const run of box.timers.splice(0)) run();
    is("once they type and pause, the count is said", box.live(), en.count(17, 4_000));
  }

  part("A lesson the server refuses (signed out, closed, held by a quiz)");
  {
    const box = mount({ state: "none" });
    box.type("A note.");
    const saving = box.submit();
    box.answer(403, { ok: false, error: "closed" });
    await saving;
    is("the student is not told to try again in a minute when retrying cannot help", box.status() !== en.failed, true);
    is("and what they wrote stays in the box", box.value(), "A note.");
  }

  part("Third review of #3031, L2: Undo leaves focus in the box, not on the page");
  {
    const box = mount({ state: "kept", text: "Lamination notes." });
    let focused = 0;
    const area = box.find("textarea")[0];
    const ref = area?.props.ref as { current: unknown } | undefined;
    if (ref && typeof ref === "object") ref.current = { focus: () => { focused++; } };
    box.type("");
    const saving = box.submit();
    box.answer(200, { ok: true, text: "" });
    await saving;
    const undo = box.find("button").find((e) => e.props.type !== "submit");
    const back = undo ? (undo.props.onClick as () => Promise<void>)() : Promise.resolve();
    if (undo) box.answer(200, { ok: true, text: "Lamination notes." });
    await back;
    is("the box has a ref the page can focus", Boolean(ref && typeof ref === "object" && "current" in ref), true);
    is("after Undo, whose button goes away, focus is moved to the box", focused > 0, true);
  }
}

/** components/lesson-notes-kept.tsx under the same minimal hook runtime: which of its refs was focused, in order. */
async function keptFocus(): Promise<void> {
  part("N3: focus never falls to the page while the course's notes are deleted");
  const code = transpileModule(readFileSync("components/lesson-notes-kept.tsx", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  const slots: unknown[] = [];
  const focused: number[] = [];
  let at = 0;
  let pending: (() => void)[] = [];
  let answer: ((r: { json: () => Promise<unknown> }) => void) | null = null;
  const exports: { LessonNotesKept?: (props: unknown) => El } = {};
  const react = {
    useState(init: unknown) {
      const k = at++;
      if (!(k in slots)) slots[k] = init;
      return [slots[k], (next: unknown) => { slots[k] = next; render(); }];
    },
    // An element's ref (null at first) stands for the element: focusing it is recorded by its hook's place.
    useRef(init: unknown) {
      const k = at++;
      if (!(k in slots)) slots[k] = { current: init === null ? { focus: () => focused.push(k) } : init };
      return slots[k];
    },
    useEffect(fn: () => unknown, deps: unknown[]) {
      const k = at++;
      const prev = slots[k] as { deps: unknown[] } | undefined;
      if (!prev || deps.some((d, j) => !Object.is(d, prev.deps[j]))) pending.push(() => { slots[k] = { deps }; fn(); });
    },
  };
  runInNewContext(code, {
    exports,
    fetch: () => new Promise((resolve) => { answer = resolve; }),
    require: (name: string) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") { const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props }); return { jsx, jsxs: jsx, Fragment: "fragment" }; }
      if (name === "@/lib/buyer-words/lesson-notes") return words;
      throw Error("Unexpected dependency " + name);
    },
  });
  let tree!: El;
  function render() {
    at = 0;
    pending = [];
    tree = exports.LessonNotesKept!({ handle: "shop", product: "prod", language: "en" });
    for (const run of pending) run();
  }
  render();
  const all = (node: unknown, out: El[] = []): El[] => {
    if (Array.isArray(node)) node.forEach((n) => all(n, out));
    else if (node && typeof node === "object" && "props" in node) { out.push(node as El); all((node as El).props.children, out); }
    return out;
  };
  const text = (node: unknown): string => Array.isArray(node) ? node.map(text).join("") : typeof node === "string" ? node : node && typeof node === "object" && "props" in node ? text((node as El).props.children) : "";
  const button = (said: string) => all(tree).find((e) => e.type === "button" && text(e.props.children) === said);
  const status = all(tree).find((e) => e.props.role === "status");
  const statusRef = status?.props.ref as { current: { focus: () => void } } | undefined;
  const placeOf = (ref: unknown) => slots.indexOf(ref);
  (button(en.clearAll)!.props.onClick as () => void)();
  const keepRef = button(en.clearNo)?.props.ref;
  is("setup: asking moves focus to keeping the notes", focused.at(-1), placeOf(keepRef));
  const yes = button(en.clearYes);
  const deleting = (yes!.props.onClick as () => Promise<void>)();
  is("while deleting, the question (and the focused button) is gone", [button(en.clearYes), text(all(tree).find((e) => e.props.role === "status")?.props.children)], [undefined, en.clearing]);
  is("and focus is on the status that says Deleting…, not on the page", focused.at(-1), placeOf(statusRef));
  answer!({ json: async () => ({ ok: true }) });
  await deleting;
  is("once deleted, focus stays on the status that says so", [focused.at(-1), text(all(tree).find((e) => e.props.role === "status")?.props.children)], [placeOf(statusRef), en.clearedAll]);
}

main().then(keptFocus).then(done);
