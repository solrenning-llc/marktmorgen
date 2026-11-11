/**
 * 95 [D2-DEMAND-RADAR], review of #3731 (MR): what the two new lists of "What
 * customers are saying" read on each click is paid for before it is read.
 *
 * A click reads, on top of what the summary already read, one SMEMBERS of the
 * products coming soon, a HLEN for each of up to WAITLIST_VOICE_PRODUCTS of
 * them, and one LRANGE of up to ASSISTANT_MISSED_KEPT of the assistant's
 * unanswered questions. The route takes VOICE_EXTRA_STUDIO_UNITS more of the
 * store's studio requests first, each priced in tests/plan-cost-registry.ts
 * at twenty commands and fifty kilobytes (UNIT_COST.studio), and refuses with
 * nothing read when they cannot be taken.
 */
import { readFileSync } from "node:fs";
import { VOICE_EXTRA_STUDIO_UNITS } from "@/lib/customer-voice";
import { WAITLIST_VOICE_PRODUCTS } from "@/lib/waitlist";
import { ASSISTANT_MISSED_KEPT, MAX_ASSISTANT_QUESTION } from "@/lib/store-assistant-rules";
import { done, is } from "./check";

const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
const route = readFileSync("app/api/store/voice/route.ts", "utf8");

is("a studio unit is priced at twenty commands and fifty kilobytes", /studio: request\("studio", 20 \+ TAKE_COMMANDS \+ LOCKED_UNTIL_STAR_COMMANDS, 50_000\)/.test(registry), true);
is("the extra units cover every command the new lists read", VOICE_EXTRA_STUDIO_UNITS * 20 >= 1 + WAITLIST_VOICE_PRODUCTS + 1, true);
// Each kept question at its longest, written as a row with its time and quoting, at most a kilobyte.
is("and every byte", VOICE_EXTRA_STUDIO_UNITS * 50_000 >= ASSISTANT_MISSED_KEPT * Math.max(1_024, MAX_ASSISTANT_QUESTION * 2), true);
is("the route takes them before the summary reads anything", /countStudio\(store, "stats", VOICE_EXTRA_STUDIO_UNITS\)[\s\S]*makeVoice\(/.test(route), true);
is("and refuses with nothing read when they are not there", /if \(!extra\.ok\) return Response\.json/.test(route), true);

done();
