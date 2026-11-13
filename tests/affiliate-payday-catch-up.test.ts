/**
 * The affiliate payday (lib/affiliate-payday.ts, sendPaydayEmails) when the run on the payday does not finish a
 * store (webhooks/cron audit, Claude 1, 12/11/2026). The job runs once a day (vercel.json, "0 13 * * *"), and a
 * store was only looked at on the exact day of its payday: a read that threw on the 5th (or a deadline that ran
 * out before the store) left that month's affiliates unpaid and the creator unwritten to until the 5th of next
 * month. Now a payday the day's run did not handle is caught up for PAYDAY_CATCH_UP_DAYS, once, and a payday that
 * was handled (the email sent, or nobody owed anything that day) never is.
 * Synthetic only: an in-memory Redis and a stand-in for the email provider.
 */
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { PAYDAY_CATCH_UP_DAYS, paydayDue, paydayEmail, autoPayEmail, sendPaydayEmails } from "@/lib/affiliate-payday";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_payday_catch_up_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const sent: { to: string; subject: string; text: string }[] = [];
let paypalCalls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname.endsWith("paypal.com")) {
    paypalCalls += 1;
    return answer({ error: "synthetic: no PayPal here" }, 500);
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    sent.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to), subject: String(body.subject), text: String(body.text) });
    return answer({ id: `email_${sent.length}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The stores whose affiliate book cannot be read: every pipeline touching it throws, as Redis failing that day does. */
const failing = new Set<string>();
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (commands.some((c) => [...failing].some((id) => String(c[1]).startsWith(`nl:aff:${id}:`)))) throw new Error("redis is down (synthetic)");
  return pipeline(commands);
}) as typeof redis.pipeline;

const DAY = 86_400;
const T0 = Math.floor(Date.now() / 1000) - 400 * DAY;
const at = (iso: string) => new Date(iso);

async function seed(owner: string, handle: string, payday: number, owed: boolean): Promise<string> {
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, `acct_1Test${handle.slice(0, 8).padEnd(8, "0")}`, true);
  await setAffiliateSetting(owner, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, payday }));
  const statsId = (await storeForEmail(owner))!.statsId!;
  const aff = "a1a1a1a1a1a1";
  await pipeline([["HSET", `nl:aff:${statsId}:people`, aff, JSON.stringify({ id: aff, email: `${aff}@example.com`, code: "a1a1a", status: "approved", appliedAt: T0 * 1000, decidedAt: T0 * 1000, note: "" })]]);
  if (owed) await addSale(statsId, "cs_1");
  return statsId;
}

async function addSale(statsId: string, ref: string): Promise<void> {
  await pipeline([["HSET", `nl:aff:${statsId}:sales`, ref, JSON.stringify({ ref, pi: `pi_${ref}`, aff: "a1a1a1a1a1a1", at: T0 + 10 * DAY, product: "prod01", title: "Bread course", base: 1000, total: 1000, currency: "usd", rate: 20, self: false, how: "click" })]]);
}

const to = (owner: string) => sent.filter((m) => m.to === owner).length;

async function main(): Promise<void> {
  redis.clear();

  part("Which payday a run is for");
  is("on the day", paydayDue(5, at("2026-11-05T13:00:00Z")), { month: "2026-11", late: 0 });
  is("a day after", paydayDue(5, at("2026-11-06T13:00:00Z")), { month: "2026-11", late: 1 });
  is(`the last day caught up (${PAYDAY_CATCH_UP_DAYS})`, paydayDue(5, at("2026-11-08T13:00:00Z")), { month: "2026-11", late: 3 });
  is("never after that", paydayDue(5, at("2026-11-09T13:00:00Z")), null);
  is("never before the day", paydayDue(5, at("2026-11-04T13:00:00Z")), null);
  is("the 28th caught up on the 1st is the earlier month's", paydayDue(28, at("2026-03-01T13:00:00Z")), { month: "2026-02", late: 1 });
  is("no payday set is never due", paydayDue(0, at("2026-11-05T13:00:00Z")), null);

  const MISSED = "missed@example.com";
  const QUIET = "quiet@example.com";
  const PAID = "paid@example.com";
  await seed(MISSED, "missedshop", 5, true);
  const quietStats = await seed(QUIET, "quietshop", 5, false);
  await seed(PAID, "paidshop", 5, true);

  part("The payday's run fails for one store: the others are handled that day");
  const missedStats = (await storeForEmail(MISSED))!.statsId!;
  failing.add(missedStats);
  const fifth = await sendPaydayEmails(Date.now() + 20_000, at("2026-11-05T13:00:00Z"));
  failing.delete(missedStats);
  is("on the 5th the failing store is counted failed and not written to", [fifth.failed, to(MISSED)], [1, 0]);
  is("the owed store that read fine is written to", to(PAID), 1);
  is("and nothing to the store with nobody owed", to(QUIET), 0);

  part("A store that did not have this payday on its day is never caught up (Claude 2 nuvem F/B MEDIUM)");
  const LATE = "late@example.com";
  await seed(LATE, "lateshop", 5, true);
  // The store (or its affiliates, or this payday) did not exist on the 5th: nothing failed, so nothing is caught up.
  const sixth = await sendPaydayEmails(Date.now() + 20_000, at("2026-11-06T13:00:00Z"));
  is("the 6th catches up only the payday the 5th's run reached and did not finish", [to(LATE), to(MISSED), to(PAID), sixth.sent], [0, 1, 1, 1]);
  const missedMail = sent.filter((m) => m.to === MISSED)[0];
  is("its email never says today is the payday", [missedMail?.text.includes("Today is the"), missedMail?.text.includes("yesterday")], [false, true]);
  await sendPaydayEmails(Date.now() + 20_000, at("2026-11-07T13:00:00Z"));
  is("the 7th sends nothing more", [to(LATE), to(MISSED), to(PAID)], [0, 1, 1]);

  part("A payday moved onto a day that just passed is not caught up (Claude 2 nuvem F/B MEDIUM)");
  const MOVED = "moved@example.com";
  await seed(MOVED, "movedshop", 20, true);
  await sendPaydayEmails(Date.now() + 20_000, at("2026-11-12T13:00:00Z"));
  is("(control) nothing on the 12th while its payday is the 20th", to(MOVED), 0);
  await setAffiliateSetting(MOVED, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, payday: 12 }));
  await sendPaydayEmails(Date.now() + 20_000, at("2026-11-13T13:00:00Z"));
  is("moving it to the 12th on the 13th sends nothing that day", to(MOVED), 0);
  await sendPaydayEmails(Date.now() + 20_000, at("2026-11-15T13:00:00Z"));
  is("nor on the last day a catch-up could reach", to(MOVED), 0);

  part("A payday with nobody owed is handled: a sale clearing after it waits for next month");
  await addSale(quietStats, "cs_after");
  await sendPaydayEmails(Date.now() + 20_000, at("2026-11-06T13:00:00Z"));
  is("the store with nobody owed on the 5th gets nothing on the 6th", to(QUIET), 0);

  part("The 5th failing for a store, then the 6th reaching it");
  const FAILED = "failed@example.com";
  await seed(FAILED, "failedshop", 5, true);
  const failedStats = (await storeForEmail(FAILED))!.statsId!;
  failing.add(failedStats);
  const dec5 = await sendPaydayEmails(Date.now() + 20_000, at("2026-12-05T13:00:00Z"));
  failing.delete(failedStats);
  is("on December 5th the store fails and nothing is sent to it", [dec5.failed > 0, to(FAILED)], [true, 0]);
  await sendPaydayEmails(Date.now() + 20_000, at("2026-12-06T13:00:00Z"));
  is("on December 6th its payday is caught up", to(FAILED), 1);
  is("the stores handled on December 5th are not written to again", [to(MISSED), to(PAID), to(LATE), to(MOVED)], [2, 2, 1, 0]);
  await sendPaydayEmails(Date.now() + 20_000, at("2026-12-07T13:00:00Z"));
  is("and only once", to(FAILED), 1);

  part("A payday caught up never pays by itself through PayPal (Claude 1 cloud MEDIUM)");
  const AUTO = "auto@example.com";
  const autoStats = await seed(AUTO, "autoshop", 5, true);
  await pipeline([["SET", `nl:pp:${autoStats}`, JSON.stringify({ client: "synthetic-client", secret: "synthetic-secret", at: T0, auto: true })]]);
  failing.add(autoStats);
  await sendPaydayEmails(Date.now() + 20_000, at("2027-01-05T13:00:00Z"));
  failing.delete(autoStats);
  is("(control) the 5th's run reached it and failed: nothing sent", to(AUTO), 0);
  const before = paypalCalls;
  await sendPaydayEmails(Date.now() + 20_000, at("2027-01-06T13:00:00Z"));
  is("the 6th's catch-up never calls PayPal", paypalCalls - before, 0);
  const autoMail = sent.filter((m) => m.to === AUTO).at(-1);
  is("it sends the manual email instead, saying nothing was paid by itself", [to(AUTO), autoMail?.text.includes("we do not pay late by ourselves") ?? false, autoMail?.text.includes("Your affiliate payday was") ?? true], [1, true, false]);
  const ONTIME = "ontime@example.com";
  const onTimeStats = await seed(ONTIME, "ontimeshop", 9, true);
  await pipeline([["SET", `nl:pp:${onTimeStats}`, JSON.stringify({ client: "synthetic-client", secret: "synthetic-secret", at: T0, auto: true })]]);
  await sendPaydayEmails(Date.now() + 20_000, at("2027-02-09T13:00:00Z"));
  const onTimeMail = sent.filter((m) => m.to === ONTIME).at(-1);
  is("(control) on its own payday a store that pays by itself takes the automatic path", onTimeMail?.text.includes("It is your affiliate payday") ?? false, true);

  part("The words of a payday caught up");
  const manual = paydayEmail({ storeName: "S", payday: 5, people: 1, totalCents: 200, currency: "usd", waitingCents: 0, hold: 0, refundsChecked: true, late: 2 });
  is("manual: no 'today' in the subject, the day named", [manual.subject.includes("today"), manual.text.includes("2 days ago")], [false, true]);
  const auto = autoPayEmail({ ok: false, reason: "nothing" } as Parameters<typeof autoPayEmail>[0], "usd", 1);
  is("automatic: never 'it is your affiliate payday'", [auto.subject.includes("today"), auto.text.includes("It is your affiliate payday"), auto.text.includes("was yesterday")], [false, false, true]);
  done();
}

main();
