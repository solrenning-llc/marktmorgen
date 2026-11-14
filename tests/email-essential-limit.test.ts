/**
 * SG2(17): every ordinary counter that admits an email must fail closed.
 *
 * `withinEssentialLimit` already has behavioral coverage for lost, partial and
 * malformed Redis acknowledgements. This contract keeps each email admission
 * on that helper while leaving unrelated public/read-only counters alone.
 */
import fs from "node:fs";
import path from "node:path";
import { done, is, part } from "./check";

const root = process.cwd();
const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");

const expected = new Map<string, string[]>([
  ["lib/affiliate-hub.ts", ["affhub-ip", "affhub-address"]],
  ["lib/buyer-library.ts", ["library-ip", "library-address"]],
  ["lib/podcast-access.ts", ["podcast-link-address"]],
  ["lib/store-contact.ts", ["contact-ip", "contact-store"]],
  ["lib/assistant-reminder.ts", ["assist-remind-store"]],
  ["lib/checkout-ask.ts", ["remind-ask", "remind-store"]],
  ["app/api/store/course/start/route.ts", ["course-start-order"]],
  ["app/api/store/course/task/route.ts", ["task-hand-in"]],
  ["app/api/store/group/route.ts", ["group-place"]],
]);

part("SG2(17): unknown email counters refuse before work or delivery");
for (const [file, scopes] of expected) {
  const source = read(file);
  is(`${file} imports the fail-closed allowance`, /\b(?:withinEssentialLimit|essentialLimitState)\b/.test(source), true);
  for (const scope of scopes) {
    // Either fail-closed helper; essentialLimitState also tells "limited" from "error"
    // (email-essential-limit-behaviour.test.ts runs that).
    const strict = new RegExp(`(?:withinEssentialLimit|essentialLimitState)\\(\\s*[\"']${scope}[\"']`);
    const permissive = new RegExp(`withinLimit\\(\\s*[\"']${scope}[\"']`);
    is(`${file}: ${scope} refuses unknown evidence`, [strict.test(source), permissive.test(source)], [true, false]);
  }
}

// The feed-open allowance spends no email and remains the ordinary public
// anti-abuse guard; SG2(17) changes only the paid delivery boundary.
const podcast = read("lib/podcast-access.ts");
is(
  "podcast feed reads keep their ordinary public allowance",
  /withinLimit\(\s*["']podcast-feed["']/.test(podcast),
  true,
);

done();
