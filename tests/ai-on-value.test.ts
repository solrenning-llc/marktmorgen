/**
 * Rule 24 on the studio pages (VR item 2): what a page hands AiOn when the month's AI allowance could not be read.
 * lib/ai.ts aiLeft throws on an unknown read; the page passes null, and aiOnValue turns it into `known: false`,
 * which every AiOn reader shows as "We could not check your AI allowance", never "0 left". A known count, a spent
 * allowance and a page where AI is off are unchanged (controls).
 */
import { aiOnValue } from "@/lib/ai-on-value";
import { allowanceOf } from "@/components/ai-assist";
import { done, is } from "./check";

is("an unread allowance is said to be unknown, never 0 left", aiOnValue(true, null), { on: true, left: 0, known: false });
is("and AiOn's readers read it as unknown", allowanceOf(aiOnValue(true, null)), null);
is("a known count is that count", aiOnValue(true, 9), { on: true, left: 9 });
is("a spent allowance is still 0 left", allowanceOf(aiOnValue(true, 0)), 0);
is("AI off: off, whatever was read", aiOnValue(false, null), { on: false, left: 0 });

done();
