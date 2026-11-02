/**
 * More refusals said as they are (534 [FQ1], unit 34; added 2 November
 * 2026). An API write refused by the store's figure says the store's own
 * words (the same as a read), under "monthly_limit", "no_place" or
 * "unavailable" by its reason, and the docs say so; the pool's words offer a
 * paid plan only while one can be bought; the help center and the studio
 * offer a larger plan only where one is sold, never say "this month" to a
 * trial, and promise only what always works; a person's erasure refused for
 * no place shows why; studio messages no longer say "Your plan's … for this
 * month … or on a larger plan".
 */
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { POOL_FULL_WORDS, poolFullWords } from "@/lib/free-pool-rules";
import { WRITE_ERRORS, refusedFigure } from "@/lib/api-write";
import { takeAllowance } from "@/lib/store-allowance";
import { NON_PAYING_ALLOWANCES } from "@/lib/store-allowance-rules";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const DAY = 86_400_000;

async function main() {
  part("The API's writes, by the figure's own reason");
  redis.clear();
  const now = Date.now();
  const trial = { sid: "w".repeat(32), handle: "writetrial", statsId: "stats_write", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_Write0001", trialEnds: (now + 5 * DAY) / 1000, planEndedAt: "", cycle: "month" as const };
  await takeAllowance(trial as never, "api", NON_PAYING_ALLOWANCES.trial.api, now);
  const used = await takeAllowance(trial as never, "api", 1, now);
  const said = used.ok ? null : refusedFigure(used);
  is("a trial's API figure used: monthly_limit with the store's own words, for this trial, and what comes after", [said?.ok === false && said.error, said?.ok === false && said.message?.includes("for this trial are used"), said?.ok === false && said.message?.includes("after that, these need a paid plan")], ["monthly_limit", true, true]);
  is("no place: no_place with the pool's words; not counted: unavailable", [JSON.stringify(refusedFigure({ reason: "pool", message: POOL_FULL_WORDS })), JSON.stringify(refusedFigure({ reason: "unknown", message: "x" }))], [JSON.stringify({ ok: false, error: "no_place", message: POOL_FULL_WORDS }), JSON.stringify({ ok: false, error: "unavailable" })]);
  is("the fixed words are only a fallback, with no time claimed", [WRITE_ERRORS.monthly_limit[0], /month|trial|larger plan|opens again/.test(WRITE_ERRORS.monthly_limit[1]), WRITE_ERRORS.no_place[0]], [429, false, 429]);
  is("every write route says the store's own words first", ["app/api/v1/access/route.ts", "app/api/v1/leads/route.ts", "app/api/v1/leads/labels/route.ts"].every((f) => read(f).includes("done.message ?? WRITE_ERRORS[done.error][1]")), true);
  is("a read refused for no place says no_place too", read("lib/api-guard.ts").includes('taken.reason === "pool" ? "no_place" : "unavailable"'), true);
  const docs = flat(read("app/developers/page.tsx"));
  is("the docs: the trial's figure, its message says when, no_place listed, no larger plan promised", [docs.includes("A free trial has ${NON_PAYING_ALLOWANCES.trial.api.toLocaleString(\"en-US\")} for the whole trial"), docs.includes("its message says when the figure opens again, if it does"), docs.includes('{"error": "no_place"'), docs.includes("or at once on a larger plan")], [true, true, true, false]);

  part("The pool's words");
  is("a paid plan offered only while one can be bought", [poolFullWords(false), poolFullWords(true).endsWith("A paid plan opens it at once."), POOL_FULL_WORDS.includes("as soon as your plan is paid")], [POOL_FULL_WORDS, true, false]);
  is("everyone who says it passes the sale state", [read("lib/store-allowance.ts").includes('refuse("pool", poolFullWords(PLANS_ON_SALE))'), read("lib/store-allowance.ts").includes('if (code === "allowance-pool") return poolFullWords(PLANS_ON_SALE);'), read("app/studio/paused/page.tsx").includes("? poolFullWords(PLANS_ON_SALE)")], [true, true, true]);

  part("The help center and the studio");
  const help = read("lib/help-content.ts");
  is("help: a larger plan only where sold, figures that need a plan after a trial, a plan paid only while plans are sold, only what always works", [help.includes("(or, where a larger plan is on sale, until it moves to one)"), help.includes("after it, some figures, such as API requests and webhooks, need a paid plan"), help.includes('${PLANS_ON_SALE ? " or until its plan is paid" : ""}'), help.includes("Changing your plan, canceling it"), help.includes("Canceling your plan, deleting your store and downloading your sales always work.")], [true, true, true, false, true]);
  const studio = flat(read("app/studio/page.tsx"));
  is("studio: a larger plan only where one can be had; the trial's visits for the trial; only what always works", [studio.includes('const largerOnSale = PLANS_ON_SALE && (tier === "creator" ? PRO_ON_SALE : tier === "pro");'), (studio.match(/largerOnSale \? ", or on a larger plan" : ""/g) ?? []).length, /next billing month, or on a larger plan"/.test(studio), (studio.match(/counted visits \$\{standing === "trial" \? "for the trial" : "this month"\}/g) ?? []).length, studio.includes('${PLANS_ON_SALE ? "Changing or canceling your plan" : "Canceling your plan"}')], [true, 3, false, 2, true]);

  part("Studio messages");
  const msgs = [read("components/import-tool.tsx"), read("components/clickfunnels-funnel.tsx"), read("app/api/store/import/route.ts"), read("components/person-erase.tsx"), read("components/deals-board.tsx")].join("\n");
  is("none says \"Your plan's … for this month\" or \"or on a larger plan\"", [/Your plan's [^"]*for this month/.test(msgs), /or on a larger plan/.test(msgs)], [false, false]);
  is("a person's erasure refused for no place shows the store's words", [read("app/api/store/person/route.ts").includes('const said = "message" in result && typeof result.message === "string" ? { message: result.message } : {};'), read("components/person-erase.tsx").includes('(answer.error === "limited" || answer.error === "unavailable") && answer.message')], [true, true]);
  is("a deal's workflow not started is not blamed on the month", read("components/deals-board.tsx").includes("The workflow for this stage was not started for this person."), true);

  done();
}

void main();
