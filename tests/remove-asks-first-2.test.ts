/**
 * AX274, WCAG 3.3.6 Error Prevention (All) at AAA: removing something the creator
 * set up either asks first or can be undone. The studio audit of 13 November 2026
 * found two more that did neither, acting on the first press: the welcome video on
 * the store page (its address is gone with it, so putting it back means finding the
 * address again) and a phone that receives the store's alerts (adding it again means
 * going through the browser's permission flow on that phone).
 *
 * Both now go through ConfirmAction (components/confirm-action.tsx, the mechanism of
 * 568 [GD2] (h)): the first press asks what will happen; only "Yes, remove" does it;
 * "Keep it", focused, puts it back. The six of tests/remove-asks-first.test.ts are
 * the same audit's first batch.
 *
 * What fails here: either one acting on its first press again, or asking without
 * saying what is removed.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("The welcome video and an alert phone ask before they are removed");
for (const [file, question, firstPress] of [
  ["components/intro-editor.tsx", "Remove the welcome video?", /onClick=\{\(\) => \{ setUrl\(""\); void save\(""\); \}\}/],
  ["components/phone-alerts-panel.tsx", "Remove this phone?", /onClick=\{async \(\) => \{\s*if \(await send\(\{ action: "remove", id: device\.id \}/],
] as const) {
  const text = readFileSync(file, "utf8");
  is(`${file}: the first press no longer removes`, firstPress.test(text), false);
  is(`${file}: through ConfirmAction, saying what is removed`, text.includes("<ConfirmAction") && text.includes(question) && /yes="Yes, remove"/.test(text), true);
  is(`${file}: imports the shared ConfirmAction`, /import \{ ConfirmAction \} from "@\/components\/confirm-action";/.test(text), true);
}

done();
