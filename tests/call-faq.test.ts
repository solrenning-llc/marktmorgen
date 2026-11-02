/**
 * The questions someone starting out asks about paid calls (534 [FQ1], unit
 * 4, lib/call-faq.ts; added 2 November 2026). Checked: the call editor's own
 * buttons and the products it takes, read from its file; a group call's
 * seats; the studio's Upcoming calls and its own sentence about Stripe; the
 * reminders as they are planned; the shared trial answer; no figure about
 * calls or bookings; first in the page's own Questions block, no question
 * asked twice.
 */
import { readFileSync } from "node:fs";
import { CALL_EDITOR_WORDS, UPCOMING_CALLS, callBeginnerQuestions } from "@/lib/call-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { MAX_SEATS } from "@/lib/call-setup";
import { REMINDER_MIN_LEAD_MS } from "@/lib/call-records";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const editor = read("components/call-editor.tsx");
is("the editor's two ways in and their buttons", Object.values(CALL_EDITOR_WORDS).every((w) => editor.includes(w)), true);
is("the save buttons are the ones shown before anything is saved", [new RegExp(`saved \\? "Save the hours" : "${CALL_EDITOR_WORDS.weeklySave}"`).test(flat(editor)), new RegExp(`saved \\? "Save the sessions" : "${CALL_EDITOR_WORDS.liveSave}"`).test(flat(editor))], [true, true]);
const store = flat(read("lib/store.ts"));
const refusals = store.slice(store.indexOf("if (setup) {"), store.indexOf("return { ...product, call: setup };"));
is("what the server refuses to make a call: free, bundle, membership, several prices, a file, a link or shipping, a course or a podcast, a named price", ["isFree(product)", "isBundle(product)", "product.recurring", "product.options.length > 0", "product.file || product.link || product.shipping", "product.course || product.podcast", "product.pwyw"].every((w) => refusals.includes(w)), true);
is("a group call's most at each time, the same 50 the page's intro and features write by hand", [MAX_SEATS, findPage("platform", "calls")?.intro.includes(`a group of up to ${MAX_SEATS}`)], [50, true]);
const studio = flat(read("app/studio/page.tsx"));
is("Upcoming calls, its own sentence about Stripe, and only calls that have not ended", [studio.includes(UPCOMING_CALLS), studio.includes("Calls can be booked once your Stripe account is connected and your store can take payments."), studio.includes("if (call.end <= now) continue;")], [true, true, true]);
const records = flat(read("lib/call-records.ts"));
is("reminders a day and an hour before, each only when it falls at least an hour after it is planned, and planned again on a move", [/\[\["24", 24\], \["1", 1\]\]/.test(records), records.includes("if (at - now < REMINDER_MIN_LEAD_MS) continue;"), REMINDER_MIN_LEAD_MS, /unplanReminders\([^)]*\);\s*if \(writesAboutBookings\(store\)\) await planReminders/.test(flat(read("lib/calls.ts")))], [true, true, 3_600_000, true]);
const reminders = flat(read("lib/call-reminders.ts"));
is("the buyer's reminder for each booking, yours for each time with everyone booked, to your own address", [reminders.includes("async function remindBuyer("), reminders.includes("async function remindCreator(store: Store, product: Listing, paid: PaidCall[]"), /remindCreator[\s\S]*?to: store\.email/.test(reminders)], [true, true, true]);
const calls = flat(read("lib/calls.ts"));
is("the creator-side booking email skips the calendar file only when the call is already in that person's Google Calendar", [calls.includes("...(theirs ? {} : { attachments: [{ filename: \"call.ics\"") && calls.includes("const theirs = onTheirCalendar(meeting, creatorSide, store.email);"), calls.includes("It is already in your Google Calendar, so no calendar file is attached.")], [true, true]);
is("and a team call's goes to its host when you are not one", calls.includes("return !hosts.length || hosts.includes(owner) ? store.email : hosts[0];"), true);
is("a call can have no meeting link, which the creator sends", editor.includes("No meeting link: you send one to each buyer yourself."), true);
is("a package is paid once and each session booked from it later", flat(read("lib/call-packages.ts")).length > 0 && findPage("platform", "calls")?.blocks.some((b) => JSON.stringify(b).includes("The buyer pays once and books each session from their own link")), true);

part("The answers");
const now = callBeginnerQuestions(false);
const later = callBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What is a paid call here?", "How do I start one?", "Can I try it before paying?", "Do paid calls work?"]);
is("a group's seats from the code", answer(now, "What is a paid call here?").includes(`a group of up to ${MAX_SEATS} at each time`), true);
is("start: the editor's own buttons, in order", (() => { const a = answer(now, "How do I start one?"); const at = Object.values(CALL_EDITOR_WORDS).map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), true);
is("start: what cannot be a call, each one the server refuses", ["Something free", "a membership", "a course", "a podcast", "a bundle", "something you ship", "several prices", "names the price", "does not deliver a file or a link"].every((w) => answer(now, "How do I start one?").includes(w)), true);
is("try before paying: the one shared answer, in a call's words", [answer(now, "Can I try it before paying?"), answer(later, "Can I try it before paying?")], [tryBeforePaying("A call", "a call, with its hours or its dates,", false), tryBeforePaying("A call", "a call, with its hours or its dates,", true, TRIAL_DAYS)]);
is("does it work: not bookable while plans are off sale, no figure, the creator's own Upcoming calls", [answer(now, "Do paid calls work?").startsWith("Paid plans are not on sale yet, so no call can be booked now. We publish no number of calls or bookings"), answer(later, "Do paid calls work?").startsWith("We publish no number of calls or bookings"), answer(now, "Do paid calls work?").includes(`“${UPCOMING_CALLS}”`), answer(now, "Do paid calls work?").includes("calls still to come")], [true, true, true, true]);
is("the emails as sent: the buyer's file, yours unless in Google Calendar, a team call's to its host", ["The buyer gets an email with a calendar file.", "or the host does on a team call you do not host.", "If the call is already in that person's Google Calendar, their email has no file."].every((w) => answer(now, "What is a paid call here?").includes(w)), true);
is("a package booked later, and a link the creator sends", [answer(now, "What is a paid call here?").includes("books later from a package of sessions they already paid for"), answer(now, "What is a paid call here?").includes("or by a link you send yourself")], [true, true]);
is("one space between sentences, never two", /\s{2}/.test(now.map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of calls, buyers or bookings, no percent, no result promised", /\b\d{2,}\s+(calls|buyers|bookings|creators|sales)|%|guarantee|proven|results?\b/i.test(all), false);
is("nothing said to be recorded or streamed here", answer(now, "What is a paid call here?").includes("nothing is streamed or recorded here"), true);

part("On the calls page");
const faq = (findPage("platform", "calls")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
