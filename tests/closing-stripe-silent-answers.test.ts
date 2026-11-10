/**
 * A closed store whose Stripe never answers (DONO-3): what is silence, and what a lapse must still do.
 *
 * Follows tests/closing-stripe-silent-lapse.test.ts. Its P1-P3 come from the independent pre-review's proof of
 * claude5/closed-store-deadline @ d401db4a70 (they failed there and pass on main):
 *
 *   - P1-P3: only Stripe giving no answer (the network failed, it timed out, a server error) is silence. An answer
 *     in a shape or a funding this code cannot read, or a write of ours that failed after Stripe said the plan
 *     runs, holds the store as before and never lapses; the independent observation is read even then;
 *   - A1: a lapse never deletes the record of a member whose paid time was not given back before that member is
 *     told, as a refund not made (the notice already promised "If it cannot be, we will email you");
 *   - A2: a failure of ours (a lock that cannot be claimed) or a Stripe that is not configured is never silence;
 *   - M2: how many known renewals were left running at Stripe is written down on the dated record;
 *   - M3: each lapse is counted in its month, and the owner's monthly report says how many.
 */
import { createHash } from "node:crypto";
import { type Hands, closeOne } from "@/lib/plan-closing";
import { savePaidPeriod } from "@/lib/closing-holds";
import * as heldStores from "@/lib/held-stores";
import { companyMonthlyMarginReportWithHeld } from "@/lib/company-margin-report";
import { DUE_KEY } from "@/lib/closed-store-data";
import { CLOSING_DAYS, ERASE_EVERY_DAYS, ERASE_WITHIN_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { addProduct, claimHandle, setProductFile, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { STREAM_API_ORIGIN } from "@/lib/stream-rules";
import { vaultPath } from "@/lib/vault-rules";
import type { ProductFile } from "@/lib/product-file";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 24 * 60 * 60 * 1000;
const C = CLOSING_DAYS;
const M = CLOSING_DAYS - WARN_MONTH_DAYS;
const W = CLOSING_DAYS - WARN_WEEK_DAYS;
/** The days after the closing day Stripe is waited for: the time already set, less one walk's room. */
const SILENT = ERASE_WITHIN_DAYS - ERASE_EVERY_DAYS;
const LIBRARY = "4242";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stateKey = (key: string) => `nl:plan:closing:${sha(key).slice(0, 40)}`;

// ------------------------------------------------------------- stand-ins

/** The file store, by path. */
const objects = new Map<string, number>();
let fileStore: "up" | "down" = "up";
/** Stripe, as the platform (plans) and as the creators' connected accounts (what they sold). */
const platform: "up" | "down" = "up";
let connected: "up" | "down" = "up";
const running = new Map<string, Record<string, unknown>>();
/** Ended plan subscriptions the platform reads by id only: a store's own, so our key is confirmed (H1 on #3463). */
const ownPlans = new Map<string, Record<string, unknown>>();
const ownPlan = (handle: string) => ownPlans.set(handle, { id: `sub_${handle}0001`, object: "subscription", status: "canceled", customer: `cus_${handle}0001`, metadata: { store: handle, tier: "creator" }, items: { data: [{ price: { recurring: { interval: "month" } } }] } });
const posted: string[] = [];
let breakAfterRead = false;
let breakRedis = false;
/** A failure of ours: the next HGETALL of a key with this prefix throws, once. */
let breakRead = "";
const sent: { to: string[]; subject: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.origin === STREAM_API_ORIGIN) {
    if (url.pathname.endsWith("/videos") && method === "GET") return json({ totalItems: 0, currentPage: 1, itemsPerPage: 1000, items: [] });
    return json({}, 404);
  }
  if (url.origin === "https://api.stripe.com") {
    const headers = new Headers(init?.headers);
    const onAccount = headers.has("Stripe-Account");
    if ((onAccount ? connected : platform) === "down") throw new TypeError("fetch failed");
    if (method !== "GET") posted.push(`${method} ${url.pathname}`);
    const path = url.pathname.replace(/^\/v1/, "");
    if (path === "/subscriptions/search") {
      const query = url.searchParams.get("query") ?? "";
      return json({ object: "search_result", data: [...running.entries()].filter(([handle]) => query.includes(`'${handle}'`)).map(([, row]) => row), has_more: false, next_page: null });
    }
    if (path === "/subscriptions") return json({ object: "list", data: [], has_more: false });
    if (path === "/checkout/sessions" && method === "GET") return json({ object: "list", data: [], has_more: false });
    const one = [...running.values(), ...ownPlans.values()].find((row) => path === `/subscriptions/${String(row.id)}`);
    if (one) { if (breakAfterRead) { breakAfterRead = false; breakRedis = true; } return json(one); }
    return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
  }
  if (url.hostname === "api.resend.com") {
    // One email, or a batch of them (lib/closing-buyers.ts sends its members' notices as one batch).
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string } | { to: string[]; subject: string }[];
    const mails = Array.isArray(body) ? body : [body];
    sent.push(...mails);
    return json(Array.isArray(body) ? { data: mails.map((_, i) => ({ id: `email-${sent.length - mails.length + i + 1}` })) } : { id: `email-${sent.length}` });
  }
  return new Response(null, { status: 404 });
}) as typeof fetch;

const hands: Hands = {
  measure: async (folder) => [...objects].filter(([path]) => path.startsWith(`vault/${folder}/`)).reduce((sum, [, bytes]) => sum + bytes, 0),
  list: async (prefix) => {
    if (fileStore === "down") throw new Error("the file store is down");
    return [...objects.keys()].filter((path) => path.startsWith(prefix));
  },
  remove: async (paths) => {
    if (fileStore === "down") throw new Error("the file store is down");
    for (const path of paths) objects.delete(path);
  },
};

// ---------------------------------------------------------------- stores

type Made = { email: string; handle: string; folder: string; ended: number };
let tokens = 0;

/** A store on a paid plan with one file, whose plan then ends. */
async function closingStore(handle: string): Promise<Made> {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `${handle} studio`, "");
  await setSubscription(email, { customerId: `cus_${handle}0001`, subscriptionId: `sub_${handle}0001`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  const folder = await storeFolder(email);
  const added = await addProduct(email, "Guide", "", "19", null);
  if (!added.ok) throw new Error(`no product: ${added.reason}`);
  tokens += 1;
  const pathname = vaultPath(folder, added.product.id, tokens.toString(16).padStart(16, "0"), "guide.pdf");
  objects.set(pathname, 10 * 1024 * 1024);
  const file: ProductFile = { pathname, name: "guide.pdf", bytes: 10 * 1024 * 1024, contentType: "application/pdf", addedAt: "2026-06-01T00:00:00.000Z" };
  const put = await setProductFile(email, added.product.id, file);
  if (!put.ok) throw new Error(`no file: ${put.reason}`);
  await setSubscription(email, { active: false });
  const ended = Date.parse((await storeForEmail(email))?.planEndedAt ?? "");
  return { email, handle, folder, ended };
}

/** Its three notices, as the daily run sends them, so its closing day can come. */
async function told(made: Made): Promise<void> {
  for (const at of [made.ended + 60_000, made.ended + M * DAY, made.ended + W * DAY]) await closeOne(made.email, at, hands);
}

const filesOf = (made: Made) => [...objects.keys()].filter((path) => path.startsWith(`vault/${made.folder}/`)).length;
const inLine = async (made: Made) => (await redis.pipeline([["ZSCORE", DUE_KEY, made.email]]))[0] !== null;
const record = async (made: Made): Promise<Record<string, unknown> | null> => {
  const [raw] = await redis.pipeline([["GET", stateKey(made.email)]]);
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null;
};

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const real = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = real;
  }
}

const realNow = Date.now.bind(Date);
const clockAt = (ms: number) => {
  const shift = ms - realNow();
  Date.now = () => realNow() + shift;
};


// A plan in good standing as Stripe sends it (lib/billing.ts reads a search row exactly: its created, its customer
// expanded, its one USD item and price, its period and its stop fields).
const activeSub = (made: Made, extra: Record<string, unknown> = {}) => ({ id: `sub_${made.handle}0001`, object: "subscription", status: "active", created: Math.floor((made.ended - 30 * DAY) / 1000), cancel_at: null, cancel_at_period_end: false, customer: { id: `cus_${made.handle}0001`, object: "customer", email: made.email }, metadata: { store: made.handle, tier: "creator" }, items: { data: [{ quantity: 1, price: { currency: "usd", unit_amount: 6900, recurring: { interval: "month", interval_count: 1 } }, current_period_start: Math.floor((made.ended + 30 * DAY) / 1000), current_period_end: Math.floor((made.ended + 60 * DAY) / 1000) }] }, current_period_end: Math.floor((made.ended + 60 * DAY) / 1000), ...extra });

async function main(): Promise<void> {
  redis.clear();
  clockAt(Date.UTC(2026, 9, 20, 12, 0, 0));
  for (const [name, value] of [
    ["BUNNY_STREAM_LIBRARY_ID", LIBRARY],
    ["BUNNY_STREAM_API_KEY", "a-stand-in-library-key-for-tests-only"],
    ["BUNNY_STREAM_TOKEN_KEY", "a-stand-in-token-key-for-tests-only"],
    ["STRIPE_SECRET_KEY", "sk_test_a_stand_in_key_for_tests_only"],
    ["RESEND_API_KEY", "re_test_a_stand_in_key_for_tests_only"],
  ]) process.env[name] = value;
  const realPipeline = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (commands: (string | number)[][]) => {
    if (breakRedis) { breakRedis = false; throw new Error("redis timeout (stand-in)"); }
    if (breakRead && commands.some((command) => command[0] === "HGETALL" && String(command[1] ?? "").startsWith(breakRead))) {
      breakRead = "";
      throw new Error("redis timeout (stand-in)");
    }
    return realPipeline(commands);
  }) as typeof redis.pipeline;

  const funded = await closingStore("fundedstore");
  const odd = await closingStore("oddstore");
  const flaky = await closingStore("flakystore");
  for (const made of [funded, odd, flaky]) await told(made);

  part("P1: Stripe answers ACTIVE (contract-funded plan): readSubscription without fundingStore says unknown");
  running.set(funded.handle, activeSub(funded, { metadata: { store: funded.handle, tier: "creator", funding_grant: "grant_1" } }));
  const f1 = await quietly(() => closeOne(funded.email, funded.ended + (C + 1) * DAY, hands));
  is("before the deadline: held (as before)", f1.state, "held");
  const f2 = await quietly(() => closeOne(funded.email, funded.ended + (C + SILENT + 1) * DAY, hands));
  is("past the deadline, Stripe answering ACTIVE every day: the store must NOT be removed", [f2.state, filesOf(funded), await inLine(funded)], ["held", 1, false]);

  part("P2: Stripe answers in an unknown shape (a status this code does not know), the search shows the plan live");
  running.set(odd.handle, activeSub(odd, { status: "active_pending" }));
  const o2 = await quietly(() => closeOne(odd.email, odd.ended + (C + SILENT + 1) * DAY, hands));
  is("an answer in an unknown shape is not silence: never removed", [o2.state, filesOf(odd)], ["held", 1]);

  part("P3: Stripe answers ACTIVE, then our own Redis write fails once");
  running.set(flaky.handle, activeSub(flaky));
  breakAfterRead = true;
  const k2 = await quietly(() => closeOne(flaky.email, flaky.ended + (C + SILENT + 1) * DAY, hands));
  is("Stripe said the plan runs: a failed write of ours is never silence, never removed", [k2.state === "removed", filesOf(flaky), await inLine(flaky)], [false, 1, false]);

  process.env.COMPANY_POSTAL_ADDRESS = "100 Example Street, Example City, NY 10001, United States";
  running.clear();
  const member = await closingStore("memberstore");
  const locked = await closingStore("lockedstore");
  const unset = await closingStore("unsetstore");
  for (const made of [member, locked, unset]) await told(made);

  part("A1 and M2: a lapse tells the member whose paid time was not given back, before anything is deleted");
  await setStripeAccount(member.email, "acct_1SilentMember01");
  const memberStore = await storeForEmail(member.email);
  if (!memberStore) throw new Error("no member store");
  // A member who paid for 60 days from 10 days before the plan ended: time is left after the closing day.
  await savePaidPeriod(memberStore, "sub_member0000001", { inv: "in_member0000001", amt: 6000, cur: "usd", ps: Math.floor((member.ended - 10 * DAY) / 1000), pe: Math.floor((member.ended + 50 * DAY) / 1000), e: "paid-member@example.com" });
  ownPlan(member.handle);
  connected = "down";
  const memberHeld = await quietly(() => closeOne(member.email, member.ended + (C + 1) * DAY, hands));
  is("its renewals cannot be stopped: held", memberHeld.state, "held");
  // Silent on every daily run until the deadline (Claude 3's H1 on #3463: a streak, never one silence).
  for (let d = C + 2; d <= C + SILENT; d += 1) await quietly(() => closeOne(member.email, member.ended + d * DAY, hands));
  const before = sent.length;
  const memberGone = await quietly(() => closeOne(member.email, member.ended + (C + SILENT + 1) * DAY, hands));
  const toMember = sent.slice(before).filter((mail) => mail.to.includes("paid-member@example.com"));
  is("past the deadline it closes without Stripe", [memberGone.state, memberGone.lapsed, filesOf(member)], ["removed", true, 0]);
  is("the member is emailed once that the refund was not made, before the records go", toMember.filter((mail) => /may not have been made/.test(mail.subject)).length, 1);
  is("and once that the membership may keep renewing (M2 on #3463)", toMember.filter((mail) => /may keep renewing/.test(mail.subject)).length, 1);
  is("the dated record says how many known renewals were left running at Stripe", (await record(member))?.unstopped, 1);
  connected = "up";

  part("A2: a failure of ours is never silence");
  await setStripeAccount(locked.email, "acct_1SilentLocked01");
  const lockedStore = await storeForEmail(locked.email);
  if (!lockedStore) throw new Error("no locked store");
  await savePaidPeriod(lockedStore, "sub_locked0000001", { inv: "in_locked0000001", amt: 6000, cur: "usd", ps: Math.floor((locked.ended - 10 * DAY) / 1000), pe: Math.floor((locked.ended + 50 * DAY) / 1000), e: "locked-member@example.com" });
  ownPlan(locked.handle);
  // The member store's account was silent on these same days: two accounts silent together would read as ours.
  for (const k of redis.keys()) if (k.startsWith("nl:held:silent:")) redis.run(["DEL", k]);
  connected = "down";
  for (let d = C + 1; d <= C + SILENT; d += 1) await quietly(() => closeOne(locked.email, locked.ended + d * DAY, hands));
  // The members' payments, read under the refunds' lock: our own Redis fails on it.
  breakRead = "nl:closing:paid:";
  const lockedLate = await quietly(() => closeOne(locked.email, locked.ended + (C + SILENT + 1) * DAY, hands));
  connected = "up";
  is("the members' payments cannot be read (our Redis): held past the deadline, nothing removed", [lockedLate.state, lockedLate.note, filesOf(locked), await inLine(locked)], ["held", "its members' unused time is not settled yet", 1, false]);
  // Its day begins and is held on the file store; then Stripe is not configured at all.
  fileStore = "down";
  await quietly(() => closeOne(unset.email, unset.ended + (C + 1) * DAY, hands));
  fileStore = "up";
  const key = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const unsetLate = await quietly(() => closeOne(unset.email, unset.ended + (C + SILENT + 1) * DAY, hands));
  process.env.STRIPE_SECRET_KEY = key;
  is("Stripe not configured is not Stripe silent: held past the deadline, nothing removed", [unsetLate.state, filesOf(unset), await inLine(unset)], ["held", 1, false]);

  part("M3: each lapse is counted in its month, and the owner's report says how many");
  const lapsedAt = new Date(member.ended + (C + SILENT + 1) * DAY);
  const month = lapsedAt.toISOString().slice(0, 7);
  const lastDay = Date.UTC(lapsedAt.getUTCFullYear(), lapsedAt.getUTCMonth() + 1, 0, 12);
  await heldStores.recordHeldMonth(lastDay, true);
  // Read through the module, so this file builds before the reader exists (its first commit is the failing one).
  const readLapsedMonth = (Reflect.get(heldStores, "readLapsedMonth") ?? (async () => "missing")) as (month: string) => Promise<number | null | string>;
  is("the month counts the one lapse", await readLapsedMonth(month), 1);
  const nextMonth = lastDay + 5 * DAY;
  const report = await companyMonthlyMarginReportWithHeld(null, nextMonth);
  is("the report reads it", [report.month, Reflect.get(report, "lapsedStores")], [month, 1]);
  is("a month with no complete observation is unknown, never zero", await readLapsedMonth("2026-01"), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
