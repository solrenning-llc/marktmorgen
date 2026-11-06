/**
 * Email health said to the creator before a pause (599 [KB20], unit 1;
 * lib/mail-health-levels.ts; added 1 November 2026). Checked:
 *
 *   - "over" is exactly the pause's own line (overTheLine), for every count;
 *   - "near" and "watch" sit at four fifths and half of that line, in the
 *     number and in the share together, and never move the line;
 *   - the worse measure is said, bounces first as the pause reads them;
 *   - the words: plain, with what to do, no promise; the numbers sentence;
 *   - the studio's email page shows it from the same seven days, with no
 *     panel while a pause is already said.
 */
import { readFileSync } from "node:fs";
import { BOUNCE_FLOOR, BOUNCE_RATE, COMPLAINT_FLOOR, COMPLAINT_RATE } from "@/lib/mail-health-rules";
import { overTheLine } from "@/lib/mail-health";
import { HEALTH_NOTE, healthAdvice, healthLevels, healthLine, shareWords } from "@/lib/mail-health-levels";
import { done, is, part } from "./check";

function main(): void {
  part("Over is the pause's own line");
  let same = true;
  for (const sent of [0, 10, 100, 1250, 5000, 40000]) {
    // Up to past each line, for every sent tried: both sides of the line are reached.
    for (let bounced = 0; bounced <= Math.min(sent, Math.ceil(sent * BOUNCE_RATE) + BOUNCE_FLOOR + 5); bounced += 1) {
      for (const complained of [0, 2, Math.ceil(sent * COMPLAINT_RATE) + COMPLAINT_FLOOR]) {
        if (complained > sent) continue;
        const line = overTheLine({ sent, bounced, complained });
        const levels = healthLevels({ sent, bounced, complained });
        same &&= (levels.worst === "over") === (line !== null);
        same &&= (levels.bounces === "over") === (bounced >= BOUNCE_FLOOR && bounced / sent >= BOUNCE_RATE);
      }
    }
  }
  is("over exactly when the pause's own line is reached, both sides of each line, both measures together", same, true);

  part("The steps before it");
  const sent = 10_000;
  const at = (part: number) => Math.ceil(Math.max(BOUNCE_FLOOR * part, sent * BOUNCE_RATE * part));
  is("bounces: fine, watch at half, near at four fifths, over at the line", [at(0.5) - 1, at(0.5), at(0.8), at(1)].map((bounced) => healthLevels({ sent, bounced, complained: 0 }).bounces), ["fine", "watch", "near", "over"]);
  is("a high share over a handful is not a step: the number must be reached too", healthLevels({ sent: 20, bounced: 10, complained: 0 }).bounces, "fine");
  const cat = (part: number) => Math.ceil(Math.max(COMPLAINT_FLOOR * part, sent * COMPLAINT_RATE * part));
  is("complaints: the same steps on their own line", [cat(0.5), cat(0.8), cat(1)].map((complained) => healthLevels({ sent, bounced: 0, complained }).complaints), ["watch", "near", "over"]);
  is("nothing sent: fine", healthLevels({ sent: 0, bounced: 0, complained: 0 }), { bounces: "fine", complaints: "fine", worst: "fine", measure: null });
  is("the worse measure is the one said", healthLevels({ sent, bounced: at(0.5), complained: cat(0.8) }).measure, "complaints");
  is("on a tie, bounces first, as the pause reads them", healthLevels({ sent, bounced: at(0.8), complained: cat(0.8) }).measure, "bounces");

  part("The words");
  const all = (["fine", "watch", "near", "over"] as const).flatMap((level) => (["bounces", "complaints"] as const).map((m) => healthAdvice(level, m)));
  is("each level a title and what to do", all.every((a) => a.title.length > 5 && a.text.length > 20), true);
  is("at the line: the next report pauses, not \"the next email\"; near: a pause, and it goes on by itself", [healthAdvice("over", "bounces").text.includes("The next bounce or spam report we hear about pauses email to your list for 7 days; it then goes on by itself."), /next email/i.test(healthAdvice("over", "bounces").text), healthAdvice("near", "complaints").text.includes("pauses for 7 days")], [true, false, true]);
  is("under the steps: no pause coming, never \"healthy\" (a handful at a high share is not proof of anything)", [healthAdvice("fine", null).title, /healthy|nothing to do/i.test(JSON.stringify(healthAdvice("fine", null)))], ["No pause coming", false]);
  is("no promise or alarm", /guarantee|never be paused|always deliver|urgent|immediately|warning!|files are never/i.test(JSON.stringify(all) + HEALTH_NOTE), false);
  is("only what the code keeps going is said never to pause", HEALTH_NOTE.includes("Sign-in links and purchase receipts are never paused; while a pause lasts, email to your list, your sequences and the email to buyers you brought over wait."), true);
  is("the advice asks only what the studio lets a creator do", /take off the list|remove .* addresses/i.test(JSON.stringify(all)), false);
  is("the numbers, in a sentence that says what is counted", healthLine({ sent: 1200, bounced: 30, complained: 1 }), "Email to your list, and the one email to buyers you brought over, in the last 7 days (counting starts again when a pause ends): 1,200 sent, 30 to addresses that do not exist (2.5%), 1 reported as spam (0.08%).");
  is("nothing sent, said so", healthLine({ sent: 0, bounced: 0, complained: 0 }).endsWith(": none sent."), true);
  is("shares rounded down, so just under a line never reads as it, and <0.01% rather than 0", [shareWords(5, 6281), shareWords(196, 10000), shareWords(1, 30000), shareWords(0, 100)], ["0.07%", "1.9%", "<0.01%", "0%"]);
  is("it does not claim every report reaches us", HEALTH_NOTE.includes("a low number here is not a promise that nobody reported you"), true);

  part("On the studio's email page");
  const page = readFileSync("app/studio/email/page.tsx", "utf8");
  is("read from the same seven days as the pause", page.includes("listHealth(healthId(store)).catch(() => null)"), true);
  is("shown only when no pause is confirmed (a failed read shows nothing, never \"no pause coming\")", page.includes("pauseForSending(healthId(store)).catch(() => undefined)") && page.includes("{confirmedPause === null && health && levels && advice ? (") && page.includes('aria-labelledby="mail-health-title"'), true);
}

main();
done();
