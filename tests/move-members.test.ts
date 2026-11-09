/**
 * Members moved from another platform (lib/move-rules.ts, lib/move-members.ts,
 * the "members" import in lib/imports.ts). Stripe and the email sender are
 * played by a stand-in for `fetch`. What is checked:
 *
 *   - renewal dates as other platforms export them, and a date that could be
 *     read two ways refused rather than guessed;
 *   - the first charge is never before the renewal date, and a date already
 *     passed is charged at checkout;
 *   - nothing starts until the creator confirms they will stop the old
 *     renewals, and every row that is not a membership that can move is
 *     listed with why;
 *   - each member gets one email with a link of their own; the link opens a
 *     checkout for that address, first charged on the renewal date, with no
 *     free trial on top;
 *   - one reminder, never to somebody who already kept it.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { MIN_DEFER_SECONDS, datesInFile, firstChargeAt, letteredDate, readRenewal, reminderAt } from "@/lib/move-rules";
import { addRows, finishUpload, runImport, sendMoveReminders, startImport } from "@/lib/imports";
import { moveCounts, openMove, readMove } from "@/lib/move-members";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const now = Date.now();
const nowS = Math.floor(now / 1000);
const noon = (d: Date) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12) / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

type Sent = { to: string | string[]; subject: string; text: string };
const emails: Sent[] = [];
const checkouts: URLSearchParams[] = [];
const customersByEmail = new Map<string, string>();
const liveSubs = new Map<string, { status: string; metadata: Record<string, string> }[]>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as Sent | Sent[];
    for (const one of Array.isArray(body) ? body : [body]) emails.push(one);
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/customers" && method === "GET") {
    const id = customersByEmail.get(url.searchParams.get("email") ?? "");
    return answer({ object: "list", data: id ? [{ id }] : [], has_more: false });
  }
  if (path === "/subscriptions") return answer({ object: "list", data: liveSubs.get(url.searchParams.get("customer") ?? "") ?? [], has_more: false });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"m".repeat(20)}${checkouts.length}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
  redis.clear();

  part("Renewal dates as other platforms export them");
  const nov3 = Math.floor(Date.UTC(2026, 10, 3, 12) / 1000);
  is("the year first", [readRenewal("2026-11-03"), readRenewal("2026/11/03"), readRenewal("2026-11-03 14:20:00"), readRenewal("2026-11-03T14:20:00Z")], Array(4).fill({ ok: true, at: nov3 }));
  is("with the month's name", [readRenewal("Nov 3, 2026"), readRenewal("November 3rd 2026"), readRenewal("3 November 2026"), readRenewal("3 Nov, 2026")], Array(4).fill({ ok: true, at: nov3 }));
  is("day and month that can only be read one way", [readRenewal("11/23/2026"), readRenewal("23/11/2026"), readRenewal("11/11/2026")], [
    { ok: true, at: Math.floor(Date.UTC(2026, 10, 23, 12) / 1000) },
    { ok: true, at: Math.floor(Date.UTC(2026, 10, 23, 12) / 1000) },
    { ok: true, at: Math.floor(Date.UTC(2026, 10, 11, 12) / 1000) },
  ]);
  is("one that could be April or May is not guessed", readRenewal("04/05/2026"), { ok: false, reason: "ambiguous" });
  is("but read as the creator chose for the file", [readRenewal("04/05/2026", "mdy"), readRenewal("04/05/2026", "dmy")], [
    { ok: true, at: Math.floor(Date.UTC(2026, 3, 5, 12) / 1000) },
    { ok: true, at: Math.floor(Date.UTC(2026, 4, 4, 12) / 1000) },
  ]);
  is("and one that does not fit that choice is refused, not swapped", readRenewal("23/11/2026", "mdy"), { ok: false, reason: "order" });
  is("the month in letters, in the stores' seven languages, whole or cut short", [
    readRenewal("3-Nov-26"),
    readRenewal("3. November 2026"),
    readRenewal("3 de novembro de 2026"),
    readRenewal("3 noviembre 2026"),
    readRenewal("3 novembre 2026"),
    readRenewal("3 nov. 2026"),
  ], Array(6).fill({ ok: true, at: nov3 }));
  is("and in other months", [readRenewal("1er mars 2026"), readRenewal("3 dez 2026"), readRenewal("3 okt 2026"), readRenewal("3 giu 2026")].map((r) => (r.ok ? letteredDate(r.at) : r.reason)), ["Mar 1, 2026", "Dec 3, 2026", "Oct 3, 2026", "Jun 3, 2026"]);
  is("letters that could start two months are not guessed", readRenewal("3 jui 2026"), { ok: false, reason: "unreadable" });
  is("a file's other dates say which way it writes them", [datesInFile(["04/05/2026", "23/11/2026"]), datesInFile(["04/05/2026"]), datesInFile(["23/11/2026", "11/23/2026"])], [
    { twoWays: true, proves: "dmy", mixed: false },
    { twoWays: true, proves: null, mixed: false },
    { twoWays: false, proves: null, mixed: true },
  ]);
  is("a day that does not exist, and no date at all", [readRenewal("2026-02-30"), readRenewal("next month"), readRenewal("  ")], [
    { ok: false, reason: "unreadable" },
    { ok: false, reason: "unreadable" },
    { ok: false, reason: "empty" },
  ]);

  part("Never charged before the renewal date");
  is("a renewal far enough away is the first charge", firstChargeAt(nowS + 20 * DAY, now), nowS + 20 * DAY);
  is("one too close for Stripe to wait for is charged later, never earlier", firstChargeAt(nowS + DAY, now), nowS + MIN_DEFER_SECONDS);
  is("one already passed is due, and taken at checkout", firstChargeAt(nowS - DAY, now), null);
  is("the reminder goes three days before", reminderAt(nowS + 20 * DAY, now), nowS + 17 * DAY);
  is("and not at all when there is no time for one", reminderAt(nowS + 3 * DAY, now), null);

  part("Bringing members over");
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  // A members import needs the postal address its emails carry (lib/move-members.ts, movePostal).
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "12 Harbor Lane, Portland, ME 04101, USA" });
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 7, payments: 0 });
  const fixed = await addProduct(OWNER, "Six Months", "", "19", { interval: "month", trialDays: 0, payments: 6 });
  const guide = await addProduct(OWNER, "The Guide", "", "12", null);
  if (!club.ok || !fixed.ok || !guide.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setProductLink(OWNER, fixed.product.id, "https://example.com/six");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  let store = (await storeForEmail(OWNER))!;

  const in20 = noon(new Date((nowS + 20 * DAY) * 1000));
  const rows = [
    ["2", "ada@example.com", "The Inner Circle", iso(in20), ""],
    ["3", "ben@example.com", "the inner circle", iso(nowS - 2 * DAY), ""],
    ["4", "cy@example.com", "The Inner Circle", "04/05/2026", ""],
    ["5", "dee@example.com", "The Guide", iso(in20), ""],
    ["6", "eve@example.com", "Six Months", iso(in20), ""],
    ["7", "ada@example.com", "The Inner Circle", iso(in20), ""],
    ["8", "fay@example.com", "Nothing Like It", iso(in20), ""],
    ["9", "gus@example.com", "The Inner Circle", iso(nowS - 60 * DAY), ""],
    ["10", "not an address", "The Inner Circle", iso(in20), ""],
    ["11", "hal@example.com", "The Inner Circle", iso(in20), ""],
  ];
  const refused = await startImport(store, OWNER, "members", { expected: rows.length, file: "patrons.csv" });
  is("nothing starts until the creator says they will stop the old renewals", refused.ok ? "started" : refused.reason, "stopped");
  const started = await startImport(store, OWNER, "members", { expected: rows.length, file: "patrons.csv", stopped: true });
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  await addRows(store, started.job.id, rows);
  await finishUpload(store, started.job.id);
  let job = await runImport(started.job.id, Date.now() + 30_000);
  for (let i = 0; i < 5 && job && job.state !== "done"; i += 1) job = await runImport(started.job.id, Date.now() + 30_000);
  is("finished", job?.state, "done");
  is("three members invited, one repeated row left out, six rows that cannot move", [job?.counts.added, job?.counts.skipped, job?.counts.errors], [3, 1, 6]);
  is("each invited member emailed once", emails.map((e) => [e.to].flat()[0]).sort(), ["ada@example.com", "ben@example.com", "hal@example.com"]);

  const ada = emails.find((e) => [e.to].flat()[0] === "ada@example.com")!;
  const ben = emails.find((e) => [e.to].flat()[0] === "ben@example.com")!;
  is("the subject names the membership and the store", ada.subject, "Keep your membership of The Inner Circle with Harbor Kitchen");
  is("a member whose renewal is ahead hears nothing is charged before it", ada.text.includes(`Nothing is charged before ${new Date(in20 * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}, the day it would have renewed, and the first payment here is $29.`), true);
  is("and that one reminder may follow", ada.text.includes("one reminder is sent a few days before"), true);
  is("a member whose renewal has passed hears the payment is due", ben.text.includes("Its next payment is due now"), true);
  is("and that nothing more is sent", ben.text.includes("Nothing more is sent because of it."), true);
  is("each says who sent it for whom", ada.text.includes("Sent by Marktmorgen on behalf of Harbor Kitchen."), true);

  part("The link");
  const adaLink = ada.text.match(/\/move\/([A-Za-z0-9_-]+)\?k=([0-9a-f]{40})/);
  const benLink = ben.text.match(/\/move\/([A-Za-z0-9_-]+)\?k=([0-9a-f]{40})/);
  if (!adaLink || !benLink) throw new Error("no link");
  store = (await storeForEmail(OWNER))!;
  is("it is Ada's, for this membership", (await readMove(store, adaLink[1], adaLink[2]))?.e, "ada@example.com");
  is("it opens nothing for another product", await readMove(store, guide.product.id, adaLink[2]), null);
  is("and nothing with a token made up", await readMove(store, adaLink[1], "f".repeat(40)), null);
  const unasked = await openMove(store, adaLink[1], adaLink[2], "https://marktmorgen.com", now);
  is("without the box to start the membership before the 14 days end (lib/digital-consent.ts), no checkout opens", unasked.ok ? "opened" : unasked.reason, "consent");
  const opened = await openMove(store, adaLink[1], adaLink[2], "https://marktmorgen.com", now, TEST_CONSENT);
  is("the checkout opens", opened.ok, true);
  const body = checkouts.at(-1)!;
  is("for her address only", body.get("customer_email"), "ada@example.com");
  is("first charged on the renewal date", body.get("subscription_data[trial_end]"), String(in20));
  is("with no free trial on top", body.get("subscription_data[trial_period_days]"), null);
  is("marked as moved, on the payment and on the subscription", [body.get("metadata[moved]"), body.get("subscription_data[metadata][moved]"), body.get("metadata[first_charge]")], ["yes", "yes", String(in20)]);
  await openMove(store, benLink[1], benLink[2], "https://marktmorgen.com", now, TEST_CONSENT);
  const due = checkouts.at(-1)!;
  is("a payment already due is taken at checkout", [due.get("subscription_data[trial_end]"), due.get("metadata[moved]")], [null, "yes"]);

  part("One reminder, never to somebody who kept it");
  customersByEmail.set("hal@example.com", "cus_Hal000001");
  liveSubs.set("cus_Hal000001", [{ status: "trialing", metadata: { store: "harbor", product: club.product.id } }]);
  const sentBefore = emails.length;
  // From the renewal date itself, so the hour the test runs at changes nothing.
  const early = await sendMoveReminders(Date.now() + 30_000, (in20 - 4 * DAY) * 1000);
  is("nothing before its day", [early.sent, emails.length], [0, sentBefore]);
  const reminded = await sendMoveReminders(Date.now() + 30_000, (in20 - 3 * DAY + 3_600) * 1000);
  is("Ada is reminded; Hal, who kept it, is not", [reminded.sent, reminded.kept, emails.slice(sentBefore).map((e) => [e.to].flat()[0])], [1, 1, ["ada@example.com"]]);
  is("the reminder says it is the only one", emails.at(-1)?.text.includes("This is the only reminder."), true);
  const again = await sendMoveReminders(Date.now() + 30_000, (in20 - 2 * DAY) * 1000);
  is("and it is sent once", [again.sent, emails.length], [0, sentBefore + 1]);
  is("the studio counts who was invited and who kept it", await moveCounts(store), { invited: 3, kept: 1 });

  done();
}

void main();
