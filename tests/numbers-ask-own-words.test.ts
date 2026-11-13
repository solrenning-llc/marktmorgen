// Every refusal the numbers question route answers has its own sentence in
// the panel (components/numbers-ask.tsx MESSAGES, or the studio's shared
// STUDIO_MESSAGES), so the creator is told why, not the generic server text.
// Claude 1's and Claude 7's LEVE on #3803: "unavailable" (the month's AI jobs
// could not be read) fell back to server_error. Source-level, no network.
import { readFileSync } from "node:fs";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { done, is, part } from "./check";

const route = readFileSync("app/api/store/numbers/ask/route.ts", "utf8");
const panel = readFileSync("components/numbers-ask.tsx", "utf8");
const block = /const MESSAGES: Record<string, string> = \{([\s\S]*?)\n\};/.exec(panel)?.[1] ?? "";
const own = new Set([...block.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]));
// A refusal that carries its own sentence (`message`, as studio_used does) is shown as it comes.
const answered = [...new Set([...route.matchAll(/error: "([a-z_]+)"(?!, message:)/g)].map((m) => m[1]))];

part("each refusal of the numbers question has its own words in the panel");
is("the route's refusals were found", answered.length > 4, true);
for (const reason of answered) is(`"${reason}" has a sentence`, own.has(reason) || reason in STUDIO_MESSAGES, true);

part("an unreadable AI balance says what could not be read, and that nothing was counted");
const unavailable = /^\s*unavailable:\s*"([^"]+)"/m.exec(block)?.[1] ?? "";
is("it names the AI jobs", /AI jobs/.test(unavailable), true);
is("it says nothing was counted", /Nothing was counted/.test(unavailable), true);
done();
