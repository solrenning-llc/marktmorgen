/**
 * The call editor offers to sell a product as a call only where the server
 * would take it (added 2 November 2026, found by 534 [FQ1], unit 4): every
 * refusal in setProductCall (lib/store.ts) is either checked by the editor's
 * own `eligible` (components/call-editor.tsx) or keeps the editor off the
 * product (components/product-editor.tsx). A podcast was offered the buttons
 * and refused with the course message. And the calls page says of the
 * booking emails and reminders only what lib/calls.ts and
 * lib/call-reminders.ts do.
 */
import { readFileSync } from "node:fs";
import { findPage } from "@/lib/site-pages";
import { onTheirCalendar } from "@/lib/calls";
import { done, is, part } from "./check";

const flat = (s: string) => s.replace(/\s+/g, " ");
const store = flat(readFileSync("lib/store.ts", "utf8"));
const editor = flat(readFileSync("components/call-editor.tsx", "utf8"));
const productEditor = flat(readFileSync("components/product-editor.tsx", "utf8"));

part("What the server refuses, the editor never offers");
const refusals = store.slice(store.indexOf("if (setup) {"), store.indexOf("return { ...product, call: setup };"));
const eligible = editor.slice(editor.indexOf("const eligible ="), editor.indexOf("async function send("));
const hidden = /\{product\.course \|\| product\.bundle \|\| product\.shipping \? null : <CallEditor/.test(productEditor);
is("the server's refusals, read whole", ["isFree(product)", "isBundle(product)", "product.recurring", "product.options.length > 0", "product.file", "product.link", "product.shipping", "product.course", "product.podcast", "product.pwyw"].every((w) => refusals.includes(w)), true);
is("the editor is not drawn on a course, a bundle or something shipped", hidden, true);
const checks: [string, string][] = [
  ["free", "product.priceCents > 0"],
  ["membership", "!product.recurring"],
  ["several prices", "product.options.length === 0"],
  ["a file", "!product.file"],
  ["a link", "!product.link"],
  ["a course", "!product.course"],
  ["a podcast", "!product.podcast"],
  ["a named price", "!product.pwyw"],
];
for (const [what, check] of checks) is(`not offered on ${what}`, eligible.includes(check), true);

part("The calendar file is left out only where the event already is");
const owner = "owner@example.com";
const host = "host@example.com";
is("the owner's own Google event: no file for the owner", onTheirCalendar({ made: true, provider: "google", host: "" }, owner, owner), true);
is("a team call made on the owner's calendar while its host gets the email: the host gets the file", onTheirCalendar({ made: true, provider: "google", host: "" }, host, owner), false);
is("a team call made on the host's own calendar: no file for the host", onTheirCalendar({ made: true, provider: "google", host: "Host@Example.com" }, host, owner), true);
is("a collective call on another host's calendar, emailed to the owner: the owner gets the file", onTheirCalendar({ made: true, provider: "google", host }, owner, owner), false);
is("a meeting not made, or on Zoom: the file is sent", [onTheirCalendar({ made: false, provider: "google", host: "" }, owner, owner), onTheirCalendar({ made: true, provider: "zoom", host: "" }, owner, owner), onTheirCalendar(null, owner, owner)], [false, false, false]);
const calls = flat(readFileSync("lib/calls.ts", "utf8"));
is("the booking email uses it for its sentence and its attachment, and tells only the owner about reminders", [calls.includes("const theirs = onTheirCalendar(meeting, creatorSide, store.email);"), calls.includes('theirs ? "It is already in your Google Calendar, so no calendar file is attached."'), calls.includes("...(theirs ? {} : { attachments:"), calls.includes('!toOwner ? "."'), calls.includes("inGoogle(")], [true, true, true, true, false]);

part("The pages say what the emails and reminders do");
const reminders = flat(readFileSync("lib/call-reminders.ts", "utf8"));
const page = JSON.stringify(findPage("platform", "calls"));
is("a team call's booking email goes to its first host unless you host it", [calls.includes("return !hosts.length || hosts.includes(owner) ? store.email : hosts[0];"), page.includes("sends its booking email to one address: yours when you host it, otherwise its first host's.")], [true, true]);
is("its reminders come to the store's own address", [/async function remindCreator\(.*?to: store\.email,/.test(reminders), page.includes("Its reminders before the call come to you."), page.includes("booking email and reminders to one address")], [true, true, false]);
is("with no meeting link, the buyer's email says the link will be sent", [calls.includes("room ? b.joinAtThatTime(room) : b.willSendLink("), readFileSync("lib/buyer-words/booking.ts", "utf8").includes("willSendLink: (store: string) =>"), page.includes("the buyer is told you will send it")], [true, true, true]);
is("the reminder lead rule is said where reminders are", [flat(readFileSync("lib/call-records.ts", "utf8")).includes("if (at - now < REMINDER_MIN_LEAD_MS) continue;"), page.includes("A reminder that would come less than an hour after the booking is skipped.")], [true, true]);
const oldWords = /you both get|both of you get the invitation|emailed to both of you|both get the invitation/i;
const files = ["app/page.tsx", "app/mission/page.tsx", "app/studio/page.tsx", "components/call-editor.tsx", "lib/feature-pages.ts", "lib/help-content.ts", "lib/site-pages.ts"];
is("and nowhere is it said that both always get the same email or file", files.filter((f) => oldWords.test(readFileSync(f, "utf8"))), []);

done();
