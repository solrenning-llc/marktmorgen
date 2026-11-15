/**
 * 488 [IT5] unit 1: the rules and the cost of a store preview before an account (docs/it5-store-preview.md). Pure:
 * the switch, the caps and the worst cost of one preview, computed from the repository's own tables, never typed.
 * The month's ceiling takes the source of its places as an argument, so it serves either way the owner chooses to fund
 * it ((A) a count of its own grown by the paying stores, (B) inside the free places) and chooses neither. The function
 * time of the preview's route is priced from the duration that route must declare; until that route exists with that
 * declaration the cost is not priced, so the worst is unknown and the switch must stay off.
 */
import { existsSync, readFileSync } from "node:fs";
import { WRITING_JOB_MICRO_USD, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS, VERCEL_CALL_MICRO_USD_PER_MILLION, VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR } from "@/lib/spend-cost-table";
import { freePoolSize } from "@/lib/free-pool-rules";
import * as rules from "@/lib/store-preview-rules";
import { nonPayingWorst } from "./plan-cost-registry";
import { done, is, part } from "./check";

const {
  STORE_PREVIEW_ON, PREVIEW_JOBS, PREVIEWS_PER_ADDRESS_PER_DAY, PREVIEW_DB_COMMANDS, PREVIEW_ROUTE, PREVIEW_ROUTE_SECONDS,
  previewFunctionMicroUsd, previewWorstMicroUsd, previewsPerFreePlace, previewMonthCeiling, previewDayCeiling, routePricedIn,
} = rules;

part("The switch and the caps");
is("off", STORE_PREVIEW_ON, false);
is("written false in the source, never computed", /export const STORE_PREVIEW_ON: boolean = false;/.test(readFileSync("lib/store-preview-rules.ts", "utf8")), true);
is("two writing jobs at most: the draft and one answers round, never a third", PREVIEW_JOBS, 2);
is("two previews per address per day", PREVIEWS_PER_ADDRESS_PER_DAY, 2);

part("The function time, from the duration the route must declare");
const seconds = PREVIEW_ROUTE_SECONDS;
const perCall = Math.ceil((seconds / 3600) * VERCEL_CPU_MICRO_USD_PER_HOUR + VERCEL_FUNCTION_GB * (seconds / 3600) * VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR + VERCEL_CALL_MICRO_USD_PER_MILLION / 1_000_000);
is("each job's call: every second of maxDuration at full CPU and 2 GB, plus the call", previewFunctionMicroUsd(), PREVIEW_JOBS * perCall);
// Read here, not in the pure module: priced only once the route exists and declares that duration.
const priced = existsSync(PREVIEW_ROUTE) && routePricedIn(readFileSync(PREVIEW_ROUTE, "utf8"));
is("the route is not built yet, so the function time is not priced", priced, false);
is("a route that declares another duration is not priced", routePricedIn("export const maxDuration = 300;"), false);
is("nor one that declares none", routePricedIn("export async function POST() {}"), false);
is("control: the declared duration prices it", routePricedIn(`export const maxDuration = ${seconds};`), true);

part("The worst of one preview: unknown until every part is priced");
is("not priced: unknown, never a partial sum", previewWorstMicroUsd(false), null);
const db = Math.ceil((PREVIEW_DB_COMMANDS * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1_000_000);
is("priced: the jobs, their function time and the database", previewWorstMicroUsd(true), PREVIEW_JOBS * WRITING_JOB_MICRO_USD + PREVIEW_JOBS * perCall + db);
is("unknown worst while unpriced means the switch is off", priced || STORE_PREVIEW_ON === false, true);

part("The month's ceiling takes the source of its places, and chooses neither");
const worst = previewWorstMicroUsd(true)!;
const nonPaying = Math.round(nonPayingWorst() * 1_000_000);
is("(B) one free place makes floor(a free store's worst / a preview's worst) previews", previewsPerFreePlace(nonPaying, worst), Math.floor(nonPaying / worst));
is("(B) an unknown preview worst makes none", previewsPerFreePlace(nonPaying, null), 0);
is("(A) its own count: the base and a share per paying store", previewMonthCeiling({ kind: "own", base: 100, perPaying: 1 }, 41), 141);
is("(A) a fraction per store rounds down", previewMonthCeiling({ kind: "own", base: 0, perPaying: 0.5 }, 41), 20);
is("(B) the free places times the previews per place", previewMonthCeiling({ kind: "free-places", perPlace: 40 }, 41), freePoolSize(41) * 40);
for (const [what, source, paying] of [
  ["a negative base", { kind: "own", base: -1, perPaying: 1 }, 10],
  ["a share that is not a number", { kind: "own", base: 1, perPaying: Number.NaN }, 10],
  ["a negative count of paying stores", { kind: "own", base: 1, perPaying: 1 }, -5],
  ["a kind it does not know", { kind: "other" }, 10],
  ["places per preview that are not whole", { kind: "free-places", perPlace: 1.5 }, 10],
] as const) is(`fails closed on ${what}: no previews`, previewMonthCeiling(source as never, paying), 0);

part("The day's ceiling: a day cannot spend the month");
is("twice a thirtieth of the month, rounded up", previewDayCeiling(141), Math.ceil((141 * 2) / 30));
is("never more than the month", previewDayCeiling(3), 1);
is("none from none", previewDayCeiling(0), 0);

part("Pure and browser-safe");
const source = readFileSync("lib/store-preview-rules.ts", "utf8");
is("imports only the supplier rates and the free places' rules", [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort(), ["@/lib/free-pool-rules", "@/lib/spend-cost-table"]);
is("no network, environment or database", /process\.env|fetch\(|redisPipeline|node:/.test(source), false);
done();
