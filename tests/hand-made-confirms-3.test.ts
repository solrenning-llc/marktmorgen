/**
 * Two more "are you sure" questions made by hand (see tests/hand-made-confirms*.test.ts): revoking an API key and
 * removing a product's funnel of offers. Each lost the focus to the top of the page when it opened and when it was
 * kept (WCAG 2.4.3), and Escape did nothing (2.1.1). Each is now a ConfirmAction, with the same words.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("Two more questions are ConfirmActions");
for (const [file, question, handMade] of [
  ["components/api-key-editor.tsx", "Revoke it? Anything using it stops working, and so do the webhook endpoints it added.", /revoking === key\.id \?/],
  ["components/funnel-editor.tsx", "Remove ${initial.steps.length === 1 ? \"the offer\"", /confirmRemove \? \(/],
] as const) {
  const text = readFileSync(file, "utf8");
  is(`${file}: no hand-made question`, handMade.test(text), false);
  is(`${file}: asks through ConfirmAction`, text.includes("<ConfirmAction") && text.includes(question), true);
}
done();
