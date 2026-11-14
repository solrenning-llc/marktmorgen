/**
 * Four more "are you sure" questions made by hand (see tests/hand-made-confirms.test.ts): disconnecting the Discord
 * server, removing the store's own domain, removing a lesson's quiz and stopping a bundle. Each lost the focus to
 * the top of the page when it opened and when it was kept (WCAG 2.4.3), and Escape did nothing (2.1.1). Each is
 * now a ConfirmAction (components/confirm-action.tsx), with the same words as one question.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("Four more questions are ConfirmActions");
for (const [file, question, handMade] of [
  ["components/discord-studio.tsx", "Disconnect the server? The bot leaves it.", /\{leaving \? \(/],
  ["components/domain-editor.tsx", "stops opening your store. marktmorgen.com/@", /\{removing \? \(/],
  ["components/quiz-editor.tsx", "Remove the quiz? The lessons after it stop waiting on it.", /removing \? \(/],
  ["components/bundle-editor.tsx", "Make it an ordinary product again?", /confirmClear \? \(/],
] as const) {
  const text = readFileSync(file, "utf8");
  is(`${file}: no hand-made question`, handMade.test(text), false);
  is(`${file}: asks through ConfirmAction`, text.includes("<ConfirmAction") && text.includes(question), true);
}
done();
