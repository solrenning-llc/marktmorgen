/**
 * AX274, WCAG 3.3.6 Error Prevention (All) at AAA: removing or clearing something
 * either asks first or can be undone. The APG and error-prevention audit of
 * 13 November 2026 found six more that did neither, acting on the first press:
 * an outreach draft (written by AI from the business's site; deleting it means
 * writing it again), the two lists of questions visitors and the assistant could
 * not answer (nothing brings them back), the note after paying (its words, video
 * and button all go), a payment request, and the creator's reply to a review.
 *
 * Each now goes through ConfirmAction (components/confirm-action.tsx), as in
 * tests/remove-asks-first.test.ts and tests/remove-asks-first-2.test.ts: the first
 * press asks what will happen, only the "Yes, …" button does it, and "Keep it",
 * focused, leaves everything as it was.
 *
 * What fails here: any of them acting on its first press again, or asking without
 * saying what goes.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("Six more removals ask first");
for (const [file, question, yes, firstPress] of [
  ["components/outreach-studio.tsx", "Delete this draft?", "Yes, delete", /<button[^>]*onClick=\{\(\) => run\(\{ action: "drop" \}/],
  ["components/answers-editor.tsx", "Clear the list?", "Yes, clear", /<button[^>]*onClick=\{\(\) => void post\(\{ clear: true \}/],
  ["components/store-assistant-editor.tsx", "Clear the list?", "Yes, clear", /<button[^>]*onClick=\{\(\) => void post\(\{ clear: true \}/],
  ["components/thanks-note-editor.tsx", "Remove the note?", "Yes, remove", /<button[^>]*onClick=\{\(\) => void send\(null\)\}/],
  ["components/payment-requests-studio.tsx", "Delete this request?", "Yes, delete", /<button[^>]*onClick=\{\(\) => void act\("delete"/],
  ["components/review-studio.tsx", "Remove your reply?", "Yes, remove", /<button[^>]*onClick=\{\(\) => act\("reply", \{ action: "reply", text: "" \}/],
] as const) {
  const text = readFileSync(file, "utf8");
  is(`${file}: the first press no longer acts`, firstPress.test(text), false);
  is(`${file}: through ConfirmAction, saying what goes`, text.includes("<ConfirmAction") && text.includes(question) && text.includes(`yes="${yes}"`), true);
  is(`${file}: imports the shared ConfirmAction`, /import \{ ConfirmAction \} from "@\/components\/confirm-action";/.test(text), true);
}

done();
