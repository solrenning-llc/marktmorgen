/**
 * Every refusal app/api/store/numbers/ask can answer is said in its own words by the panel
 * (components/numbers-ask.tsx MESSAGES), never by the generic "Something went wrong on our side".
 * Claude 7 on #3803: "unavailable" (the month's AI jobs could not be read) had no words of its own,
 * so the creator was not told why. Codes from the route itself; askNumbers' reasons come through
 * `done.reason` and are listed by lib/numbers-ask.ts's own type.
 */
import { readFileSync } from "node:fs";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { done, is } from "./check";

const route = readFileSync("app/api/store/numbers/ask/route.ts", "utf8");
const panel = readFileSync("components/numbers-ask.tsx", "utf8");
const codes = [...route.matchAll(/error: "([a-z_]+)"/g)].map((m) => m[1]);
const block = panel.slice(panel.indexOf("const MESSAGES"), panel.indexOf("};", panel.indexOf("const MESSAGES")));
const own = new Set([...block.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]));
const words = new Set([...own, ...Object.keys(STUDIO_MESSAGES)]);
// The studio's own refusal carries its sentence in `message`, which the panel shows as it came.
if (/data\.error === "studio_used" && typeof data\.message === "string"/.test(panel)) words.add("studio_used");

is("the route answers some refusals", codes.length > 3, true);
is("each refusal the route answers has its own words in the panel", codes.filter((code) => !words.has(code)), []);
is("an unreadable AI balance says why, and that nothing was counted", /unavailable: "[^"]*could not be read[^"]*Nothing was counted/.test(block), true);
done();
