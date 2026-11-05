/**
 * What the public pages say about team hosts' two-way Google Calendar sync
 * comes from the switch the studio and the routes read (hostSyncOn in
 * lib/meet-providers.ts), never from a promise that it "switches on once
 * Google approves": the scopes were added on 17 Oct 2026 and the deployment's
 * own variable decides (docs/team-scheduling.md). The mission page's PayPal
 * line follows paypalAtCheckout the same way.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hostSyncOn } from "@/lib/meet-providers";
import {
  busyReadLimit,
  calendarEventsMissionLine,
  googleWritesLimit,
  nothingWrittenApartFrom,
  teamHostCalendarChoice,
  teamHostCalendarLimit,
  teamSyncLimit,
} from "@/lib/host-sync-words";
import { PAYPAL_WAITS, paypalAtCheckout, paypalCheckoutLine } from "@/lib/public-explanations";
import { CREATOR_PAGES, FEATURE_PAGES } from "@/lib/feature-pages";
import { HELP_SECTIONS } from "@/lib/help-content";

/** Every string a public page carries, deep. */
function words(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(words);
  if (value && typeof value === "object") return Object.values(value).flatMap(words);
  return [];
}

const PAGES = [...words(FEATURE_PAGES), ...words(CREATOR_PAGES), ...words(HELP_SECTIONS)].join("\n");
const TEAM_WRITES = "team calls whose host connected their own Google Calendar";
const NOT_ON = "is built and not switched on yet";

test("no public page waits on Google for a switch the deployment holds", () => {
  assert.doesNotMatch(PAGES, /once Google approves/);
  assert.doesNotMatch(readFileSync("app/mission/page.tsx", "utf8"), /once Google approves/);
});

test("each sentence has one true version for each state, and the two differ where the state matters", () => {
  for (const on of [true, false]) {
    const all = [googleWritesLimit(on), teamSyncLimit(on) ?? "", teamHostCalendarLimit(on), busyReadLimit(on), teamHostCalendarChoice(on), nothingWrittenApartFrom(on), calendarEventsMissionLine(on)];
    for (const line of all) assert.doesNotMatch(line, /Google approves|switches on once/);
    // Writing a team call into a host's Google Calendar is said only when it can happen.
    assert.equal(googleWritesLimit(on).includes(TEAM_WRITES), on);
    assert.equal(nothingWrittenApartFrom(on).includes(TEAM_WRITES), on);
    assert.equal(calendarEventsMissionLine(on).includes(TEAM_WRITES), on);
    // Two-way sync is offered to hosts only when it is on, and said to be off only when it is.
    assert.equal(teamHostCalendarLimit(on).includes("their own Google Calendar for two-way sync ("), on);
    assert.equal(teamHostCalendarChoice(on).includes("their own Google Calendar for two-way sync ("), on);
    assert.equal(teamHostCalendarLimit(on).includes(NOT_ON), !on);
    assert.equal(teamHostCalendarChoice(on).includes(NOT_ON), !on);
    assert.equal(teamSyncLimit(on) === null, on);
    // Busy times are read through Google only for a team host who connected it.
    assert.equal(busyReadLimit(on).startsWith("Apart from a team host's own Google Calendar"), on);
  }
  assert.ok(teamSyncLimit(false)?.includes(NOT_ON));
  assert.ok(teamSyncLimit(false)?.includes("private iCal address"));
});

test("the pages carry the words of the state this deployment is in", () => {
  const on = hostSyncOn();
  for (const line of [googleWritesLimit(on), teamHostCalendarLimit(on), busyReadLimit(on), teamHostCalendarChoice(on), nothingWrittenApartFrom(on)]) {
    assert.ok(PAGES.includes(line), line);
  }
  if (on) assert.ok(!PAGES.includes(teamSyncLimit(false) ?? "missing"));
  else assert.ok(PAGES.includes(teamSyncLimit(false) ?? "missing"));
  // The other state's sentences are not there.
  for (const line of [googleWritesLimit(!on), teamHostCalendarLimit(!on), busyReadLimit(!on), teamHostCalendarChoice(!on), nothingWrittenApartFrom(!on)]) {
    assert.ok(!PAGES.includes(line), line);
  }
});

test("the default reads the deployment's own switch", () => {
  const keys = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_CALENDAR_SYNC_SCOPES"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "synthetic-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "synthetic-secret";
    process.env.GOOGLE_CALENDAR_SYNC_SCOPES = "1";
    assert.equal(hostSyncOn(), true);
    assert.equal(calendarEventsMissionLine(), calendarEventsMissionLine(true));
    assert.equal(teamSyncLimit(), null);
    delete process.env.GOOGLE_CALENDAR_SYNC_SCOPES;
    assert.equal(hostSyncOn(), false);
    assert.equal(calendarEventsMissionLine(), calendarEventsMissionLine(false));
    assert.equal(teamSyncLimit(), teamSyncLimit(false));
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("the mission page's PayPal line follows the PayPal client, built or waiting", () => {
  assert.ok(paypalCheckoutLine(false).includes(PAYPAL_WAITS));
  assert.ok(paypalCheckoutLine(false).startsWith("PayPal at checkout: Stripe offers it only to accounts in the EU"));
  assert.match(paypalCheckoutLine(true), /straight into your own PayPal account/);
  assert.doesNotMatch(paypalCheckoutLine(true), /not on yet|waits on PayPal/);
  assert.equal(paypalCheckoutLine(), paypalCheckoutLine(paypalAtCheckout()));
});

test("the mission page puts both lines in the list their state belongs to", () => {
  const mission = readFileSync("app/mission/page.tsx", "utf8");
  const notBuilt = mission.slice(mission.indexOf("const NOT_BUILT = ["), mission.indexOf("];", mission.indexOf("const NOT_BUILT = [")));
  assert.ok(notBuilt.length > 0);
  assert.doesNotMatch(notBuilt, /PayPal at checkout|Writing every booking into your calendar/);
  assert.ok(mission.includes("const paypal = paypalAtCheckout();"));
  assert.ok(mission.includes("const calendarSync = hostSyncOn();"));
  assert.ok(mission.includes("...(paypal ? [paypalCheckoutLine(true)] : []),"));
  assert.ok(mission.includes("...(paypal ? [] : [paypalCheckoutLine(false)]),"));
  assert.ok(mission.includes("calendarEventsMissionLine(calendarSync),"));
});

test("every place that says how old a host's calendar may be says the server's figure", async () => {
  const { STALE_SECONDS, SYNC_SECONDS } = await import("@/lib/host-calendar");
  const { HOST_STALE_MINUTES, HOST_SYNC_MINUTES } = await import("@/lib/team-scheduling-rules");
  assert.equal(HOST_STALE_MINUTES * 60, STALE_SECONDS);
  assert.equal(HOST_SYNC_MINUTES * 60, SYNC_SECONDS);
  // The studio's editor, the host's calendar card, the help and the feature page read the figure, never type it.
  for (const file of ["components/team-event-editor.tsx", "components/host-calendar.tsx", "lib/help-content.ts", "lib/feature-pages.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /last read more than \d+ minutes ago|more than \d+ minutes old|at most every \d+ minutes while someone is looking at a booking page/, file);
  }
  assert.match(readFileSync("components/team-event-editor.tsx", "utf8"), /last read more than \$\{HOST_STALE_MINUTES\} minutes ago/);
  assert.match(readFileSync("components/host-calendar.tsx", "utf8"), /more than \$\{HOST_STALE_MINUTES\} minutes old/);
  assert.ok(PAGES.includes(`last read more than ${HOST_STALE_MINUTES} minutes ago`));
});
