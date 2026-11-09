/**
 * A members import and the month's emails to people brought over (audit R46, finding 2). Synthetic only: Stripe and
 * the sender are stand-ins for fetch, Redis is lib/redis-memory.ts.
 *
 * Each member brought over is emailed their own link (components/import-tool.tsx), out of the store's emails to
 * people brought over: IMPORT_ALLOWANCES.creator.movedEmails a month on Store, the plan's monthly emails on Studio and
 * Scale. Held here:
 *   - an import with more members than the emails left now does not start, and says how many can go now and when
 *     the allowance opens again; nothing is invited and nothing is emailed;
 *   - within the allowance, the import starts and every member is emailed, as before;
 *   - the emails for the whole file are taken when it starts, from the same counter and by the same rules as each
 *     send (reserveMoved): nothing else can use them first, what the import does not send is given back when it ends,
 *     is canceled or does not start, and a plan whose month can send nothing (a funded period not reserved) refuses;
 *   - that count is read exactly (CX-123 rule 24): any other reply refuses the start, with nothing started;
 *   - a reminder refused by a full month is tried once more when the month opens again, while that is still before
 *     the renewal date, and is never sent twice.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { addRows, cancelImport, finishUpload, reserveMoved, runImport, sendMoveReminders, startImport, storeImports } from "@/lib/imports";
import { moveCounts } from "@/lib/move-members";
import { allowanceWindow } from "@/lib/allowance-window";
import { monthlyAllowance } from "@/lib/mail";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
type Sent = { to: string | string[]; subject: string; text: string };
const emails: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as Sent | Sent[];
    for (const one of Array.isArray(body) ? body : [body]) emails.push(one);
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: "email_1" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;
const to = (e: Sent) => String([e.to].flat()[0]);

const realNow = Date.now;
const setClock = (ms: number) => {
  Date.now = () => ms;
};

/**
 * Answers every read or count of a key starting with `prefix` (GET, INCRBY) with `reply` while `fn` runs, whichever
 * of them the start uses to learn the emails left: the command still runs, only its reply is replaced.
 */
async function withCountReply<T>(prefix: string, reply: unknown, fn: () => Promise<T>): Promise<T> {
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = (await pipeline(commands)) as unknown[];
    return commands.map((c, i) => (["GET", "INCRBY"].includes(String(c[0]).toUpperCase()) && String(c[1]).startsWith(prefix) ? reply : replies[i]));
  }) as typeof redis.pipeline;
  try {
    return await fn();
  } finally {
    redis.pipeline = pipeline;
  }
}

async function run(id: string) {
  let job = await runImport(id, Date.now() + 30_000);
  for (let i = 0; i < 20 && job && job.state !== "done"; i += 1) job = await runImport(id, Date.now() + 30_000);
  return job;
}

async function creatorStore(owner: string, handle: string, fields: { tier?: "creator" | "pro"; period: ReturnType<typeof paidPeriod> & { funded?: true } }) {
  await claimHandle(owner, handle, "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, `acct_1Test${handle.slice(0, 6).padEnd(6, "0")}01`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, ...(fields.tier ? { tier: fields.tier } : {}), period: fields.period });
  const club = await addProduct(owner, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(owner, club.product.id, "https://example.com/club");
  return (await storeForEmail(owner))!;
}

const memberRows = (n: number, renews: number, prefix = "member") => {
  const day = new Date(renews * 1000).toISOString().slice(0, 10);
  return Array.from({ length: n }, (_, i) => [String(i + 2), `${prefix}${i + 1}@example.com`, "The Inner Circle", day, ""]);
};

async function importMembers(owner: string, rows: string[][]) {
  const started = await startImport((await storeForEmail(owner))!, owner, "members", { expected: rows.length, file: "patrons.csv", stopped: true });
  if (!started.ok) return { started, job: null };
  const s = (await storeForEmail(owner))!;
  await addRows(s, started.job.id, rows);
  await finishUpload(s, started.job.id);
  return { started, job: await run(started.job.id) };
}

async function main(): Promise<void> {
  // The clock is fixed to 03:00 UTC of today, and runs on from there (review on #3384, MEDIUM 1): the file's renewal
  // is a date alone, read at noon UTC, so a reminder's due time below depends on the time of day the test starts.
  // Before, a start between about 12:00 and 23:00 UTC found the reminders not yet due, and the put-back was never
  // exercised. Same UTC day as the real clock, so nothing that reads the date another way crosses a day or a month.
  const fixedStart = Math.floor(realNow() / 86_400_000) * 86_400_000 + 3 * 3_600_000;
  const realStart = realNow();
  Date.now = () => fixedStart + (realNow() - realStart);
  process.env.STRIPE_SECRET_KEY = "sk_test_move_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
  redis.clear();
  const nowS = Math.floor(Date.now() / 1000);

  part("Store plan: more members than the month's emails left");
  const OWNER = "r46e-owner@example.com";
  const store = await creatorStore(OWNER, "r46emails", { period: paidPeriod() });
  is("setup: a paid Store plan with no monthly emails", [store.tier, monthlyAllowance(store)], ["creator", 0]);
  const in10 = nowS + 10 * DAY;
  const over = await startImport(store, OWNER, "members", { expected: 25, file: "patrons.csv", stopped: true });
  const refusal = over as { ok: boolean; reason?: string; limit?: number; opens?: string };
  is("25 members with 20 emails left: the import does not start", [refusal.ok, refusal.reason, refusal.limit], [false, "emails_month", 20]);
  is("and it says when the allowance opens again", typeof refusal.opens === "string" && /opens again/.test(refusal.opens), true);
  is("nothing is invited, nothing is emailed, no import is listed", [(await moveCounts((await storeForEmail(OWNER))!)).invited, emails.length, (await storeImports((await storeForEmail(OWNER))!)).length], [0, 0, 0]);

  part("Within the allowance, every member is emailed, as before");
  const twenty = await importMembers(OWNER, memberRows(20, in10));
  is("20 members start", twenty.started.ok, true);
  is("all 20 are invited and emailed", { added: twenty.job?.counts.added, mailed: twenty.job?.counts.mailed, unmailed: twenty.job?.counts.unmailed, state: twenty.job?.state }, { added: 20, mailed: 20, unmailed: 0, state: "done" });
  is("20 emails went, one to each member", new Set(emails.map(to)).size, 20);
  const none = await startImport((await storeForEmail(OWNER))!, OWNER, "members", { expected: 1, file: "one.csv", stopped: true });
  is("with none left, one more member does not start, and says 0 can go now", [none.ok, (none as { reason?: string }).reason, (none as { limit?: number }).limit], [false, "emails_month", 0]);

  part("The emails left are read exactly (rule 24)");
  const OTHER = "r46e-other@example.com";
  await creatorStore(OTHER, "r46exact", { period: paidPeriod() });
  for (const [label, reply] of [["a fraction", 2.5], ["true", true], ["a list", ["3"]], ["text that is not a count", "3x"], ["nothing at all", undefined]] as const) {
    let threw = false;
    let started = false;
    try {
      const r = await withCountReply("nl:imports:moved:", reply, async () => startImport((await storeForEmail(OTHER))!, OTHER, "members", { expected: 2, file: "patrons.csv", stopped: true }));
      started = r.ok;
    } catch {
      threw = true;
    }
    is(`Store: the count read as ${label} refuses the start`, { threw, started }, { threw: true, started: false });
  }
  is("Store: nothing was started by an unknown read", (await storeImports((await storeForEmail(OTHER))!)).length, 0);
  const fine = await startImport((await storeForEmail(OTHER))!, OTHER, "members", { expected: 2, file: "patrons.csv", stopped: true });
  is("Store control: a confirmed absent count is the whole allowance, and it starts", fine.ok, true);

  const STUDIO = "r46e-studio@example.com";
  const studio = await creatorStore(STUDIO, "r46studio", { tier: "pro", period: paidPeriod() });
  const allowance = monthlyAllowance(studio);
  is("setup: a paid Studio plan with monthly emails", allowance > 0, true);
  const window = allowanceWindow(studio)!;
  const listId = (await ensureListId(STUDIO))!.listId!;
  await redis.pipeline([["SET", `nl:mail:used:${listId}:${window.id}`, String(allowance - 3)]]);
  const studioOver = await startImport((await storeForEmail(STUDIO))!, STUDIO, "members", { expected: 5, file: "patrons.csv", stopped: true });
  is("Studio: 5 members with 3 monthly emails left does not start", [studioOver.ok, (studioOver as { reason?: string }).reason, (studioOver as { limit?: number }).limit], [false, "emails_month", 3]);
  let studioThrew = false;
  try {
    await withCountReply("nl:mail:used:", "many", async () => startImport((await storeForEmail(STUDIO))!, STUDIO, "members", { expected: 2, file: "patrons.csv", stopped: true }));
  } catch {
    studioThrew = true;
  }
  is("Studio: the month's count read in another shape refuses the start", studioThrew, true);
  is("Studio: nothing was started", (await storeImports((await storeForEmail(STUDIO))!)).length, 0);
  // A count whose reply is unknown may still have been taken, so it is never given back on that answer; set again.
  await redis.pipeline([["SET", `nl:mail:used:${listId}:${window.id}`, String(allowance - 3)]]);
  const studioFits = await startImport((await storeForEmail(STUDIO))!, STUDIO, "members", { expected: 3, file: "patrons.csv", stopped: true });
  is("Studio control: 3 members with 3 left starts", studioFits.ok, true);

  part("The emails for the whole file are held when it starts (review on #3384, MEDIUM 2)");
  const HOLD = "r46e-hold@example.com";
  await creatorStore(HOLD, "r46hold", { period: paidPeriod() });
  const held = await startImport((await storeForEmail(HOLD))!, HOLD, "members", { expected: 20, file: "patrons.csv", stopped: true });
  is("Store: 20 members with 20 emails left starts", held.ok, true);
  is("another email to people brought over cannot take one of those 20 meanwhile", await reserveMoved((await storeForEmail(HOLD))!, 1), 0);
  if (held.ok) {
    const s = (await storeForEmail(HOLD))!;
    await addRows(s, held.job.id, memberRows(20, in10, "held"));
    await finishUpload(s, held.job.id);
  }
  const heldDone = held.ok ? await run(held.job.id) : null;
  is("so every one of the 20 is emailed their link", { mailed: heldDone?.counts.mailed, unmailed: heldDone?.counts.unmailed, state: heldDone?.state }, { mailed: 20, unmailed: 0, state: "done" });

  const BACK = "r46e-back@example.com";
  await creatorStore(BACK, "r46back", { period: paidPeriod() });
  const back = await startImport((await storeForEmail(BACK))!, BACK, "members", { expected: 5, file: "patrons.csv", stopped: true });
  if (back.ok) {
    const s = (await storeForEmail(BACK))!;
    const rows = memberRows(3, in10, "back");
    await addRows(s, back.job.id, [...rows, ["5", "back1@example.com", "The Inner Circle", rows[0][3], ""], ["6", "back2@example.com", "The Inner Circle", rows[0][3], ""]]);
    await finishUpload(s, back.job.id);
  }
  const backDone = back.ok ? await run(back.job.id) : null;
  is("a file of 5 rows that emails 3 (two repeated)", [back.ok, backDone?.counts.mailed, backDone?.state], [true, 3, "done"]);
  is("gives back the 2 it did not use when it ends: 17 of 20 can go", await reserveMoved((await storeForEmail(BACK))!, 20), 17);

  const STOP = "r46e-stop@example.com";
  await creatorStore(STOP, "r46stop", { period: paidPeriod() });
  const first = await startImport((await storeForEmail(STOP))!, STOP, "members", { expected: 6, file: "patrons.csv", stopped: true });
  const busy = await startImport((await storeForEmail(STOP))!, STOP, "members", { expected: 4, file: "more.csv", stopped: true });
  is("a second import while the first runs is told the store is busy", [first.ok, busy.ok, (busy as { reason?: string }).reason], [true, false, "busy"]);
  if (first.ok) await cancelImport((await storeForEmail(STOP))!, first.job.id);
  is("the busy refusal and the canceled import each give back what they held: all 20 can go", await reserveMoved((await storeForEmail(STOP))!, 20), 20);

  part("The start follows the same rules as each send (review on #3384, MEDIUM 3)");
  const FUNDED = "r46e-funded@example.com";
  await creatorStore(FUNDED, "r46funded", { tier: "pro", period: { ...paidPeriod(), funded: true } });
  const sentBefore = emails.length;
  const funded = await startImport((await storeForEmail(FUNDED))!, FUNDED, "members", { expected: 3, file: "patrons.csv", stopped: true });
  is(
    "Studio whose funded period is not reserved can send none of the month's emails: 3 members do not start",
    [funded.ok, (funded as { reason?: string }).reason, (funded as { limit?: number }).limit],
    [false, "emails_month", 0],
  );
  is("nothing is invited, emailed or listed", [(await moveCounts((await storeForEmail(FUNDED))!)).invited, emails.length - sentBefore, (await storeImports((await storeForEmail(FUNDED))!)).length], [0, 0, 0]);

  part("A reminder refused by a full month waits for the month to open again");
  const RE = "r46e-remind@example.com";
  // A billing month that ends in two days; members renew in four and a half, so their reminder is due in a day and a
  // half, inside this month, and the next month opens before they renew.
  const t0 = Date.now();
  const remindStore = await creatorStore(RE, "r46remind", { period: paidPeriod(t0, { behind: 28, ahead: 2 }) });
  const renews = Math.floor(t0 / 1000) + Math.round(4.5 * DAY);
  const three = await importMembers(RE, memberRows(3, renews, "late"));
  is("three members are invited and emailed", [three.job?.counts.added, three.job?.counts.mailed], [3, 3]);
  const firstWindow = allowanceWindow(remindStore, t0)!;
  await redis.pipeline([["SET", `nl:imports:moved:${remindStore.sid}:${firstWindow.id}`, "20"]]);
  const before = emails.length;
  const dueAt = (renews - 3 * DAY + 3_600) * 1000;
  setClock(dueAt);
  const refused = await sendMoveReminders(dueAt + 30_000, dueAt);
  is("the month is full: no reminder goes now", [refused.sent, emails.length - before], [0, 0]);
  const queued = (await redis.pipeline([["ZRANGEBYSCORE", "nl:mv:due", "-inf", "+inf", "WITHSCORES"]]))[0] as string[];
  const mine = (member: string) => member.startsWith(`${remindStore.sid}|`);
  const scores = queued.flatMap((member, i) => (i % 2 === 0 && mine(member) ? [Number(queued[i + 1])] : []));
  is("each is put back for when the month opens again, before the renewal date", { count: scores.length, all: scores.every((s) => s === firstWindow.end / 1000), beforeRenewal: firstWindow.end / 1000 < renews }, { count: 3, all: true, beforeRenewal: true });

  // The next month: one email of it already used elsewhere but for one, so one reminder goes and two are refused
  // again; the month after opens past the renewal date, so those two are not put back a second time.
  const opened = firstWindow.end + 3_600_000;
  setClock(opened);
  const nextWindow = allowanceWindow((await storeForEmail(RE))!, opened)!;
  await redis.pipeline([["SET", `nl:imports:moved:${remindStore.sid}:${nextWindow.id}`, "19"]]);
  const second = await sendMoveReminders(opened + 30_000, opened);
  const remindersNow = emails.slice(before).map(to);
  is("when it opens, the reminders go while the month allows (one here)", [second.sent, remindersNow.length], [1, 1]);
  const left = (await redis.pipeline([["ZRANGEBYSCORE", "nl:mv:due", "-inf", "+inf"]]))[0] as string[];
  is("refused a second time, they are not put back again (at most once more)", left.filter(mine).length, 0);
  await redis.pipeline([["SET", `nl:imports:moved:${remindStore.sid}:${nextWindow.id}`, "0"]]);
  const third = await sendMoveReminders(opened + 7_200_000 + 30_000, opened + 7_200_000);
  is("never sent twice: nothing more goes afterward", [third.sent, emails.slice(before).length], [0, 1]);
  Date.now = realNow;
  done();
}

void main();
