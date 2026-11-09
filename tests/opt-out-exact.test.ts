/**
 * Once-only emails read their Redis answers exactly (CX-123 rule 24).
 *
 * 1. The affiliate payday email (lib/affiliate-payday.ts): the store's month
 *    is claimed with SET NX before it goes. A claim answered in any other shape
 *    than "OK" or nil is never read as ours: the store is not written to on it.
 * 2. The usage watch's over-allowance notice (app/api/cron/usage/route.ts):
 *    the list of stores already told is read before anybody is written to. A
 *    list that is not nil or a JSON list of names is never read as "nobody
 *    told yet": nobody is written to about the allowance on it, the list is
 *    left as it was, and the run says the part is unknown.
 *
 * 3. The numbers emails (lib/stats-report.ts): whether the creator pressed
 *    "Stop" (weeklyOff, one SMISMEMBER by the store's id and addresses since
 *    finding 5 of the handles audit) is read exactly, and an answer of another
 *    shape is never "not stopped": no email goes on it. The week's, the
 *    month's and the busy day's claims (SET NX) go through claimMark: an
 *    answer of another shape not read back as ours is never ours.
 *
 * Confirmed answers (a claim held by another run, a list never written) work
 * as before. Synthetic data only. Part 3 follows the proof Claude 5 wrote in
 * sweep A6 (tests/sweep-a6-numbers-mail.proof.ts on claude5/sweep-a6 at
 * 61c3662c: claimWeek firing twice, weeklyOff ignoring the stop, claimMonth and
 * the busy-day claim).
 */
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { sendPaydayEmails } from "@/lib/affiliate-payday";
import { recordDelivery, rememberFolderOwner, DELIVERY_ALLOWANCE_BYTES } from "@/lib/delivery";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { GET as usage } from "@/app/api/cron/usage/route";
import { BUSY_FLOOR, claimMonth, claimWeek, maybeBusyAlert, setWeeklyOff, weeklyOff } from "@/lib/stats-report";
import { setSubscription } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_opt_out_exact_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
delete process.env.CRON_SECRET;

const sent: { to: string; subject: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string };
    sent.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to), subject: String(body.subject) });
    return answer({ id: `email_${sent.length}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** Replies the test puts in place of Redis's own, for the commands `when` picks. */
let inject: { when: (command: (string | number)[]) => boolean; reply: () => unknown[] } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (inject && commands.length === 1 && inject.when(commands[0])) return inject.reply();
  return pipeline(commands);
}) as typeof redis.pipeline;

const OWNER = "baker@example.com";
const DAY = 86_400;
const T0 = Math.floor(Date.now() / 1000) - 400 * DAY;
const MALFORMED: [string, () => unknown[]][] = [
  ["no reply at all", () => []],
  ["undefined", () => [undefined]],
  ["QUEUED", () => ["QUEUED"]],
  ["a number", () => [1]],
  ["two replies", () => ["OK", "OK"]],
];

async function payday(): Promise<void> {
  await claimHandle(OWNER, "crumb", "Crumb Bakery", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestOptOut0001", true);
  const today = new Date().getUTCDate();
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, payday: today }));
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const aff = "a1a1a1a1a1a1";
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, aff, JSON.stringify({ id: aff, email: `${aff}@example.com`, code: "a1a1a", status: "approved", appliedAt: T0 * 1000, decidedAt: T0 * 1000, note: "" })],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff, at: T0 + 10 * DAY, product: "prod01", title: "Bread course", base: 1000, total: 1000, currency: "usd", rate: 20, self: false, how: "click" })],
  ]);
  const month = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
  const claim = `nl:aff:payday:${statsId}:${month}`;
  const isClaim = (c: (string | number)[]) => c[0] === "SET" && c[1] === claim;
  // What a run did for the store: the emails it counts as sent, and whether it went past the claim (the next
  // step reads whether the creator pays from their PayPal by itself, then writes the email).
  const run = async () => {
    const seen: string[] = [];
    const watch = redis.pipeline;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      for (const c of commands) seen.push(`${c[0]} ${c[1]}`);
      return watch(commands);
    }) as typeof redis.pipeline;
    try {
      const counts = await sendPaydayEmails(Date.now() + 20_000);
      return { sent: counts.sent, pastTheClaim: seen.includes(`GET nl:pp:${statsId}`) };
    } finally {
      redis.pipeline = watch;
    }
  };
  const none = { sent: 0, pastTheClaim: false };

  part("Payday: the month's first run writes once, a second finds it taken");
  is("the first run sends the payday email", await run(), { sent: 1, pastTheClaim: true });
  is("a second run, claim answered nil (held): nothing", await run(), none);

  part("Payday: a claim answered in another shape is never ours");
  for (const [label, reply] of MALFORMED) {
    inject = { when: isClaim, reply };
    is(`claim held by the first run, answered ${label}: nothing sent`, await run(), none);
    await pipeline([["DEL", claim]]);
    is(`claim not held, answered ${label} and not read back as ours: nothing sent`, await run(), none);
    inject = null;
    await pipeline([["SET", claim, "held-by-another-run"]]);
  }

  part("Payday: confirmed absence still sends");
  await pipeline([["DEL", claim]]);
  is("no claim yet, SET NX answers OK: the email goes", await run(), { sent: 1, pastTheClaim: true });
}

async function told(): Promise<void> {
  const folder = "f0f0f0f0f0f0f0f0";
  const owner = "heavy@example.com";
  await rememberFolderOwner(folder, owner);
  await recordDelivery(`stores/${folder}/prod01/file.zip`, DELIVERY_ALLOWANCE_BYTES + 1024);
  const TOLD = "nl:usage-watch:told";
  const isTold = (c: (string | number)[]) => c[0] === "GET" && c[1] === TOLD;
  const toldWrites: unknown[] = [];
  const run = async () => {
    const before = sent.length;
    const writesBefore = toldWrites.length;
    let status = -1;
    let body: Record<string, unknown> = {};
    const watch = redis.pipeline;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      for (const c of commands) if (c[0] === "SET" && c[1] === TOLD) toldWrites.push(c[2]);
      return watch(commands);
    }) as typeof redis.pipeline;
    try {
      const response = await usage({ headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/usage") } as unknown as Parameters<typeof usage>[0]);
      status = response.status;
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      status = -1;
    } finally {
      redis.pipeline = watch;
    }
    return { emails: sent.slice(before).filter((m) => m.to === owner).length, status, unread: body.unread ?? [], toldWritten: toldWrites.length > writesBefore };
  };

  part("Usage watch: the told list read exactly");
  is("never written (nil): the owner is told once and the list written", await run(), { emails: 1, status: 200, unread: [], toldWritten: true });
  is("written with the store in it: nobody told again", await run(), { emails: 0, status: 200, unread: [], toldWritten: false });
  const kept = await pipeline([["GET", TOLD]]);
  for (const [label, reply] of [
    ...MALFORMED,
    ["not JSON", () => ["{"]],
    ["JSON that is not a list", () => [JSON.stringify({ folder })]],
    ["a list holding a number", () => [JSON.stringify([1])]],
    ["a JSON string", () => [JSON.stringify(folder)]],
  ] as [string, () => unknown[]][]) {
    inject = { when: isTold, reply };
    is(`list answered ${label}: nobody told, the list left as it was, the part said unknown`, await run(), { emails: 0, status: 503, unread: ["delivery"], toldWritten: false });
    inject = null;
  }
  is("the list holds what it held", await pipeline([["GET", TOLD]]), kept);
}

async function numbers(): Promise<void> {
  const owner = "numbers@example.com";
  await claimHandle(owner, "loaf", "Loaf House", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_OptOut00001", subscriptionId: "sub_OptOut00001", active: true, period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const one = (command: string, reply: () => unknown[]) => ({ when: (c: (string | number)[]) => c[0] === command, reply });
  // SMISMEMBER answers one 0 or 1 for each member asked (the store's id and its address): anything else is of another shape.
  const STOP_MALFORMED: [string, () => unknown[]][] = [
    ["no reply at all", () => []],
    ["undefined", () => [undefined]],
    ["QUEUED", () => ["QUEUED"]],
    ["2", () => [2]],
    ["two replies", () => [0, 0]],
    ["a flag of 2", () => [[2, 0]]],
    ["one flag for two members", () => [[0]]],
    ["a flag as text", () => [["0", 0]]],
  ];

  part("Numbers emails: the stop read exactly");
  await setWeeklyOff(store, true);
  is("stopped (1): off", await weeklyOff(store), true);
  await setWeeklyOff(store, false);
  is("not stopped (0): on", await weeklyOff(store), false);
  for (const [label, reply] of STOP_MALFORMED) {
    inject = one("SMISMEMBER", reply);
    is(`the stop answered ${label}: never read as "not stopped"`, await weeklyOff(store), true);
    inject = null;
  }

  part("Numbers emails: the week's and the month's claims read exactly");
  is("the week, first: ours", await claimWeek("loaf-week"), true);
  is("the week, again (nil): not ours", await claimWeek("loaf-week"), false);
  is("the month, first: ours", await claimMonth("loaf-month", "2026-10"), true);
  is("the month, again (nil): not ours", await claimMonth("loaf-month", "2026-10"), false);
  for (const [label, reply] of MALFORMED) {
    inject = one("SET", reply);
    is(`the week claimed already, answered ${label}: not ours`, await claimWeek("loaf-week"), false);
    is(`the week not claimed, answered ${label} and not read back as ours: not ours`, await claimWeek(`loaf-week-${label}`), false);
    is(`the month claimed already, answered ${label}: not ours`, await claimMonth("loaf-month", "2026-10"), false);
    is(`the month not claimed, answered ${label} and not read back as ours: not ours`, await claimMonth(`loaf-month-${label}`, "2026-10"), false);
    inject = null;
  }

  part("Numbers emails: the busy day's email once a day, on an exact claim");
  const busy = async () => {
    const before = sent.length;
    const said = await maybeBusyAlert(store, BUSY_FLOOR);
    return { said, emails: sent.slice(before).filter((m) => m.to === owner).length };
  };
  is("a busy day: the email goes", await busy(), { said: true, emails: 1 });
  is("again that day (nil): nothing", await busy(), { said: false, emails: 0 });
  for (const [label, reply] of MALFORMED) {
    inject = { when: (c) => c[0] === "SET" && String(c[1]).startsWith("nl:busy:"), reply };
    is(`the day claimed already, answered ${label}: nothing`, await busy(), { said: false, emails: 0 });
    inject = null;
  }
  await setWeeklyOff(store, true);
  for (const [label, reply] of STOP_MALFORMED) {
    await pipeline([["DEL", `nl:busy:${new Date().toISOString().slice(0, 10)}:${store.handle}`]]);
    inject = one("SMISMEMBER", reply);
    is(`stopped, the stop answered ${label}: no busy-day email`, await busy(), { said: false, emails: 0 });
    inject = null;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await payday();
  await told();
  await numbers();
  done();
}

void main();
