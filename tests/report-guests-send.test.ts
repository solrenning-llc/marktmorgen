/**
 * 405 [HX1] unit 6: the numbers email to confirmed addresses outside the team,
 * as the weekly and monthly jobs send it. Synthetic store, team and addresses
 * on the in-memory database; the sender is a stand-in that records what
 * would have gone, so no real email is sent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimHandle, ensureStoreId, storeForEmail } from "@/lib/store";
import { answerLink, readShare, saveShare } from "@/lib/report-guests";
import { monthFigures, periodWords, reportMessage, sendGuestReports, weekFigures, type PeriodFigures } from "@/lib/report-guests-mail";
import { takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only"; // a synthetic credential the Resend fixture knows

const OWNER = "owner@example.test";
const sent: { to: string; subject: string; text: string; headers: Record<string, string> }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body));
    sent.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text, headers: body.headers ?? {} });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  throw new Error(`no network in this test: ${url.href}`);
}) as typeof fetch;

const PERIOD: PeriodFigures = { from: "2026-11-09", to: "2026-11-15", values: { sales: 12, revenue: 45_600, visits: 1_234, currency: "usd" } };
const real = redis.pipeline.bind(redis);

async function storeWith(handle: string, guests: string[], every: "week" | "month" = "week", figures = ["sales", "revenue", "visits"]) {
  const owner = `${handle}-${OWNER}`;
  await claimHandle(owner, handle, "Ledger Studio", "");
  const store = (await ensureStoreId(owner))!;
  const saved = await saveShare(store.sid, { figures, every, addresses: guests }, { team: [], owner });
  assert.ok(saved.ok);
  return { store: (await storeForEmail(owner))!, invites: saved.invites };
}
const confirm = async (token: string) => assert.equal((await answerLink("confirm", token)).result, "confirmed");

test("only a confirmed address gets it, with only the chosen figures and its own one-click leave link", async () => {
  const { store, invites } = await storeWith("sendhxa", ["partner@example.test", "invited@example.test", "left@example.test"], "week", ["visits", "sales"]);
  await confirm(invites[0].confirmToken);
  await confirm(invites[2].confirmToken);
  assert.equal((await answerLink("leave", invites[2].leaveToken)).result, "left");
  sent.length = 0;
  const run = await sendGuestReports(store, "week", PERIOD);
  assert.deepEqual(run, { sent: 1, skipped: 0, failed: 0 });
  assert.equal(sent.length, 1);
  const [one] = sent;
  assert.equal(one.to, "partner@example.test");
  assert.equal(one.subject, "Ledger Studio: numbers for the last 7 days");
  assert.ok(one.text.includes("for the 7 days from Nov 9 to Nov 15, 2026 (dates in UTC)."));
  assert.ok(one.text.includes("Sales: 12\nVisits: 1,234"));
  assert.ok(!one.text.includes("Money in"), "a figure not chosen is not in it");
  const leave = `https://marktmorgen.com/api/numbers-guest/leave?t=${encodeURIComponent(invites[0].leaveToken)}`;
  assert.ok(one.text.endsWith(leave) || one.text.includes(`/api/numbers-guest/leave?t=${encodeURIComponent(invites[0].leaveToken)}`));
  assert.match(one.headers["List-Unsubscribe"], new RegExp(`/api/numbers-guest/leave\\?t=${invites[0].leaveToken.replace(/[-]/g, "\\-")}>$`));
  assert.equal(one.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  // The leave link in it works: one press and the next run sends nothing.
  assert.equal((await answerLink("leave", invites[0].leaveToken)).result, "left");
  sent.length = 0;
  assert.equal((await sendGuestReports(store, "week", PERIOD)).sent, 0);
  assert.equal(sent.length, 0);
});

test("the leave link's record is written again before each email", async () => {
  const { store, invites } = await storeWith("sendhxb", ["partner@example.test"]);
  await confirm(invites[0].confirmToken);
  const guest = (await readShare(store.sid)).guests[0];
  await redis.pipeline([["EXPIRE", `nl:rguest:link:${guest.leave}`, 5]]);
  await sendGuestReports(store, "week", PERIOD);
  const ttl = Number((await redis.pipeline([["TTL", `nl:rguest:link:${guest.leave}`]]))[0]);
  assert.ok(ttl > 60 * 86_400, `lives ${ttl}s`);
});

test("a store whose choice is the other interval, or with no figure, sends nothing", async () => {
  const { store, invites } = await storeWith("sendhxc", ["partner@example.test"], "month");
  await confirm(invites[0].confirmToken);
  sent.length = 0;
  assert.equal((await sendGuestReports(store, "week", PERIOD)).sent, 0);
  await saveShare(store.sid, { figures: [], every: "month", addresses: ["partner@example.test"] }, { team: [], owner: store.email });
  assert.equal((await sendGuestReports(store, "month", { ...PERIOD, month: "2026-10" })).sent, 0);
  assert.equal(sent.length, 0);
});

test("an address that joined the team since, or is now the owner's, gets the team's email instead", async () => {
  const { store, invites } = await storeWith("sendhxd", ["partner@example.test"]);
  await confirm(invites[0].confirmToken);
  await redis.pipeline([["SET", `nl:team:${store.sid}`, JSON.stringify({ members: [{ email: "partner@example.test", role: "editor", joinedAt: "2026-11-16T00:00:00Z" }], invites: [] })]]);
  sent.length = 0;
  assert.deepEqual(await sendGuestReports(store, "week", PERIOD), { sent: 0, skipped: 1, failed: 0 });
  await redis.pipeline([["DEL", `nl:team:${store.sid}`]]);
  assert.deepEqual(await sendGuestReports({ ...store, email: "partner@example.test" }, "week", PERIOD), { sent: 0, skipped: 1, failed: 0 });
  assert.equal(sent.length, 0);
});

test("the list is read again just before each email: one removed after the run began gets nothing", async () => {
  const { store, invites } = await storeWith("sendhxe", ["partner@example.test", "books@example.test"]);
  await confirm(invites[0].confirmToken);
  await confirm(invites[1].confirmToken);
  sent.length = 0;
  let reads = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = await real(commands);
    if (commands[0]?.[0] === "GET" && commands[0][1] === `nl:rguest:${store.sid}` && ++reads === 2) {
      // Between the run's first read and the first address's own: books is taken off the list.
      await saveShare(store.sid, { figures: ["sales"], every: "week", addresses: ["partner@example.test"] }, { team: [], owner: store.email });
    }
    return reply;
  }) as typeof redis.pipeline;
  try {
    const run = await sendGuestReports(store, "week", PERIOD);
    assert.deepEqual(run, { sent: 1, skipped: 1, failed: 0 });
  } finally {
    redis.pipeline = real;
  }
  assert.deepEqual(sent.map((one) => one.to), ["partner@example.test"]);
});

test("a list or team that does not read sends nothing", async () => {
  const { store, invites } = await storeWith("sendhxf", ["partner@example.test"]);
  await confirm(invites[0].confirmToken);
  sent.length = 0;
  for (const key of [`nl:rguest:${store.sid}`, `nl:team:${store.sid}`]) {
    redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "GET" && commands[0][1] === key ? [] : real(commands))) as typeof redis.pipeline;
    try {
      const run = await sendGuestReports(store, "week", PERIOD);
      assert.equal(run.sent, 0, key);
      assert.equal(run.failed, 1, key);
    } finally {
      redis.pipeline = real;
    }
  }
  assert.equal(sent.length, 0);
});

test("each email is taken from the store's emails first: when they are used up, nothing goes", async () => {
  const { store, invites } = await storeWith("sendhxg", ["partner@example.test", "books@example.test"]);
  await confirm(invites[0].confirmToken);
  await confirm(invites[1].confirmToken);
  const room = allowanceFor(store, "email");
  let left = room;
  for (let i = 0; i < room; i += 1) {
    const taken = await takeAllowance(store, "email");
    if (!taken.ok) break;
    left = taken.left;
    // Leave room for exactly one email.
    if (left === 1) break;
  }
  assert.equal(left, 1);
  sent.length = 0;
  const run = await sendGuestReports(store, "week", PERIOD);
  assert.deepEqual(run, { sent: 1, skipped: 0, failed: 1 });
  assert.equal(sent.length, 1, "the second email did not fit the figure and was not sent");
});

test("a figure not read in full is said unknown, never zero, and the period says its time zone", () => {
  const message = reportMessage({ name: "Ledger Studio", handle: "ledger" }, "month", ["sales", "revenue", "visits"], { from: null, to: null, month: "2026-10", values: { sales: null, revenue: null, visits: 0, currency: "usd" } }, "https://marktmorgen.com/api/numbers-guest/leave?t=x");
  assert.equal(message.subject, "Ledger Studio: numbers for October 2026");
  assert.ok(message.text.includes("for October 2026 (dates in UTC)."));
  assert.ok(message.text.includes("Sales: unknown\nMoney in, after refunds: unknown\nVisits: 0"));
  assert.ok(message.text.includes('"unknown" means the figure could not be read in full'));
  assert.ok(!/\$0\.00/.test(message.text));
  assert.equal(periodWords("week", { from: null, to: null }), "the last 7 days (dates in UTC)");
});

test("the week's and the month's figures are read as the store's own emails read them", () => {
  const window = (over: Record<string, unknown>) => ({ period: { from: "2026-11-09", to: "2026-11-15" }, sales: 3, visitors: 40, payments: { complete: true, gross_receipts: 900, after_refunds: 700 }, ...over });
  const summary = (week: Record<string, unknown>, daily: { payments_complete: boolean; refunds_complete: boolean; rows: { date: string; after_refunds: number | null }[] }) =>
    ({ currency: "eur", days: { last_7_days: window(week), last_90_days: { daily_payments: daily } } }) as never;
  const none = { payments_complete: true, refunds_complete: true, rows: [] };
  assert.deepEqual(weekFigures(summary({}, none)).values, { sales: 3, revenue: 700, visits: 40, currency: "eur" });
  assert.equal(weekFigures(summary({ payments: { complete: false, gross_receipts: null, after_refunds: null } }, none)).values.revenue, null);
  assert.equal(weekFigures(summary({ sales: null }, none)).values.sales, null);

  const october = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  const days = october.map((date) => ({ date, visitors: 2, sales: 1 }));
  const rows = october.map((date) => ({ date, after_refunds: 100 }));
  const full = monthFigures(summary({}, { payments_complete: true, refunds_complete: true, rows }), days, true, "2026-10");
  assert.deepEqual(full.values, { visits: 62, sales: 31, revenue: 3_100, currency: "eur" });
  assert.deepEqual([full.from, full.to], ["2026-10-01", "2026-10-31"]);
  // A day missing: nothing of the month is said as a number.
  const short = monthFigures(summary({}, { payments_complete: true, refunds_complete: true, rows }), days.slice(1), true, "2026-10");
  assert.deepEqual(short.values, { visits: null, sales: null, revenue: null, currency: "eur" });
  // Sales not read in full, or refunds not read: those alone are unknown.
  assert.equal(monthFigures(summary({}, { payments_complete: true, refunds_complete: true, rows }), days, false, "2026-10").values.sales, null);
  assert.equal(monthFigures(summary({}, { payments_complete: true, refunds_complete: false, rows }), days, true, "2026-10").values.revenue, null);
  assert.equal(monthFigures(summary({}, { payments_complete: true, refunds_complete: true, rows: rows.map((r, i) => (i === 3 ? { ...r, after_refunds: null } : r)) }), days, true, "2026-10").values.revenue, null);
});

test("the stand-in sender is the only one this test reaches", () => {
  assert.ok(sent.every((one) => one.to.endsWith("@example.test")));
});
