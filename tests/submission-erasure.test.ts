/**
 * 750 [CD1] unit 3: a buyer's files sent for review leave with the person,
 * are in the copy of their data, and go at the end of their keeping time
 * (lib/submission-store.ts), on the in-memory Redis with the vault stood in
 * for. What is checked:
 *
 *   - one buyer keeps at most MAX_SUBMISSIONS_PER_PERSON in a store, so the
 *     erasure's cost is bounded (lib/erasure-rules.ts, ERASE_SUBMISSIONS);
 *   - deleting a person gives up their open uploads, deletes their records
 *     and doors, hands every file of theirs to the erasure, takes them off the
 *     sweep's list and lets their places go; another buyer's stay; an upload
 *     the vault did not give up, or an entry that does not read, leaves the
 *     erasure unfinished, never "done";
 *   - the copy of their data has each file they sent and each upload open,
 *     and says when a record could not be read;
 *   - the daily sweep deletes each file whose keeping time ended, then its
 *     record, at most SUBMISSION_SWEEP_PER_RUN a run; a file the vault did not
 *     delete, or an entry that does not read, stays on the list and is tried
 *     again the next day; a list that cannot be read is unknown.
 *
 * That the erasure runs it, the registry says it is erased and the copy
 * copies it is held by tests/person-data-registry.test.ts and tests/person-copy.test.ts.
 */
import { MAX_SUBMISSIONS_PER_PERSON, type SubmissionSetup } from "@/lib/submission-rules";
import {
  SUBMISSION_SWEEP_PER_RUN,
  SUBMISSION_SWEEP_RETRY_SECONDS,
  type DoorSteps,
  closeSubmissionDoor,
  forgetSubmissionsPerson,
  liveCount,
  openSubmissionDoor,
  readSubmission,
  submissionsCopyOf,
  sweepSubmissions,
} from "@/lib/submission-store";
import { ERASE_SUBMISSIONS } from "@/lib/erasure-rules";
import type { DataStore } from "@/lib/store-data";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const MiB = 1024 * 1024;
const DAY = 86_400;
const FOLDER = "0123456789abcdef0123456789abcdef";
const COURSE = "course0001ab";
const ANA = "a".repeat(32);
const BOB = "b".repeat(32);
const SHOP: DataStore & { statsId: string; tier: "creator" } = { sid: "submission-erasure-0", statsId: "c".repeat(32), tier: "creator", subscriptionActive: true, subscriptionId: "sub_x", trialEnds: 0, planEndedAt: "" };
const SETUP: SubmissionSetup = { instruction: "Send your form check.", kinds: ["video", "pdf"], maxBytes: 200 * MiB, keepDays: 30 };
const NOW = 1_800_000_000;
const lesson = (n: number) => `lesson${String(n).padStart(4, "0")}ab`;

function world(overrides: Partial<DoorSteps> = {}) {
  const calls: string[] = [];
  let n = 0;
  const steps: DoorSteps = {
    reserveStoreUpload: async () => true,
    openReservedVault: async (input) => {
      n += 1;
      return { ok: true, sessionId: "s", upload: { pathname: `vault/${input.folder}/${input.ownerId}/${String(n).padStart(16, "0")}-${input.name}`, pieces: 1, pieceBytes: 16 * MiB, multipart: true } };
    },
    reserveUploadControl: async () => true,
    signPieces: async () => [],
    closeReservedVault: async (pathname) => ({ ok: true, file: { pathname, bytes: 5 * MiB, contentType: "video/mp4" } }),
    abortReservedVault: async (pathname) => (calls.push(`abort ${pathname}`), true),
    deleteVault: async (paths) => (calls.push(`delete ${paths.join()}`), true),
    ...overrides,
  };
  return { steps, calls };
}
const ask = (who: string, lessonId: string, nowSeconds = NOW) => ({
  store: SHOP,
  data: SHOP as DataStore,
  folder: FOLDER,
  courseId: COURSE,
  lessonId,
  who,
  email: who === ANA ? "ana@example.com" : "bob@example.com",
  setup: SETUP,
  file: { bytes: 5 * MiB, type: "video/mp4", name: "form.mp4", limitBytes: 5 * 1024 * MiB },
  nowSeconds,
});
/** Opens and, unless `open`, closes one submission; answers its file's path and id. */
async function send(who: string, lessonId: string, steps: DoorSteps, open = false, nowSeconds = NOW): Promise<{ path: string; id: string }> {
  const opened = await openSubmissionDoor(ask(who, lessonId, nowSeconds), steps);
  if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
  const path = opened.upload.pathname;
  const id = path.split("/")[2].slice(4);
  if (!open) {
    const closed = await closeSubmissionDoor({ store: SHOP, folder: FOLDER, courseId: COURSE, lessonId, who, data: SHOP, note: "Week one." }, path, ["e"], nowSeconds, steps);
    if (!closed.ok) throw new Error(`close refused: ${closed.reason}`);
  }
  return { path, id };
}
async function commandsOf<T>(work: () => Promise<T>): Promise<{ value: T; commands: number; bytes: number }> {
  const original = redis.pipeline.bind(redis);
  let commands = 0;
  let bytes = 0;
  redis.pipeline = (async (list: (string | number)[][]) => {
    const reply = await original(list);
    commands += list.length;
    bytes += JSON.stringify(list).length + JSON.stringify(reply).length;
    return reply;
  }) as typeof redis.pipeline;
  try {
    return { value: await work(), commands, bytes };
  } finally {
    redis.pipeline = original;
  }
}
const threw = async (work: () => Promise<unknown>) => work().then(() => "no", (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : String(error)));
/** The paths on the sweep's list (each kept as "<folder>|<path>"). */
const due = async () => ((await redis.pipeline([["ZRANGEBYSCORE", "nl:sub:due", "-inf", "+inf"]]))[0] as string[]).map((member) => member.slice(member.indexOf("|") + 1));

async function main(): Promise<void> {
  part("At most a fixed number per buyer in a store");
  {
    const { steps } = world();
    const who = "d".repeat(32);
    let opened = 0;
    for (let i = 0; opened < MAX_SUBMISSIONS_PER_PERSON; i += 1) {
      await send(who, lesson(100 + Math.floor(i / 3)), steps);
      opened += 1;
    }
    const over = await openSubmissionDoor(ask(who, lesson(199)), steps);
    is("one more, on a lesson with room, is refused", over, { ok: false, reason: "busy" });
    is("and holds no place there", await liveCount(FOLDER, COURSE, lesson(199), who, NOW), 0);
    const files: string[] = [];
    const measured = await commandsOf(() => forgetSubmissionsPerson(FOLDER, who, files, steps));
    is("deleting a person at the cap deletes every one", measured.value, MAX_SUBMISSIONS_PER_PERSON);
    // Each open upload given up at the real vault reads and deletes its record and gives its reservation back: eight at most.
    is("and stays inside what the erasure counts for it, every one an open upload at its worst", measured.commands + 8 * MAX_SUBMISSIONS_PER_PERSON <= ERASE_SUBMISSIONS[0], true);
    is("in bytes too", measured.bytes + 1_024 * MAX_SUBMISSIONS_PER_PERSON <= ERASE_SUBMISSIONS[1], true);
    is("and frees the buyer to send again", (await openSubmissionDoor(ask(who, lesson(199)), steps)).ok, true);
  }

  part("Deleting a person");
  {
    const { steps, calls } = world();
    const first = await send(ANA, lesson(1), steps);
    const second = await send(ANA, lesson(2), steps);
    const open = await send(ANA, lesson(3), steps, true);
    const bobs = await send(BOB, lesson(1), steps);
    calls.length = 0;
    const files: string[] = [];
    const gone = await forgetSubmissionsPerson(FOLDER, ANA, files, steps);
    is("their two records go", gone, 2);
    is("their open upload is given up at the vault", calls, [`abort ${open.path}`]);
    is("every file of theirs goes to the erasure to be deleted", [...files].sort(), [first.path, second.path, open.path].sort());
    is("their records are gone", [await readSubmission(FOLDER, first.id), await readSubmission(FOLDER, second.id)], [null, null]);
    is("their files are off the sweep's list", (await due()).filter((p) => p !== bobs.path), []);
    is("their places are let go", await liveCount(FOLDER, COURSE, lesson(1), ANA, NOW), 0);
    is("another buyer's record stays", (await readSubmission(FOLDER, bobs.id))?.path, bobs.path);
    is("and is still on the list", (await due()).includes(bobs.path), true);
    is("deleted again, nothing more goes", await forgetSubmissionsPerson(FOLDER, ANA, [], steps), 0);
  }
  {
    const stuck = world({ abortReservedVault: async () => false });
    const open = await send("e".repeat(32), lesson(4), stuck.steps, true);
    is("an upload the vault did not give up leaves the erasure unfinished", await threw(() => forgetSubmissionsPerson(FOLDER, "e".repeat(32), [], stuck.steps)), "Error: a submission upload could not be given up");
    is("and its door is kept for the retry", (await submissionsCopyOf(FOLDER, "e".repeat(32))).length, 1);
    is("pressed again once the vault answers, it finishes", await forgetSubmissionsPerson(FOLDER, "e".repeat(32), [], world().steps), 0);
    void open;
    await redis.pipeline([["ZADD", `nl:sub:who:${FOLDER}:${"f".repeat(32)}`, NOW + DAY, "not|an entry"]]);
    is("an entry that does not read is unknown, never left out", await threw(() => forgetSubmissionsPerson(FOLDER, "f".repeat(32), [], world().steps)), "unknown");
  }

  part("The copy of their data");
  {
    const { steps } = world();
    const who = "1".repeat(32);
    const kept = await send(who, lesson(5), steps);
    await send(who, lesson(6), steps, true);
    const copy = (await submissionsCopyOf(FOLDER, who)) as Record<string, unknown>[];
    is("each file sent, as sent", copy.find((r) => r.lesson === lesson(5)), {
      course: COURSE,
      lesson: lesson(5),
      file: "form.mp4",
      bytes: 5 * MiB,
      type: "video/mp4",
      note: "Week one.",
      sent: new Date(NOW * 1000).toISOString(),
      keptUntil: new Date((NOW + 30 * DAY) * 1000).toISOString(),
      state: "submitted",
      reply: null,
    });
    is("and the upload still open", copy.find((r) => r.lesson === lesson(6))?.state, "uploading");
    await redis.pipeline([["SET", `nl:sub:rec:${FOLDER}:${kept.id}`, "{broken"]]);
    const said = (await submissionsCopyOf(FOLDER, who)) as Record<string, unknown>[];
    is("a record that does not read is said, never left out", typeof said.find((r) => r.lesson === lesson(5))?.unread, "string");
  }

  part("The daily sweep at the end of the keeping time");
  {
    await redis.pipeline([["DEL", "nl:sub:due"]]);
    const { steps, calls } = world();
    const who = "2".repeat(32);
    const kept = await send(who, lesson(7), steps);
    calls.length = 0;
    is("nothing is due before its keeping time ends", await sweepSubmissions(NOW + 30 * DAY - 1, steps), { deleted: 0, retried: 0 });
    is("and nothing was deleted", calls, []);
    const broken = world({ deleteVault: async () => false });
    is("a file the vault did not delete is kept on the list", await sweepSubmissions(NOW + 30 * DAY, broken.steps), { deleted: 0, retried: 1 });
    is("its record is kept", (await readSubmission(FOLDER, kept.id))?.path, kept.path);
    is("and it is not tried again the same day", await sweepSubmissions(NOW + 30 * DAY + 60, steps), { deleted: 0, retried: 0 });
    is("it is tried the next day, and goes", await sweepSubmissions(NOW + 30 * DAY + SUBMISSION_SWEEP_RETRY_SECONDS, steps), { deleted: 1, retried: 0 });
    is("the file first", calls, [`delete ${kept.path}`]);
    is("then its record", await readSubmission(FOLDER, kept.id), null);
    is("and it is off the list", await due(), []);
  }
  {
    await redis.pipeline([["DEL", "nl:sub:due"]]);
    const many: (string | number)[] = [];
    for (let i = 0; i < SUBMISSION_SWEEP_PER_RUN + 5; i += 1) many.push(NOW - 10, `${FOLDER}|vault/${FOLDER}/sub_${i.toString(16).padStart(32, "0")}/${"0".repeat(16)}-a.pdf`);
    await redis.pipeline([["ZADD", "nl:sub:due", ...many], ["ZADD", "nl:sub:due", NOW - 20, "not a path"]]);
    const run = await sweepSubmissions(NOW, world().steps);
    is("one run deletes at most its ceiling", run.deleted + run.retried, SUBMISSION_SWEEP_PER_RUN);
    is("an entry that does not read is kept and tried again, never dropped", run.retried, 1);
    is("the six past the ceiling wait for the next run, with the one kept for tomorrow", (await due()).length, 7);
    is("the entry that does not read is still there", (await due()).includes("not a path"), true);
    const original = redis.pipeline.bind(redis);
    redis.pipeline = (async () => [7]) as unknown as typeof redis.pipeline;
    const unknown = await threw(() => sweepSubmissions(NOW, world().steps));
    redis.pipeline = original;
    is("a list that cannot be read is unknown, never nothing due", unknown, "unknown");
  }
  part("A file a close keeps without a known record still reaches the sweep (review of #3568, Codex C2)");
  {
    await redis.pipeline([["DEL", "nl:sub:due"]]);
    /** The next record write is answered as `answer` says: sent and never answered, or answered with nothing and not run. */
    const onRecordWrite = (answer: "never answered" | "out of shape") => {
      const original = redis.pipeline.bind(redis);
      redis.pipeline = (async (list: (string | number)[][]) => {
        if (list.some((command) => String(command[0]) === "SET" && String(command[1]).startsWith("nl:sub:rec:"))) {
          redis.pipeline = original;
          if (answer === "never answered") throw new Error("fetch failed");
          return [];
        }
        return original(list);
      }) as typeof redis.pipeline;
    };
    const close = (who: string, lessonId: string, path: string, steps: DoorSteps) =>
      closeSubmissionDoor({ store: SHOP, folder: FOLDER, courseId: COURSE, lessonId, who, data: SHOP, note: "" }, path, ["e"], NOW, steps);
    const { steps, calls } = world();
    const who = "3".repeat(32);
    const lost = await send(who, lesson(8), steps, true);
    onRecordWrite("never answered");
    is("a close whose record write was never answered is not known", await threw(() => close(who, lesson(8), lost.path, steps)), "Error: fetch failed");
    is("its file is kept: the write may have landed", calls.filter((call) => call.startsWith("delete")), []);
    is("and it is on the sweep's list, so it never outlives the keeping time", await due(), [lost.path]);
    const stuck = world({ deleteVault: async () => false });
    const absent = await send(who, lesson(9), stuck.steps, true);
    onRecordWrite("out of shape");
    is("a record Redis confirms was not written is unknown too", await threw(() => close(who, lesson(9), absent.path, stuck.steps)), "unknown");
    is("its file, which the vault did not delete, is on the list as well", (await due()).sort(), [lost.path, absent.path].sort());
    calls.length = 0;
    is("the sweep deletes both when the keeping time ends", await sweepSubmissions(NOW + 30 * DAY, steps), { deleted: 2, retried: 0 });
    is("those files", calls.sort(), [`delete ${lost.path}`, `delete ${absent.path}`].sort());
    is("and the list is empty", await due(), []);
  }

  part("A file completed whose record and its recovery both fail still reaches the sweep (review of #3570, Codex C2)");
  {
    await redis.pipeline([["DEL", "nl:sub:due"]]);
    const { steps, calls } = world();
    const who = "4".repeat(32);
    const both = await send(who, lesson(10), steps, true);
    // The record write and then the read-back that would recover it are each sent and never answered, and neither ran.
    const original = redis.pipeline.bind(redis);
    let failed = 0;
    redis.pipeline = (async (list: (string | number)[][]) => {
      const record = list.some((command) => String(command[0]) === "SET" && String(command[1]).startsWith("nl:sub:rec:"));
      const readBack = String(list[0]?.[0]) === "GET" && String(list[0]?.[1]).startsWith("nl:sub:rec:");
      if ((failed === 0 && record) || (failed === 1 && readBack)) {
        failed += 1;
        if (failed === 2) redis.pipeline = original;
        throw new Error("fetch failed");
      }
      return original(list);
    }) as typeof redis.pipeline;
    const result = await threw(() =>
      closeSubmissionDoor({ store: SHOP, folder: FOLDER, courseId: COURSE, lessonId: lesson(10), who, data: SHOP, note: "" }, both.path, ["e"], NOW, steps),
    );
    redis.pipeline = original;
    is("control: both requests failed, and the close is not known", [failed, result], [2, "Error: fetch failed"]);
    is("control: no record was written", await readSubmission(FOLDER, both.id), null);
    is("its file is kept for now", calls.filter((call) => call.startsWith("delete")), []);
    is("but it is on the sweep's list all the same", await due(), [both.path]);
    is("so the sweep deletes it once the keeping time ends", await sweepSubmissions(NOW + 31 * DAY, steps), { deleted: 1, retried: 0 });
    is("that file", calls.filter((call) => call.startsWith("delete")), [`delete ${both.path}`]);
  }

  done();
}

main().then(
  () => undefined,
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
