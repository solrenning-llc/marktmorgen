/**
 * How long a saved agreement template is kept and what it may take of the
 * store's data room (634 [GL2], unit 2a; the owner's decision of 2 November
 * 2026, 23h36): the rules, on synthetic templates only.
 */
import { KEEP_DAYS, MAX_BODY, MAX_LINE_TEXT, MAX_LINES, MAX_TITLE } from "@/lib/agreement-rules";
import { type AgreementTemplate, MAX_TEMPLATE_BYTES, MAX_TEMPLATE_NAME, TEMPLATE_KEEP_DAYS, keptUntilWords, templateBytes, templateExport, templateKeptUntil, templateProblem, templateProblemWords, templateSizeProblem } from "@/lib/agreement-template-rules";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const SAVED = Date.UTC(2026, 10, 2, 15, 0);
const base: AgreementTemplate = { id: "a".repeat(32), name: "Monthly coaching", kind: "proposal", title: "Coaching for {client_name}", body: "Hi {client_name}, here is the plan from {store_name}.", lines: [{ text: "Four sessions", quantity: 1, amount: "400" }], updatedAt: SAVED };

part("Kept from the last time it was saved or used");
is("as long as an agreement's record", TEMPLATE_KEEP_DAYS, KEEP_DAYS);
is("from the day it was saved", templateKeptUntil(base), SAVED + KEEP_DAYS * DAY);
is("each use keeps it longer, even if never edited again", templateKeptUntil({ ...base, usedAt: SAVED + 300 * DAY }), SAVED + 700 * DAY);
is("a use before the last save does not shorten it", templateKeptUntil({ ...base, usedAt: SAVED - 10 * DAY }), SAVED + KEEP_DAYS * DAY);
is("said on the template, in the creator's time zone", keptUntilWords(base, "America/New_York"), "Kept until December 7, 2027 if you don't use it. Using it or saving it keeps it another 400 days.");

part("Counted at its exact size, never above the cap");
is("its size is its JSON in UTF-8", templateBytes(base), new TextEncoder().encode(JSON.stringify(base)).length);
const heavy = "€\"\\";
const fill = (n: number) => heavy.repeat(Math.ceil(n / heavy.length)).slice(0, n);
const longest: AgreementTemplate = {
  ...base,
  name: fill(MAX_TEMPLATE_NAME),
  title: fill(MAX_TITLE),
  body: fill(MAX_BODY),
  lines: Array.from({ length: MAX_LINES }, () => ({ text: fill(MAX_LINE_TEXT), quantity: 1, amount: "1.00" })),
  usedAt: SAVED,
};
is("a template at every limit, in the heaviest characters, is one the rules take", templateProblem(longest, 0, "usd"), null);
is("and fits under the cap", [templateBytes(longest) <= MAX_TEMPLATE_BYTES, templateSizeProblem(longest)], [true, null]);
const over: AgreementTemplate = { ...longest, body: fill(MAX_BODY * 3) };
is("anything larger is refused before it is counted or kept, never cut", templateSizeProblem(over), { why: "too_big" });
is("saying how to fix it", templateProblemWords({ why: "too_big" }), "This template is too long to keep. Make its text shorter, then save it again.");

part("In the store's export");
is("what the creator wrote, when it was saved and used, and until when it is kept", templateExport({ ...base, usedAt: SAVED + DAY }), {
  name: "Monthly coaching",
  kind: "proposal",
  title: "Coaching for {client_name}",
  text: "Hi {client_name}, here is the plan from {store_name}.",
  lines: [{ text: "Four sessions", quantity: 1, amount: "400" }],
  savedAt: "2026-11-02T15:00:00.000Z",
  lastUsedAt: "2026-11-03T15:00:00.000Z",
  keptUntil: new Date(SAVED + DAY + KEEP_DAYS * DAY).toISOString(),
});
is("never its id", "id" in templateExport(base), false);

done();
