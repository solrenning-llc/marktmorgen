/**
 * Where a kept record's clock starts again with each new write, the privacy policy says so (nuvem I privacy audit
 * of main @3cdc624a7d, 13 November 2026, MÉDIO).
 *
 * - Unanswered questions (lib/answers.ts, lib/store-assistant.ts): one list per store, its 120 days renewed by each
 *   new unanswered question and cut only to the 50 latest; the policy said "up to about four months".
 * - An import (lib/imports.ts): its record, report and buyers still to be emailed are kept 14 days again at every
 *   step, and kept alive while the plan's payment is paused; the policy said "14 days after the import began".
 * - A team's notes about a person (lib/buyer-profile.ts): kept three years from the latest note, said nowhere.
 *
 * Each sentence is held here to the code's own figures, so the two cannot part again.
 */
import { readFileSync } from "node:fs";
import { MISSED_KEPT, MISSED_SECONDS } from "@/lib/answers-rules";
import { ASSISTANT_MISSED_KEPT, ASSISTANT_MISSED_SECONDS } from "@/lib/store-assistant-rules";
import { done, is, part } from "./check";

const policy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ").replace(/&apos;/g, "'");
const source = (file: string) => readFileSync(file, "utf8");

part("Unanswered questions: four months from the store's latest one, the 50 latest");
is("the code keeps 50 for 120 days, renewed by each new one, on both pages", [MISSED_KEPT, MISSED_SECONDS, ASSISTANT_MISSED_KEPT, ASSISTANT_MISSED_SECONDS], [50, 120 * 86_400, 50, 120 * 86_400]);
is("the policy no longer says a flat 'up to about four months'", /for up to about four months/.test(policy), false);
is("it says, twice, that the four months run from the store's latest unanswered question and only the 50 latest are kept",
  (policy.match(/about four months after the store's latest unanswered question, and only the 50 latest/g) ?? []).length, 2);

part("An import: 14 days from its last step, and longer while the plan's payment is paused");
is("the code renews 14 days at each step and keeps it alive while costs are paused", [/KEEP_SECONDS = 14 \* 86_400/.test(source("lib/imports.ts")), /costsPaused\(store/.test(source("lib/imports.ts"))], [true, true]);
is("the policy no longer counts from when the import began", /14 days after the import began|14 days after it began/.test(policy), false);
is("it says 14 days after the import's last step, kept while the plan's payment is paused", (policy.match(/14 days after the import's last step/g) ?? []).length >= 2 && /while the store's plan payment is unpaid or disputed/.test(policy), true);

is("the studio's own line says the same", /kept for 14 days after the import's last step \(longer only while your plan's payment is unpaid or disputed\)/.test(source("lib/person-data.ts")), true);

part("A team's notes about a person: three years from the latest note");
is("the code keeps them three years, renewed by each note", /NOTES_SECONDS = 3 \* 365 \* 86_400/.test(source("lib/buyer-profile.ts")), true);
is("the policy says it", /notes, kept three years after the team's latest note about you/.test(policy), true);
done();
