/**
 * The questions someone starting out asks about phone notifications (534
 * [FQ1], unit 19, lib/phone-faq.ts; added 2 November 2026). Checked: the
 * panel's own words, read from its file; what it says without the
 * deployment's keys and on an iPhone; the most devices, one figure for the
 * panel, the server and the page; each role hearing only what it may; the
 * shared trial answer in both states; no figure; first in the page's own
 * Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { PHONE_WORDS, phoneBeginnerQuestions } from "@/lib/phone-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { MAX_DEVICES } from "@/lib/phone-alerts-rules";
import { MAX_DEVICES as SERVER_MAX, eventsFor } from "@/lib/phone-alerts";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const panel = flat(read("components/phone-alerts-panel.tsx"));
const studio = flat(read("app/studio/page.tsx"));
is("the studio tool, and the panel's choice, button and test", [studio.includes(`title: "${PHONE_WORDS.tool}"`), panel.includes(PHONE_WORDS.choose), panel.includes(`"Turning on…" : "${PHONE_WORDS.on}"`), panel.includes(`"Sending…" : "${PHONE_WORDS.test}"`)], [true, true, true, true]);
is("without the deployment's keys, nothing can be turned on, and the panel says so", panel.includes("Notifications are not set up on this deployment yet, so none can be turned on."), true);
is("on iPhone and iPad, the home screen first, from iOS 16.4", [panel.includes("Add to Home Screen first — iOS 16.4+"), panel.includes("Tap Share")], [true, true]);
is("one figure for the most devices: the panel, the server and the page read it", [SERVER_MAX === MAX_DEVICES, /const MAX_DEVICES = \d/.test(panel), JSON.stringify(findPage("platform", "phone-notifications")).includes(`Up to ${MAX_DEVICES} devices each.`)], [true, false, true]);
is("a lesson comment carries the start of what the student wrote, and the page and panel say so", [/excerpt\(comment\.text, \d+\)/.test(read("lib/lesson-comment-notify.ts")), JSON.stringify(findPage("platform", "phone-notifications")).includes("the start of a lesson comment, as the student wrote it"), panel.includes("New comment on a lesson"), /never show a buyer/.test(panel)], [true, true, true, false]);
is("each role hears only what it may", [eventsFor("owner").includes("affiliate"), eventsFor("editor").includes("affiliate"), eventsFor("support").includes("sale")], [true, false, true]);
is("the page no longer counts the kinds by hand", JSON.stringify(findPage("platform", "phone-notifications")).includes("which of the five"), false);

part("The answers");
const now = phoneBeginnerQuestions(false);
const later = phoneBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What are phone notifications here?", "How do I turn on phone notifications?", "Can I try phone notifications before paying?", "Is it an app from the App Store or Google Play?"]);
is("the most devices from the code", answer(now, "What are phone notifications here?").includes(`You can use up to ${MAX_DEVICES} devices of your own`), true);
is("turn on: the panel's own words, in order, the iPhone step and the deployment without keys", [(() => { const a = answer(now, "How do I turn on phone notifications?"); const at = Object.values(PHONE_WORDS).map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), answer(now, "How do I turn on phone notifications?").includes("then open it from there and go back to"), answer(now, "How do I turn on phone notifications?").includes("If the page says notifications are not set up yet")], [true, true, true]);
const keys = " That holds once notifications are set up on our side.";
is("try before paying: the one shared answer, said once the keys are set up", [answer(now, "Can I try phone notifications before paying?"), answer(later, "Can I try phone notifications before paying?")], [tryBeforePaying("Phone notifications", "phone notifications on your devices", false) + keys, tryBeforePaying("Phone notifications", "phone notifications on your devices", true, TRIAL_DAYS) + keys]);
is("App Store: no, as the page's own limits say", [answer(now, "Is it an app from the App Store or Google Play?").startsWith("No."), JSON.stringify(findPage("platform", "phone-notifications")).includes("It is not an app from the App Store or Google Play")], [true, true]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no figure but the code's own, no result promised", [/\d/.test(all.split(String(MAX_DEVICES)).join("").split(String(TRIAL_DAYS)).join("").replaceAll("16.4", "")), /guarantee|proven|results?\b/i.test(all)], [false, false]);

part("On the phone notifications page");
const faq = (findPage("platform", "phone-notifications")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
