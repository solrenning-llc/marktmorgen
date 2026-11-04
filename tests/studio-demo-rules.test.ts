/**
 * 256 [KJ1], unit 1: the studio demo's rules. Every cap holds at its exact
 * boundary, every capability is classified and the closed list is refused,
 * a demo key never leaves its namespace or its families, every example AI
 * answer carries its label, the demo stays off while a cost is unknown, and
 * docs/studio-demo.md states the worst day this file works out and how many
 * addresses it takes to close the demo for everyone.
 */
import { readFileSync } from "node:fs";
import {
  DEMO_ACTIONS_PER_SESSION, DEMO_ACTION_FUNCTION_MICRO_USD, DEMO_ACTION_MAX_BYTES, DEMO_AI_EXAMPLES, DEMO_AI_LABEL, DEMO_BYTES_PER_SESSION,
  DEMO_CAPABILITIES, DEMO_COMMANDS_PER_ACTION, DEMO_COMMANDS_PER_DAY, DEMO_COOKIE, DEMO_KEY_FAMILIES, DEMO_NAMESPACE, DEMO_OFF_WORDS,
  DEMO_RESPONSE_MAX_BYTES, DEMO_SESSIONS_PER_ADDRESS_PER_DAY, DEMO_SESSIONS_PER_DAY, DEMO_SESSION_SECONDS, DEMO_SESSION_WORST_COMMANDS, DEMO_SIGN_UP, DEMO_START_COMMANDS,
  DEMO_UNKNOWN_COSTS, STUDIO_DEMO_ON, demoActionAllowed, demoAiExample, demoDayFunctionWorstMicroUsd, demoDayKey, demoDayWorstActions,
  demoForbids, demoSessionAllowed, isDemoSessionId, sandboxKey, type DemoAiExampleKind, type DemoCapability,
} from "@/lib/studio-demo-rules";
import * as rules from "@/lib/studio-demo-rules";
import { SESSION_COOKIE } from "@/lib/auth";
import { STORE_COOKIE } from "@/lib/studio-route";
import { CDN_PER_REQUEST } from "./traffic-cost";
import { done, is, part } from "./check";

const ON = true;
const SID = "sd" + "0123456789abcdef".repeat(2);
const verdict = (v: { ok: boolean; reason?: string }) => (v.ok ? "ok" : v.reason);

part("Off, and off while any cost is unknown");
is("STUDIO_DEMO_ON is false", STUDIO_DEMO_ON, false);
is("an unknown cost is listed, so it could not be on", DEMO_UNKNOWN_COSTS.length > 0, true);
// The two conditions docs/studio-demo.md sets besides the costs: the privacy policy says what the demo keeps, and the exposure has its reviewed line.
const privacy = readFileSync("app/privacy/page.tsx", "utf8");
const funded = readFileSync("docs/funded-exposure-review.md", "utf8");
const privacyNamesDemo = privacy.includes("nl_studio_demo") && /fingerprint/i.test(privacy.slice(Math.max(0, privacy.indexOf("nl_studio_demo") - 600), privacy.indexOf("nl_studio_demo") + 600));
const fundedHasDemo = funded.includes("256 [KJ1]") && /studio demo/i.test(funded);
is("on only when no cost is unknown, the privacy policy names the demo's cookie and the address's daily fingerprint, and docs/funded-exposure-review.md has the demo's line", !STUDIO_DEMO_ON || (DEMO_UNKNOWN_COSTS.length === 0 && privacyNamesDemo && fundedHasDemo), true);
is("off: no session opens, whatever the counts", verdict(demoSessionAllowed({ today: "2026-11-04", sessionsToday: 0, commandsToday: 0 })), "off");
is("off: no action runs", verdict(demoActionAllowed({ actions: 0, bytes: 0, startedAt: 0, now: 1, commandsToday: 0 }, { commands: 1, bytes: 1 })), "off");

part("Opening a session: the day's caps at their edges");
const open = (sessionsToday: number, commandsToday: number, today = "2026-11-04") => verdict(demoSessionAllowed({ today, sessionsToday, commandsToday }, ON));
is("the last session of the day opens", open(DEMO_SESSIONS_PER_DAY - 1, 0), "ok");
is("one past the day's sessions is refused", open(DEMO_SESSIONS_PER_DAY, 0), "sessions");
is("room for exactly a whole session's worst: opens", open(0, DEMO_COMMANDS_PER_DAY - DEMO_SESSION_WORST_COMMANDS), "ok");
is("one command short of it: refused", open(0, DEMO_COMMANDS_PER_DAY - DEMO_SESSION_WORST_COMMANDS + 1), "commands");
is("a session's worst is its start and every action at its most", DEMO_SESSION_WORST_COMMANDS, DEMO_START_COMMANDS + DEMO_ACTIONS_PER_SESSION * DEMO_COMMANDS_PER_ACTION);
is("an unknown count refuses, never reads as zero", [open(Number.NaN, 0), open(0, -1), open(1.5, 0), open(0, 0, "today"), open(0, 0, "2026-13-01")], ["unknown", "unknown", "unknown", "unknown", "unknown"]);

part("One action: the session's and the day's caps at their edges");
const start = Date.UTC(2026, 10, 4, 12);
const base = { actions: 0, bytes: 0, startedAt: start, now: start, commandsToday: 0 };
const act = (s: Partial<typeof base>, cost = { commands: DEMO_COMMANDS_PER_ACTION, bytes: DEMO_ACTION_MAX_BYTES }) => verdict(demoActionAllowed({ ...base, ...s }, cost, ON));
is("the first action runs", act({}), "ok");
is("the last allowed action runs", act({ actions: DEMO_ACTIONS_PER_SESSION - 1 }), "ok");
is("one past the session's actions is refused", act({ actions: DEMO_ACTIONS_PER_SESSION }), "actions");
is("filling the session's bytes exactly runs", act({ bytes: DEMO_BYTES_PER_SESSION - DEMO_ACTION_MAX_BYTES }), "ok");
is("one byte past them is refused", act({ bytes: DEMO_BYTES_PER_SESSION - DEMO_ACTION_MAX_BYTES + 1 }), "bytes");
is("the last millisecond of its life runs", act({ now: start + DEMO_SESSION_SECONDS * 1000 - 1 }), "ok");
is("at the end of its life it is over", act({ now: start + DEMO_SESSION_SECONDS * 1000 }), "expired");
is("filling the day's commands exactly runs", act({ commandsToday: DEMO_COMMANDS_PER_DAY - DEMO_COMMANDS_PER_ACTION }), "ok");
is("one command past the day's is refused", act({ commandsToday: DEMO_COMMANDS_PER_DAY - DEMO_COMMANDS_PER_ACTION + 1 }), "commands");
is("an action dearer than the worst costed is refused", [act({}, { commands: DEMO_COMMANDS_PER_ACTION + 1, bytes: 0 }), act({}, { commands: 1, bytes: DEMO_ACTION_MAX_BYTES + 1 })], ["too_big", "too_big"]);
is("unknown or impossible readings refuse", [act({ now: start - 1 }), act({ actions: -1 }), act({ bytes: Number.POSITIVE_INFINITY }), act({}, { commands: Number.NaN, bytes: 0 })], ["unknown", "unknown", "unknown", "unknown"]);

part("What a demo may reach");
const forbidden: DemoCapability[] = ["email", "ai", "payments", "uploads", "webhooks", "apiKeys", "team", "export", "publish", "domains", "import"];
const allowed: DemoCapability[] = ["draftProduct", "draftPage", "draftOffer", "draftSubscription", "draftEmail", "aiExample", "preview"];
is("every capability is classified, and only these", Object.keys(DEMO_CAPABILITIES).sort(), [...forbidden, ...allowed].sort());
is("the closed list is refused, each one", forbidden.map(demoForbids), forbidden.map(() => true));
is("the drafts, the examples and the preview stay in the sandbox", allowed.map(demoForbids), allowed.map(() => false));
is("a name nobody classified is refused", ["billing", "toString", "__proto__", ""].map(demoForbids), [true, true, true, true]);

part("Keys: one namespace, one session, allowed families only");
is("a draft's key", sandboxKey(SID, "product:p1"), `nl:sdemo:{${SID}}:product:p1`);
is("a family with no part", sandboxKey(SID, "steps"), `nl:sdemo:{${SID}}:steps`);
is("every family stays under the namespace", DEMO_KEY_FAMILIES.map((f) => sandboxKey(SID, f)?.startsWith(`${DEMO_NAMESPACE}{${SID}}:`)), DEMO_KEY_FAMILIES.map(() => true));
is("other families are refused", ["store", "mail", "ai-spend", "auth", "rl", "Product", "products"].map((k) => sandboxKey(SID, k)), [null, null, null, null, null, null, null]);
is("a part that could escape is refused", ["product:a:b", "product:{x}", "product: x", "product:", "product:../x", `product:${"a".repeat(41)}`, "nl:store:x"].map((k) => sandboxKey(SID, k)), [null, null, null, null, null, null, null]);
is("a store id or any other id is never a demo session", ["0123456789abcdef0123456789abcdef", "SD" + "a".repeat(32), "sd" + "a".repeat(31), `${SID}x`].map((id) => [isDemoSessionId(id), sandboxKey(id, "steps")]), [[false, null], [false, null], [false, null], [false, null]]);
is("a demo session id is never the shape of a store id", /^[0-9a-f]{32}$/.test(SID), false);
is("the day's counts have their own key", [demoDayKey("2026-11-04"), demoDayKey("2026-11-4"), demoDayKey("x")], ["nl:sdemo:day:2026-11-04", null, null]);
is("the demo's cookie is neither the sign-in's nor the store switcher's", [SESSION_COOKIE, STORE_COOKIE].includes(DEMO_COOKIE), false);

part("The words");
const kinds = Object.keys(DEMO_AI_EXAMPLES) as DemoAiExampleKind[];
is("the label says it is an example and no AI is called", DEMO_AI_LABEL, "Example answer — the demo does not call the AI");
is("every example comes with the label", kinds.map((k) => demoAiExample(k).label), kinds.map(() => DEMO_AI_LABEL));
is("no example states a figure, a deal or urgency", kinds.filter((k) => /\d|%|\$|free|now|today|only|limited|hurry|best|guarantee/i.test(DEMO_AI_EXAMPLES[k])), []);
const seed = readFileSync("lib/demo-seed.ts", "utf8");
is("the products the examples name are the demo store's own", ["Weekly Meal Planner", "Grocery List Pack", "Harbor Kitchen"].map((n) => seed.includes(`"${n}"`)), [true, true, true]);
is("the turned-off buttons say why and what they do in a real studio", [/off in the demo/.test(DEMO_OFF_WORDS.send), /off in the demo/.test(DEMO_OFF_WORDS.publish), /your own studio/.test(DEMO_OFF_WORDS.send + DEMO_OFF_WORDS.publish)], [true, true, true]);
is("the end leads to sign-up", DEMO_SIGN_UP.href, "/signin?from=demo");

part("The worst day, as docs/studio-demo.md states it");
// Read by name, so a rule that is missing fails here rather than stopping the build.
const R = rules as unknown as Record<string, unknown>;
const num = (name: string) => (typeof R[name] === "number" ? (R[name] as number) : Number.NaN);
const call = (name: string) => (typeof R[name] === "function" ? (R[name] as () => number)() : Number.NaN);
const reachable = call("demoDayReachableSessions");
is("the sessions a day can reach: each opening reserves its whole worst", reachable, Math.min(DEMO_SESSIONS_PER_DAY, Math.floor(DEMO_COMMANDS_PER_DAY / DEMO_SESSION_WORST_COMMANDS)));
is("the day's commands bind before its sessions do", reachable < DEMO_SESSIONS_PER_DAY, true);
const actions = demoDayWorstActions();
is("every reachable session at every action", actions, reachable * DEMO_ACTIONS_PER_SESSION);
// The CDN's part, from tests/traffic-cost.ts: a request at the CDN, and the bytes a function sends it ($0.06 a GB, Fast Origin Transfer).
const ORIGIN_MICRO_USD_PER_BYTE = (0.06 / 1e9) * 1e6;
const cdnPerAnswer = CDN_PER_REQUEST * 1e6 + DEMO_RESPONSE_MAX_BYTES * ORIGIN_MICRO_USD_PER_BYTE;
const refusals = num("DEMO_REFUSALS_PER_DAY");
const perOpening = num("DEMO_START_FUNCTION_MICRO_USD") + num("DEMO_SESSION_KEPT_MICRO_USD") + cdnPerAnswer;
const perAction = DEMO_ACTION_FUNCTION_MICRO_USD + cdnPerAnswer;
const perRefusal = num("DEMO_REFUSAL_FUNCTION_MICRO_USD") + cdnPerAnswer;
const sessionRefusals = call("demoDaySessionRefusals");
is("each reachable session counts its own refusals, at most", sessionRefusals, reachable * num("DEMO_REFUSALS_PER_SESSION"));
const cohortMicroUsd = call("demoCohortFunctionWorstMicroUsd") + (reachable + actions + sessionRefusals) * cdnPerAnswer;
const refusalsMicroUsd = call("demoRefusalsFunctionWorstMicroUsd") + refusals * cdnPerAnswer;
const keptDay = num("DEMO_DAY_HASHES_KEPT_MICRO_USD");
is("the day's own hashes kept are priced, never zero", keptDay > 0, true);
const dayMicroUsd = cohortMicroUsd + refusalsMicroUsd + keptDay;
is("the day's function worst is one day's openings, its refusals and its own hashes kept", demoDayFunctionWorstMicroUsd(), call("demoCohortFunctionWorstMicroUsd") + call("demoRefusalsFunctionWorstMicroUsd") + keptDay);
// Every pair a day can hold, by brute force: s sessions open only while s whole worsts fit, each takes up to its actions and counts up to its own refusals.
let best = 0;
for (let s = 0; s <= DEMO_SESSIONS_PER_DAY; s += 1) {
  if (s * DEMO_SESSION_WORST_COMMANDS > DEMO_COMMANDS_PER_DAY) break;
  for (let a = 0; a <= s * DEMO_ACTIONS_PER_SESSION; a += 1) {
    for (const r of [0, refusals]) best = Math.max(best, s * (perOpening + num("DEMO_REFUSALS_PER_SESSION") * perRefusal) + a * perAction + r * perRefusal + keptDay);
  }
}
is("the day's ceiling is the most of every pair the caps allow", Math.abs(dayMicroUsd - best) < 1e-6, true);
const dollars = (micro: number) => `$${(micro / 1e6).toFixed(2)}`;
// A session lives past midnight, so thirty days can hold the actions of thirty-one days of openings.
const thirtyMicroUsd = 31 * cohortMicroUsd + 30 * (refusalsMicroUsd + keptDay);
is(`the doc states what a day's own hashes cost kept (${keptDay.toFixed(2)} µ$)`, readFileSync("docs/studio-demo.md", "utf8").includes(`| ${keptDay.toFixed(2)} µ$ |`), true);
const doc = readFileSync("docs/studio-demo.md", "utf8");
is("an action at its worst, in micro-USD", Math.round(perAction * 100) / 100, 51.77);
is(`the doc states the day's known worst (${dollars(dayMicroUsd)})`, doc.includes(`${dollars(dayMicroUsd)} a day`), true);
is(`the doc states thirty days (${dollars(thirtyMicroUsd)})`, doc.includes(`${dollars(thirtyMicroUsd)} in thirty days`), true);
is(`the doc states the sessions' own refused actions (${sessionRefusals})`, doc.includes(`sessions' own ${sessionRefusals.toLocaleString("en-US")} refused actions`), true);
is(`the doc states the reachable sessions and actions (${reachable}, ${actions})`, doc.includes(`${reachable} openings and ${actions.toLocaleString("en-US")} actions`), true);
is("the doc says the demo stays off while a cost is unknown", /unknown/i.test(doc) && /STUDIO_DEMO_ON/.test(doc), true);

part("Its life, refusals and addresses");
is("a session lives longer than twenty hours (WCAG 2.2.1, its twenty-hour exception)", DEMO_SESSION_SECONDS > 20 * 3600, true);
const kept = num("DEMO_SESSION_KEPT_MICRO_USD");
const atEveryCap = perOpening + DEMO_ACTIONS_PER_SESSION * perAction + num("DEMO_REFUSALS_PER_SESSION") * perRefusal;
is(`the doc states a session at every cap (${Math.round(atEveryCap)} µ$)`, doc.includes(`**${Math.round(atEveryCap).toLocaleString("en-US")} µ$ ($${(atEveryCap / 1e6).toFixed(4)})**`), true);
is(`the doc states what a session's bytes cost for its whole life (${kept.toFixed(2)} µ$)`, doc.includes(`${kept.toFixed(2)} µ$`), true);
is("a refusal's commands are bounded and its day's refusals capped", [Number.isSafeInteger(num("DEMO_REFUSAL_WORST_COMMANDS")) && num("DEMO_REFUSAL_WORST_COMMANDS") > 0, Number.isSafeInteger(refusals) && refusals > 0], [true, true]);
is("no text says refusals are bounded per address", DEMO_UNKNOWN_COSTS.some((t) => /bounded per address/.test(t)), false);
const addresses = Math.ceil(reachable / DEMO_SESSIONS_PER_ADDRESS_PER_DAY);
is(`the doc states how many addresses or networks can take the day (${addresses})`, doc.includes(`${addresses} addresses`), true);
const perAddress = num("DEMO_REFUSALS_PER_ADDRESS_PER_DAY");
is("one address counts only a small share of the day's refusals", Number.isSafeInteger(perAddress) && perAddress > 0 && perAddress * 100 <= refusals, true);
const closers = Math.ceil(refusals / perAddress);
is(`the doc states how many addresses or networks it takes to close the day for everyone (${closers})`, doc.includes(`${closers} addresses or networks, each spending its ${perAddress}`), true);
is(`the doc states a counted refusal at its worst (${perRefusal.toFixed(2)} µ$, ${num("DEMO_REFUSAL_WORST_COMMANDS")} commands)`, doc.includes(`${num("DEMO_REFUSAL_WORST_COMMANDS")} commands, 2 KB through the database, CDN | ${perRefusal.toFixed(2)} µ$`), true);

done();
