/**
 * Every error the "Ask your numbers" route answers has its own words in the panel (components/numbers-ask.tsx), so a
 * creator is never told "Something went wrong on our side" for a known state. Claude 1's and Claude 7's LEVE on
 * #3803: an unreadable AI balance answers `unavailable`, which had no entry and fell back to the server-error words.
 * `studio_used` carries its own message from the server and is shown as sent.
 */
import { readFileSync } from "node:fs";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { done, is, part } from "./check";

const route = readFileSync("app/api/store/numbers/ask/route.ts", "utf8");
const panel = readFileSync("components/numbers-ask.tsx", "utf8");
const codes = [...new Set([...route.matchAll(/error: "([a-z_]+)"/g)].map((m) => m[1]))];
const block = /const MESSAGES: Record<string, string> = \{([\s\S]*?)\n\};/.exec(panel)?.[1] ?? "";
const own = new Set([...block.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]));

part("The route's errors, read from its source");
is("some are found", codes.length >= 5, true);
is("the panel's own words are found", own.size >= 5, true);

part("Each has words of its own in the panel");
for (const code of codes) {
  if (code === "studio_used") continue;
  is(`"${code}" has words`, own.has(code) || code in STUDIO_MESSAGES, true);
}

part("The unreadable balance says what happened, and that nothing was counted");
const words = /\n\s+unavailable: "([^"]+)"/.exec(block)?.[1] ?? "";
is("it does not say something went wrong on our side", /went wrong/i.test(words), false);
is("it says nothing was counted", /nothing was counted/i.test(words), true);

done();
