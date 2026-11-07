/**
 * 290 [SQ1], the independent reviews of #3031: Codex J (review 5808597778)
 * and Claude 2 (comment 6702645688). Each part reproduces one finding with
 * the real code on the in-memory Redis; only the moment two requests meet,
 * or the moment an erasure runs, is chosen by the test.
 *
 *   J1  two saves started from the same note: at most one is acknowledged,
 *       and the kept note is the acknowledged one;
 *   J2  the 300-note bound holds when two new notes race for the last place;
 *   J3  a course's download admits what it reads (every note of the course
 *       at its worst) before it reads it, from the store's public requests;
 *   C2-2 words typed while a save is on its way are kept, and leaving stays
 *       guarded until they are saved;
 *   C2-3 an erasure that runs while a save is in flight leaves no note;
 *   C2-4 a student whose course is no longer open still downloads their own
 *       notes, as the privacy policy says;
 *   C2-5 a lesson the route refuses (held back by a quiz) shows no box, and
 *       a refusal retrying cannot fix is not told "try again in a minute";
 *   C2-6 a whole note deleted can be undone;
 *   C2-7 the count is not spoken before the student types.
 *
 * The box is run under a minimal hook runtime (Claude 2's harness from the
 * review, node:vm): no browser, no React DOM.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, transpileModule } from "typescript";
import * as notesLib from "@/lib/lesson-notes";
import { forgetLessonNotesPerson, notesAsText, notesOf, readNote, saveNote } from "@/lib/lesson-notes";
import * as rules from "@/lib/lesson-notes-rules";
import * as words from "@/lib/buyer-words/lesson-notes";
import { emailKey } from "@/lib/learn";
import { heldBack } from "@/lib/quiz";
import type { Course, Lesson } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { SHAPES, readShapeCost } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis) as Pipeline;
const read = (file: string) => readFileSync(file, "utf8");
const lib = notesLib as unknown as Record<string, unknown>;
const en = words.lessonNotesWords("en");

const STATS = "r".repeat(16);
const COURSE_A = "a".repeat(32);
const COURSE_B = "b".repeat(32);
const lessonId = (n: number) => `l${String(n).padStart(11, "0")}`;
const touchesNotes = (commands: Commands) => commands.some((c) => c.some((arg) => typeof arg === "string" && arg.startsWith("nl:lnote:")));
/** The first read of a save: the pipeline that reads the note (HGET), before anything is written. */
const isNoteRead = (commands: Commands) => commands.some((c) => c[0] === "HGET" && typeof c[1] === "string" && c[1].startsWith("nl:lnote:"));

/** Runs `acts` at once, each one's first note read held until all of them have read: the instant two requests meet. */
async function together<T>(acts: (() => Promise<T>)[]): Promise<T[]> {
  let waiting = 0;
  let open: () => void = () => undefined;
  const allRead = new Promise<void>((resolve) => { open = resolve; });
  redis.pipeline = (async (commands: Commands) => {
    if (!isNoteRead(commands)) return real(commands);
    const replies = await real(commands);
    waiting += 1;
    if (waiting >= acts.length) open();
    await allRead;
    return replies;
  }) as Pipeline;
  try {
    return await Promise.all(acts.map((act) => act()));
  } finally {
    redis.pipeline = real;
  }
}

async function concurrentSaves(): Promise<void> {
  part("J1: two saves started from the same note");
  const who = emailKey("j1-race@example.com");
  const first = await saveNote({ statsId: STATS, learner: who, courseId: COURSE_A, lessonId: lessonId(1), text: "Original.", was: "", room: ROOM });
  is("setup: the original note is kept", first.ok, true);
  const [a, b] = await together([
    () => saveNote({ statsId: STATS, learner: who, courseId: COURSE_A, lessonId: lessonId(1), text: "Version A from the first tab.", was: "Original.", room: ROOM }),
    () => saveNote({ statsId: STATS, learner: who, courseId: COURSE_A, lessonId: lessonId(1), text: "Version B from the second tab.", was: "Original.", room: ROOM }),
  ]);
  const acknowledged = [a, b].filter((r) => r.ok).map((r) => (r.ok ? r.text : ""));
  is("exactly one of the two is acknowledged; the other is told the note changed", [acknowledged.length, [a, b].filter((r) => !r.ok && r.reason === "changed").length], [1, 1]);
  const kept = await readNote(STATS, who, COURSE_A, lessonId(1));
  is("the kept note is the acknowledged one (no acknowledged save is lost)", kept.state === "kept" ? kept.text : kept.state, acknowledged[0] ?? "none");
}

async function lastPlace(): Promise<void> {
  part("J2: the 300-note bound when two new notes race for the last place");
  const who = emailKey("j2-bound@example.com");
  for (let n = 0; n < rules.MAX_NOTES_PER_STUDENT - 1; n++) {
    // Two courses, each inside the 200 lessons a course holds.
    const saved = await saveNote({ statsId: STATS, learner: who, courseId: n < 200 ? COURSE_A : COURSE_B, lessonId: lessonId(n), text: `n${n}`, was: "", room: ROOM });
    if (!saved.ok) throw new Error(`setup note ${n}: ${saved.reason}`);
  }
  const [a, b] = await together([
    () => saveNote({ statsId: STATS, learner: who, courseId: COURSE_B, lessonId: "lastplace001", text: "First new note.", was: "", room: ROOM }),
    () => saveNote({ statsId: STATS, learner: who, courseId: COURSE_B, lessonId: "lastplace002", text: "Second new note.", was: "", room: ROOM }),
  ]);
  const [count] = await real([["HLEN", `nl:lnote:${STATS}:${who}`]]);
  is(`the student keeps at most ${rules.MAX_NOTES_PER_STUDENT} notes`, Number(count) <= rules.MAX_NOTES_PER_STUDENT, true);
  is("one takes the last place, the other is refused as too many", [a, b].map((r) => (r.ok ? "ok" : r.reason)).sort(), ["ok", "too_many"]);
}

async function downloadCost(): Promise<void> {
  part("J3: a course's download admits its reads before them");
  const who = emailKey("j3-cost@example.com");
  // The worst a student may keep: 200 notes on one course and 100 on another, each 4,000 characters that are
  // stored at six bytes each (a lone surrogate, which JSON writes as \\uXXXX).
  const worst = "\uD800".repeat(rules.MAX_NOTE_CHARS);
  for (let n = 0; n < rules.MAX_NOTES_PER_STUDENT; n++) {
    const saved = await saveNote({ statsId: STATS, learner: who, courseId: n < 200 ? COURSE_A : COURSE_B, lessonId: lessonId(n), text: worst, was: "", room: ROOM });
    if (!saved.ok) throw new Error(`setup note ${n}: ${saved.reason}`);
  }
  const page = laterPageCost();
  for (const course of [COURSE_A, COURSE_B, "e".repeat(32)]) {
    let commands = 0;
    let dbBytes = 0;
    const size = (value: unknown): number => (typeof value === "string" ? Buffer.byteLength(value) : Array.isArray(value) ? value.reduce((s: number, v) => s + size(v), 0) : 8);
    // The route already takes one of the store's public requests (takeBuyerRead(store)) before anything is read.
    let units = 1;
    let admittedBeforeReads = true;
    let readValues = false;
    redis.pipeline = (async (commands_: Commands) => {
      const replies = await real(commands_);
      if (touchesNotes(commands_)) {
        commands += commands_.length;
        dbBytes += size(commands_) + size(replies);
        if (commands_.some((c) => c[0] === "HMGET" || c[0] === "HGETALL" || c[0] === "HVALS")) readValues = true;
      }
      return replies;
    }) as Pipeline;
    let kept: { lesson: string; text: string; at: number }[] = [];
    try {
      if (typeof lib.courseNotesOf === "function") {
        const got = await (lib.courseNotesOf as (s: string, l: string, c: string, admit: (u: number) => Promise<boolean>) => Promise<typeof kept | null>)(STATS, who, course, async (u) => {
          if (readValues) admittedBeforeReads = false;
          units += u;
          return true;
        });
        kept = got ?? [];
      } else {
        // The route as it is: every course's notes read, then filtered.
        kept = (await notesOf(STATS, who)).filter((note) => note.course === course);
      }
    } finally {
      redis.pipeline = real;
    }
    const text = notesAsText({ words: en, courseTitle: "T".repeat(200), storeName: "S".repeat(80), day: "November 7, 2026", lessons: kept.map((n) => ({ id: n.lesson, title: "L".repeat(200), module: "M".repeat(200) })), notes: kept });
    const outBytes = Buffer.byteLength(text);
    // The route's own reads (store, listing, course, session, ledger) are inside its first request, as before; the notes on top.
    const cost = readShapeCost({ seconds: SHAPES.heavy.seconds * (1 + dbBytes / 1e6), cpu: SHAPES.heavy.cpu * (1 + dbBytes / 1e6), commands: 12 + commands, dbBytes: 65_536 + dbBytes, outBytes, stripePages: 0 });
    const label = course === COURSE_A ? "200 notes" : course === COURSE_B ? "100 notes" : "no notes";
    console.log(`  ${label}: ${commands} commands, ${dbBytes} database bytes, ${outBytes} bytes sent; ${units} requests admitted ($${(units * page).toFixed(6)}) for $${cost.toFixed(6)}`);
    is(`${label}: the requests admitted cost at least what the download reads and sends`, units * page >= cost, true);
    is(`${label}: they are admitted before the notes are read`, admittedBeforeReads, true);
  }
}

function everySize(): void {
  part("J3: at every size a course's notes may reach, the requests admitted cost more than the worst download");
  const units = lib.noteReadUnits as (n: number) => number;
  const valueBytes = lib.MAX_NOTE_VALUE_BYTES as number;
  const page = laterPageCost();
  // One course can hold every note a student keeps (its lessons, and lessons since taken out of it).
  let failing = -1;
  for (let n = 0; n <= rules.MAX_NOTES_PER_STUDENT; n++) {
    // The list of all the student's notes (a 45-byte field each), then the course's values, fifty to a command.
    const dbBytes = 65_536 + rules.MAX_NOTES_PER_STUDENT * 64 + n * (valueBytes + 64);
    // Each note sent with its lesson's and module's titles (120 characters, four bytes each) and its separator.
    const outBytes = 4_096 + n * (4 * rules.MAX_NOTE_CHARS + 2 * 4 * 120 + 32);
    const cost = readShapeCost({ seconds: SHAPES.heavy.seconds * (1 + dbBytes / 1e6), cpu: SHAPES.heavy.cpu * (1 + dbBytes / 1e6), commands: 12 + 1 + Math.ceil(n / 50), dbBytes, outBytes, stripePages: 0 });
    if ((1 + units(n)) * page < cost && failing < 0) failing = n;
  }
  is("no size of a course's notes costs more than the requests its download takes", failing, -1);
}

async function erasureDuringSave(): Promise<void> {
  part("C2-3: an erasure that runs while a save is in flight");
  const who = emailKey("c2-erase@example.com");
  const first = await saveNote({ statsId: STATS, learner: who, courseId: COURSE_A, lessonId: lessonId(7), text: "Draft one.", was: "", room: ROOM });
  is("setup: a first note is kept", first.ok, true);
  let erased = -1;
  redis.pipeline = (async (commands: Commands) => {
    // The write of the note: its HSET, or the one step that checks and writes it.
    const writes = commands.some((c) => c[0] === "HSET" || c[0] === "EVAL") && touchesNotes(commands);
    if (erased === -1 && writes) {
      redis.pipeline = real;
      // The person is deleted from the store (lib/person-erasure.ts runs this) at this instant.
      erased = await forgetLessonNotesPerson(STATS, who, ROOM);
    }
    return real(commands);
  }) as Pipeline;
  try {
    await saveNote({ statsId: STATS, learner: who, courseId: COURSE_A, lessonId: lessonId(7), text: "Draft two, longer than the first one.", was: "Draft one.", room: ROOM });
  } finally {
    redis.pipeline = real;
  }
  is("setup: the erasure ran and deleted one note", erased, 1);
  const after = await readNote(STATS, who, COURSE_A, lessonId(7));
  is("after the erasure answered, nothing of the person's notes is left", after.state, "none");
  is("the person's notes, listed after the erasure, are none", (await notesOf(STATS, who)).length, 0);
  const [slot] = await real([["HGET", "nl:data:room-test-store", `ln:${who}:${COURSE_A}:${lessonId(7)}`]]);
  is("and the note's slot in the room is empty", slot, null);
}

function closedCourse(): void {
  part("C2-4: the download after the course is no longer open");
  const reader = lib.noteReaderOf as undefined | ((access: unknown, courseId: string) => string | null);
  const learner = (scope: "all" | string[], owner = false) => ({ email: "zoe@example.com", scope, owner });
  const of = (access: unknown) => (typeof reader === "function" ? reader(access, COURSE_A) : "no reader");
  is("a student the course is open to reads their own notes", of({ state: "open", learner: learner([COURSE_A]), start: 1 }), emailKey("zoe@example.com"));
  is("so does one whose membership ended", of({ state: "ended", learner: learner([COURSE_A]) }), emailKey("zoe@example.com"));
  is("and one refunded, still signed in to the course", of({ state: "closed", learner: learner([COURSE_A]) }), emailKey("zoe@example.com"));
  is("and one signed in to Marktmorgen with the same address", of({ state: "closed", learner: learner("all") }), emailKey("zoe@example.com"));
  is("never someone signed in to another course only", of({ state: "closed", learner: learner(["f".repeat(32)]) }), null);
  is("never the creator", of({ state: "open", learner: learner("all", true), start: 1 }), null);
  is("never a visitor", of({ state: "closed", learner: null }), null);
  const route = read("app/api/store/course/note/route.ts");
  is("the route's download finds its reader that way, and reads only the course's notes", /noteReaderOf\(access, course\.id\)/.test(route) && /courseNotesOf\(/.test(route) && !/notesOf\(store\.statsId, who\)\)\.filter/.test(route), true);
  const privacy = read("app/privacy/page.tsx");
  is("the privacy policy says when the download is there, and no longer says \"at any time\"", !/notes as a text file at any time/.test(privacy) && /also after the course is no longer open to them/.test(privacy), true);
}

function heldLesson(): void {
  part("C2-5: a preview lesson held behind a quiz");
  const lesson = (id: string, extra: Partial<Lesson> = {}): Lesson => ({ id, title: id, preview: false, video: null, files: [], link: null, hasBody: true, quiz: null, ...extra });
  const previewAfter = lesson("previewaft01", { preview: true });
  const course = { id: "q".repeat(32), certificate: false, modules: [{ id: "m1", title: "Module", dripDays: 0, lessons: [lesson("intro0000001"), lesson("quizlesson01", { quiz: { required: true } as Lesson["quiz"] }), previewAfter] }] } as unknown as Course;
  is("setup: the route refuses the held preview lesson (heldBack)", heldBack(course, new Set()).has(previewAfter.id), true);
  const page = read("app/[handle]/course/[product]/[lesson]/page.tsx");
  is("the page shows the box only on a lesson the route accepts saves for (not held back)", /const note = student && open && !blocker \? await readNote\(/.test(page), true);
}

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const compiled = transpileModule(read("components/lesson-notes.tsx"), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;

/** The box's real code under a minimal hook runtime: re-rendered on every set, effects run after each render, fetch held by the test. */
function mount(initial: unknown) {
  const slots: unknown[] = [];
  let at = 0;
  let pending: (() => void)[] = [];
  const guard: boolean[] = [];
  const timers: (() => void)[] = [];
  const posted: { text: string; was: string }[] = [];
  const answers: ((r: { status: number; json: () => Promise<unknown> }) => void)[] = [];
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
    fetch: (_url: string, init: { body: string }) => {
      posted.push(JSON.parse(init.body));
      return new Promise((resolve) => { answers.push(resolve); });
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
  const text = (node: unknown): string => (Array.isArray(node) ? node.map(text).join("") : typeof node === "string" ? node : node && typeof node === "object" && "props" in node ? text((node as El).props.children) : "");
  return {
    guard, timers, posted,
    status: () => text(all(tree).find((e) => e.props.role === "status")?.props.children),
    live: () => text(all(tree).find((e) => e.props["aria-live"] === "polite")?.props.children),
    type(value: string) { (all(tree).find((e) => e.type === "textarea")!.props.onChange as (e: unknown) => void)({ target: { value } }); },
    value: () => all(tree).find((e) => e.type === "textarea")?.props.value,
    submit: () => (all(tree).find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {} }),
    answer: (status: number, body: unknown) => answers.shift()!({ status, json: async () => body }),
    buttons: () => all(tree).filter((e) => e.type === "button"),
  };
}

async function theBox(): Promise<void> {
  part("C2-2: typing while a save is on its way");
  {
    const box = mount({ state: "none" });
    box.type("Proof twice.");
    const saving = box.submit();
    box.answer(200, { ok: true, text: "Proof twice." });
    await saving;
    is("control: an ordinary save keeps the words, says saved and stops guarding", [box.value(), box.status(), box.guard.at(-1)], ["Proof twice.", en.saved, false]);
  }
  {
    const box = mount({ state: "none" });
    box.type("Step one: proof the dough.");
    const saving = box.submit();
    box.type("Step one: proof the dough.\nStep two: shape it, typed while the first save was on its way.");
    is("while the save is on its way and the box holds unsaved words, leaving the page is guarded", box.guard.at(-1), true);
    box.answer(200, { ok: true, text: "Step one: proof the dough." });
    await saving;
    is("what was typed during the save is still in the box after it answers", box.value(), "Step one: proof the dough.\nStep two: shape it, typed while the first save was on its way.");
    is("and leaving is still guarded, since it is not saved", box.guard.at(-1), true);
    const next = box.submit();
    is("the next save starts from what the server kept", box.posted.at(-1)?.was, "Step one: proof the dough.");
    box.answer(200, { ok: true, text: "Step one: proof the dough.\nStep two: shape it, typed while the first save was on its way." });
    await next;
    is("and once it is saved, leaving is no longer guarded", box.guard.at(-1), false);
  }

  part("C2-6: a whole note deleted can be undone");
  {
    const before = "Three pages of what the teacher said about lamination.";
    const box = mount({ state: "kept", text: before });
    box.type("");
    const saving = box.submit();
    box.answer(200, { ok: true, text: "" });
    await saving;
    is("status says it was deleted", box.status(), en.cleared);
    const undo = box.buttons().find((b) => b.props.type === "button");
    is("an undo button is offered beside it", Boolean(undo), true);
    if (undo) {
      const back = (undo.props.onClick as () => Promise<void>)();
      is("undo saves the deleted note again, from no note", [box.posted.at(-1)?.text, box.posted.at(-1)?.was], [before, ""]);
      box.answer(200, { ok: true, text: before });
      await back;
      is("and the box holds it again, saved", [box.value(), box.status(), box.guard.at(-1)], [before, en.saved, false]);
    }
  }

  part("C2-7: the count is not spoken unasked");
  {
    const box = mount({ state: "kept", text: "Short." });
    for (const run of box.timers.splice(0)) run();
    is("a screen reader is told nothing on load, before the student types", box.live(), "");
    box.type("Short. And more.");
    for (const run of box.timers.splice(0)) run();
    is("once the student types, the count is said after a pause", box.live(), en.count(16, rules.MAX_NOTE_CHARS));
  }

  part("C2-5: a refusal retrying cannot fix");
  for (const error of ["closed", "owner"]) {
    const box = mount({ state: "none" });
    box.type("A note.");
    const saving = box.submit();
    box.answer(403, { ok: false, error });
    await saving;
    is(`"${error}": the student is not told to try again in a minute, and is told the lesson is not open to them`, [box.status() !== en.failed, box.status() === (en as Record<string, unknown>).closed], [true, true]);
    is(`"${error}": what they typed stays in the box`, box.value(), "A note.");
  }
  for (const language of ["en", "es", "fr", "de", "it", "nl", "pt"] as const) {
    const w = words.lessonNotesWords(language) as Record<string, unknown>;
    is(`${language}: the new sentences are said`, ["closed", "undo"].map((k) => typeof w[k] === "string" && (w[k] as string).length > 0), [true, true]);
  }
}

void (async () => {
  await concurrentSaves();
  await lastPlace();
  await downloadCost();
  everySize();
  await erasureDuringSave();
  closedCourse();
  heldLesson();
  await theBox();
  done();
})();
