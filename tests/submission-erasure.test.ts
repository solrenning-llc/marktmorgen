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
  abortSubmissionDoor,
  buyerSlotFor,
  closeSubmissionDoor,
  forgetSubmissionsPerson,
  liveCount,
  openSubmissionDoor,
  readSubmission,
  submissionsCopyOf,
  sweepSubmissions,
} from "@/lib/submission-store";
import { ERASE_SUBMISSIONS } from "@/lib/erasure-rules";
import { type DataStore, dataKey } from "@/lib/store-data";
import { UnknownReplyError } from "@/lib/redis-reply";
import { suppressCommand } from "@/lib/suppression";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const MiB = 1024 * 1024;
const DAY = 86_400;
const FOLDER = "0123456789abcdef0123456789abcdef";
const COURSE = "course0001ab";
const ANA = "a".repeat(32);
const BOB = "b".repeat(32);
/** The store's list id, under which its deleted people are kept (lib/suppression.ts). */
const LIST = "list_submission_erasure";
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
  listId: LIST,
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
    const measured = await commandsOf(() => forgetSubmissionsPerson(FOLDER, who, files, steps, SHOP));
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
    const slotOf = async (who: string, at: string) => (await redis.pipeline([["HGET", dataKey(SHOP) ?? "", buyerSlotFor(FOLDER, COURSE, at, who) ?? ""]]))[0];
    is("control: their room slots are there before", (await Promise.all([1, 2, 3].map((n) => slotOf(ANA, lesson(n))))).every((v) => v !== null), true);
    const gone = await forgetSubmissionsPerson(FOLDER, ANA, files, steps, SHOP);
    is("their two records go", gone, 2);
    is("their open upload is given up at the vault", calls, [`abort ${open.path}`]);
    is("every file of theirs goes to the erasure to be deleted", [...files].sort(), [first.path, second.path, open.path].sort());
    is("their records are gone", [await readSubmission(FOLDER, first.id), await readSubmission(FOLDER, second.id)], [null, null]);
    // Left due at once on the sweep's list (Claude 6 on #3570): the next daily sweep deletes them if the erasure's own
    // delete does not happen.
    const dueScores = await redis.pipeline([first.path, second.path, open.path].map((p) => ["ZSCORE", "nl:sub:due", `${FOLDER}|${p}`]));
    is("their files stay on the sweep's list, due at once", dueScores.every((score) => score !== null && Number(score) <= NOW), true);
    is("their places are let go", await liveCount(FOLDER, COURSE, lesson(1), ANA, NOW), 0);
    is("their room slots are emptied, so the store's room keeps nothing of them", await Promise.all([1, 2, 3].map((n) => slotOf(ANA, lesson(n)))), [null, null, null]);
    is("another buyer's slot stays", (await slotOf(BOB, lesson(1))) !== null, true);
    // Their slots' turns on the store's list name them (review of #3568, Claude 6): taken off with them, another's kept.
    const turns = ((await redis.pipeline([["ZRANGEBYSCORE", `nl:sub:slots:${FOLDER}`, "-inf", "+inf"]]))[0] as string[]) ?? [];
    is("their slots' turns on the store's list are gone with them", turns.filter((member) => member.endsWith(`|${ANA}`)), []);
    is("another buyer's turn stays", turns.some((member) => member.endsWith(`|${BOB}`)), true);
    is("another buyer's record stays", (await readSubmission(FOLDER, bobs.id))?.path, bobs.path);
    is("and is still on the list", (await due()).includes(bobs.path), true);
    is("deleted again, nothing more goes", await forgetSubmissionsPerson(FOLDER, ANA, [], steps), 0);
  }
  {
    const stuck = world({ abortReservedVault: async () => false });
    const open = await send("e".repeat(32), lesson(4), stuck.steps, true);
    is("an upload the vault did not give up leaves the erasure unfinished", await threw(() => forgetSubmissionsPerson(FOLDER, "e".repeat(32), [], stuck.steps)), "Error: a submission upload could not be given up");
    is("and its door is kept for the retry", (await submissionsCopyOf(FOLDER, "e".repeat(32))).length, 1);
    // lib/vault.ts (#3502) answers a cancel it did not make with "busy" or "tries": neither gave the upload up, so the
    // erasure is not finished and the door stays for the retry, as when the vault could not confirm.
    for (const refused of ["busy", "tries"] as const) {
      const held = world({ abortReservedVault: async () => refused });
      is(`the vault answered "${refused}": the erasure is not finished`, await threw(() => forgetSubmissionsPerson(FOLDER, "e".repeat(32), [], held.steps)), "Error: a submission upload could not be given up");
      is(`the vault answered "${refused}": the door is kept for the retry`, (await submissionsCopyOf(FOLDER, "e".repeat(32))).length, 1);
    }
    is("pressed again once the vault answers, it finishes", await forgetSubmissionsPerson(FOLDER, "e".repeat(32), [], world().steps), 0);
    void open;
    await redis.pipeline([["ZADD", `nl:sub:who:${FOLDER}:${"f".repeat(32)}`, NOW + DAY, "not|an entry"]]);
    is("an entry that does not read is unknown, never left out", await threw(() => forgetSubmissionsPerson(FOLDER, "f".repeat(32), [], world().steps)), "unknown");
  }

  part("A retry can still empty the buyer's room after an unconfirmed room update");
  {
    const { steps } = world();
    const who = "2".repeat(32);
    const lessonId = lesson(231);
    await send(who, lessonId, steps);
    const roomKey = dataKey(SHOP) ?? "";
    const slot = buyerSlotFor(FOLDER, COURSE, lessonId, who) ?? "";
    const whoKey = `nl:sub:who:${FOLDER}:${who}`;
    const original = redis.pipeline.bind(redis);
    is("control: the buyer's room slot exists before erasure", (await original([["HGET", roomKey, slot]]))[0] !== null, true);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((command) => command[0] === "EVAL" && command[3] === roomKey)) return [];
      return original(commands);
    }) as typeof redis.pipeline;
    try {
      is("the unreadable room write stops erasure", await threw(() => forgetSubmissionsPerson(FOLDER, who, [], steps, SHOP)), "unknown");
    } finally {
      redis.pipeline = original;
    }
    is("the index still names the buyer's lesson for the retry", (await original([["EXISTS", whoKey]]))[0], 1);
    await forgetSubmissionsPerson(FOLDER, who, [], steps, SHOP);
    is("retry empties the slot and finally removes the index", await original([["HGET", roomKey, slot], ["EXISTS", whoKey]]), [null, 0]);
  }

  part("An erased buyer's file stays on the sweep's list until it is deleted (Claude 6 on #3570, MEDIUM)");
  {
    // The erasure hands the path to its caller, which deletes it at the end; if that delete never happens (it fails and
    // its fallback fails too, or the function stops first), the sweep's entry is the file's only durable reminder.
    const who = "c".repeat(32);
    const { steps } = world();
    const sent = await send(who, lesson(40), steps);
    const files: string[] = [];
    is("control: the file is on the sweep's list before", (await due()).includes(sent.path), true);
    await forgetSubmissionsPerson(FOLDER, who, files, steps, SHOP);
    is("control: the erasure names the file to its caller", files.includes(sent.path), true);
    // The caller's delete never happens here.
    is("the file stays on the sweep's list after the erasure", (await due()).includes(sent.path), true);
    is("pressed again, nothing is left to find", await forgetSubmissionsPerson(FOLDER, who, [], steps), 0);
    const sweeper = world();
    await sweepSubmissions(NOW + 400 * DAY, sweeper.steps);
    is("so the daily sweep deletes the erased buyer's file", sweeper.calls.includes(`delete ${sent.path}`), true);
    is("and then it is off the list", (await due()).includes(sent.path), false);
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
    // The course is named by the product the buyer bought, as the other course records of the copy are (Claude 5 and
    // Claude 3 on #3570, LOW); a course no longer in the store keeps its own id.
    const named = (await submissionsCopyOf(FOLDER, who, (id) => (id === COURSE ? "prod_course" : null))) as Record<string, unknown>[];
    is("the course is named by its product, in every kind of record", [...new Set(named.map((r) => r.course))], ["prod_course"]);
    const gone = (await submissionsCopyOf(FOLDER, who, () => null)) as Record<string, unknown>[];
    is("a course with no product left keeps its own id", [...new Set(gone.map((r) => r.course))], [COURSE]);
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
        if (list.some((command) => (String(command[0]) === "SET" || String(command[0]) === "EVAL") && command.some((arg) => String(arg).startsWith("nl:sub:rec:")))) {
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
      const record = list.some((command) => (String(command[0]) === "SET" || String(command[0]) === "EVAL") && command.some((arg) => String(arg).startsWith("nl:sub:rec:")));
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

  part("An erasure that runs while a close is at the vault is never undone by that close (Claude 1 on #3570)");
  {
    const who = "7".repeat(32);
    let erased: number | string = "not run";
    const erasedFiles: string[] = [];
    const racing = world({
      closeReservedVault: async (pathname) => {
        // The buyer's erasure runs while the vault completes the file, and says done.
        erased = await forgetSubmissionsPerson(FOLDER, who, erasedFiles, world().steps);
        return { ok: true, file: { pathname, bytes: 5 * MiB, contentType: "video/mp4" } };
      },
    });
    const opened = await openSubmissionDoor(ask(who, lesson(30)), racing.steps);
    if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
    const path = opened.upload.pathname;
    const id = path.split("/")[2].slice(4);
    const closed = await closeSubmissionDoor({ store: SHOP, folder: FOLDER, courseId: COURSE, lessonId: lesson(30), who, data: SHOP, note: "Private note." }, path, ["e"], NOW, racing.steps).catch((error: unknown) => ({ thrown: String(error) }));
    is("control: the erasure ran and said done, naming the file", [erased, erasedFiles.includes(path)], [0, true]);
    is("the close is not said kept", (closed as { ok?: boolean }).ok === true, false);
    is("after an erasure said done, no record of the erased buyer remains", await readSubmission(FOLDER, id), null);
    // An empty index counts as none (Redis drops a sorted set with no member; the stand-in may keep the key).
    const left = await redis.pipeline([["ZCARD", `nl:sub:who:${FOLDER}:${who}`], ["ZSCORE", "nl:sub:due", `${FOLDER}|${path}`]]);
    // The erasure leaves the file due at once on the sweep's list (Claude 6 on #3570); the close does not push it later.
    is("nor their index; the file's sweep entry stays due at once", [left[0], left[1] !== null && Number(left[1]) <= NOW], [0, true]);
    is("and the completed file is deleted", racing.calls.includes(`delete ${path}`), true);

    // Control: with no erasure, a close still keeps its record.
    const plain = world();
    const sent = await send("9".repeat(32), lesson(31), plain.steps);
    is("an ordinary close keeps its record", (await readSubmission(FOLDER, sent.id))?.state, "submitted");
  }

  part("A close that writes between the erasure's record delete and its places' removal is undone (Codex N1 on #3570, MEDIUM)");
  {
    // The narrower gap of N1-20261120-0616: the close has taken its door and waits at the vault; the erasure deletes
    // the buyer's records, and only then does the close's write run, while the buyer's place and index entry are still
    // there. Its record must never outlive the erasure that said done.
    const who = "6".repeat(32);
    let openVault!: () => void;
    const atVault = new Promise<void>((resolve) => (openVault = resolve));
    const racing = world({
      closeReservedVault: async (pathname) => {
        await atVault;
        return { ok: true, file: { pathname, bytes: 5 * MiB, contentType: "video/mp4" } };
      },
    });
    const opened = await openSubmissionDoor(ask(who, lesson(32)), racing.steps);
    if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
    const path = opened.upload.pathname;
    const id = path.split("/")[2].slice(4);
    const closing = closeSubmissionDoor({ store: SHOP, folder: FOLDER, courseId: COURSE, lessonId: lesson(32), who, data: SHOP, note: "Private note." }, path, ["e"], NOW, racing.steps).catch((error: unknown) => ({ thrown: String(error) }));
    // Let the close take its door and reach the vault.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    const original = redis.pipeline.bind(redis);
    let closedInGap = false;
    redis.pipeline = (async (list: (string | number)[][]) => {
      const reply = await original(list);
      // Right after the erasure deletes this buyer's record, the close at the vault goes on and writes.
      if (!closedInGap && list.some((command) => command[0] === "DEL" && command[1] === `nl:sub:rec:${FOLDER}:${id}`)) {
        closedInGap = true;
        redis.pipeline = original;
        openVault();
        await closing;
      }
      return reply;
    }) as typeof redis.pipeline;
    const erasedFiles: string[] = [];
    let erased: number | string;
    try {
      erased = await forgetSubmissionsPerson(FOLDER, who, erasedFiles, world().steps).catch((error: unknown) => String(error));
    } finally {
      redis.pipeline = original;
    }
    is("control: the close ran inside the erasure, after its record delete", closedInGap, true);
    is("the erasure said done, naming the file", [typeof erased, erasedFiles.includes(path)], ["number", true]);
    is("after the erasure said done, no record of the erased buyer remains", await readSubmission(FOLDER, id), null);
    const left = await redis.pipeline([["ZCARD", `nl:sub:who:${FOLDER}:${who}`], ["ZRANGEBYSCORE", `nl:sub:list:${FOLDER}:${COURSE}`, "-inf", "+inf"], ["ZSCORE", "nl:sub:due", `${FOLDER}|${path}`]]);
    is("nor their index, nor a line on the studio's list", [left[0], (left[1] as string[]).some((member) => member.includes(id))], [0, false]);
    is("and the file stays due at once on the sweep's list", left[2] !== null && Number(left[2]) <= NOW, true);
  }

  // Review of #3570 (Claude 1 cloud, MEDIUM; taken by Claude 3): an abort that read the door, then a close that took it
  // and wrote its record while the abort was at the vault, then the abort letting the place and the index entry go.
  part("An abort and a close of the same upload: only one of them ever owns it");
  {
    const who = "6".repeat(32);
    const at = { store: SHOP, folder: FOLDER, courseId: COURSE, lessonId: lesson(40), who, data: SHOP as DataStore };
    const opened = await openSubmissionDoor(ask(who, lesson(40)), world().steps);
    if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
    const path = opened.upload.pathname;
    const id = path.split("/")[2].slice(4);
    let closedMeanwhile: unknown = "not run";
    const racing = world({
      abortReservedVault: async () => {
        // The close runs to its end while the abort waits on the vault, and the vault then says the upload is gone.
        closedMeanwhile = await closeSubmissionDoor({ ...at, note: "" }, path, ["e"], NOW, world().steps);
        return true;
      },
    });
    const given = await abortSubmissionDoor(at, path, racing.steps, NOW);
    const kept = (closedMeanwhile as { ok?: boolean }).ok === true;
    is("control: one of them finished", given === "done" || kept, true);
    const files: string[] = [];
    await forgetSubmissionsPerson(FOLDER, who, files, world().steps, SHOP);
    is("after the buyer's erasure, no record of them remains", await readSubmission(FOLDER, id), null);
    is("and a kept file is handed to the erasure, never left behind", !kept || files.includes(path), true);
  }

  // Review of #3570 (Claude 1 cloud, MEDIUM): an erasure during a close took the file off the sweep's list, and the
  // close's own delete of the completed file failed: nothing would ever delete it.
  part("A completed file the close could not delete, after an erasure, goes back on the sweep's list");
  {
    const who = "5".repeat(32);
    const files: string[] = [];
    const racing = world({
      closeReservedVault: async (pathname) => {
        await forgetSubmissionsPerson(FOLDER, who, files, world().steps, SHOP);
        return { ok: true, file: { pathname, bytes: 5 * MiB, contentType: "video/mp4" } };
      },
      deleteVault: async () => false,
    });
    const opened = await openSubmissionDoor(ask(who, lesson(41)), racing.steps);
    if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
    const path = opened.upload.pathname;
    await closeSubmissionDoor({ store: SHOP, folder: FOLDER, courseId: COURSE, lessonId: lesson(41), who, data: SHOP, note: "" }, path, ["e"], NOW, racing.steps).catch(() => null);
    const score = (await redis.pipeline([["ZSCORE", "nl:sub:due", `${FOLDER}|${path}`]]))[0];
    is("the file is due on the sweep's list again, from now", score !== null && Number(score) <= NOW, true);
  }

  // Review of #3570 (Claude 1 cloud, LOW): an erasure between the place and the door's write made the open fail, and its
  // catch kept the door it had just written, with the buyer's address, for up to a day. Since Codex L-20261120-2049 the
  // door's write is fenced on the place (SUBMISSION_DOOR_OPEN_WRITE): the open is refused, and no door is written at all.
  part("An open whose place an erasure took before its door's write is refused and writes no door");
  {
    const who = "4".repeat(32);
    let id = "";
    const racing = world({
      openReservedVault: async (input) => {
        id = input.ownerId.slice(4);
        await forgetSubmissionsPerson(FOLDER, who, [], world().steps, SHOP);
        return { ok: true, sessionId: "s", upload: { pathname: `vault/${input.folder}/${input.ownerId}/0000000000000001-${input.name}`, pieces: 1, pieceBytes: 16 * MiB, multipart: true } };
      },
    });
    is("the open is refused", await openSubmissionDoor(ask(who, lesson(42)), racing.steps), { ok: false, reason: "unavailable" });
    is("its provider session is cancelled", racing.calls.some((call) => call.startsWith("abort ")), true);
    is("and no door was written", (await redis.pipeline([["EXISTS", `nl:sub:door:${FOLDER}:${id}`]]))[0], 0);
  }

  // Codex N1's MÉDIO on #3570 (RED from Codex U and X4): a close or abort takes the door with GETDEL and waits on the
  // vault; an erasure that runs then finds no door, and a refused vault step must not put the buyer's door back.
  part("A failed vault step cannot put a door back after the buyer was erased");
  {
    const who = "8".repeat(32);
    const files: string[] = [];
    let erased: number | string = "not run";
    const racing = world({
      closeReservedVault: async () => {
        erased = await forgetSubmissionsPerson(FOLDER, who, files, world().steps, SHOP);
        return { ok: false as const, reason: "unavailable" as const };
      },
    });
    const opened = await openSubmissionDoor(ask(who, lesson(43)), racing.steps);
    if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
    const id = opened.upload.pathname.split("/")[2].slice(4);
    const closed = await closeSubmissionDoor(
      { store: SHOP, folder: FOLDER, courseId: COURSE, lessonId: lesson(43), who, data: SHOP, note: "" },
      opened.upload.pathname, ["e"], NOW, racing.steps,
    );
    const door = (await redis.pipeline([["GET", `nl:sub:door:${FOLDER}:${id}`]]))[0];
    is("control: the erasure finished and collected the path", [erased, files.includes(opened.upload.pathname)], [0, true]);
    is("the refused close stays refused without restoring personal data", [closed, door], [{ ok: false, reason: "unavailable" }, null]);
  }
  {
    const who = "0".repeat(32);
    let erased: number | string = "not run";
    const racing = world({
      abortReservedVault: async () => {
        erased = await forgetSubmissionsPerson(FOLDER, who, [], world().steps, SHOP);
        return false;
      },
    });
    const opened = await openSubmissionDoor(ask(who, lesson(44)), racing.steps);
    if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
    const id = opened.upload.pathname.split("/")[2].slice(4);
    const result = await abortSubmissionDoor(
      { store: SHOP, folder: FOLDER, courseId: COURSE, lessonId: lesson(44), who, data: SHOP },
      opened.upload.pathname, racing.steps, NOW,
    );
    const door = (await redis.pipeline([["GET", `nl:sub:door:${FOLDER}:${id}`]]))[0];
    is("control: the erasure finished while abort waited", erased, 0);
    is("the refused abort stays refused without restoring personal data", [result, door], ["unavailable", null]);
  }
  {
    // Control: a refused close for a buyer still there puts the door back, so they can close it again.
    const who = "9".repeat(32);
    const refusing = world({ closeReservedVault: async () => ({ ok: false as const, reason: "unavailable" as const }) });
    const opened = await openSubmissionDoor(ask(who, lesson(45)), refusing.steps);
    if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
    const id = opened.upload.pathname.split("/")[2].slice(4);
    await closeSubmissionDoor(
      { store: SHOP, folder: FOLDER, courseId: COURSE, lessonId: lesson(45), who, data: SHOP, note: "" },
      opened.upload.pathname, ["e"], NOW, refusing.steps,
    );
    is("control: a buyer still there gets the door back after a refused close", typeof (await redis.pipeline([["GET", `nl:sub:door:${FOLDER}:${id}`]]))[0], "string");
  }

  // Claude 6 on #3570 (MEDIUM): an erasure still running before the live places are removed lets a refused vault
  // step put the door back with both checks passing. Pause the place cleanup until the put-back has run.
  part("A refused vault step during a running erasure leaves no door after it says done");
  for (const via of ["close", "abort"] as const) {
    const who = (via === "close" ? "5" : "6").repeat(32);
    const lessonId = lesson(via === "close" ? 46 : 47);
    const original = redis.pipeline.bind(redis);
    let reached!: () => void;
    const atFinal = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    redis.pipeline = (async (list: (string | number)[][]) => {
      if (list.some((c) => c[0] === "DEL" && String(c[1]).startsWith("nl:sub:live:") && String(c[1]).endsWith(`:${who}`))) {
        reached();
        await gate;
      }
      return original(list);
    }) as typeof redis.pipeline;
    let erasure: Promise<number> | null = null;
    const vaultStep = async () => {
      erasure = forgetSubmissionsPerson(FOLDER, who, [], world().steps, SHOP);
      await atFinal;
    };
    const racing = world({
      closeReservedVault: async () => (await vaultStep(), { ok: false as const, reason: "unavailable" as const }),
      abortReservedVault: async () => (await vaultStep(), false),
    });
    try {
      const opened = await openSubmissionDoor(ask(who, lessonId), world().steps);
      if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
      const id = opened.upload.pathname.split("/")[2].slice(4);
      if (via === "close") {
        await closeSubmissionDoor({ store: SHOP, folder: FOLDER, courseId: COURSE, lessonId, who, data: SHOP, note: "" }, opened.upload.pathname, ["e"], NOW, racing.steps);
      } else {
        await abortSubmissionDoor({ store: SHOP, folder: FOLDER, courseId: COURSE, lessonId, who, data: SHOP }, opened.upload.pathname, racing.steps, NOW);
      }
      release();
      const erased = await (erasure as unknown as Promise<number>);
      const door = (await original([["GET", `nl:sub:door:${FOLDER}:${id}`]]))[0];
      is(`${via}: the erasure said done`, erased, 0);
      is(`${via}: no door with the buyer's email is left after the erasure said done`, door, null);
    } finally {
      release();
      redis.pipeline = original;
    }
  }

  // Codex L-20261120-2049 (MEDIUM): an erasure writes the person's print on the store's list of the deleted first, then
  // reads what is theirs once; an open of theirs that ran in between left a live place, an entry, a door and a vault
  // session after the erasure said done. Now the open asks that list before and after taking its place.
  part("A person deleted from the store opens nothing, and an open racing their erasure leaves nothing (Codex L-20261120-2049)");
  {
    const left = async (who: string, lessonId: string) =>
      (await redis.pipeline([["ZCARD", `nl:sub:live:${FOLDER}:${COURSE}:${lessonId}:${who}`], ["ZCARD", `nl:sub:who:${FOLDER}:${who}`]])) as [number, number];
    // A world that counts the vault sessions it opened: a refused open never asks the vault, so never writes a door.
    const counting = () => {
      const w = world({ openReservedVault: async (input) => (w.calls.push("vault:open"), { ok: true, sessionId: "s", upload: { pathname: `vault/${input.folder}/${input.ownerId}/0-${input.name}`, pieces: 1, pieceBytes: 16 * MiB, multipart: true } }) });
      return w;
    };
    const nothing = async (who: string, lessonId: string) => [...(await left(who, lessonId))];

    // Already deleted: refused before a place is taken, the vault never asked.
    const gone = "d0".repeat(16);
    await redis.pipeline([suppressCommand("list_erased_before", "bob@example.com", NOW)]);
    const before = counting();
    is("a deleted person's open is refused", await openSubmissionDoor({ ...ask(gone, lesson(50)), listId: "list_erased_before" }, before.steps), { ok: false, reason: "unavailable" });
    is("with no place, no entry and no vault session (so no door)", [...(await nothing(gone, lesson(50))), before.calls], [0, 0, []]);
    is("control: the same person in another store, not deleted there, opens", (await openSubmissionDoor({ ...ask(gone, lesson(50)), listId: "list_other_store" }, world().steps)).ok, true);

    // Deleted between the open's first ask and its place: the second ask catches it and the place is given back.
    const racing = "d1".repeat(16);
    const original = redis.pipeline.bind(redis);
    let printed = false;
    redis.pipeline = (async (list: (string | number)[][]) => {
      const reply = await original(list);
      if (!printed && list[0]?.[0] === "ZADD" && String(list[0][1]).startsWith(`nl:sub:live:${FOLDER}:${COURSE}:${lesson(51)}:${racing}`)) {
        printed = true;
        await original([suppressCommand("list_erased_between", "bob@example.com", NOW)]);
      }
      return reply;
    }) as typeof redis.pipeline;
    const between = counting();
    let opened: unknown;
    try {
      opened = await openSubmissionDoor({ ...ask(racing, lesson(51)), listId: "list_erased_between" }, between.steps);
    } finally {
      redis.pipeline = original;
    }
    is("control: the print was written once the place was taken", printed, true);
    is("the open is refused", opened, { ok: false, reason: "unavailable" });
    is("and the place taken meanwhile is given back, nothing else written", [...(await nothing(racing, lesson(51))), between.calls], [0, 0, []]);

    // The second ask not answered: unknown, never "not deleted"; the place is given back.
    const unsure = "d2".repeat(16);
    let broken = false;
    redis.pipeline = (async (list: (string | number)[][]) => {
      if (!broken && list[0]?.[0] === "HEXISTS" && list[0][1] === "nl:erased:list_erased_unknown") {
        broken = true;
        return ["maybe"];
      }
      return original(list);
    }) as typeof redis.pipeline;
    // The first ask is let through: HEXISTS of a print never written answers 0 on the stand-in; break the second only.
    let asked = 0;
    const breaking = redis.pipeline;
    redis.pipeline = (async (list: (string | number)[][]) => {
      if (list[0]?.[0] === "HEXISTS" && list[0][1] === "nl:erased:list_erased_unknown" && (asked += 1) === 1) return original(list);
      return breaking(list);
    }) as typeof redis.pipeline;
    const unsureWorld = counting();
    let thrown: string;
    try {
      thrown = await threw(() => openSubmissionDoor({ ...ask(unsure, lesson(52)), listId: "list_erased_unknown" }, unsureWorld.steps));
    } finally {
      redis.pipeline = original;
    }
    is("control: the second ask was the broken one", [asked, broken], [2, true]);
    is("an answer not known refuses the open as unknown", thrown, "unknown");
    is("and gives the place back, nothing else written", [...(await nothing(unsure, lesson(52))), unsureWorld.calls], [0, 0, []]);

    // The report's interleaving: the erasure has written the print and taken its one read of the person's entries;
    // an open of theirs runs whole; the erasure goes on and says done. The open must be refused, with nothing left.
    const during = "d3".repeat(16);
    await redis.pipeline([suppressCommand("list_erased_during", "bob@example.com", NOW)]);
    let openedDuring: unknown = "not run";
    const duringWorld = counting();
    let snapshotTaken = false;
    redis.pipeline = (async (list: (string | number)[][]) => {
      const reply = await original(list);
      if (!snapshotTaken && list[0]?.[0] === "ZRANGEBYSCORE" && list[0][1] === `nl:sub:who:${FOLDER}:${during}`) {
        snapshotTaken = true;
        redis.pipeline = original;
        openedDuring = await openSubmissionDoor({ ...ask(during, lesson(53)), listId: "list_erased_during" }, duringWorld.steps).catch((error: unknown) => String(error));
      }
      return reply;
    }) as typeof redis.pipeline;
    const files: string[] = [];
    let erased: number | string;
    try {
      erased = await forgetSubmissionsPerson(FOLDER, during, files, world().steps).catch((error: unknown) => String(error));
    } finally {
      redis.pipeline = original;
    }
    is("control: the open ran after the erasure's read of the person's entries", snapshotTaken, true);
    is("the erasure said done", erased, 0);
    is("the open that ran in between was refused", openedDuring, { ok: false, reason: "unavailable" });
    is("and nothing of the person is left: no place, no entry, no vault session (so no door)", [...(await nothing(during, lesson(53))), duringWorld.calls], [0, 0, []]);

    // The erasure whole between the open's second ask and its door's write: the print came after both asks, its read
    // of the buyer's index found the place's entry, and it said done. The door is never written after that
    // (SUBMISSION_DOOR_OPEN_WRITE): the provider's session is cancelled and the open is refused.
    const late = "d4".repeat(16);
    let asks = 0;
    let erasedLate: number | string = "not run";
    const lateFiles: string[] = [];
    const lateWorld = counting();
    redis.pipeline = (async (list: (string | number)[][]) => {
      const reply = await original(list);
      if (list[0]?.[0] === "HEXISTS" && list[0][1] === "nl:erased:list_erased_late" && (asks += 1) === 2) {
        redis.pipeline = original;
        await original([suppressCommand("list_erased_late", "bob@example.com", NOW)]);
        erasedLate = await forgetSubmissionsPerson(FOLDER, late, lateFiles, world().steps).catch((error: unknown) => String(error));
      }
      return reply;
    }) as typeof redis.pipeline;
    let openedLate: unknown;
    try {
      openedLate = await openSubmissionDoor({ ...ask(late, lesson(54)), listId: "list_erased_late" }, lateWorld.steps);
    } finally {
      redis.pipeline = original;
    }
    is("control: the erasure ran whole after the second ask and said done", [asks, erasedLate], [2, 0]);
    is("the open is refused", openedLate, { ok: false, reason: "unavailable" });
    const aborted = lateWorld.calls.find((call) => call.startsWith("abort "));
    const lateId = aborted?.split("/")[2]?.slice(4) ?? "no abort";
    is("the provider's session was opened and then cancelled", [lateWorld.calls.filter((call) => !call.startsWith("abort ")), typeof aborted], [["vault:open"], "string"]);
    const lateDoor = (await redis.pipeline([["EXISTS", `nl:sub:door:${FOLDER}:${lateId}`]]))[0];
    is("no door that names the buyer was written, no place and no entry remain", [lateDoor, ...(await nothing(late, lesson(54)))], [0, 0, 0]);
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
