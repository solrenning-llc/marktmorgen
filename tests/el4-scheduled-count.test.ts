/**
 * The count for an email scheduled for later (460 [EL4], unit 3,
 * lib/send-count.ts scheduledCount; added 16 November 2026). Checked:
 *
 *   - going out inside this month of the plan: what it uses and what is left
 *     now, and that anything sent before then uses the same month;
 *   - past what is left: that what does not fit waits for the month to turn
 *     (lib/broadcasts.ts, "The rest go out when the month turns."), never
 *     that it is refused or sent anyway;
 *   - going out after this month ends: that it counts in that month, with no
 *     number for a month nobody can read yet;
 *   - nobody to send to, a time or an end that is not one: nothing is said;
 *   - the composer passes the end of the plan's month from the page, shows
 *     it in the same live region as the count for now, and offers the
 *     buyers active lately for a scheduled email past what is left too.
 */
import { readFileSync } from "node:fs";
import { scheduledCount } from "@/lib/send-count";
import { done, is, part } from "./check";

const ENDS = Date.UTC(2026, 11, 3, 12);
const BEFORE = ENDS - 5 * 86_400_000;

function main(): void {
  part("Inside this month of the plan");
  is("it fits", scheduledCount(1_200, 600, 5_000, BEFORE, ENDS), { over: false, line: "When it goes out, this email uses 1,200 emails; 4,400 are left this month right now. Anything sent before then uses the same month." });
  is("one person, one email", scheduledCount(1, 4_999, 5_000, BEFORE, ENDS)?.line, "When it goes out, this email uses 1 email; 1 is left this month right now. Anything sent before then uses the same month.");
  is("past what is left: the rest waits for the month to turn", scheduledCount(900, 4_500, 5_000, BEFORE, ENDS), { over: true, line: "When it goes out, this email needs 900 emails, and 500 are left this month right now. What does not fit waits until the month turns. Send it to a smaller group, or schedule it after this month ends." });
  is("none left", scheduledCount(10, 5_000, 5_000, BEFORE, ENDS)?.line.includes("and none are left this month right now"), true);
  is("used past the month reads as none left", scheduledCount(10, 5_200, 5_000, BEFORE, ENDS)?.line.includes("and none are left"), true);

  part("After this month ends");
  is("exactly at the end: the next month", scheduledCount(900, 4_500, 5_000, ENDS, ENDS), { over: false, line: "It goes out after this month of your plan ends, so its 900 emails count in that month, not this one." });
  is("one email", scheduledCount(1, 0, 5_000, ENDS + 1, ENDS)?.line, "It goes out after this month of your plan ends, so its 1 email counts in that month, not this one.");

  part("Nothing to say");
  is("nobody to send to", scheduledCount(0, 0, 5_000, BEFORE, ENDS), null);
  is("numbers that are not counts or times", [scheduledCount(1.5, 0, 10, BEFORE, ENDS), scheduledCount(5, -1, 10, BEFORE, ENDS), scheduledCount(5, 0, 10, Number.NaN, ENDS), scheduledCount(5, 0, 10, BEFORE, Number.POSITIVE_INFINITY)], [null, null, null, null]);

  part("In the composer");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  const page = readFileSync("app/studio/email/page.tsx", "utf8");
  is("the page passes the end of the plan's month, the same window the count reads", page.includes("monthEnds={allowanceWindow(store)?.end ?? null}"), true);
  is("the composer gets it only when the month and its count are known", studio.includes("monthEnds={props.monthKnown && props.used !== null ? props.monthEnds ?? null : null}"), true);
  is("counted only for a valid scheduled time and a real recipient count", studio.includes("const laterCount = reach !== null && later && scheduledAt !== null && props.month && props.monthEnds ? scheduledCount(reach, props.month.used, props.month.allowance, scheduledAt, props.monthEnds) : null;"), true);
  is("one line on the page: now or later, never both", studio.includes("const shownCount = monthCount ?? laterCount;") && studio.includes('aria-live="polite" data-send-count>{shownCount?.line ?? ""}</p>'), true);
  is("the offer of the buyers active lately follows the line shown", studio.includes("const offerDays = shownCount?.over ? activeOffer(true, activeDays, quietDays, ACTIVE_DAYS) : null;"), true);
  const lib = readFileSync("lib/send-count.ts", "utf8");
  is("it still asks for nothing and sends nothing", /\bfetch\(|import /.test(lib.replace(/^\s*\*.*$/gm, "")), false);
  done();
}

main();
