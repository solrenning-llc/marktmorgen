/**
 * 750 [CD1] unit 4: the studio's side of buyers' files for review,
 * app/api/store/course/submissions, called through NextRequest with the
 * studio's access, the course and the studio requests stood in for
 * (tests/submission-studio-world.ts) and the real rules and store on the
 * in-memory Redis. What is checked:
 *
 *   - it stays off: lib/submission-switch.ts says false and the trainers'
 *     page still says "Not yet" (rule VR);
 *   - a role without the permission is refused before anything is read;
 *   - a lesson's settings are saved, read back and stopped; stopping answers
 *     the settings it had, so the studio can undo it; settings that do not
 *     read are refused by name; anything unknown is said as unknown;
 *   - the "To review" list takes its studio requests before it reads, shows
 *     a page at a time, newest first, and says a record it cannot read;
 *   - a reply is written once, moves the file to answered and lets the
 *     buyer's waiting place go; a second, an empty one, one for another course
 *     or for a file that is gone are refused; two at once never both pass;
 *   - the buyer is told of the reply once, and the studio hears whether the
 *     email went (unit 6; the email itself in tests/submission-notice.test.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/course/submissions/route";
import { type DoorSteps, SUBMISSION_LIST_PAGE, SUBMISSION_LIST_UNITS, SUBMISSION_REPLY_UNITS, closeSubmissionDoor, forgetSubmissionsPerson, liveCount, openSubmissionDoor } from "@/lib/submission-store";
import type { SubmissionSetup } from "@/lib/submission-rules";
import type { DataStore } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { COURSE, FOLDER, LESSONS, STORE, resetWorld, state } from "./submission-studio-world";
import { done, is, part } from "./check";

const MiB = 1024 * 1024;
const NOW = Math.floor(Date.now() / 1000);
const SETUP: SubmissionSetup = { instruction: "Film one set from the side.", kinds: ["video"], maxBytes: 100 * MiB, keepDays: 30 };
const BASE = "https://marktmorgen.com/api/store/course/submissions";

async function get(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await GET(new NextRequest(`${BASE}?${query}`));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
async function post(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await POST(new NextRequest(BASE, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

let opened = 0;
const steps: DoorSteps = {
  reserveStoreUpload: async () => true,
  openReservedVault: async (input) => {
    opened += 1;
    return { ok: true, sessionId: "s", upload: { pathname: `vault/${input.folder}/${input.ownerId}/${String(opened).padStart(16, "0")}-${input.name}`, pieces: 1, pieceBytes: 16 * MiB, multipart: true } };
  },
  reserveUploadControl: async () => true,
  signPieces: async () => [],
  closeReservedVault: async (pathname) => ({ ok: true, file: { pathname, bytes: 5 * MiB, contentType: "video/mp4" } }),
  abortReservedVault: async () => true,
  deleteVault: async () => true,
};
/** One kept file from a buyer on a lesson, sent at `at`; answers its id. */
async function sent(who: string, lessonId: string, at: number): Promise<string> {
  const ask = { store: STORE, data: STORE as DataStore, folder: FOLDER, courseId: COURSE, lessonId, who, email: `${who.slice(0, 3)}@example.com`, setup: SETUP, file: { bytes: 5 * MiB, type: "video/mp4", name: "set.mp4", limitBytes: 5 * 1024 * MiB }, nowSeconds: at };
  const door = await openSubmissionDoor(ask, steps);
  if (!door.ok) throw new Error(`open: ${door.reason}`);
  const closed = await closeSubmissionDoor({ store: STORE, folder: FOLDER, courseId: COURSE, lessonId, who, data: STORE as DataStore, note: "My first try." }, door.upload.pathname, ["e"], at, steps);
  if (!closed.ok) throw new Error(`close: ${closed.reason}`);
  return closed.submission.id;
}

async function main(): Promise<void> {
  part("It stays off until the buyer's side works");
  const root = process.cwd();
  is("the switch in the code is off", /export const SUBMISSIONS_READY = false;/.test(readFileSync(join(root, "lib/submission-switch.ts"), "utf8")), true);
  is("the trainers' page still says it is not built", readFileSync(join(root, "lib/feature-pages.ts"), "utf8").includes("Not yet: a product that asks the buyer to upload a video is not built."), true);

  part("Only a role that may change products, before anything is read");
  resetWorld();
  state.access = false;
  is("a read is refused", (await get(`id=prod1&lessonId=${LESSONS[0]}`)).status, 403);
  is("a change is refused", (await post({ action: "setup", id: "prod1", lessonId: LESSONS[0], setup: SETUP })).status, 403);
  is("and nothing was read", state.events, ["access", "access"]);

  part("A lesson's settings");
  resetWorld();
  is("nothing asked yet", (await get(`id=prod1&lessonId=${LESSONS[0]}`)).body, { ok: true, setup: null });
  is("saved", (await post({ action: "setup", id: "prod1", lessonId: LESSONS[0], setup: SETUP })).body, { ok: true, setup: SETUP });
  is("read back", (await get(`id=prod1&lessonId=${LESSONS[0]}`)).body, { ok: true, setup: SETUP });
  is("settings that do not read are refused by name", await post({ action: "setup", id: "prod1", lessonId: LESSONS[0], setup: { ...SETUP, kinds: [] } }), { status: 400, body: { ok: false, error: "kinds" } });
  is("a lesson not in the course", (await post({ action: "setup", id: "prod1", lessonId: "nope", setup: SETUP })).status, 404);
  is("a product that is not this store's course", (await get(`id=other&lessonId=${LESSONS[0]}`)).status, 404);
  is("stopping answers what it had, for an undo", (await post({ action: "setup", id: "prod1", lessonId: LESSONS[0], setup: null })).body, { ok: true, setup: null, was: SETUP });
  is("so nothing is asked", (await get(`id=prod1&lessonId=${LESSONS[0]}`)).body, { ok: true, setup: null });
  is("and the undo saves it again", (await post({ action: "setup", id: "prod1", lessonId: LESSONS[0], setup: SETUP })).body.ok, true);
  state.listing = "unknown";
  is("a product that could not be read is unknown", await get(`id=prod1&lessonId=${LESSONS[0]}`), { status: 503, body: { ok: false, error: "unavailable" } });
  resetWorld();
  await redis.pipeline([["SET", `nl:sub:setup:${COURSE}:${LESSONS[1]}`, "{broken"]]);
  is("settings kept but unreadable are unknown, never none", await get(`id=prod1&lessonId=${LESSONS[1]}`), { status: 503, body: { ok: false, error: "unavailable" } });
  await redis.pipeline([["DEL", `nl:sub:setup:${COURSE}:${LESSONS[1]}`]]);

  part("The \"To review\" list");
  resetWorld();
  is("empty", (await get("id=prod1&list=1")).body, { ok: true, next: null, rows: [] });
  is("its studio requests are taken after the course is found and before the list is read", state.events, ["access", "read:listing", "read:course", `allowance:studio:${SUBMISSION_LIST_UNITS}`]);
  const ids: string[] = [];
  for (let i = 0; i < SUBMISSION_LIST_PAGE + 2; i += 1) ids.push(await sent(`${String(i).padStart(2, "0")}${"a".repeat(30)}`, LESSONS[i % 2], NOW - 100 + i));
  resetWorld();
  const first = await get("id=prod1&list=1");
  const rows = first.body.rows as { id: string; lessonTitle: string; buyer: string; file: unknown; note: string; state: string; reply: unknown }[];
  is("a page at a time", rows.length, SUBMISSION_LIST_PAGE);
  is("newest first", rows[0].id, ids[ids.length - 1]);
  is("each says the lesson, the buyer, the file and the note", { lesson: rows[0].lessonTitle, buyer: rows[0].buyer, file: rows[0].file, note: rows[0].note, state: rows[0].state, reply: rows[0].reply }, {
    lesson: "Lesson 2",
    buyer: "11a@example.com",
    file: { name: "set.mp4", bytes: 5 * MiB, type: "video/mp4" },
    note: "My first try.",
    state: "submitted",
    reply: null,
  });
  const second = await get(`id=prod1&list=1&before=${first.body.next}`);
  is("the next page has the rest", (second.body.rows as unknown[]).length, 2);
  is("and no page after it", second.body.next, null);
  resetWorld();
  state.allowance = false;
  is("no studio requests left: refused before the list is read", await get("id=prod1&list=1"), { status: 429, body: { ok: false, error: "limit", message: "Your plan's studio requests for this month are used up." } });
  resetWorld();
  await redis.pipeline([["SET", `nl:sub:rec:${FOLDER}:${ids[0]}`, "{broken"]]);
  const all = [...((await get("id=prod1&list=1")).body.rows as { id: string; unread?: boolean }[])];
  const rest = (await get(`id=prod1&list=1&before=${(await get("id=prod1&list=1")).body.next}`)).body.rows as { id: string; unread?: boolean }[];
  is("a record that does not read is said, never left out", [...all, ...rest].find((row) => row.id === ids[0])?.unread, true);
  // Review of #3571 (Claude 3, MEDIUM 1): files closed in the same second share their score, and none may be lost between pages.
  resetWorld();
  const listKey = `nl:sub:list:${FOLDER}:${COURSE}`;
  const before = (await redis.pipeline([["ZRANGEBYSCORE", listKey, "-inf", "+inf", "WITHSCORES"]]))[0] as string[];
  await redis.pipeline([["DEL", listKey]]);
  const tied: string[] = [];
  for (let i = 0; i < SUBMISSION_LIST_PAGE + 2; i += 1) tied.push(await sent(`${String(i).padStart(2, "0")}${"t".repeat(30)}`, LESSONS[i % 2], NOW + 50));
  const tiedFirst = await get("id=prod1&list=1");
  const tiedSecond = await get(`id=prod1&list=1&before=${tiedFirst.body.next}`);
  const tiedListed = [...(tiedFirst.body.rows as { id: string }[]), ...(tiedSecond.body.rows as { id: string }[])].map((row) => row.id);
  is(
    "every one of twelve files closed in the same second is listed across the pages, once",
    [(tiedFirst.body.rows as unknown[]).length, (tiedSecond.body.rows as unknown[]).length, new Set(tiedListed).size, tiedSecond.body.next],
    [SUBMISSION_LIST_PAGE, 2, SUBMISSION_LIST_PAGE + 2, null],
  );
  is("and they are the twelve sent", [...tiedListed].sort(), [...tied].sort());
  // The list as it was before this case, for the cases after it.
  const kept: (string | number)[] = [];
  for (let i = 0; i < before.length; i += 2) kept.push(Number(before[i + 1]), before[i]);
  await redis.pipeline([["DEL", listKey], ["ZADD", listKey, ...kept]]);

  part("A reply, once");
  resetWorld();
  const target = ids[5];
  const who = `05${"a".repeat(30)}`;
  is("the buyer's place is held while it waits", await liveCount(FOLDER, COURSE, LESSONS[1], who, NOW), 1);
  is("an empty reply is refused", (await post({ action: "reply", id: "prod1", submission: target, text: "  " })).body, { ok: false, error: "reply" });
  const counted = redis.pipeline.bind(redis);
  let replyCommands = 0;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    replyCommands += batch.length;
    return counted(batch);
  }) as typeof redis.pipeline;
  const replied = await post({ action: "reply", id: "prod1", submission: target, text: "Knees out a little more." });
  redis.pipeline = counted;
  is("it is answered", replied.body.state, "reviewed");
  is("with the words", (replied.body.reply as { text: string }).text, "Knees out a little more.");
  // 750 [CD1] unit 6: the buyer is told by email, and the studio hears whether it went (no sender here, so it did not).
  // No sender here: lib/email.ts answers false, which may also be a send that went, so it is never said as "none went".
  is("the studio is told the email could not be confirmed, never that none went", replied.body.emailed, "unknown");
  is("the reply is marked told, so it is never emailed twice", (await redis.pipeline([["EXISTS", `nl:sub:told:${FOLDER}:${target}`]]))[0], 1);
  is("the reply and its notice stay inside the studio requests taken (20 commands each)", replyCommands <= 20 * (1 + SUBMISSION_REPLY_UNITS), true);
  is("its studio requests were taken first", state.events.includes(`allowance:studio:${SUBMISSION_REPLY_UNITS}`), true);
  is("the buyer's place is let go", await liveCount(FOLDER, COURSE, LESSONS[1], who, NOW), 0);
  is("a second reply is refused", await post({ action: "reply", id: "prod1", submission: target, text: "Again." }), { status: 409, body: { ok: false, error: "reviewed" } });
  const listed = [...((await get("id=prod1&list=1")).body.rows as { id: string; state: string }[]), ...((await get(`id=prod1&list=1&before=${(await get("id=prod1&list=1")).body.next}`)).body.rows as { id: string; state: string }[])];
  is("the list shows it answered", listed.find((row) => row.id === target)?.state, "reviewed");
  is("a file that is not there", (await post({ action: "reply", id: "prod1", submission: "f".repeat(32), text: "Hi" })).status, 404);
  const both = await Promise.all([post({ action: "reply", id: "prod1", submission: ids[6], text: "One." }), post({ action: "reply", id: "prod1", submission: ids[6], text: "Two." })]);
  is("two at once: one is sent, the other refused", both.map((r) => r.status).sort(), [200, 409]);
  await forgetSubmissionsPerson(FOLDER, `07${"a".repeat(30)}`, [], steps);
  is("a file whose buyer was deleted is gone", (await post({ action: "reply", id: "prod1", submission: ids[7], text: "Hi" })).status, 404);
  const after = [...((await get("id=prod1&list=1")).body.rows as { id: string }[]), ...((await get(`id=prod1&list=1&before=${(await get("id=prod1&list=1")).body.next}`)).body.rows as { id: string }[])];
  is("and off the list", after.some((row) => row.id === ids[7]), false);
  done();
}

main().then(
  () => undefined,
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
