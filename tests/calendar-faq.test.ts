/**
 * The questions someone starting out asks about calendar sync (534 [FQ1],
 * unit 15, lib/calendar-faq.ts; added 2 November 2026). Checked: the studio
 * card's own words and when it shows, read from its files; the code's
 * limits and how long a reading is kept; what is kept of a calendar; dated
 * sessions; the shared trial answer in both states; no figure; first in the
 * page's own Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { CALENDAR_WORDS, calendarBeginnerQuestions } from "@/lib/calendar-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { CACHE_SECONDS, LOOKAHEAD_DAYS, MAX_FEEDS, STALE_SECONDS } from "@/lib/calendar-limits";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const card = flat(read("components/calendar-editor.tsx"));
const studio = flat(read("app/studio/page.tsx"));
is("the card's title, field, button and help", Object.values(CALENDAR_WORDS).every((w) => card.includes(w)), true);
is("the card shows once the store has a call product, for the owner and Admins", studio.includes('callProducts.length > 0 && may("settings") ? calendarView(current)'), true);
is("no account and no password, only busy times kept, as the card says", card.includes("No account to connect and no password: the address gives us a read-only copy, and only the busy times are kept, never a title or a guest."), true);
is("a full card says to remove one to add another", card.includes("Remove one to add another."), true);
is("team hosts read their own calendar, under Your calendar", flat(read("app/studio/page.tsx")).includes('title: "Your calendar", text: "Your own busy times, kept out of the team calls you host."'), true);
is("the server reads with the same limits, again every few minutes, and the last good reading stands while a calendar stops answering", [read("lib/calendar-sync.ts").includes('import { CACHE_SECONDS, LOOKAHEAD_DAYS, MAX_FEEDS, STALE_SECONDS } from "@/lib/calendar-limits";'), /"EX", CACHE_SECONDS/.test(read("lib/calendar-sync.ts")), /STALE_SECONDS/.test(read("lib/calendar-sync.ts").replace(/^.*export \{.*$/m, ""))], [true, true, true]);

part("The answers");
const now = calendarBeginnerQuestions(false);
const later = calendarBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What is calendar sync here?", "How do I connect a calendar?", "Can I try it before paying?", "Does it stop double bookings?"]);
is("the limits from the code", answer(now, "What is calendar sync here?").startsWith(`Up to ${MAX_FEEDS} calendars with a private iCal (.ics) address`) && answer(now, "What is calendar sync here?").includes(`up to ${LOOKAHEAD_DAYS} days ahead`), true);
is("connect: the card's own words, in order, once a call is sold", [(() => { const a = answer(now, "How do I connect a calendar?"); const at = Object.values(CALENDAR_WORDS).map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), answer(now, "How do I connect a calendar?").includes("once your store has a call (a draft counts)")], [true, true]);
is("try before paying: the one shared answer, in calendar sync's words", [answer(now, "Can I try it before paying?"), answer(later, "Can I try it before paying?")], [tryBeforePaying("Calendar sync", "a call and the calendars your store reads", false), tryBeforePaying("Calendar sync", "a call and the calendars your store reads", true, TRIAL_DAYS)]);
is("double bookings: how often a calendar is read and how long a last reading stands, from the code, and team hosts", [answer(now, "Does it stop double bookings?").includes(`at most every ${CACHE_SECONDS / 60} minutes`), answer(now, "Does it stop double bookings?").includes(`for up to ${STALE_SECONDS / 3600} hours`), answer(now, "Does it stop double bookings?").includes("each host's own calendar counts"), /never (double )?booked/i.test(answer(now, "Does it stop double bookings?"))], [true, true, true, false]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of bookings or creators, no percent, no result promised", /\b\d+\s+(bookings|sales|buyers|creators)|\d+%|guarantee|proven|results?\b/i.test(all), false);

part("On the calendar sync page");
const faq = (findPage("platform", "calendar-sync")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
