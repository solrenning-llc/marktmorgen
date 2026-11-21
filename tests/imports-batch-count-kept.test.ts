/**
 * A members import's email batch (lib/imports.ts mailStep) and a member's renewal reminder (sendMoveReminders) whose
 * answer was not known keep what they reserved, the company's day and the store's month (or the import's hold), and
 * mark it (lib/batch-count.ts); the same batch tried again sends under that count instead of reserving again, and the
 * mark goes once it is sent (#4073, Codex X6's LOW: the lost-ack retry held for every batch-email caller, not only
 * announcements). Drives the real runImport and sendMoveReminders with the batch answer stubbed
 * (tests/batch-answer-world.ts). Synthetic data only: Stripe and Redis are stand-ins.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { addRows, finishUpload, readJob, runImport, sendMoveReminders, startImport } from "@/lib/imports";
import { REMIND_DAYS_BEFORE } from "@/lib/move-rules";
import { mailDay } from "@/lib/mail";
import { answerBatches, batchAnswers, type BatchAnswer } from "./batch-answer-world";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const DAY = 86_400;
const HOUR = 3_600;
const POSTAL = "12 Harbor Lane, Portland, ME 04101, USA";

// Stripe answers nothing (no member kept their place yet); no email service is reached (the batch answer is stubbed).
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

const read = async (key: string) => Number((await redis.pipeline([["GET", key]]))[0] ?? 0);
/** The store's month (lib/mail.ts usedKey, or the imported-rows month), and the company's day, as counted. */
const counted = async () => {
  let month = 0;
  for (const key of redis.keys().filter((k) => k.startsWith("nl:mail:used:") || k.startsWith("nl:imports:moved:"))) month += await read(key);
  return { month, day: await read(mailDay()()) };
};
const marks = () => redis.keys().filter((k) => k.startsWith("nl:mail:kept:")).length;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_only_a_stand_in";
  // A sender with room (lib/mail.ts senderRoom); the batch itself never reaches it (tests/batch-answer-world.ts).
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.MARKETING_DAILY_CAP = "1000";
  redis.clear();
  // The renewal date at noon UTC, so the date the row carries is the one the reminder is timed from.
  const noon = (s: number) => Math.floor(s / DAY) * DAY + 12 * HOUR;
  const renews = noon(Math.floor(Date.now() / 1000) + 20 * DAY);

  /** A store with one member to move, renewing on `renews`, its members import uploaded and not yet run. */
  async function memberImport(handle: string): Promise<string> {
    const owner = `owner-${handle}@example.com`;
    await claimHandle(owner, handle, "Harbor Kitchen", "");
    await ensureStatsId(owner);
    await ensureListId(owner);
    await setMailSettings(owner, { fromName: "Harbor Kitchen", address: POSTAL });
    await setStripeAccount(owner, `acct_${handle}`, true);
    await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, period: paidPeriod() });
    const club = await addProduct(owner, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
    if (!club.ok) throw new Error("no product");
    await setProductLink(owner, club.product.id, "https://example.com/club");
    const store = (await storeForEmail(owner))!;
    const started = await startImport(store, owner, "members", { expected: 1, file: "patrons.csv", stopped: true });
    if (!started.ok) throw new Error(`members not started: ${started.reason}`);
    await addRows(store, started.job.id, [["2", `fern-${handle}@example.com`, "The Inner Circle", new Date(renews * 1000).toISOString().slice(0, 10), ""]]);
    await finishUpload(store, started.job.id);
    return started.job.id;
  }

  for (const unknown of ["unconfirmed", "uncertain"] as BatchAnswer[]) {
    // An import started with its hold (ImportJob.held, taken for the whole file at the start) and one started before
    // the hold existed, which takes from the store's month at the mail step (reserveMoved).
    for (const legacy of [false, true]) {
      const id = await memberImport(`move${unknown}${legacy ? "old" : ""}`);
      if (legacy) {
        const job = (await readJob(id))!;
        delete job.held;
        await redis.pipeline([["SET", `nl:import:${id}`, JSON.stringify(job)]]);
      }
      part(`A members import's email batch${legacy ? " (an import started before its hold)" : ""} answered "${unknown}", then sent`);
      const before = await counted();
      const heldAtStart = (await readJob(id))?.held?.n;
      answerBatches(unknown, "sent");
      for (let i = 0; i < 10 && batchAnswers.handed.length < 1; i += 1) await runImport(id, Date.now() + 30_000);
      const waiting = await readJob(id);
      is("the answer was not known: the import is still mailing", [batchAnswers.handed.length, waiting?.state], [1, "mailing"]);
      const held = await counted();
      if (legacy) is("the email stays counted, in the store's month and the company's day", [held.month - before.month, held.day - before.day], [1, 1]);
      else {
        is("the company's day keeps the email counted", held.day - before.day, 1);
        is("the import's hold keeps it taken", (heldAtStart ?? 0) - (waiting?.held?.n ?? 0), 1);
      }
      is("and the batch is marked as holding its count", marks(), 1);
      for (let i = 0; i < 10 && (await readJob(id))?.state !== "done"; i += 1) await runImport(id, Date.now() + 30_000);
      const finished = await readJob(id);
      is("tried again and sent: the import is done, the member emailed", [finished?.state, finished?.counts.mailed, finished?.counts.unmailed], ["done", 1, 0]);
      is("the same batch, under the same key, handed over twice", [batchAnswers.handed.length, batchAnswers.handed[0]?.key === batchAnswers.handed[1]?.key], [2, true]);
      const after = await counted();
      is("counted once, not twice", [after.month - before.month, after.day - before.day], [legacy ? 1 : 0, 1]);
      is("no mark is left once the batch was sent", marks(), 0);
    }

    // Both members just imported (one a store) are due their renewal reminder, each its own one-email batch.
    part(`Two members' renewal reminders answered "${unknown}", then sent`);
    const due = renews - REMIND_DAYS_BEFORE * DAY + 60;
    const beforeReminder = await counted();
    answerBatches(unknown, unknown, "sent");
    const first = await sendMoveReminders(Date.now() + 30_000, due * 1000);
    is("the answers were not known: nothing counted as sent", [batchAnswers.handed.length, first.sent], [2, 0]);
    const heldReminder = await counted();
    is("both reminders stay counted, in the store's month and the company's day", [heldReminder.month - beforeReminder.month, heldReminder.day - beforeReminder.day], [2, 2]);
    is("and each is marked as holding its count", marks(), 2);
    const again = await sendMoveReminders(Date.now() + 30_000, (due + HOUR) * 1000);
    is("tried again and sent", again.sent, 2);
    const keys = batchAnswers.handed.map((h) => h.key);
    is("the same two reminders, under the same keys, handed over twice", [keys.length, new Set(keys).size], [4, 2]);
    const afterReminder = await counted();
    is("counted once, not twice", [afterReminder.month - beforeReminder.month, afterReminder.day - beforeReminder.day], [2, 2]);
    is("no mark is left once the reminders were sent", marks(), 0);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
