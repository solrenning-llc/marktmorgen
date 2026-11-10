/**
 * 750 [CD1] unit 5: the buyer's side of a file sent for review, on the lesson
 * page. The route and the store are the real ones on the in-memory Redis, with
 * the store, the course, the learner and the vault stood in for
 * (tests/submission-upload-world.ts) and the switch on
 * (tests/submission-switch-on.ts). What is checked:
 *
 *   - the file the buyer picks is checked against what the creator asked
 *     (kind and size) before anything is sent; a browser that names no type
 *     is read by the file's extension;
 *   - sending goes open, sign, the pieces, then done with the note, and says
 *     how far it got; Stop gives the upload up at the door (abort) and
 *     never closes it; a refusal says the door's own reason;
 *   - the buyer's own files on the lesson are listed (waiting, reviewed with
 *     the creator's reply, withdrawn, still sending), another buyer's and
 *     another lesson's never; a record that does not read is said, never
 *     left out; the list's reads are paid before they are made, by how many
 *     there are;
 *   - a waiting file can be withdrawn by its buyer only, once: its file is
 *     deleted first, taken off the sweep's list, and its place on the lesson
 *     let go; a reviewed, expired or another buyer's file is refused, and a
 *     file the vault did not delete stays as it was;
 *   - the route lists and withdraws only for the signed-in buyer, after its
 *     public request or buyer action;
 *   - the lesson page reads the settings and shows the box only while the
 *     switch is on, for a student with the lesson open on a paid course; the
 *     box itself has a real labelled file input, the kinds and the largest
 *     file, and says every language's words.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/course/submission/route";
import {
  SUBMISSION_STEP_COMMANDS,
  type DoorSteps,
  buyerSubmissionsFor,
  closeSubmissionDoor,
  liveCount,
  mineUnits,
  openSubmissionDoor,
  readSubmission,
  replySubmission,
  saveSetupFor,
  withdrawSubmission,
} from "@/lib/submission-store";
import { MAX_SUBMISSIONS_PER_PERSON, MAX_SUBMISSION_RECORD_BYTES, type SubmissionSetup } from "@/lib/submission-rules";
import { checkChosenFile, sendSubmission } from "@/lib/submission-upload";
import { SUBMISSIONS_WORDS } from "@/lib/buyer-words/submissions";
import { LessonSubmission } from "@/components/lesson-submission";
import type { DataStore } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { COURSE, FOLDER, LESSON, resetWorld, state } from "./submission-upload-world";
import { done, is, part } from "./check";

const MiB = 1024 * 1024;
const ANA = "a".repeat(32);
const BOB = "b".repeat(32);
const NOW = 1_800_000_000;
const SETUP: SubmissionSetup = { instruction: "Film your squat from the side.", kinds: ["video", "pdf"], maxBytes: 200 * MiB, keepDays: 30 };
const SHOP = { sid: "submission-buyer-0", statsId: "d".repeat(32), tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_x", trialEnds: 0, planEndedAt: "" };
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

/** A stand-in vault and allowance that write down what they were asked, in order. */
function vault(overrides: Partial<DoorSteps> = {}) {
  const calls: string[] = [];
  let n = 0;
  const steps: DoorSteps = {
    reserveStoreUpload: async () => (calls.push("budget"), true),
    openReservedVault: async (input) => {
      n += 1;
      const pathname = `vault/${input.folder}/${input.ownerId}/${String(n).padStart(16, "0")}-${input.name}`;
      return { ok: true, sessionId: "s", upload: { pathname, pieces: 1, pieceBytes: 16 * MiB, multipart: true } };
    },
    reserveUploadControl: async () => true,
    signPieces: async (_p, numbers) => numbers.map((number) => ({ number, url: "https://vault.example.test/p", type: null })),
    closeReservedVault: async (pathname) => ({ ok: true, file: { pathname, bytes: 50 * MiB, contentType: "video/mp4" } }),
    abortReservedVault: async () => (calls.push("vault:abort"), true),
    deleteVault: async (paths) => (calls.push(`vault:delete:${paths.join(",")}`), true),
    ...overrides,
  };
  return { steps, calls };
}
const ask = (who: string, lessonId = LESSON, nowSeconds = NOW) => ({
  store: SHOP,
  data: SHOP as DataStore,
  folder: FOLDER,
  courseId: COURSE,
  lessonId,
  who,
  email: who === ANA ? "ana@example.com" : "bob@example.com",
  setup: SETUP,
  file: { bytes: 50 * MiB, type: "video/mp4", name: "squat.mp4", limitBytes: 5 * 1024 * MiB },
  nowSeconds,
});
/** Opens and, unless `keepOpen`, closes one upload for `who`; answers its id and path. */
async function sent(who: string, note: string, lessonId = LESSON, keepOpen = false, nowSeconds = NOW): Promise<{ id: string; path: string }> {
  const { steps } = vault();
  const opened = await openSubmissionDoor(ask(who, lessonId, nowSeconds), steps);
  if (!opened.ok) throw new Error(`open: ${opened.reason}`);
  const path = opened.upload.pathname;
  const id = path.split("/")[2].slice(4);
  if (keepOpen) return { id, path };
  const closed = await closeSubmissionDoor({ store: SHOP, folder: FOLDER, courseId: COURSE, lessonId, who, data: SHOP, note }, path, ["e"], nowSeconds, steps);
  if (!closed.ok) throw new Error(`close: ${closed.reason}`);
  return { id, path };
}
/** Counts the commands the in-memory Redis is sent while `work` runs. */
async function commandsOf<T>(work: () => Promise<T>): Promise<{ value: T; commands: number }> {
  const original = redis.pipeline.bind(redis);
  let commands = 0;
  redis.pipeline = (async (list: (string | number)[][]) => ((commands += list.length), original(list))) as typeof redis.pipeline;
  try {
    return { value: await work(), commands };
  } finally {
    redis.pipeline = original;
  }
}
const at = (who = ANA, lessonId = LESSON) => ({ folder: FOLDER, who, courseId: COURSE, lessonId });

async function call(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new NextRequest("https://marktmorgen.com/api/store/course/submission", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const response = await POST(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
const route = { handle: "shop", product: "prod1", lesson: LESSON };

async function main(): Promise<void> {
  part("The file the buyer picks, checked before anything is sent");
  {
    is("a video of a kind asked for", checkChosenFile(SETUP, { name: "squat.mp4", size: 50 * MiB, type: "video/mp4" }), { ok: true, type: "video/mp4" });
    is("a browser that names no type: read by the extension", checkChosenFile(SETUP, { name: "Squat.MOV", size: MiB, type: "" }), { ok: true, type: "video/quicktime" });
    is("a PDF", checkChosenFile(SETUP, { name: "plan.pdf", size: MiB, type: "application/pdf" }), { ok: true, type: "application/pdf" });
    is("a photo when only video and PDF are asked", checkChosenFile(SETUP, { name: "me.jpg", size: MiB, type: "image/jpeg" }), { ok: false, reason: "type" });
    is("a .jpeg named by extension when photos are asked", checkChosenFile({ kinds: ["photo"], maxBytes: 10 * MiB }, { name: "me.jpeg", size: MiB, type: "" }), { ok: true, type: "image/jpeg" });
    is("never an SVG", checkChosenFile({ kinds: ["photo"], maxBytes: 10 * MiB }, { name: "x.svg", size: 10, type: "image/svg+xml" }), { ok: false, reason: "type" });
    is("a type the browser names that the extension contradicts is not guessed", checkChosenFile(SETUP, { name: "run.mp4", size: MiB, type: "application/zip" }), { ok: false, reason: "type" });
    is("larger than the creator's largest file", checkChosenFile(SETUP, { name: "squat.mp4", size: 200 * MiB + 1, type: "video/mp4" }), { ok: false, reason: "size" });
    is("exactly the largest file", checkChosenFile(SETUP, { name: "squat.mp4", size: 200 * MiB, type: "video/mp4" }).ok, true);
    is("an empty file", checkChosenFile(SETUP, { name: "squat.mp4", size: 0, type: "video/mp4" }), { ok: false, reason: "empty" });
  }

  part("Sending: open, sign, the pieces, done with the note");
  {
    const posted: Record<string, unknown>[] = [];
    const progress: number[] = [];
    const file = Object.assign(new Blob([new Uint8Array(1_000)], { type: "" }), { name: "squat.mp4" });
    const result = await sendSubmission(file, SETUP, route, "My second try.", {
      post: async (body) => {
        posted.push(body);
        if (body.action === "open") return { ok: true, upload: { pathname: "vault/p/sub_x/1-squat.mp4", pieces: 1, pieceBytes: 16 * MiB, multipart: true } };
        if (body.action === "sign") return { ok: true, pieces: [{ number: 1, url: "https://vault.example.test/p", type: "video/mp4" }] };
        if (body.action === "done") return { ok: true, submission: { id: "x", file: { name: "squat.mp4", bytes: 1_000, type: "video/mp4" }, at: NOW, keepUntil: NOW + 30 * 86_400, state: "submitted" } };
        return { ok: false, error: "invalid" };
      },
      put: async (_url, piece, _type, onSent) => (onSent(piece.size), { status: 200, etag: "e1" }),
      onProgress: (percent) => progress.push(percent),
    });
    is("it is sent", result.ok, true);
    is("open, sign, done, in that order", posted.map((p) => p.action), ["open", "sign", "done"]);
    is("the open names the lesson, the file and the type read from its name", posted[0], { action: "open", ownerId: "", name: "squat.mp4", bytes: 1_000, type: "video/mp4", multipart: true, ...route });
    is("done carries the pieces and the note", { etags: posted[2].etags, note: posted[2].note, pathname: posted[2].pathname }, { etags: ["e1"], note: "My second try.", pathname: "vault/p/sub_x/1-squat.mp4" });
    is("every step names the lesson", posted.every((p) => p.handle === "shop" && p.product === "prod1" && p.lesson === LESSON), true);
    is("it says how far it got, to the end", progress[progress.length - 1], 100);
    is("the record it answers", result.ok ? result.submission.state : "", "submitted");
  }
  {
    const posted: string[] = [];
    const file = Object.assign(new Blob([new Uint8Array(10)]), { name: "photo.jpg" });
    const result = await sendSubmission(file, SETUP, route, "", { post: async (body) => (posted.push(String(body.action)), { ok: true }) });
    is("a file of a kind not asked for is refused before anything is sent", result, { ok: false, reason: "type" });
    is("nothing posted", posted, []);
  }
  {
    const posted: string[] = [];
    const file = Object.assign(new Blob([new Uint8Array(10)], { type: "video/mp4" }), { name: "a.mp4" });
    const result = await sendSubmission(file, SETUP, route, "", { post: async (body) => (posted.push(String(body.action)), { ok: false, error: "busy" }) });
    is("the door's own reason is said", result, { ok: false, reason: "busy" });
    is("nothing after the refused open", posted, ["open"]);
  }
  {
    const posted: Record<string, unknown>[] = [];
    const stop = new AbortController();
    const file = Object.assign(new Blob([new Uint8Array(10)], { type: "video/mp4" }), { name: "a.mp4" });
    const result = await sendSubmission(file, SETUP, route, "", {
      signal: stop.signal,
      wait: async () => undefined,
      post: async (body) => {
        posted.push(body);
        if (body.action === "open") return { ok: true, upload: { pathname: "vault/p/sub_y/1-a.mp4", pieces: 1, pieceBytes: 16 * MiB, multipart: true } };
        if (body.action === "sign") return { ok: true, pieces: [{ number: 1, url: "https://vault.example.test/p", type: null }] };
        return { ok: true };
      },
      // The buyer presses Stop while the piece is on its way.
      put: async () => (stop.abort(), { status: 0, etag: null }),
    });
    is("stopped, it says so", result, { ok: false, reason: "stopped" });
    is("the upload is given up at the door, never closed", posted.map((p) => p.action), ["open", "sign", "abort"]);
    is("the one it opened", posted[2].pathname, "vault/p/sub_y/1-a.mp4");
  }
  {
    const posted: string[] = [];
    const stop = new AbortController();
    stop.abort();
    const file = Object.assign(new Blob([new Uint8Array(10)], { type: "video/mp4" }), { name: "a.mp4" });
    const result = await sendSubmission(file, SETUP, route, "", { signal: stop.signal, post: async (body) => (posted.push(String(body.action)), { ok: true }) });
    is("stopped before it began: nothing is opened", [result, posted], [{ ok: false, reason: "stopped" }, []]);
  }
  {
    const posted: string[] = [];
    const file = Object.assign(new Blob([new Uint8Array(10)], { type: "video/mp4" }), { name: "a.mp4" });
    const result = await sendSubmission(file, SETUP, route, "", {
      wait: async () => undefined,
      post: async (body) => {
        posted.push(String(body.action));
        if (body.action === "open") return { ok: true, upload: { pathname: "vault/p/sub_z/1-a.mp4", pieces: 1, pieceBytes: 16 * MiB, multipart: true } };
        if (body.action === "sign") return { ok: true, pieces: [{ number: 1, url: "https://vault.example.test/p", type: null }] };
        return { ok: true };
      },
      put: async () => ({ status: 0, etag: null }),
    });
    is("a piece that never arrives stops the upload", result, { ok: false, reason: "upload_stopped" });
    is("and gives it up", posted[posted.length - 1], "abort");
  }

  part("The buyer's own files on the lesson");
  await saveSetupFor(SHOP as DataStore, COURSE, LESSON, SETUP);
  const first = await sent(ANA, "First try.", LESSON, false, NOW);
  const second = await sent(ANA, "Second try.", LESSON, false, NOW + 60);
  const open = await sent(ANA, "", LESSON, true, NOW + 120);
  await sent(ANA, "Elsewhere.", "lesson0002ab", false, NOW + 30);
  await sent(BOB, "Bob's.", LESSON, false, NOW + 90);
  {
    const paid: number[] = [];
    const listed = await commandsOf(() => buyerSubmissionsFor(at(), NOW + 200, async (units) => (paid.push(units), true)));
    const rows = listed.value.ok ? listed.value.rows : [];
    is("Ana's three on this lesson, newest first", rows.map((row) => row.id), [open.id, second.id, first.id]);
    is("the one still sending says so, with its upload's path", rows[0], { id: open.id, state: "uploading", file: { name: "squat.mp4", bytes: 50 * MiB, type: "video/mp4" }, at: NOW + 120, pathname: open.path });
    is("a waiting one with its note and keeping time", rows[1], {
      id: second.id,
      state: "submitted",
      file: { name: "squat.mp4", bytes: 50 * MiB, type: "video/mp4" },
      note: "Second try.",
      at: NOW + 60,
      keepUntil: NOW + 60 + 30 * 86_400,
      reply: null,
    });
    is("its reads paid before, by how many there are", paid, [mineUnits(3)]);
    is("inside its commands", listed.commands <= SUBMISSION_STEP_COMMANDS.mine, true);
    is("the most a list can read is held", SUBMISSION_STEP_COMMANDS.mine, 1 + 2 * MAX_SUBMISSIONS_PER_PERSON);
    is("nothing of another buyer's or the buyer's address in any row", JSON.stringify(rows).includes("bob") || JSON.stringify(rows).includes("ana@"), false);
  }
  {
    const before = await commandsOf(() => buyerSubmissionsFor(at(), NOW + 200, async () => false));
    is("no request left to pay with: resting", before.value, { ok: false, reason: "resting" });
    is("and no record was read", before.commands, 1);
    is("nothing sent on another lesson is asked for", (await buyerSubmissionsFor(at(ANA, "lesson0003ab"), NOW, async () => true)), { ok: true, rows: [] });
    let asked = -1;
    await buyerSubmissionsFor(at(BOB), NOW + 200, async (units) => ((asked = units), true));
    is("Bob pays for his one", asked, mineUnits(1));
    is("a list of none costs nothing more", mineUnits(0), 0);
    is("one record at its largest fits the units it pays", mineUnits(1) * 65_536 >= MAX_SUBMISSION_RECORD_BYTES, true);
  }
  {
    const replied = await replySubmission({ data: SHOP as DataStore, folder: FOLDER, courseId: COURSE, id: first.id, reply: { text: "Knees out a little more.", file: null } }, NOW + 300);
    is("the creator replies", replied.ok, true);
    const listed = await buyerSubmissionsFor(at(), NOW + 400, async () => true);
    const row = listed.ok ? listed.rows.find((r) => r.id === first.id) : null;
    is("reviewed, with the creator's words", row && "reply" in row ? { state: row.state, reply: row.reply } : null, { state: "reviewed", reply: { text: "Knees out a little more.", at: NOW + 300 } });
    await redis.pipeline([["SET", `nl:sub:rec:${FOLDER}:${second.id}`, "{not json"]]);
    const garbled = await buyerSubmissionsFor(at(), NOW + 400, async () => true);
    is("a record that does not read is said, never left out", garbled.ok ? garbled.rows.find((r) => r.id === second.id) : null, { id: second.id, state: "unread" });
  }

  part("Withdrawing a waiting file");
  {
    const third = await sent(ANA, "Third.", "lesson0002ab", false, NOW + 500);
    const lesson2 = { ...at(ANA, "lesson0002ab"), data: SHOP as DataStore };
    const { steps, calls } = vault();
    is("Bob cannot withdraw Ana's", await withdrawSubmission({ ...lesson2, who: BOB, id: third.id }, NOW + 600, steps), { ok: false, reason: "gone" });
    is("nor on another lesson", await withdrawSubmission({ ...lesson2, lessonId: LESSON, id: third.id }, NOW + 600, steps), { ok: false, reason: "gone" });
    is("nothing was deleted for them", calls, []);
    const failing = vault({ deleteVault: async () => false });
    is("a file the vault did not delete is not withdrawn", await withdrawSubmission({ ...lesson2, id: third.id }, NOW + 600, failing.steps), { ok: false, reason: "unavailable" });
    is("it still waits", (await readSubmission(FOLDER, third.id))?.state, "submitted");
    const places = await liveCount(FOLDER, COURSE, "lesson0002ab", ANA, NOW + 600);
    const done1 = await commandsOf(() => withdrawSubmission({ ...lesson2, id: third.id }, NOW + 600, steps));
    is("withdrawn", done1.value.ok ? { state: done1.value.submission.state, closedAt: done1.value.submission.closedAt } : done1.value, { state: "withdrawn", closedAt: NOW + 600 });
    is("its file deleted first", calls, [`vault:delete:${third.path}`]);
    is("kept as withdrawn", (await readSubmission(FOLDER, third.id))?.state, "withdrawn");
    is("its place on the lesson let go", await liveCount(FOLDER, COURSE, "lesson0002ab", ANA, NOW + 600), places - 1);
    is("off the sweep's list", (await redis.pipeline([["ZSCORE", "nl:sub:due", `${FOLDER}|${third.path}`]]))[0], null);
    is("inside its commands", done1.commands <= SUBMISSION_STEP_COMMANDS.withdraw, true);
    is("once only", await withdrawSubmission({ ...lesson2, id: third.id }, NOW + 700, steps), { ok: false, reason: "state" });
    is("a reviewed file is not withdrawn", await withdrawSubmission({ ...at(), data: SHOP as DataStore, id: first.id }, NOW + 700, steps), { ok: false, reason: "state" });
    const late = await sent(ANA, "Late.", "lesson0002ab", false, NOW + 800);
    is("nor one past its keeping time", await withdrawSubmission({ ...lesson2, id: late.id }, NOW + 800 + 30 * 86_400, steps), { ok: false, reason: "expired" });
    is("an id that is no record", await withdrawSubmission({ ...lesson2, id: "nope" }, NOW, steps), { ok: false, reason: "gone" });
  }

  part("The route: only the signed-in buyer, after its request");
  {
    resetWorld();
    state.learner = null;
    is("signed out, nothing listed", await call({ ...route, action: "mine" }), { status: 401, body: { ok: false, error: "signed_out" } });
    resetWorld();
    state.learner = { email: "owner@example.test", scope: "all", owner: true };
    is("the creator has no files of their own here", (await call({ ...route, action: "mine" })).status, 403);
    resetWorld();
    const mine = await call({ ...route, action: "mine" });
    const rows = (mine.body.submissions ?? []) as { id: string; state: string }[];
    is("Ana's files on the lesson, newest first, the unread one last", rows.map((row) => row.state), ["uploading", "reviewed", "unread"]);
    is("the store's public request first, then the reads' own, before they were made", state.events.filter((e) => e.startsWith("hold")), ["hold", `hold:${mineUnits(3)}`]);
    resetWorld();
    state.access = "ended";
    is("a buyer whose access ended still sees their own files", (await call({ ...route, action: "mine" })).status, 200);
    resetWorld();
    state.hold = false;
    is("no request left: resting, nothing read", [await call({ ...route, action: "mine" }), state.events], [{ status: 503, body: { ok: false, error: "resting" } }, ["read:store", "hold"]]);

    const fourth = await sent(ANA, "Fourth.", LESSON, false, NOW + 900);
    resetWorld();
    state.action = false;
    is("no buyer action left: nothing withdrawn", (await call({ ...route, action: "withdraw", id: fourth.id })).body, { ok: false, error: "resting" });
    is("it still waits", (await readSubmission(FOLDER, fourth.id))?.state, "submitted");
    resetWorld();
    state.learner = { email: "bob@example.com", scope: "all", owner: false };
    is("another buyer cannot withdraw it", await call({ ...route, action: "withdraw", id: fourth.id }), { status: 404, body: { ok: false, error: "unknown" } });
    resetWorld();
    state.learner = null;
    is("signed out, nothing withdrawn", (await call({ ...route, action: "withdraw", id: fourth.id })).status, 401);
    resetWorld();
    const withdrawn = await call({ ...route, action: "withdraw", id: fourth.id });
    is("its buyer withdraws it", withdrawn.body, { ok: true, submission: { id: fourth.id, state: "withdrawn" } });
    is("after one buyer action, and its file deleted", state.events.filter((e) => e === "action" || e === "vault:delete"), ["action", "vault:delete"]);
    is("kept as withdrawn", (await readSubmission(FOLDER, fourth.id))?.state, "withdrawn");
    resetWorld();
    is("a second time: it no longer waits", await call({ ...route, action: "withdraw", id: fourth.id }), { status: 409, body: { ok: false, error: "state" } });
    resetWorld();
    is("a lesson the course does not have", (await call({ ...route, lesson: "lesson0002ab", action: "withdraw", id: fourth.id })).status, 404);
  }

  part("The lesson page, and the box on it");
  {
    const page = read("app/[handle]/course/[product]/[lesson]/page.tsx");
    is("the settings are read only while the switch is on, for a student with the lesson open on a paid course", /SUBMISSIONS_READY && student && open && !blocker && product\.priceCents > 0\s*\?\s*await readSetupFor\(course\.id, lesson\.id\)/.test(page), true);
    is("settings that could not be read are said as unknown", /readSetupFor\(course\.id, lesson\.id\)\.catch\(\(\) => "unknown" as const\)/.test(page), true);
    is("the box is shown only when the creator asked", /\{submissionSetup \? \(\s*<LessonSubmission/.test(page), true);
    is("the switch is still off", read("lib/submission-switch.ts").includes("export const SUBMISSIONS_READY = false;"), true);

    const html = renderToStaticMarkup(createElement(LessonSubmission, { setup: SETUP, where: route, storeName: "Ana's Gym", language: "en" }));
    const w = SUBMISSIONS_WORDS.en;
    is("a section named by its heading", /<section[^>]*aria-labelledby="submission-title"/.test(html) && html.includes(`id="submission-title"`), true);
    is("what the creator asked", html.includes("Film your squat from the side."), true);
    is("a real file input, with its label", /<label[^>]*for="submission-file"/.test(html) && /<input[^>]*type="file"[^>]*id="submission-file"|<input[^>]*id="submission-file"[^>]*type="file"/.test(html), true);
    is("it takes only the kinds asked", /accept="\.mp4,\.mov,\.webm,\.pdf"/.test(html), true);
    is("the kinds and the largest file are said beside it", html.includes(w.largest("200 MB")) && html.includes(w.kinds.video) && html.includes(w.kinds.pdf), true);
    is("and how long the file is kept", html.includes(w.keptFor("Ana's Gym".replace("'", "&#x27;"), 30)), true);
    is("the hint is tied to the input", /aria-describedby="submission-file-hint"/.test(html), true);
    is("the note has its own label", /<label[^>]*for="submission-note"/.test(html), true);
    is("its list says it is loading, politely", /role="status"[^>]*>[^<]*Loading your files/.test(html), true);
    is("no time limit or countdown in the box", /setTimeout|setInterval/.test(read("components/lesson-submission.tsx")), false);
    is("a withdrawal is checked before it is sent", read("components/lesson-submission.tsx").includes("w.withdrawAsk("), true);
    is("errors are alerts", read("components/lesson-submission.tsx").includes('role="alert"'), true);
    is("progress is a real progress bar", read("components/lesson-submission.tsx").includes("<progress"), true);
    const unknown = renderToStaticMarkup(createElement(LessonSubmission, { setup: "unknown", where: route, storeName: "Ana's Gym", language: "en" }));
    is("settings that could not be read: said, and no file input", unknown.includes(w.unloadedSetup) && !unknown.includes('type="file"'), true);
    const keys = JSON.stringify(Object.keys(w));
    is("every language says all English says", Object.entries(SUBMISSIONS_WORDS).filter(([, words]) => JSON.stringify(Object.keys(words)) !== keys).map(([code]) => code), []);
    const de = renderToStaticMarkup(createElement(LessonSubmission, { setup: SETUP, where: route, storeName: "Ana's Gym", language: "de" }));
    is("a German store's box is in German", de.includes(SUBMISSIONS_WORDS.de.heading) && !de.includes(w.heading), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
