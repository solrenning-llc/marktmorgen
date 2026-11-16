/**
 * 405 [HX1] unit 1: the rules for the numbers email to addresses outside the
 * team. Pure: synthetic addresses only, nothing stored or sent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AFFILIATE_MIN_SELLERS,
  INVITE_DAYS,
  MAX_REPORT_GUESTS,
  REPORT_FIGURES,
  type Guest,
  guestAddress,
  guestLines,
  inviteOpen,
  mayGet,
  planGuests,
  readEvery,
  readFigures,
} from "@/lib/report-guests-rules";
import { MAX_WEEKLY_TEAM } from "@/lib/stats-report";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 12);
const guest = (address: string, state: Guest["state"], invitedAt = NOW - DAY): Guest => ({ address, state, invitedAt });
const who = { team: ["Team.One@example.test"], owner: "owner@example.test" };

test("at most three addresses outside the team, apart from the team's own five", () => {
  assert.equal(MAX_REPORT_GUESTS, 3);
  assert.equal(MAX_WEEKLY_TEAM, 5, "the team's list is its own and does not change");
});

test("figures: only the known ones, each once, in one order; none chosen is none sent", () => {
  assert.deepEqual(readFigures(["visits", "sales", "visits"]), ["sales", "visits"]);
  assert.deepEqual(readFigures([]), []);
  assert.equal(readFigures(["sales", "orders"]), null, "an unknown figure refuses the whole choice");
  assert.equal(readFigures("sales"), null);
  assert.equal(readFigures([1]), null);
  assert.deepEqual(readFigures([...REPORT_FIGURES].reverse()), [...REPORT_FIGURES]);
  // No buyer's name, address, order list or affiliate's identity is ever a figure.
  for (const figure of REPORT_FIGURES) assert.doesNotMatch(figure, /email|name|order|buyer|customer|address/);
});

test("schedule: a week or a month, nothing else", () => {
  assert.equal(readEvery("week"), "week");
  assert.equal(readEvery("month"), "month");
  for (const raw of ["day", "", null, 7, "Week"]) assert.equal(readEvery(raw), null);
});

test("an address is one plain address, kept in lower case", () => {
  assert.equal(guestAddress("  Partner@Example.Test "), "partner@example.test");
  for (const raw of ["", "partner", "partner@", "@example.test", "a@b", "a b@example.test", "a@example.test, b@example.test", "<a@example.test>", "a@@example.test", 42, null, `${"a".repeat(250)}@example.test`]) {
    assert.equal(guestAddress(raw), null, `refused: ${String(raw)}`);
  }
});

test("planning: new addresses are invited, kept ones keep their state, removed ones go", () => {
  const current = [guest("kept@example.test", "confirmed"), guest("gone@example.test", "invited")];
  const plan = planGuests(["Kept@example.test", "new@example.test"], current, who);
  assert.ok(plan.ok);
  assert.deepEqual(plan.keep, [current[0]]);
  assert.deepEqual(plan.invite, ["new@example.test"]);
  assert.deepEqual(plan.drop, ["gone@example.test"]);
});

test("planning refuses, naming why, and changes nothing", () => {
  const cases: [unknown[], string][] = [
    [["a@example.test", "b@example.test", "c@example.test", "d@example.test"], "too_many"],
    [["not an address"], "not_an_address"],
    [["team.one@example.test"], "on_the_team"],
    [["OWNER@example.test"], "own_address"],
    [["a@example.test", "A@example.test"], "twice"],
  ];
  for (const [typed, why] of cases) {
    const plan = planGuests(typed, [], who);
    assert.equal(plan.ok, false, why);
    if (!plan.ok) assert.equal(plan.why, why);
  }
  // Blank lines are not addresses typed, so they are skipped, not refused.
  const blank = planGuests(["", "  ", "a@example.test"], [], who);
  assert.ok(blank.ok && blank.invite.length === 1);
});

test("a re-added address that left is invited again, never confirmed by itself", () => {
  const plan = planGuests(["back@example.test"], [guest("back@example.test", "left")], who);
  assert.ok(plan.ok);
  assert.deepEqual(plan.keep, []);
  assert.deepEqual(plan.invite, ["back@example.test"]);
});

test("an invitation lapses, and only a confirmed address gets numbers", () => {
  assert.equal(inviteOpen(guest("a@example.test", "invited", NOW - (INVITE_DAYS * DAY - 1)), NOW), true);
  assert.equal(inviteOpen(guest("a@example.test", "invited", NOW - INVITE_DAYS * DAY), NOW), false);
  assert.equal(inviteOpen(guest("a@example.test", "invited", Number.NaN), NOW), false, "an unread time is not open");
  assert.equal(inviteOpen(guest("a@example.test", "confirmed"), NOW), false);
  const share = { figures: readFigures(["sales"])!, every: "week" as const };
  assert.equal(mayGet(guest("a@example.test", "confirmed"), share, who), true);
  assert.equal(mayGet(guest("a@example.test", "invited"), share, who), false, "pending gets nothing");
  assert.equal(mayGet(guest("a@example.test", "left"), share, who), false);
  assert.equal(mayGet(guest("a@example.test", "confirmed"), { ...share, figures: [] }, who), false, "nothing chosen, nothing sent");
  // Checked again just before sending: an address since put on the team, or now the owner's, gets nothing here.
  assert.equal(mayGet(guest("team.one@example.test", "confirmed"), share, who), false);
  assert.equal(mayGet(guest("owner@example.test", "confirmed"), share, who), false);
});

test("lines: only the chosen figures, and unknown is said, never zero", () => {
  const lines = guestLines(["sales", "revenue", "visits", "subscribers"], {
    sales: 12,
    revenue: null,
    visits: 0,
    subscribers: undefined,
    currency: "usd",
  });
  assert.deepEqual(lines, ["Sales: 12", "Money in, after refunds: unknown", "Visits: 0", "New subscribers: unknown"]);
  assert.deepEqual(guestLines(["visits"], { visits: 1500, currency: "usd" }), ["Visits: 1,500"]);
  assert.deepEqual(guestLines(["revenue"], { revenue: 123456, currency: "usd" }), ["Money in, after refunds: $1,234.56"]);
  assert.deepEqual(guestLines(["revenue"], { revenue: 100, currency: "" }), ["Money in, after refunds: unknown"], "no currency, no amount");
  // A period that refunded more than it took is known, and is said below zero, never as unknown or zero.
  assert.deepEqual(guestLines(["revenue"], { revenue: -500, currency: "usd" }), ["Money in, after refunds: -$5"]);
  assert.deepEqual(guestLines(["revenue"], { revenue: 1.5, currency: "usd" }), ["Money in, after refunds: unknown"]);
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.deepEqual(guestLines(["sales"], { sales: bad, currency: "usd" }), ["Sales: unknown"]);
});

test("affiliate sales go only as a total of enough sellers that no one affiliate shows", () => {
  assert.equal(AFFILIATE_MIN_SELLERS, 3);
  const many = guestLines(["affiliates"], { affiliates: { sellers: 3, sales: 9 }, currency: "usd" });
  assert.deepEqual(many, ["Sales through affiliates, all together: 9"]);
  const few = guestLines(["affiliates"], { affiliates: { sellers: 2, sales: 9 }, currency: "usd" });
  assert.deepEqual(few, [`Sales through affiliates: not shown, because fewer than ${AFFILIATE_MIN_SELLERS} affiliates made sales`]);
  assert.doesNotMatch(few[0], /9/);
  assert.deepEqual(guestLines(["affiliates"], { affiliates: { sellers: null, sales: 9 }, currency: "usd" }), ["Sales through affiliates: unknown"]);
  assert.deepEqual(guestLines(["affiliates"], { currency: "usd" }), ["Sales through affiliates: unknown"]);
});
