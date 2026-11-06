/**
 * The count before sending (460 [EL4], unit 1, lib/send-count.ts; added
 * 1 November 2026). Checked:
 *
 *   - what one email to the list is of this month's emails, and how many
 *     times the month still lets the creator write to the same people;
 *   - past what is left, it says so and offers only what exists today (a
 *     smaller group, or next month), never a way to send more;
 *   - nobody to send to, or numbers that are not counts: nothing is said;
 *   - the composer shows it next to the recipient count, from the numbers
 *     the page already has, and still sends nothing by itself.
 */
import { readFileSync } from "node:fs";

const read = (file: string) => readFileSync(file, "utf8");
import { sendCount } from "@/lib/send-count";
import { done, is, part } from "./check";

function main(): void {
  part("Inside the month");
  is("several times", sendCount(1_200, 600, 5_000), { over: false, line: "This email uses 1,200 emails; 4,400 are left this month right now. If nothing else uses emails, that is enough to write to these people up to 3 times this month, this one included." });
  is("exactly once", sendCount(400, 4_400, 5_000)?.line, "This email uses 400 emails; 600 are left this month right now. That leaves room for this one only.");
  is("one person, one email left", sendCount(1, 4_999, 5_000)?.line, "This email uses 1 email; 1 is left this month right now. That leaves room for this one only.");

  part("Past what is left");
  is("more people than emails left", sendCount(900, 4_500, 5_000), { over: true, line: "This email needs 900 emails, and 500 are left this month right now. Send it to a smaller group, or send it next month." });
  is("none left", sendCount(10, 5_000, 5_000)?.line, "This email needs 10 emails, and none are left this month right now. Send it to a smaller group, or send it next month.");
  is("used past the month reads as none left, never as a negative", sendCount(10, 5_200, 5_000)?.line.includes("none are left"), true);
  is("one left", sendCount(2, 4_999, 5_000)?.line.includes("and 1 is left"), true);

  part("Nothing to say");
  is("nobody to send to", sendCount(0, 0, 5_000), null);
  is("numbers that are not counts", [sendCount(1.5, 0, 10), sendCount(5, -1, 10), sendCount(5, 0, Number.NaN)], [null, null, null]);

  part("In the composer");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("it takes the month from the same two numbers as the This month card, and none when the plan's month cannot be told", studio.includes("month={props.monthKnown ? { used: props.used, allowance: props.allowance } : null}") && read("app/studio/email/page.tsx").includes("monthKnown={windowId(store) !== null}"), true);
  is("shown only with a real recipient count, for an email that goes now", studio.includes("const monthCount = reach !== null && !later && props.month ? sendCount(reach, props.month.used, props.month.allowance) : null;"), true);
  is("in a polite live region that is always on the page, so a new count is read out", studio.includes('aria-live="polite" data-send-count>{monthCount?.line ?? ""}</p>'), true);
  is("bold when it is past what is left", studio.includes('monthCount?.over ? "font-semibold text-ink" : "text-ink-soft"'), true);
  const lib = readFileSync("lib/send-count.ts", "utf8");
  is("it asks for nothing and sends nothing", /\bfetch\(|import /.test(lib.replace(/^\s*\*.*$/gm, "")), false);
  done();
}

main();
