/**
 * One buyer's share of the store's monthly upload starts (Codex X6, focal on #3574, MEDIUM 7057232550): a buyer who
 * opens an upload for review and gives it up, again and again, spends one of the store's monthly upload starts each
 * time (lib/upload-budget-policy.ts, PAID_UPLOAD_OPENS: never given back). Each buyer may start at most a fifth of the
 * plan's starts in one store in one allowance window (lib/submission-store.ts, SUBMISSION_BUYER_OPENS; the
 * coordinator's figure), counted before the store's own allowance is asked, and is refused past it with a reason of
 * its own ("buyer_limit"), never the store's ("budget"), which says the store has no room.
 *
 * In-memory Redis, the vault stood in for; synthetic store and buyers.
 */
import { PAID_UPLOAD_OPENS } from "@/lib/upload-budget-policy";
import { type SubmissionSetup } from "@/lib/submission-rules";
import { type DoorSteps, SUBMISSION_BUYER_OPENS, SUBMISSION_BUYER_OPEN_COMMANDS, SUBMISSION_STEP_COMMANDS, abortSubmissionDoor, forgetSubmissionsPerson, openSubmissionDoor } from "@/lib/submission-store";
import { type DataStore } from "@/lib/store-data";
import { SUBMISSIONS_WORDS } from "@/lib/buyer-words/submissions";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const MiB = 1024 * 1024;
const FOLDER = "0123456789abcdef0123456789abcdef";
const COURSE = "course0001ab";
const NOW_S = Math.floor(Date.now() / 1000);
// A paid store inside its current billing month, so the store's allowance and the buyer's count have a window.
const SHOP: DataStore & { statsId: string; tier: "creator"; period: { start: number; end: number; renews: boolean } } = {
  sid: "submission-buyer-opens-0", statsId: "c".repeat(32), tier: "creator", subscriptionActive: true, subscriptionId: "sub_x", trialEnds: 0, planEndedAt: "",
  period: { start: NOW_S - 86_400, end: NOW_S + 29 * 86_400, renews: true },
};
const SETUP: SubmissionSetup = { instruction: "Send your form check.", kinds: ["video", "pdf"], maxBytes: 200 * MiB, keepDays: 30 };
const NOW = NOW_S;
const lesson = (n: number) => `lesson${String(n).padStart(4, "0")}ab`;
const SHARE = Math.ceil(PAID_UPLOAD_OPENS.creator / 5);

function world(storeSays = true) {
  let asked = 0;
  let n = 0;
  const steps: DoorSteps = {
    reserveStoreUpload: async () => (asked += 1, storeSays),
    openReservedVault: async (input) => {
      n += 1;
      return { ok: true, sessionId: "s", upload: { pathname: `vault/${input.folder}/${input.ownerId}/${String(n).padStart(16, "0")}-${input.name}`, pieces: 1, pieceBytes: 16 * MiB, multipart: true } };
    },
    reserveUploadControl: async () => true,
    signPieces: async () => [],
    closeReservedVault: async (pathname) => ({ ok: true, file: { pathname, bytes: 5 * MiB, contentType: "video/mp4" } }),
    abortReservedVault: async () => true,
    deleteVault: async () => true,
  };
  return { steps, asked: () => asked };
}
const ask = (who: string, lessonId: string) => ({
  store: SHOP,
  data: SHOP as DataStore,
  folder: FOLDER,
  courseId: COURSE,
  lessonId,
  who,
  email: "buyer@example.com",
  setup: SETUP,
  file: { bytes: 5 * MiB, type: "video/mp4", name: "form.mp4", limitBytes: 5 * 1024 * MiB },
  nowSeconds: NOW,
});
const where = (who: string, lessonId: string) => ({ store: SHOP, data: SHOP as DataStore, folder: FOLDER, courseId: COURSE, lessonId, who });

/** Opens and gives up one upload; answers the open's reason, or "opened". */
async function openAndGiveUp(who: string, lessonId: string, steps: DoorSteps): Promise<string> {
  const opened = await openSubmissionDoor(ask(who, lessonId), steps);
  if (!opened.ok) return opened.reason;
  await abortSubmissionDoor(where(who, lessonId), opened.upload.pathname, steps, NOW);
  return "opened";
}

async function main(): Promise<void> {
  part("One buyer opening and giving up again and again spends only their share of the store's upload starts");
  {
    const ana = "a".repeat(32);
    const shop = world();
    const answers: string[] = [];
    for (let i = 0; i < SHARE; i += 1) answers.push(await openAndGiveUp(ana, lesson(1), shop.steps));
    is(`control: ${SHARE} starts, a fifth of the Store plan's ${PAID_UPLOAD_OPENS.creator}, each opened`, answers.every((a) => a === "opened"), true);
    const asked = shop.asked();
    is("one more is refused with the buyer's own reason", await openAndGiveUp(ana, lesson(2), shop.steps), "buyer_limit");
    is("and asks nothing of the store's monthly allowance", shop.asked(), asked);
    is("another buyer in the same store still opens", await openAndGiveUp("b".repeat(32), lesson(1), shop.steps), "opened");
  }

  part("The figure, and what a start sends");
  {
    is("a fifth of each plan's monthly upload starts, rounded up", SUBMISSION_BUYER_OPENS, { creator: Math.ceil(PAID_UPLOAD_OPENS.creator / 5), pro: Math.ceil(PAID_UPLOAD_OPENS.pro / 5), scale: Math.ceil(PAID_UPLOAD_OPENS.scale / 5) });
    // The first start of a window is the dearest: the count and its bytes taken in the store's data room.
    const original = redis.pipeline.bind(redis);
    let commands = 0;
    redis.pipeline = (async (list: (string | number)[][]) => {
      commands += list.length;
      for (const command of list) if (String(command[0]).toUpperCase() === "EVAL" && String(command[1]).startsWith("-- marktmorgen:submission-buyer-open:v1")) commands += SUBMISSION_BUYER_OPEN_COMMANDS - 1;
      return original(list);
    }) as typeof redis.pipeline;
    let opened: { ok: boolean };
    try {
      opened = await openSubmissionDoor(ask("e".repeat(32), lesson(1)), world().steps);
    } finally {
      redis.pipeline = original;
    }
    is("control: the first start of a window opens", opened.ok, true);
    console.log(`        (the first start of a window sent ${commands} commands, the count's EVAL as ${SUBMISSION_BUYER_OPEN_COMMANDS})`);
    is("and stays inside the open's commands, with the count's", commands <= SUBMISSION_STEP_COMMANDS.open, true);
  }

  part("The store's own refusal and the buyer's are told apart");
  {
    const store = world(false);
    is("the store's allowance spent: the store's reason", await openAndGiveUp("c".repeat(32), lesson(1), store.steps), "budget");
    // In every language the buyer reads their own limit, never that the store has no room (VR, item 2).
    for (const [language, words] of Object.entries(SUBMISSIONS_WORDS)) {
      const own = words.buyerLimit("Fern Studio");
      is(`${language}: the buyer's limit is said in its own words, naming the store`, own !== words.noRoom("Fern Studio") && own.includes("Fern Studio") && own.length > 0, true);
    }
  }

  // Claude 6 i51q on #3574 (LOW): the count was taken before its bytes in the store's data room, so a room that was
  // full (or did not answer) left a start counted, spent, and its count's bytes counted nowhere for the window.
  part("A data room that is full refuses the start before the buyer's count is taken");
  {
    const fay = "f".repeat(32);
    const original = redis.pipeline.bind(redis);
    // The room answers full only for the count's own take: the one entry kept until a time ("~" and a month).
    redis.pipeline = (async (list: (string | number)[][]) => {
      const take = list.length === 1 && String(list[0][0]).toUpperCase() === "EVAL" && String(list[0][1]).startsWith("-- marktmorgen:store-data:v1");
      if (take && list[0].slice(3).some((part) => String(part).startsWith("~"))) return [[0, 0]];
      return original(list);
    }) as typeof redis.pipeline;
    let first: string;
    try {
      first = await openAndGiveUp(fay, lesson(1), world().steps);
    } finally {
      redis.pipeline = original;
    }
    is("control: the start is refused as full", first, "full");
    is("and no start of theirs was counted", (await redis.pipeline([["EXISTS", `nl:sub:opens:${FOLDER}:${fay}`]]))[0], 0);
    const answers: string[] = [];
    for (let i = 0; i < SHARE; i += 1) answers.push(await openAndGiveUp(fay, lesson(1), world().steps));
    is("so their whole share is still theirs", answers.every((a) => a === "opened"), true);
  }

  part("The count goes with the person");
  {
    const dee = "d".repeat(32);
    const shop = world();
    await openAndGiveUp(dee, lesson(1), shop.steps);
    is("control: their count is kept", (await redis.pipeline([["EXISTS", `nl:sub:opens:${FOLDER}:${dee}`]]))[0], 1);
    await forgetSubmissionsPerson(FOLDER, dee, [], shop.steps, SHOP);
    is("erased with them", (await redis.pipeline([["EXISTS", `nl:sub:opens:${FOLDER}:${dee}`]]))[0], 0);
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
