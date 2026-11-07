/**
 * More sends at the moment they run out (357 [ES3], unit 1; added
 * 6 November 2026). Checked:
 *
 *   - below 80% of the month's list emails nothing is said; from 80% the
 *     studio says how many are left and when the count starts again; at
 *     100% it says what stops (one-off emails) and what waits (sequences);
 *   - the only ways on are the ones that work today: the existing "Move up
 *     to Scale" when it is offered, or a smaller group; Scale is said to be
 *     the largest plan, never given an invented one, and nothing is sold;
 *   - a count that could not be read is said to be unknown, never 0 and
 *     never a percentage; a store without list email (Store) gets no notice;
 *   - the month's count is read exactly, by the reader that also decides
 *     whether a one-off email may go (lib/mail.ts usedThisMonthExact, #2958):
 *     a missing counter is 0, any other shape is unknown, and a negative
 *     count (left by a give-back) is shown as unknown, never 0;
 *   - the notice is a plain note in the "This month" card that can be hidden
 *     (no dialog, no focus taken, no page change), with no urgency words.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mailMonthNotice, shownMonthCount, type MailMonthFacts } from "@/lib/mail-month-notice";
import { MailMonthNoticeBox } from "@/components/mail-month-notice";
import { usedThisMonthExact } from "@/lib/mail";
import { store as memory } from "./redis-stub";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");

const studio: MailMonthFacts = { used: 0, allowance: 7_000, reset: "December 4 (UTC)", billing: true, trial: false, biggest: false, moveUp: null };

async function main(): Promise<void> {
  part("Below 80%: nothing is said");
  is("nothing sent", mailMonthNotice(studio), null);
  is("one email short of 80%", mailMonthNotice({ ...studio, used: 5_599 }), null);

  part("From 80%: how many are left and when the count starts again");
  const near = mailMonthNotice({ ...studio, used: 5_600 });
  is("exactly 80% is near", near?.level, "near");
  is("title says what is left", near?.title, "1,400 emails are left this month");
  is("what was used, in plain words", near?.lines[0], "You have sent 5,600 of this month's 7,000 emails to your list, one-off and sequences together.");
  is("when the billing month starts again", near?.lines[1], "The count starts again with your next billing month, on December 4 (UTC).");
  is("a smaller group is the real way to make them last", near?.lines[2], "To make the rest last, write to a smaller group of your list.");
  is("one left", mailMonthNotice({ ...studio, used: 6_999 })?.title, "1 email is left this month");
  is("a calendar month", mailMonthNotice({ ...studio, used: 6_000, billing: false })?.lines[1], "The count starts again on December 4 (UTC).");
  is("a month that could not be told", mailMonthNotice({ ...studio, used: 6_000, reset: null })?.lines[1], "The day the count starts again could not be read just now.");

  part("At 100%: what stops and what waits");
  const out = mailMonthNotice({ ...studio, used: 7_000 });
  is("level", out?.level, "out");
  is("title", out?.title, "This month's emails are used up");
  is("what stops and what waits", out?.lines[0], "One-off emails can't go out until the count starts again. Sequence emails wait and go out once it does.");
  is("when", out?.lines[1], "The count starts again with your next billing month, on December 4 (UTC).");
  is("no smaller-group advice when none are left", out?.lines.length, 2);
  is("used past the month is still used up, never negative", mailMonthNotice({ ...studio, used: 7_250 })?.title, "This month's emails are used up");

  part("Only the ways on that work today");
  const up = mailMonthNotice({ ...studio, used: 6_000, moveUp: { emails: 10_000 } });
  is("the existing move up, when it is offered", up?.lines[2], "Scale holds up to 10,000 emails a month. \"Need more?\" below shows its price and moves you up.");
  is("move up offered at 100% too", mailMonthNotice({ ...studio, used: 7_000, moveUp: { emails: 10_000 } })?.lines[2], "Scale holds up to 10,000 emails a month. \"Need more?\" below shows its price and moves you up.");
  const scale = { ...studio, allowance: 10_000, biggest: true };
  is("Scale near: largest plan, smaller group", mailMonthNotice({ ...scale, used: 8_000 })?.lines[2], "Scale is the largest plan. To make the rest last, write to a smaller group of your list.");
  is("Scale out: no plan is invented", mailMonthNotice({ ...scale, used: 10_000 })?.lines[2], "Scale is the largest plan, so no plan holds more emails.");

  part("The free trial");
  const trial = { ...studio, allowance: 300, trial: true, reset: "November 20 (UTC)", billing: true };
  const trialNear = mailMonthNotice({ ...trial, used: 240 });
  is("trial near: title names the trial, not a month", trialNear?.title, "60 emails are left in the free trial");
  is("trial near: the trial's emails", trialNear?.lines[0], "You have sent 240 of the free trial's 300 emails to your list, one-off and sequences together.");
  is("trial near: when the trial ends", trialNear?.lines[1], "The free trial's emails are counted for the whole trial, which ends on November 20 (UTC).");
  const trialOut = mailMonthNotice({ ...trial, used: 300 });
  is("trial out: title", trialOut?.title, "The free trial's emails are used up");
  is("trial out: sequences wait, no promise of when", trialOut?.lines[0], "One-off emails can't go out now. Sequence emails wait until there are emails again.");
  is("trial on Scale says nothing of the largest plan", mailMonthNotice({ ...trial, biggest: true, used: 240 })?.lines.some((line) => line.includes("largest")), false);

  part("Unknown is said, never taken for zero; Store gets no notice");
  is("unknown count: no notice", mailMonthNotice({ ...studio, used: null }), null);
  is("no list email (Store): no notice", mailMonthNotice({ ...studio, allowance: 0, used: 0 }), null);
  is("not a count: no notice", mailMonthNotice({ ...studio, used: 5_600.5 }), null);
  is("negative: no notice", mailMonthNotice({ ...studio, used: -1 }), null);
  is("allowance not a count: no notice", mailMonthNotice({ ...studio, allowance: Number.NaN, used: 10 }), null);

  part("No urgency, money or percentage words");
  const every = [studio, { ...studio, moveUp: { emails: 10_000 } }, scale, trial].flatMap((facts) => [0.8, 0.9, 1, 1.2].map((share) => mailMonthNotice({ ...facts, used: Math.round(facts.allowance * share) })));
  const words = every.flatMap((notice) => (notice ? [notice.title, ...notice.lines] : [])).join(" ");
  is("every share gives a notice", every.every(Boolean), true);
  is("no urgency or scarcity", /hurry|only \d|last chance|now or|act fast|limited|countdown|don't miss|!/i.test(words), false);
  is("no percentage", /%|percent/i.test(words), false);
  is("no price or charge", /\$|charge|pay now|buy/i.test(words), false);

  part("The month's count, read exactly (the reader of #2958, shown by shownMonthCount)");
  // As app/studio/email/page.tsx reads it (held below): a paying month that cannot be told is unknown.
  const shown = (listId: string | null, window: string | null) =>
    window === null && listId ? Promise.resolve(null) : usedThisMonthExact(listId, window).then(shownMonthCount, () => null);
  is("a missing counter is 0", await shown("l-es3", "2026-11-04"), 0);
  await memory.pipeline([["SET", "nl:mail:used:l-es3:2026-11-04", "5600"]]);
  is("a whole number is the count", await shown("l-es3", "2026-11-04"), 5_600);
  is("no list yet: nothing sent", await shown(null, "2026-11-04"), 0);
  is("no month: unknown", await shown("l-es3", null), null);
  await memory.pipeline([["SET", "nl:mail:used:l-es3:2026-11-04", "-40"]]);
  is("a negative left by a give-back is read as that number by the send (#2958)", await usedThisMonthExact("l-es3", "2026-11-04"), -40);
  is("a negative is shown as unknown, never 0 or -40", await shown("l-es3", "2026-11-04"), null);
  await memory.pipeline([["SET", "nl:mail:used:l-es3:2026-11-04", "12abc"]]);
  is("not a number is unknown", await shown("l-es3", "2026-11-04"), null);
  const pipeline = memory.pipeline.bind(memory);
  for (const [what, reply] of [["no reply", []], ["two replies", ["1", "2"]], ["an object", [{ n: 3 }]], ["a fraction", [2.5]], ["a number, not Redis's text", [7]], ["not a list", "7"]] as const) {
    (memory as unknown as { pipeline: unknown }).pipeline = async () => reply;
    is(`${what} is unknown`, await shown("l-es3", "2026-11-04"), null);
  }
  (memory as unknown as { pipeline: unknown }).pipeline = pipeline;
  is("shownMonthCount: only a whole number from zero", [0, 7, -1, 2.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1].map(shownMonthCount), [0, 7, null, null, null, null]);

  part("The box: a note that can be hidden, never a dialog");
  const box = renderToStaticMarkup(createElement(MailMonthNoticeBox, { notice: out!, hideKey: "mm:mail-month:s1:2026-11-04:out", headingId: "mail-month-heading" }));
  is("a status note", /role="status"/.test(box), true);
  is("warn colors at 100%", /class="notice notice-warn/.test(box), true);
  is("title and lines shown", box.includes("This month&#x27;s emails are used up") && box.includes("Sequence emails wait"), true);
  is("a real button to hide it", /<button type="button"[^>]*>Hide this note<\/button>/.test(box), true);
  is("no dialog, no link away", /dialog|<a\b|autofocus/i.test(box), false);
  const nearBox = renderToStaticMarkup(createElement(MailMonthNoticeBox, { notice: near!, hideKey: null, headingId: "mail-month-heading" }));
  is("info colors from 80%", /class="notice notice-info/.test(nearBox), true);
  const source = read("components/mail-month-notice.tsx");
  is("browser storage read and written inside try", (source.match(/try \{[^}]*localStorage/g) ?? []).length, 2);
  is("hiding hands focus to the card's heading", /getElementById\(headingId\)\?\.focus\(\)/.test(source), true);
  is("nothing moves", /animation|transition/i.test(source), false);

  part("Wired into the email studio");
  const page = read("app/studio/email/page.tsx");
  const studioSource = read("components/email-studio.tsx");
  is("the page reads the count exactly, unknown as null", page.includes("windowId(store) === null && store.listId\n      ? null\n      : usedThisMonthExact(store.listId, windowId(store)).then(shownMonthCount, () => null),"), true);
  is("one reader of the month's count, defined once (#2958)", (read("lib/mail.ts").match(/export async function usedThisMonthExact\b/g) ?? []).length, 1);
  is("the page builds the notice from the facts it has", /mailMonthNotice\(\{/.test(page), true);
  is("no count is not '0 of'", /props\.used === null/.test(studioSource) && studioSource.includes("This month&apos;s count could not be read just now. Reload the page to try again."), true);
  is("the composer's count needs a known number", studioSource.includes("month={props.monthKnown && props.used !== null ? { used: props.used, allowance: props.allowance } : null}"), true);
  is("the note sits in the This month card", /<MailMonthNoticeBox\b/.test(studioSource) && /id="mail-month-heading"[^>]*tabIndex=\{-1\}/.test(studioSource), true);
  done();
}

void main();
