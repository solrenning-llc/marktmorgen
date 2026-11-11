/**
 * Marktmorgen Path's rules (lib/path-rules.ts, 18 October 2026). What is
 * checked:
 *
 *   - every mission is read from facts only, and closes on its own fact;
 *   - the test purchase is open in test mode and unavailable live, and an
 *     unavailable day never holds the path back;
 *   - traffic missions follow the seven days when there is no sale, and go
 *     once a real sale is in;
 *   - levels by real money kept, in the store's currency's own scale, never
 *     going down: a refund takes the sale back, not the level;
 *   - the streak: Sunday never breaks it, two rest days a week are free, and
 *     today is never a missed day;
 *   - no notification between 21:00 and 08:00 in the person's own time;
 *   - the answers: bounded, cleaned, refused with a sentence.
 */
import {
  type PathFacts,
  NO_FACTS,
  dayMissions,
  pathProgress,
  levelNow,
  levelKept,
  levelCents,
  LEVEL_NAMES,
  streakOf,
  withCheckin,
  localDay,
  localHour,
  mayNotify,
  readAnswers,
  goalWords,
  reminderOf,
  forbiddenIn,
} from "@/lib/path-rules";
import { done, is, part } from "./check";

const answers = { minutes: 30 as const, audience: "instagram" as const, subject: "sourdough", skills: "baking" };
const facts = (over: Partial<PathFacts> = {}): PathFacts => ({ ...NO_FACTS, testMode: true, ...over });
const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 12, 15);

part("Missions read from facts only");
{
  const empty = dayMissions(facts(), answers);
  is("seven days", empty.map((m) => m.day), [1, 2, 3, 4, 5, 6, 7]);
  is("nothing done with no facts", empty.filter((m) => m.state === "done").length, 0);
  is("a title without a line is not published", dayMissions(facts({ titlePublished: false }), answers)[0].state, "open");
  const all = dayMissions(
    facts({ titlePublished: true, listedProducts: 1, productWithFile: true, testPurchase: "done", socialVisits: 1, postLinks: 3, leads: 1, realSales: 1 }),
    answers,
  );
  is("each closes on its own fact", all.map((m) => m.state), ["done", "done", "done", "done", "done", "done", "done"]);
  is("two post links of three", dayMissions(facts({ postLinks: 2 }), answers)[4].progress, { now: 2, of: 3 });
  is("the subject is in the product's words", dayMissions(facts(), answers)[1].steps[0].includes("about sourdough"), true);
  is("the audience is in the fourth day", dayMissions(facts(), answers)[3].title, "Bring your first visitor from Instagram");
  is("fifteen minutes asks fewer steps", dayMissions(facts(), { ...answers, minutes: 15 })[0].steps.length < dayMissions(facts(), answers)[0].steps.length, true);
}

part("The test purchase");
{
  is("open in test mode", dayMissions(facts({ testPurchase: "open" }), answers)[2].state, "open");
  const live = facts({ testMode: false, testPurchase: "unavailable", titlePublished: true, listedProducts: 1, productWithFile: true, socialVisits: 1, postLinks: 3, leads: 1 });
  const progress = pathProgress(live, answers, START, START + DAY);
  is("unavailable live, never asking for a real purchase", progress.days[2].closesOn.includes("never asked to buy from yourself with a real card"), true);
  is("and it does not hold the path back: today is the sale's traffic", progress.today?.id, "traffic-1");
  is("counted out of the missions that can be done", progress.of, 6 + 8);
}

part("Traffic missions after the seven days");
{
  const before = pathProgress(facts({ titlePublished: true }), answers, START, START + 2 * DAY);
  is("none on day three", before.traffic.length, 0);
  is("today is the first open day", before.today?.id, "product");
  const late = pathProgress(facts({ titlePublished: true }), answers, START, START + 8 * DAY);
  is("they begin after the seventh day with no sale", late.traffic.length, 8);
  is("today stays the first open day of the seven", late.today?.id, "product");
  const counted = pathProgress(facts({ titlePublished: true, socialVisits: 12, postLinks: 4 }), answers, START, START + 8 * DAY);
  is("a traffic mission closes on its count", counted.traffic[0].state, "done");
  const sold = pathProgress(facts({ titlePublished: true, realSales: 1 }), answers, START, START + 8 * DAY);
  is("a real sale ends them", sold.traffic.length, 0);
  is("and the path's seven are complete", sold.complete, true);
  is("with nothing more to do today", sold.today, null);
}

part("Levels");
{
  is("none with nothing published", levelNow(facts()), -1);
  is("First Light: a title and a product", LEVEL_NAMES[["first-light", "sunrise", "morning", "midday", "golden-hour", "zenith"][levelNow(facts({ titlePublished: true, listedProducts: 1 }))] as keyof typeof LEVEL_NAMES], "First Light");
  is("Sunrise: the first real sale", levelNow(facts({ titlePublished: true, listedProducts: 1, realSales: 1, revenueCents: 2_000, currency: "usd" })), 1);
  is("Morning at $100 kept", levelNow(facts({ realSales: 3, revenueCents: 10_000, currency: "usd" })), 2);
  is("High Sun at $1,000", levelNow(facts({ realSales: 30, revenueCents: 100_000, currency: "usd" })), 3);
  is("Golden Hour at $10,000", levelNow(facts({ realSales: 300, revenueCents: 1_000_000, currency: "usd" })), 4);
  is("Zenith at $100,000", levelNow(facts({ realSales: 3000, revenueCents: 10_000_000, currency: "usd" })), 5);
  is("unknown money moves no level past Sunrise", levelNow(facts({ realSales: 30, revenueCents: null })), 1);
  is("the yen's Morning is on its prices' own scale", levelCents("morning", "jpy"), 15_000);
  is("the euro's is 100", levelCents("morning", "eur"), 10_000);
  // The first sale refunded in full: the mission goes back, the level stays.
  const refunded = facts({ titlePublished: true, listedProducts: 1, realSales: 0, revenueCents: 0 });
  is("a refund takes the sale mission back", dayMissions(refunded, answers)[6].state, "open");
  is("and never the level reached", levelKept(1, refunded), 1);
  is("a damaged best is read as none", levelKept(99, facts()), -1);
  is("no level is named Hero or Games", Object.values(LEVEL_NAMES).some((n) => /hero|game/i.test(n)), false);
}

part("The streak");
{
  // 2026-10-12 is a Monday.
  const week = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"];
  is("six days in a row", streakOf(week, "2026-10-17").days, 6);
  is("today not yet opened is never a missed day", streakOf(week.slice(0, 5), "2026-10-17").days, 5);
  is("Sunday never breaks it", streakOf([...week, "2026-10-19"], "2026-10-19").days, 7);
  is("two rest days in a week are free", streakOf(["2026-10-12", "2026-10-15", "2026-10-16"], "2026-10-16").days, 3);
  is("and the rest days left say so", streakOf(["2026-10-12", "2026-10-15", "2026-10-16"], "2026-10-16").restLeft, 0);
  is("a third missed day ends it", streakOf(["2026-10-12", "2026-10-16", "2026-10-17"], "2026-10-17").days, 2);
  is("nothing opened, nothing counted", streakOf([], "2026-10-17"), { days: 0, restLeft: 2, today: false });
  is("days kept are bounded", withCheckin(Array.from({ length: 80 }, (_, i) => new Date(Date.UTC(2026, 6, 1) + i * DAY).toISOString().slice(0, 10)), "2026-10-18").length, 60);
}

part("Quiet hours, in the person's own time");
{
  // 23:30 UTC is 20:30 in São Paulo (UTC-3) and 01:30 in Berlin (UTC+2).
  const at = Date.UTC(2026, 9, 18, 23, 30);
  is("20:30 in São Paulo may be told", mayNotify("America/Sao_Paulo", at), true);
  is("01:30 in Berlin is not", mayNotify("Europe/Berlin", at), false);
  is("21:00 sharp is quiet", mayNotify("UTC", Date.UTC(2026, 9, 18, 21)), false);
  is("08:00 sharp is not", mayNotify("UTC", Date.UTC(2026, 9, 18, 8)), true);
  is("an hour, read in the zone", localHour("Asia/Tokyo", Date.UTC(2026, 9, 18, 0)), 9);
  is("the day, read in the zone", localDay("Pacific/Auckland", Date.UTC(2026, 9, 18, 13)), "2026-10-19");
  is("a zone that is not one is read as UTC", localDay("Mars/Base", Date.UTC(2026, 9, 18, 23)), "2026-10-18");
}

part("The four questions");
{
  const ok = readAnswers({ goalCents: 50_000, skills: "  baking\u0000 bread  ", subject: "sourdough", minutes: 15, audience: "tiktok", timeZone: "Europe/Lisbon" }, "eur");
  is("read and cleaned", ok.ok && ok.answers.skills, "baking bread");
  is("the goal kept in the store's currency", ok.ok && ok.answers.goalCurrency, "eur");
  is("minutes only 15, 30 or 60", readAnswers({ minutes: 45, audience: "none" }, "usd").ok, false);
  is("an audience from the list", readAnswers({ minutes: 30, audience: "myspace" }, "usd").ok, false);
  is("a zone that is not one becomes UTC", (() => { const r = readAnswers({ minutes: 30, audience: "none", timeZone: "Nowhere/Land" }, "usd"); return r.ok && r.answers.timeZone; })(), "UTC");
  is("the goal said as the person's own, never a forecast", goalWords({ goalCents: 50_000, goalCurrency: "eur" }, "eur"), "Your goal: €500 a month. It is yours, and nothing here predicts it.");
  is("a goal in another currency is not said as this one", goalWords({ goalCents: 50_000, goalCurrency: "eur" }, "usd"), "");
}

part("The reminder");
{
  const progress = pathProgress(facts({ titlePublished: true }), answers, START, START + DAY);
  const reminder = reminderOf(progress, { days: 3, restLeft: 2, today: false });
  is("names the day and the mission, no amount", reminder, { title: "Day 2 of your path", body: "Prepare your first digital product. 3 days in a row so far." });
  is("none once the path is complete", reminderOf(pathProgress(facts({ realSales: 1, titlePublished: true }), answers, START, START + DAY), { days: 0, restLeft: 2, today: false }), null);
  is("forbidden words are caught", forbiddenIn("Learn passive income secrets"), "passive income");
  is("and an ordinary line passes", forbiddenIn("Prepare your first digital product"), null);
}

part("The lead missions say what Path counts today (Revisor 2's LOW on #3591)");
{
  // Path counts an address only once it used its confirmation link (lib/path-lead.ts), so no lead text may say that
  // merely leaving an address counts, and the change from the older reading is said where the mission is shown.
  const lead = dayMissions(facts(), answers)[5];
  const traffic = pathProgress(facts({ titlePublished: true }), answers, START, START + 8 * DAY).traffic.filter((m) => m.closesOn.includes("people have"));
  is("two list missions are checked", traffic.length, 2);
  const texts = [lead.why, lead.closesOn, ...lead.steps, ...traffic.flatMap((d) => [d.why, d.closesOn])];
  is("no text says that leaving an address is what counts", texts.some((t) => /leaves? their address|left their address|left an address/i.test(t)), false);
  is("the lead mission says confirming from the email is what counts", lead.closesOn.includes("confirms their address from the email"), true);
  is("and that earlier unconfirmed sign-ups no longer count", lead.closesOn.includes("never confirmed before this changed"), true);
  is("the list missions say the same", traffic.filter((d) => d.closesOn.includes("people have")).every((d) => d.closesOn.includes("confirmed their address") && d.closesOn.includes("before this changed")), true);
}

done();
