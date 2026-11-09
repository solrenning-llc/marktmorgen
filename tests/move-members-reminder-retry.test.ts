/**
 * A moved member's one reminder when whether they kept their membership cannot be read (lib/imports.ts,
 * sendMoveReminders; lib/move-members.ts, keptAlready; Claude 5, the MÉDIO of the pre-review of
 * claude5/move-members-email-case). keptAlready throws KeptUnknown when the address has more customers than
 * KEPT_CUSTOMERS_MAX (a guest who bought several times has a customer a purchase) or a customer has more than a
 * page of subscriptions; the reminder was put back an hour, every hour, for ever: it was read again every hour
 * even past its renewal date, because keptAlready ran before reminderEmail, the one that drops a reminder once
 * the first charge has passed (40 days: 961 reads, no reminder).
 *
 * Now a reminder whose renewal date has passed leaves the line before anything is asked of Stripe, and one whose
 * answer stays unknown is tried again only within REMIND_RETRY_HOURS of when it was due, then dropped with a log
 * line naming the store and the membership, never the address. It is never sent while the answer is unknown.
 * Synthetic only: Stripe and the email sender are a stand-in for `fetch`.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
// Rule 23: imported by name now that it exists; the RED commit read it off the module so the file built without it.
import { REMIND_DAYS_BEFORE, REMIND_RETRY_HOURS } from "@/lib/move-rules";
import { KEPT_CUSTOMERS_MAX } from "@/lib/move-members";
import { addRows, finishUpload, runImport, sendMoveReminders, startImport } from "@/lib/imports";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const nowS = Math.floor(Date.now() / 1000);
const noon = (s: number) => {
  const d = new Date(s * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12) / 1000);
};
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

type Sent = { to: string | string[]; subject: string; text: string };
const emails: Sent[] = [];
const toOf = (e: Sent) => [e.to].flat()[0];
/** Addresses with more customers than KEPT_CUSTOMERS_MAX: the answer is unknown, always. */
const manyCustomers = new Set<string>();
/** Addresses whose customer reads fail this many more times before Stripe answers. */
const failing = new Map<string, number>();
const reads = new Map<string, number>();

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
    const email = url.searchParams.get("email") ?? "";
    reads.set(email, (reads.get(email) ?? 0) + 1);
    const left = failing.get(email) ?? 0;
    if (left > 0) {
      failing.set(email, left - 1);
      return new Response(JSON.stringify({ error: { message: "stand-in outage" } }), { status: 500 });
    }
    if (manyCustomers.has(email)) {
      return answer({ object: "list", data: Array.from({ length: KEPT_CUSTOMERS_MAX }, (_, i) => ({ id: `cus_Many${String(i).padStart(6, "0")}`, email, created: i })), has_more: true });
    }
    return answer({ object: "list", data: [], has_more: false });
  }
  if (path === "/subscriptions") {
    const customer = url.searchParams.get("customer") ?? "";
    reads.set(customer, (reads.get(customer) ?? 0) + 1);
    return answer({ object: "list", data: [], has_more: false });
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const logged: string[] = [];
const keep = { error: console.error, warn: console.warn };
console.error = (...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
console.warn = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));

const queued = () => (redis.run(["ZRANGEBYSCORE", "nl:mv:due", 0, 99_999_999_999]) as string[]).filter((e) => e.includes("|"));
const readsOf = (email: string) => reads.get(email) ?? 0;
const manyReads = () => [...reads].filter(([k]) => k.startsWith("cus_Many")).reduce((sum, [, n]) => sum + n, 0);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_retry_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
  redis.clear();

  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 7, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  const store = (await storeForEmail(OWNER))!;

  const in20 = noon(nowS + 20 * DAY);
  const in30 = noon(nowS + 30 * DAY);
  const rows = [
    ["2", "ada@example.com", "The Inner Circle", iso(in20), ""],
    ["3", "hal@example.com", "The Inner Circle", iso(in20), ""],
    ["4", "ivy@example.com", "The Inner Circle", iso(in30), ""],
    ["5", "jo@example.com", "The Inner Circle", iso(in30), ""],
    ["6", "kim@example.com", "The Inner Circle", iso(in30), ""],
  ];
  const started = await startImport(store, OWNER, "members", { expected: rows.length, file: "patrons.csv", stopped: true });
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  await addRows(store, started.job.id, rows);
  await finishUpload(store, started.job.id);
  let job = await runImport(started.job.id, Date.now() + 30_000);
  for (let i = 0; i < 20 && job && job.state !== "done"; i += 1) job = await runImport(started.job.id, Date.now() + 30_000);
  is("five members invited", job?.counts.added, 5);
  is("five reminders waiting", queued().length, 5);
  const invited = emails.length;
  is("each invited once", emails.map(toOf).sort(), ["ada@example.com", "hal@example.com", "ivy@example.com", "jo@example.com", "kim@example.com"]);

  part("A reminder taken off the line after its renewal date leaves it without asking Stripe");
  // Ada and Hal's reminders were due three days before in20; the job runs only a day after it (an outage, a late run).
  await sendMoveReminders(Date.now() + 30_000, (in20 + DAY) * 1000);
  is("nothing asked of Stripe for either (fails: keptAlready ran before the renewal date was looked at)", [readsOf("ada@example.com"), readsOf("hal@example.com")], [0, 0]);
  is("no reminder sent", emails.length - invited, 0);
  is("and neither is waiting any more", queued().length, 3);

  is("the hours an unknown answer is tried again for are few: at least one, at most a day", REMIND_RETRY_HOURS >= 1 && REMIND_RETRY_HOURS <= 24, true);

  part("An answer that stays unknown is tried again for a few hours, never past the renewal date, and never sent");
  manyCustomers.add("ivy@example.com");
  failing.set("kim@example.com", 2);
  const due30 = in30 - REMIND_DAYS_BEFORE * DAY;
  let at = (due30 + 60) * 1000;
  for (let k = 0; k < 24 * 40; k += 1) {
    await sendMoveReminders(Date.now() + 30_000, at);
    at += 3_600 * 1000 + 1000;
  }
  const attempts = readsOf("ivy@example.com");
  console.log(`  info: Ivy's attempts ${attempts}, her customers' subscription reads ${manyReads()}, queued ${JSON.stringify(queued())}`);
  is("40 days on, nothing is waiting (fails: Ivy's was put back every hour for ever)", queued(), []);
  is(`Ivy's answer was asked at most REMIND_RETRY_HOURS + 1 = ${REMIND_RETRY_HOURS + 1} times (fails: about one an hour, 960 in 40 days)`, attempts >= 1 && attempts <= REMIND_RETRY_HOURS + 1, true);
  is(`each try at most one customer read a spelling and one subscriptions read for each of KEPT_CUSTOMERS_MAX customers`, manyReads() <= attempts * KEPT_CUSTOMERS_MAX, true);
  is("Ivy, whose answer was never known, got no reminder: a member who may pay already is not asked to pay again", emails.filter((e) => toOf(e) === "ivy@example.com").length - 1, 0);
  is("Jo, whose answer was known, got her one reminder", emails.filter((e) => toOf(e) === "jo@example.com").length - 1, 1);
  is("Kim, whose first two tries failed, got hers on the third", [readsOf("kim@example.com"), emails.filter((e) => toOf(e) === "kim@example.com").length - 1], [3, 1]);
  const dropped = logged.filter((line) => line.includes("reminder") && line.includes("not sent"));
  is("the reminder given up on is logged once, with the store and the membership", [dropped.length, dropped.every((l) => l.includes(store.sid!) && l.includes(club.product.id))], [1, true]);
  is("and never the address", dropped.some((l) => l.includes("@")), false);
  console.error = keep.error;
  console.warn = keep.warn;
  done();
}

void main();
