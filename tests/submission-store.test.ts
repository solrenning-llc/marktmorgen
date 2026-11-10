/**
 * 750 [CD1] unit 2: where a buyer's file for review is kept, and the door it
 * goes through (lib/submission-store.ts), on the in-memory Redis with the
 * vault and the upload allowance stood in for. What is checked:
 *
 *   - the creator's settings are read exactly, and counted in the store's data room;
 *   - opening holds one of the buyer's three places, then the month's upload
 *     allowance, then the plan's storage (openReservedVault), in that order,
 *     and each refusal gives back the place; a fourth open is refused before
 *     anything is spent;
 *   - only the buyer who opened an upload, on that lesson of that store, can
 *     sign, close or give it up;
 *   - closing writes the record once, with its time to live the keeping time
 *     and a week, counted in the data room, and holds the place to the keeping time;
 *     a file that does not match, a full room or a record Redis confirms was not
 *     written deletes the file; a record that may have been written (its answer
 *     lost, or another close of the same upload first) keeps it;
 *   - each step's Redis commands stay inside SUBMISSION_STEP_COMMANDS.
 */
import { MAX_SUBMISSION_NOTE, MAX_WAITING_PER_BUYER, type SubmissionSetup } from "@/lib/submission-rules";
import {
  SUBMISSION_STEP_COMMANDS,
  SUBMISSION_SWEEP_GRACE_SECONDS,
  type DoorSteps,
  abortSubmissionDoor,
  closeSubmissionDoor,
  liveCount,
  openSubmissionDoor,
  readSetupFor,
  readSubmission,
  saveSetupFor,
  signSubmissionDoor,
  submissionOwnerId,
} from "@/lib/submission-store";
import { type DataStore, dataUsed, takeData } from "@/lib/store-data";
import { contentRoomFor } from "@/lib/store-data-rules";
import { readVaultPath } from "@/lib/vault-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const MiB = 1024 * 1024;
const FOLDER = "0123456789abcdef0123456789abcdef";
const COURSE = "course0001ab";
const LESSON = "lesson0001ab";
const ANA = "a".repeat(32);
const BOB = "b".repeat(32);
const SHOP: DataStore & { statsId: string; tier: "creator" } = { sid: "submission-store-0", statsId: "c".repeat(32), tier: "creator", subscriptionActive: true, subscriptionId: "sub_x", trialEnds: 0, planEndedAt: "" };
const SETUP: SubmissionSetup = { instruction: "Film your squat from the side.", kinds: ["video", "pdf"], maxBytes: 200 * MiB, keepDays: 30 };
const NOW = 1_800_000_000;

/** A stand-in vault and allowance that write down what they were asked, in order. */
function world(overrides: Partial<DoorSteps> = {}) {
  const calls: string[] = [];
  let n = 0;
  const steps: DoorSteps = {
    reserveStoreUpload: async () => (calls.push("budget"), true),
    openReservedVault: async (input) => {
      calls.push("vault:open");
      n += 1;
      const pathname = `vault/${input.folder}/${input.ownerId}/${String(n).padStart(16, "0")}-${input.name}`;
      return { ok: true, sessionId: "s", upload: { pathname, pieces: 1, pieceBytes: 16 * MiB, multipart: true } };
    },
    reserveUploadControl: async () => (calls.push("control"), true),
    signPieces: async (_p, numbers) => (calls.push("sign"), numbers.map((number) => ({ number, url: "https://vault.example.test/p", type: null }))),
    closeReservedVault: async (pathname) => (calls.push("vault:close"), { ok: true, file: { pathname, bytes: 50 * MiB, contentType: "video/mp4" } }),
    abortReservedVault: async () => (calls.push("vault:abort"), true),
    deleteVault: async () => (calls.push("vault:delete"), true),
    ...overrides,
  };
  return { steps, calls };
}
const ask = (who = ANA, bytes = 50 * MiB, nowSeconds = NOW) => ({
  store: SHOP,
  data: SHOP as DataStore,
  folder: FOLDER,
  courseId: COURSE,
  lessonId: LESSON,
  who,
  email: who === ANA ? "ana@example.com" : "bob@example.com",
  setup: SETUP,
  file: { bytes, type: "video/mp4", name: "squat.mp4", limitBytes: 5 * 1024 * MiB },
  nowSeconds,
});
const where = (who = ANA) => ({ store: SHOP, folder: FOLDER, courseId: COURSE, lessonId: LESSON, who });

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
/** Answers one pipeline whose first command is `name` with nothing, as a reply out of shape. */
/** A pipeline whose first command is `name`, or the close's one-step record write (lib/submission-store.ts, SUBMISSION_CLOSE_WRITE). */
const CLOSE_WRITE = "close-write";
const firstIs = (list: (string | number)[][], name: string) =>
  name === CLOSE_WRITE ? String(list[0]?.[0]) === "EVAL" && String(list[0]?.[1]).startsWith("-- marktmorgen:submission-close-write:v1") : String(list[0]?.[0]) === name;
function breakNext(name: string) {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (list: (string | number)[][]) => {
    if (firstIs(list, name)) {
      redis.pipeline = original;
      return [];
    }
    return original(list);
  }) as typeof redis.pipeline;
}
/**
 * The next pipeline whose first command is `name` is sent to Redis and runs, but its answer is lost on the
 * way back (answered with nothing); with `thenGet`, the read-back after it is answered out of shape too.
 */
function landThenLose(name: string, thenGet = false) {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (list: (string | number)[][]) => {
    if (firstIs(list, name)) {
      redis.pipeline = original;
      if (thenGet) breakNext("GET");
      await original(list);
      return [];
    }
    return original(list);
  }) as typeof redis.pipeline;
}
/** The next pipeline whose first command is `name` is never answered: the request fails, whether it ran is not known. */
function sendThenFail(name: string, runs: boolean) {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (list: (string | number)[][]) => {
    if (firstIs(list, name)) {
      redis.pipeline = original;
      if (runs) await original(list);
      throw new Error("fetch failed");
    }
    return original(list);
  }) as typeof redis.pipeline;
}
/** Redis as it answers when nothing stands in, put back between cases so a stand-in one case left unused never reaches the next. */
const PIPELINE = redis.pipeline;
const idOf = (path: string) => readVaultPath(path)?.ownerId.slice(4) ?? "";
const threw = async (work: () => Promise<unknown>) => work().then(() => "no", (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : String(error)));

async function main(): Promise<void> {
  part("The creator's settings, read exactly and counted in the data room");
  {
    is("none asked for", await readSetupFor(COURSE, LESSON), null);
    const before = (await dataUsed(SHOP))?.used ?? -1;
    await saveSetupFor(SHOP, COURSE, LESSON, SETUP);
    is("saved, it reads back", await readSetupFor(COURSE, LESSON), SETUP);
    is("its bytes are counted in the room", ((await dataUsed(SHOP))?.used ?? -1) > before, true);
    await redis.pipeline([["SET", `nl:sub:setup:${COURSE}:other0000001`, "{not json"]]);
    is("a kept setup out of shape is unknown, never none", await threw(() => readSetupFor(COURSE, "other0000001")), "unknown");
    await redis.pipeline([["SET", `nl:sub:setup:${COURSE}:other0000002`, JSON.stringify({ ...SETUP, kinds: ["zip"] })]]);
    is("a kept setup that does not read is unknown", await threw(() => readSetupFor(COURSE, "other0000002")), "unknown");
    breakNext("GET");
    is("a reply out of shape is unknown", await threw(() => readSetupFor(COURSE, LESSON)), "unknown");
    is("a setup that does not read is never saved", await threw(() => saveSetupFor(SHOP, COURSE, LESSON, { ...SETUP, keepDays: 9_999 })), "Error: submission_setup");
    await saveSetupFor(SHOP, COURSE, "lesson0002ab", SETUP);
    const held = (await dataUsed(SHOP))?.used ?? -1;
    await saveSetupFor(SHOP, COURSE, "lesson0002ab", null);
    is("removed, it is gone", await readSetupFor(COURSE, "lesson0002ab"), null);
    is("and its bytes come back", ((await dataUsed(SHOP))?.used ?? -1) < held, true);
  }

  part("Opening: a place, the allowance, then the storage");
  {
    const { steps, calls } = world();
    const counted = await commandsOf(async () => [await liveCount(FOLDER, COURSE, LESSON, ANA, NOW), await openSubmissionDoor(ask(), steps)] as const);
    const opened = counted.value[1];
    is("it opens", opened.ok, true);
    is("the allowance before the vault", calls, ["budget", "vault:open"]);
    const path = opened.ok ? opened.upload.pathname : "";
    const parts = readVaultPath(path);
    is("in the store's own vault folder", parts?.folder, FOLDER);
    is("under an owner id no product or lesson has", parts?.ownerId.startsWith("sub_") && parts.ownerId.length === 36, true);
    is("one place held", await liveCount(FOLDER, COURSE, LESSON, ANA, NOW), 1);
    is("the count and the open stay inside their commands", counted.commands <= SUBMISSION_STEP_COMMANDS.open, true);
    is("another buyer's places are their own", await liveCount(FOLDER, COURSE, LESSON, BOB, NOW), 0);
    is("an open place lapses with its upload, a day on", await liveCount(FOLDER, COURSE, LESSON, ANA, NOW + 86_401), 0);
    is("an owner id is never a lesson's", submissionOwnerId("0".repeat(32)), "sub_" + "0".repeat(32));
  }
  {
    const refused = world({ reserveStoreUpload: async () => false });
    is("no allowance left", await openSubmissionDoor(ask(BOB), refused.steps), { ok: false, reason: "budget" });
    is("the vault is never asked", refused.calls, []);
    is("the place comes back", await liveCount(FOLDER, COURSE, LESSON, BOB, NOW), 0);
    const full = world({ openReservedVault: async () => { throw new Error("storage_limit"); } });
    is("the plan's storage is full", await openSubmissionDoor(ask(BOB), full.steps), { ok: false, reason: "room" });
    is("its place comes back too", await liveCount(FOLDER, COURSE, LESSON, BOB, NOW), 0);
    const pending = world({ openReservedVault: async () => { throw new Error("storage_pending"); } });
    is("room held by uploads still open", await openSubmissionDoor(ask(BOB), pending.steps), { ok: false, reason: "pending" });
    const down = world({ openReservedVault: async () => ({ ok: false, reason: "unavailable" }) });
    is("the vault did not answer", await openSubmissionDoor(ask(BOB), down.steps), { ok: false, reason: "unavailable" });
    const roomUsed = (await dataUsed(SHOP))?.used ?? 0;
  await takeData(SHOP, [{ slot: "p:filler-open", bytes: Math.max(0, contentRoomFor(SHOP, NOW) - roomUsed - 64), set: true }]);
  const noRoom = world();
  is("a full data room takes no place", await openSubmissionDoor(ask(BOB), noRoom.steps), { ok: false, reason: "full" });
  is("and spends nothing", noRoom.calls, []);
  await takeData(SHOP, [{ slot: "p:filler-open", bytes: 0, set: true }]);
  const unknown = world({ openReservedVault: async () => { throw new Error("storage_unknown"); } });
    is("storage that could not be measured is unknown, never room", await threw(() => openSubmissionDoor(ask(BOB), unknown.steps)), "Error: storage_unknown");
    is("and gives its place back", await liveCount(FOLDER, COURSE, LESSON, BOB, NOW), 0);
    const lost = world();
    breakNext("SET");
    is("a door that could not be written is unknown", await threw(() => openSubmissionDoor(ask(BOB), lost.steps)), "unknown");
    is("its upload is given up before the browser hears of it", lost.calls, ["budget", "vault:open", "vault:abort"]);
    is("and its place comes back", await liveCount(FOLDER, COURSE, LESSON, BOB, NOW), 0);
  }
  {
    const { steps, calls } = world();
    // The lapse checked above let the first place go (time read later than now): open up to three.
    for (let i = await liveCount(FOLDER, COURSE, LESSON, ANA, NOW); i < MAX_WAITING_PER_BUYER; i += 1) await openSubmissionDoor(ask(), steps);
    is("three places held", await liveCount(FOLDER, COURSE, LESSON, ANA, NOW), MAX_WAITING_PER_BUYER);
    calls.length = 0;
    is("a fourth is refused", await openSubmissionDoor(ask(), steps), { ok: false, reason: "busy" });
    is("before anything is spent", calls, []);
    is("and holds nothing", await liveCount(FOLDER, COURSE, LESSON, ANA, NOW), MAX_WAITING_PER_BUYER);
    const both = await Promise.all([openSubmissionDoor(ask(BOB), world().steps), openSubmissionDoor(ask(BOB), world().steps), openSubmissionDoor(ask(BOB), world().steps), openSubmissionDoor(ask(BOB), world().steps)]);
    is("four at once never pass three", both.filter((o) => o.ok).length <= MAX_WAITING_PER_BUYER, true);
    is("and what is held is what opened", await liveCount(FOLDER, COURSE, LESSON, BOB, NOW), both.filter((o) => o.ok).length);
  }

  part("Signing, closing and giving up: only the buyer's own upload");
  {
    const lesson = "lesson0003ab";
    const mine = { ...ask(), lessonId: lesson };
    const { steps, calls } = world();
    const opened = await openSubmissionDoor(mine, steps);
    const path = opened.ok ? opened.upload.pathname : "";
    const at = { ...where(), lessonId: lesson };
    calls.length = 0;
    is("another buyer cannot sign it", await signSubmissionDoor({ ...at, who: BOB }, path, [1], steps), { ok: false, reason: "unknown" });
    is("another lesson's door cannot sign it", await signSubmissionDoor({ ...at, lessonId: LESSON }, path, [1], steps), { ok: false, reason: "unknown" });
    is("a creator's lesson file path is never a submission", await signSubmissionDoor(at, `vault/${FOLDER}/${lesson}/0000000000000001-a.pdf`, [1], steps), { ok: false, reason: "unknown" });
    is("nothing spent for them", calls, []);
    const signed = await commandsOf(() => signSubmissionDoor(at, path, [1], steps));
    is("the buyer signs their own", signed.value.ok, true);
    is("from the month's control requests", calls, ["control", "sign"]);
    is("inside its commands", signed.commands <= SUBMISSION_STEP_COMMANDS.sign, true);
    const noControl = world({ reserveUploadControl: async () => false });
    is("no control requests left", await signSubmissionDoor(at, path, [1], noControl.steps), { ok: false, reason: "budget" });

    calls.length = 0;
    is("another buyer cannot close it", await closeSubmissionDoor({ ...at, who: BOB, data: SHOP, note: "" }, path, ["e"], NOW, steps), { ok: false, reason: "unknown" });
    is("a note too long is refused before the vault", await closeSubmissionDoor({ ...at, data: SHOP, note: "n".repeat(MAX_SUBMISSION_NOTE + 1) }, path, ["e"], NOW, steps), { ok: false, reason: "note" });
    is("the vault was not asked", calls, []);
    const usedBefore = (await dataUsed(SHOP))?.used ?? -1;
    const closed = await commandsOf(() => closeSubmissionDoor({ ...at, data: SHOP, note: "  First try.\r\n " }, path, ["e"], NOW + 60, steps));
    const kept = closed.value.ok ? closed.value.submission : null;
    is("it closes", closed.value.ok, true);
    is("the record says what was sent", kept && { target: kept.target, buyer: kept.buyer, file: kept.file, note: kept.note, at: kept.at, state: kept.state, reply: kept.reply, closedAt: kept.closedAt }, {
      target: { kind: "lesson", courseId: COURSE, lessonId: lesson },
      buyer: "ana@example.com",
      file: { name: "squat.mp4", bytes: 50 * MiB, type: "video/mp4" },
      note: "First try.",
      at: NOW + 60,
      state: "submitted",
      reply: null,
      closedAt: 0,
    });
    is("kept for the creator's days", kept?.keepUntil, NOW + 60 + 30 * 86_400);
    is("inside its commands", closed.commands <= SUBMISSION_STEP_COMMANDS.done, true);
    is("it reads back", (await readSubmission(FOLDER, kept?.id ?? ""))?.path, path);
    const ttl = await redis.pipeline([["TTL", `nl:sub:rec:${FOLDER}:${kept?.id}`]]);
    is("its time to live is the keeping time and a week", ttl[0], 30 * 86_400 + SUBMISSION_SWEEP_GRACE_SECONDS);
    is("its bytes are counted in the data room", ((await dataUsed(SHOP))?.used ?? -1) > usedBefore, true);
    is("its place is held to the keeping time", await liveCount(FOLDER, COURSE, lesson, ANA, NOW + 10 * 86_400), 1);
    is("and lapses after it", await liveCount(FOLDER, COURSE, lesson, ANA, NOW + 31 * 86_400), 0);
    is("closed twice, the second finds no door", await closeSubmissionDoor({ ...at, data: SHOP, note: "" }, path, ["e"], NOW + 61, steps), { ok: false, reason: "unknown" });
  }
  {
    const lesson = "lesson0004ab";
    const at = { ...where(), lessonId: lesson };
    const other = world({ closeReservedVault: async (pathname) => ({ ok: true, file: { pathname, bytes: 50 * MiB, contentType: "image/png" } }) });
    const opened = await openSubmissionDoor({ ...ask(), lessonId: lesson }, other.steps);
    const path = opened.ok ? opened.upload.pathname : "";
    is("a file that is not what was declared", await closeSubmissionDoor({ ...at, data: SHOP, note: "" }, path, ["e"], NOW, other.steps), { ok: false, reason: "invalid" });
    is("is deleted", other.calls.includes("vault:delete"), true);
    is("and gives its place back", await liveCount(FOLDER, COURSE, lesson, ANA, NOW), 0);
  }
  {
    const lesson = "lesson0005ab";
    const at = { ...where(), lessonId: lesson };
    const w = world();
    const opened = await openSubmissionDoor({ ...ask(), lessonId: lesson }, w.steps);
    const path = opened.ok ? opened.upload.pathname : "";
    breakNext(CLOSE_WRITE);
    is("a record write answered out of shape is unknown", await threw(() => closeSubmissionDoor({ ...at, data: SHOP, note: "" }, path, ["e"], NOW, w.steps)), "unknown");
    is("and the file it would have named is deleted", w.calls.includes("vault:delete"), true);
    is("Redis confirms no record was written", await readSubmission(FOLDER, idOf(path)), null);
  }
  part("A record that may have been written never loses its file (review of #3568, Codex C2)");
  {
    const lesson = "lesson0008ab";
    const at = { ...where(), lessonId: lesson };
    const w = world();
    const opened = await openSubmissionDoor({ ...ask(), lessonId: lesson }, w.steps);
    const path = opened.ok ? opened.upload.pathname : "";
    landThenLose(CLOSE_WRITE);
    is("a record written whose answer was lost is unknown", await threw(() => closeSubmissionDoor({ ...at, data: SHOP, note: "" }, path, ["e"], NOW, w.steps)), "unknown");
    is("its file is kept", w.calls.includes("vault:delete"), false);
    is("for the record that names it", (await readSubmission(FOLDER, idOf(path)))?.path, path);
  }
  {
    redis.pipeline = PIPELINE;
    const lesson = "lesson0009ab";
    const at = { ...where(), lessonId: lesson };
    const w = world();
    const opened = await openSubmissionDoor({ ...ask(), lessonId: lesson }, w.steps);
    const path = opened.ok ? opened.upload.pathname : "";
    landThenLose(CLOSE_WRITE, true);
    is("a lost answer whose read-back is out of shape is unknown", await threw(() => closeSubmissionDoor({ ...at, data: SHOP, note: "" }, path, ["e"], NOW, w.steps)), "unknown");
    is("and the file is kept, never deleted on a guess", w.calls.includes("vault:delete"), false);
  }
  {
    redis.pipeline = PIPELINE;
    const lesson = "lesson0010ab";
    const at = { ...where(), lessonId: lesson };
    const w = world();
    const opened = await openSubmissionDoor({ ...ask(), lessonId: lesson }, w.steps);
    const path = opened.ok ? opened.upload.pathname : "";
    sendThenFail(CLOSE_WRITE, true);
    is("a write sent and never answered is unknown", await threw(() => closeSubmissionDoor({ ...at, data: SHOP, note: "" }, path, ["e"], NOW, w.steps)), "Error: fetch failed");
    is("and the file is kept: the write may have landed", w.calls.includes("vault:delete"), false);
    is("as it did here", (await readSubmission(FOLDER, idOf(path)))?.path, path);
  }
  {
    redis.pipeline = PIPELINE;
    const lesson = "lesson0011ab";
    const at = { ...where(), lessonId: lesson };
    let arrived = 0;
    let both: () => void = () => undefined;
    const met = new Promise<void>((resolve) => (both = resolve));
    // The vault confirms every close of the same upload it is asked for, and a close it is asked for does not go on
    // until both have passed the door or the other has already ended.
    const w = world({
      closeReservedVault: async (pathname) => {
        arrived += 1;
        if (arrived === 2) both();
        await met;
        return { ok: true, file: { pathname, bytes: 50 * MiB, contentType: "video/mp4" } };
      },
    });
    const opened = await openSubmissionDoor({ ...ask(), lessonId: lesson }, w.steps);
    const path = opened.ok ? opened.upload.pathname : "";
    const results = await Promise.all(
      [0, 1].map(() =>
        closeSubmissionDoor({ ...at, data: SHOP, note: "" }, path, ["e"], NOW, w.steps)
          .then((value) => (value.ok ? "ok" : value.reason), (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : String(error)))
          .finally(() => both()),
      ),
    );
    is("two closes at once: one is kept, the other finds the upload no longer open", [...results].sort(), ["ok", "unknown"]);
    is("the vault is asked to close it once", arrived, 1);
    is("the one that lost never deletes the kept one's file", w.calls.includes("vault:delete"), false);
    is("which its record still names", (await readSubmission(FOLDER, idOf(path)))?.path, path);
  }
  {
    // Review of #3568 (Codex C2, focal): close A's record write is answered out of shape and did not land; its
    // read-back really reads "no record", but that answer reaches it only after close B of the same upload has
    // written its own record. A's "no record" is then a snapshot from before B, and must never delete B's file.
    redis.pipeline = PIPELINE;
    const lesson = "lesson0012ab";
    const at = { ...where(), lessonId: lesson };
    const w = world();
    const opened = await openSubmissionDoor({ ...ask(), lessonId: lesson }, w.steps);
    const path = opened.ok ? opened.upload.pathname : "";
    const close = () =>
      closeSubmissionDoor({ ...at, data: SHOP, note: "" }, path, ["e"], NOW, w.steps).then(
        (value) => (value.ok ? "ok" : value.reason),
        (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : String(error)),
      );
    let second: Promise<string> = Promise.resolve("not started");
    const original = redis.pipeline.bind(redis);
    let wrote = false;
    let readBack = false;
    redis.pipeline = (async (list: (string | number)[][]) => {
      if (!wrote && firstIs(list, CLOSE_WRITE)) {
        wrote = true;
        return [];
      }
      if (wrote && !readBack && String(list[0]?.[0]) === "GET" && String(list[0]?.[1]).startsWith("nl:sub:rec:")) {
        readBack = true;
        const answer = await original(list);
        second = close();
        await second;
        return answer;
      }
      return original(list);
    }) as typeof redis.pipeline;
    const first = await close();
    redis.pipeline = PIPELINE;
    const kept = await readSubmission(FOLDER, idOf(path));
    const deleted = w.calls.includes("vault:delete");
    is("the first close, its write answered out of shape, is unknown", first, "unknown");
    is("a file is never deleted while a record names it", Boolean(kept) && deleted, false);
    is("and a close told it was kept still has its file", (await second) === "ok" && deleted, false);
  }
  {
    redis.pipeline = PIPELINE;
    const lesson = "lesson0013ab";
    const at = { ...where(), lessonId: lesson };
    let down = true;
    const w = world({
      closeReservedVault: async (pathname) =>
        down ? { ok: false, reason: "unavailable" } : { ok: true, file: { pathname, bytes: 50 * MiB, contentType: "video/mp4" } },
    });
    const opened = await openSubmissionDoor({ ...ask(), lessonId: lesson }, w.steps);
    const path = opened.ok ? opened.upload.pathname : "";
    is("control: the vault not confirming the close keeps nothing", await closeSubmissionDoor({ ...at, data: SHOP, note: "" }, path, ["e"], NOW, w.steps), { ok: false, reason: "unavailable" });
    down = false;
    const again = await closeSubmissionDoor({ ...at, data: SHOP, note: "" }, path, ["e"], NOW + 60, w.steps);
    is("and the upload is still open, so closing it again keeps it", again.ok, true);
    is("with no file deleted", w.calls.includes("vault:delete"), false);
  }
  {
    const lesson = "lesson0006ab";
    const at = { ...where(), lessonId: lesson };
    const w = world();
    const opened = await openSubmissionDoor({ ...ask(), lessonId: lesson }, w.steps);
    const path = opened.ok ? opened.upload.pathname : "";
    const room = contentRoomFor(SHOP, NOW);
    const used = (await dataUsed(SHOP))?.used ?? 0;
    await takeData(SHOP, [{ slot: "p:filler", bytes: Math.max(0, room - used - 64), set: true }]);
    is("a full data room keeps no record", await closeSubmissionDoor({ ...at, data: SHOP, note: "" }, path, ["e"], NOW, w.steps), { ok: false, reason: "full" });
    is("and its file is deleted", w.calls.includes("vault:delete"), true);
    await takeData(SHOP, [{ slot: "p:filler", bytes: 0, set: true }]);
  }
  {
    const lesson = "lesson0007ab";
    const at = { ...where(), lessonId: lesson };
    const w = world();
    const opened = await openSubmissionDoor({ ...ask(), lessonId: lesson }, w.steps);
    const path = opened.ok ? opened.upload.pathname : "";
    is("another buyer cannot give it up", await abortSubmissionDoor({ ...at, who: BOB }, path, w.steps), "unknown");
    const stuck = world({ abortReservedVault: async () => false });
    is("the vault did not confirm", await abortSubmissionDoor(at, path, stuck.steps), "unavailable");
    is("so the place is kept", await liveCount(FOLDER, COURSE, lesson, ANA, NOW), 1);
    const given = await commandsOf(() => abortSubmissionDoor(at, path, w.steps));
    is("the buyer gives it up", given.value, "done");
    is("inside its commands", given.commands <= SUBMISSION_STEP_COMMANDS.abort, true);
    is("its place comes back", await liveCount(FOLDER, COURSE, lesson, ANA, NOW), 0);
    is("and its door is gone", await signSubmissionDoor(at, path, [1], w.steps), { ok: false, reason: "unknown" });
  }
}

main().then(done, (error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
