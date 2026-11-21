/**
 * The workflow editor's "has done part of a course" trigger (287 [H4-1], unit 2; components/email-studio.tsx and
 * lessonsToReach in lib/flow-rules.ts; added 12 November 2026). Checked:
 *
 *   - lessonsToReach says exactly when reachedShare first reaches a share, for every share offered and every course
 *     from 1 to 60 lessons, so the example the editor shows is the rule the server applies;
 *   - the menu offers every share the server accepts, and nothing else;
 *   - the editor offers the trigger only with a course, picks a course when it is chosen, sends the share with it and
 *     reads it back, says it in the list of workflows and explains a refusal in words (read in its source).
 *
 * Not checked here: a run in a real browser or with a screen reader (the editor opens its form only after a click).
 */
import { readFileSync } from "node:fs";
import { MAX_REACHED_SHARE, MIN_REACHED_SHARE, REACHED_SHARE_STEP, isReachedShare, lessonsToReach, reachedShare } from "@/lib/flow-rules";
import { done, is, part } from "./check";

part("When a share is reached");
let mismatches = 0;
for (let share = MIN_REACHED_SHARE; share <= MAX_REACHED_SHARE; share += REACHED_SHARE_STEP) {
  for (let lessons = 1; lessons <= 60; lessons += 1) {
    const at = lessonsToReach(share, lessons);
    const first = Array.from({ length: lessons }, (_, i) => i + 1).find((d) => reachedShare(d, lessons) >= share);
    if (at !== first) mismatches += 1;
  }
}
is("the fewest lessons whose share is at least it, for every share and course size", mismatches, 0);
is("for example, 25% of 10 lessons is reached at 3, 50% at 5, 95% at 10", [lessonsToReach(25, 10), lessonsToReach(50, 10), lessonsToReach(95, 10)], [3, 5, 10]);
is("nothing for a bad input", [lessonsToReach(0, 10), lessonsToReach(25, 0), lessonsToReach(2.5, 10)], [0, 0, 0]);

part("The editor");
const studio = readFileSync("components/email-studio.tsx", "utf8");
const menu = Array.from({ length: (MAX_REACHED_SHARE - MIN_REACHED_SHARE) / REACHED_SHARE_STEP + 1 }, (_, i) => MIN_REACHED_SHARE + i * REACHED_SHARE_STEP);
is("the menu's shares are exactly the ones the server accepts", [menu.every(isReachedShare), menu.length, isReachedShare(MIN_REACHED_SHARE - REACHED_SHARE_STEP), isReachedShare(MAX_REACHED_SHARE + REACHED_SHARE_STEP)], [true, 19, false, false]);
is("and the editor builds its menu the same way", studio.includes("(MAX_REACHED_SHARE - MIN_REACHED_SHARE) / REACHED_SHARE_STEP + 1"), true);
is("offered only with a course", studio.includes('{courses.length ? <option value="reached">Someone who agreed to hear from you has done part of a course</option> : null}'), true);
is("choosing it picks a course", studio.includes('(trigger === "finished" || trigger === "started" || trigger === "reached") && !courses.includes(current.productId)'), true);
is("the trigger names its course when saved", studio.includes('t === "abandoned" || t === "reached";'), true);
is("the share is sent only with it, and read back from a saved workflow", studio.includes('...(draft.trigger === "reached" ? { share: draft.share } : {}),') && studio.includes("share: isReachedShare(flow.share) ? flow.share : DEFAULT_REACHED_SHARE,"), true);
is("its two choices are labeled, the share with its hint", studio.includes('<span className="field-label">How much of it they have done</span>') && studio.includes('aria-describedby="flow-reached-hint"') && studio.includes('id="flow-reached-hint"'), true);
is("the hint shows the rule with an example", studio.includes("lessonsToReach(draft.share, REACHED_EXAMPLE_LESSONS)"), true);
is("the list of workflows says it", studio.includes("has done ${f.share ?? \"part\"}% of the lessons of"), true);
is("a refused share is explained in words", /share: "Choose how much of the course a student has done before this workflow starts: from 5% to 95% of the lessons, in steps of 5\."/.test(studio), true);

done();
