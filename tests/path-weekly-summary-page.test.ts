import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import Page from "../app/studio/path/page";
import { calls, configure, savedCheckins } from "./path-weekly-summary-page-world";

async function pageAt(t: TestContext, now: string) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  try { return renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) })); }
  finally { t.mock.timers.reset(); }
}
function card(html: string) {
  const found = html.match(/<section[^>]*aria-labelledby="path-weekly-title"[^>]*>[\s\S]*?<\/section>/);
  assert.ok(found, "the actual Path page must show its saved weekly check-in summary");
  return found[0];
}
function hasDay(html: string, day: string) { return new RegExp(`datetime="${day}"`, "i").test(html); }

test("actual Path page summarizes only saved dates, keeps the current streak and makes no additional service calls", async t => {
  const days = ["2026-11-01", "2026-11-02", "2026-11-04"];
  configure(days);
  const html = await pageAt(t, "2026-11-06T17:00:00Z"), summary = card(html);
  assert.match(summary, /Your week in Path/);
  assert.match(summary, /2 saved check-in days this week/);
  assert.match(summary, /America\/New_York/);
  // Existing streakOf keeps all three saved days across its two allowed rest days and Sunday.
  assert.match(summary, /Current streak: 3 check-in days\./);
  assert.match(summary, /0 rest days left this week\./);
  assert.ok(hasDay(summary, "2026-11-02") && hasDay(summary, "2026-11-08"));
  assert.match(summary, /Recorded through/);
  const list = summary.match(/<ul[^>]*aria-label="Saved check-in days"[^>]*>([\s\S]*?)<\/ul>/)?.[1];
  assert.ok(list);
  assert.ok(hasDay(list, "2026-11-02") && hasDay(list, "2026-11-04"));
  assert.equal(hasDay(list, "2026-11-01") || hasDay(list, "2026-11-06"), false);
  assert.deepEqual(savedCheckins(), days);
  assert.deepEqual(calls, { cookies: 1, studioView: 1, readPath: 1, visitPath: 1, allowanceUsed: 1, readGrowth: 0, readBoard: 0, chargeStudio: 0 });
  assert.doesNotMatch(summary, /987654321|9,876,543|99 sales|missions completed|missed|behind|<script|<button|<form|<input/);
  assert.ok(Buffer.byteLength(summary, "utf8") < 4096, "one bounded static card");
  assert.equal((html.match(/Current streak:/g) ?? []).length, 1);
  assert.match(html, /Your next mission/);
});

test("New York changes weeks at local Monday, rather than UTC Monday", async t => {
  configure(["2026-11-01"]);
  const sunday = card(await pageAt(t, "2026-11-02T04:59:59Z"));
  assert.ok(hasDay(sunday, "2026-10-26") && hasDay(sunday, "2026-11-01"));
  assert.match(sunday, /1 saved check-in day this week/);
  configure(["2026-11-01"]);
  const monday = card(await pageAt(t, "2026-11-02T05:00:00Z"));
  assert.ok(hasDay(monday, "2026-11-02") && hasDay(monday, "2026-11-08"));
  assert.match(monday, /No check-in days are saved for this week\./);
});

test("a saved Pacific time zone can start Monday while UTC is still Sunday", async t => {
  configure(["2026-11-01"], "Pacific/Kiritimati");
  const sunday = card(await pageAt(t, "2026-11-01T09:59:59Z"));
  assert.ok(hasDay(sunday, "2026-10-26"));
  configure(["2026-11-01"], "Pacific/Kiritimati");
  const monday = card(await pageAt(t, "2026-11-01T10:00:00Z"));
  assert.ok(hasDay(monday, "2026-11-02") && hasDay(monday, "2026-11-08"));
  assert.match(monday, /No check-in days are saved for this week\./);
});

test("both occurrences of the fall-back hour are the same saved check-in day", async t => {
  for (const now of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) {
    configure(["2026-11-01", "2026-11-01"]);
    const summary = card(await pageAt(t, now));
    assert.ok(hasDay(summary, "2026-10-26") && hasDay(summary, "2026-11-01"));
    assert.match(summary, /1 saved check-in day this week/);
  }
});

test("the spring-forward day and following Monday follow civil dates", async t => {
  for (const now of ["2026-03-08T06:59:59Z", "2026-03-08T07:00:00Z"]) {
    configure(["2026-03-08"]);
    const summary = card(await pageAt(t, now));
    assert.ok(hasDay(summary, "2026-03-02") && hasDay(summary, "2026-03-08"));
    assert.match(summary, /1 saved check-in day this week/);
  }
  configure(["2026-03-08"]);
  const monday = card(await pageAt(t, "2026-03-09T04:00:00Z"));
  assert.ok(hasDay(monday, "2026-03-09") && hasDay(monday, "2026-03-15"));
});

test("a week spanning the year boundary keeps both real calendar years", async t => {
  configure(["2026-12-28", "2027-01-01"]);
  const summary = card(await pageAt(t, "2027-01-01T17:00:00Z"));
  assert.ok(hasDay(summary, "2026-12-28") && hasDay(summary, "2027-01-03"));
  assert.match(summary, /2026/); assert.match(summary, /2027/);
  assert.match(summary, /2 saved check-in days this week/);
});

test("unsorted duplicate saved dates count once without changing the record", async t => {
  const days = ["2026-11-04", "2026-11-02", "2026-11-04"];
  configure(days);
  const summary = card(await pageAt(t, "2026-11-06T17:00:00Z"));
  assert.match(summary, /2 saved check-in days this week/);
  assert.deepEqual(savedCheckins(), days);
});

test("known empty records describe saved dates without inventing activity", async t => {
  configure([]);
  const summary = card(await pageAt(t, "2026-11-06T17:00:00Z"));
  assert.match(summary, /No check-in days are saved for this week\./);
  assert.doesNotMatch(summary, /no activity|did not|missed|behind/i);
});

test("impossible, future and excessive saved dates are unavailable, never zero", async t => {
  for (const days of [["2026-02-30"], ["2026-11-07"], Array.from({ length: 61 }, () => "2026-11-02")]) {
    configure(days);
    const summary = card(await pageAt(t, "2026-11-06T17:00:00Z"));
    assert.match(summary, /Your saved check-in days could not be read for this week\./);
    assert.doesNotMatch(summary, /No check-in days|Current streak:|saved check-in days this week/);
  }
});

test("an invalid saved time zone is unavailable instead of silently becoming a UTC week", async t => {
  configure(["2026-11-02"], "Invalid/Zone");
  const summary = card(await pageAt(t, "2026-11-06T17:00:00Z"));
  assert.match(summary, /Your saved check-in days could not be read for this week\./);
  assert.doesNotMatch(summary, /Current streak:|No check-in days/);
});

test("the return view keeps its existing no-streak wording while showing the saved week", async t => {
  configure(["2026-11-02"], "America/New_York", "returning");
  const html = await pageAt(t, "2026-11-06T17:00:00Z"), summary = card(html);
  assert.match(summary, /1 saved check-in day this week/);
  assert.doesNotMatch(html, /Current streak:|check-in days in your current streak/);
  assert.match(html, /Welcome back/);
});

test("onboarding and failed reads do not manufacture a numerical weekly summary", async t => {
  configure([], "America/New_York", "absent");
  const onboarding = await pageAt(t, "2026-11-06T17:00:00Z");
  assert.match(onboarding, /Choose your Path answers/);
  assert.doesNotMatch(onboarding, /path-weekly-title/);
  for (const mode of ["read-failed", "visit-failed"] as const) {
    configure(["2026-11-02"], "America/New_York", mode);
    const html = await pageAt(t, "2026-11-06T17:00:00Z");
    assert.match(html, /Your Path could not be read just now/);
    assert.doesNotMatch(html, /path-weekly-title/);
  }
});

test("the actual weekly card uses a singular rest day when the existing streak has one left", async t => {
  configure(["2026-11-04"]);
  const summary = card(await pageAt(t, "2026-11-06T17:00:00Z"));
  assert.match(summary, /1 rest day left this week\./);
  assert.doesNotMatch(summary, /1 rest days left this week\./);
});

test("the current streak survives a time-zone move while the saved week is unavailable", async t => {
  const days = ["2026-11-05", "2026-11-06"];
  const now = "2026-11-06T01:00:00Z";
  configure(days, "Asia/Tokyo");
  const tokyo = await pageAt(t, now), tokyoSummary = card(tokyo);
  assert.match(tokyoSummary, /2 saved check-in days this week/);
  assert.match(tokyoSummary, /Current streak: 2 check-in days\./);
  assert.equal((tokyo.match(/Current streak:/g) ?? []).length, 1);

  configure(days, "America/Los_Angeles");
  const html = await pageAt(t, now), summary = card(html);
  assert.match(summary, /Your saved check-in days could not be read for this week\./);
  assert.doesNotMatch(summary, /Current streak:|saved check-in days this week|No check-in days/);
  assert.match(html, /Current streak: 1 check-in day\. 2 rest days left this week\./);
  assert.equal((html.match(/Current streak:/g) ?? []).length, 1);
  assert.ok(html.indexOf("Current streak:") < html.indexOf('aria-labelledby="path-weekly-title"'), "the fallback stays in progress, outside the unavailable weekly card");
  assert.deepEqual(savedCheckins(), days);
  assert.deepEqual(calls, { cookies: 1, studioView: 1, readPath: 1, visitPath: 1, allowanceUsed: 1, readGrowth: 0, readBoard: 0, chargeStudio: 0 });

  for (const mode of ["returning", "absent", "read-failed", "visit-failed"] as const) {
    configure(days, "America/Los_Angeles", mode);
    const view = await pageAt(t, now);
    assert.doesNotMatch(view, /Current streak:|check-in days? in your current streak/);
  }
});

test("an impossible retained date does not produce a numerical streak outside the unavailable card", async t => {
  const days = ["2026-02-30", "2026-11-06"];
  configure(days, "UTC");
  const html = await pageAt(t, "2026-11-06T12:00:00Z");
  assert.match(card(html), /Your saved check-in days could not be read for this week\./);
  assert.doesNotMatch(html, /Current streak:|check-in days? in your current streak/);
  assert.deepEqual(savedCheckins(), days);
  assert.deepEqual(calls, { cookies: 1, studioView: 1, readPath: 1, visitPath: 1, allowanceUsed: 1, readGrowth: 0, readBoard: 0, chargeStudio: 0 });
});
