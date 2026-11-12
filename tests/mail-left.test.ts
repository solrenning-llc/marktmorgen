/**
 * The email studio's words when a month's list emails run low (357 [ES3], unit 1; lib/mail-left.ts,
 * components/email-studio.tsx, app/studio/email/page.tsx; added 12 November 2026). Checked: nothing below 80%; from
 * 80%, the whole percent used, how many are left and, only for a paid plan that renews, the day the count starts
 * again (UTC); at or past the allowance, that they are used up; a plan set to end and a trial say no day (a trial,
 * "up to" what is left); nothing when the counts are not known (independent review, 12 November 2026).
 */
import { readFileSync } from "node:fs";
import { LOW_FROM_PERCENT, mailLeftWords } from "@/lib/mail-left";
import { done, is, part } from "./check";

part("The words");
is("below 80%, nothing", mailLeftWords(7_999, 10_000, "November 19"), null);
is("from 80%, the percent, what is left and when it starts again", [mailLeftWords(8_000, 10_000, "November 19"), mailLeftWords(9_871, 10_000, "November 19")], [
  "You have used 80% of this month's emails: 2,000 left until November 19 (UTC).",
  "You have used 98% of this month's emails: 129 left until November 19 (UTC).",
]);
is("the percent is rounded down, so 100% is said only when none is left", mailLeftWords(9_999, 10_000, "November 19"), "You have used 99% of this month's emails: 1 left until November 19 (UTC).");
is("used up, or past it", [mailLeftWords(10_000, 10_000, "November 19"), mailLeftWords(10_050, 10_000, "November 19")], [
  "All of this month's emails are used. The count starts again on November 19 (UTC).",
  "All of this month's emails are used. The count starts again on November 19 (UTC).",
]);
is("no day known (a plan set to end, a trial, an unread month): the count, never a day", [mailLeftWords(9_000, 10_000, null), mailLeftWords(10_000, 10_000, null)], ["You have used 90% of this month's emails: 1,000 left.", "All of this month's emails are used."]);
is("in a trial: the trial's emails, up to what is left, and no day the count starts again", [mailLeftWords(250, 300, "November 19", true), mailLeftWords(300, 300, "November 19", true)], ["You have used 83% of the trial's emails: up to 50 left.", "All of the trial's emails are used."]);
is("unknown counts say nothing", [mailLeftWords(5, 0, "November 19"), mailLeftWords(Number.NaN, 10_000, "November 19"), mailLeftWords(-1, 10_000, "November 19")], [null, null, null]);
is("the threshold", LOW_FROM_PERCENT, 80);

part("In the studio");
const studio = readFileSync("components/email-studio.tsx", "utf8");
is("drawn under the month's count, only for a known month, knowing a trial", studio.includes("{props.monthKnown && mailLeftWords(props.used, props.allowance, props.renews ?? null, props.trial) ? ("), true);
const page = readFileSync("app/studio/email/page.tsx", "utf8");
is("a day only for a paid plan that renews, from its billing window", page.includes("renews={!trial && store.period?.renews === true && store.period.funded !== true ? (() => { const window = allowanceWindow(store); return window?.billing ? opensAgainWords(window) : null; })() : null}"), true);

done();
