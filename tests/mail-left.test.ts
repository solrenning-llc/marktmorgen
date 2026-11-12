/**
 * The email studio's words when a month's list emails run low (357 [ES3], unit 1; lib/mail-left.ts,
 * components/email-studio.tsx, app/studio/email/page.tsx; added 12 November 2026). Checked: nothing below 80%; from
 * 80%, the whole percent used, how many are left and the day the count starts again (UTC); at or past the
 * allowance, that they are used up; nothing when the count, the allowance or the day is not known; and the studio
 * draws it only for a known month, from the billing window the other allowance notices read.
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
is("unknown is said as nothing", [mailLeftWords(9_000, 10_000, null), mailLeftWords(5, 0, "November 19"), mailLeftWords(Number.NaN, 10_000, "November 19"), mailLeftWords(-1, 10_000, "November 19")], [null, null, null, null]);
is("the threshold", LOW_FROM_PERCENT, 80);

part("In the studio");
const studio = readFileSync("components/email-studio.tsx", "utf8");
is("drawn under the month's count, only for a known month", studio.includes("{props.monthKnown && mailLeftWords(props.used, props.allowance, props.renews ?? null) ? ("), true);
const page = readFileSync("app/studio/email/page.tsx", "utf8");
is("the day comes from the same billing window the other allowance notices read", page.includes("renews={(() => { const window = allowanceWindow(store); return window ? opensAgainWords(window) : null; })()}"), true);

done();
