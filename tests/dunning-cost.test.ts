/**
 * The dunning job's cost line (tests/plan-cost-registry.ts, line "dunning"; lib/payment-recovery.ts): until
 * 16 November 2026 the daily job that writes about failed renewals and cards about to stop working had no line, only
 * its emails (EMAIL_SITES), so its database commands, its bytes and its Stripe waits were in no plan's worst month.
 *
 * What fails here:
 *   - the job no longer daily, or another schedule than the line's DUNNING_RUNS_PER_MONTH assumes;
 *   - a call to the database or to Stripe added to, or taken from, lib/payment-recovery.ts or the parts of
 *     lib/card-update.ts it runs, without the line's count changed with it (count it, then change the numbers here);
 *   - the line missing, not on every plan, or not built from the job's own caps.
 */
import { readFileSync } from "node:fs";
import { CARD_LOOKUPS, CARD_NOTICES_PER_RUN, CARD_PAGES, FAILED_PAGES, PER_STORE } from "@/lib/payment-recovery";
import {
  COMMAND, COST_LINES, DB_BYTE, DUNNING_RUNS_PER_MONTH, DUNNING_STORE_BYTES, DUNNING_STORE_COMMANDS, DUNNING_STORE_MONTH,
  DUNNING_STORE_RUN, DUNNING_STRIPE_CALLS, DUNNING_STRIPE_PAGES, READ_LISTING_BYTES, STRIPE_LIST_PAGE,
} from "./plan-cost-registry";
import { MAX_STORE_BYTES } from "@/lib/store";
import { done, is, part } from "./check";

const count = (text: string, call: string) => (text.match(new RegExp("\\b" + call + "\\(", "g")) ?? []).length;
const bodyOf = (text: string, head: string) => {
  const at = text.indexOf(head);
  if (at < 0) return "";
  const next = text.slice(at + head.length).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? text.slice(at) : text.slice(at, at + head.length + next);
};

part("Once a day, as the line counts it");
const crons = (JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: { path: string; schedule: string }[] }).crons ?? [];
const plans = crons.filter((c) => c.path === "/api/cron/plans");
is("the plans job runs once, at a fixed minute and hour of every day", plans.map((c) => /^\d{1,2} \d{1,2} \* \* \*$/.test(c.schedule)), [true]);
is("so a 31-day month has 31 runs", DUNNING_RUNS_PER_MONTH, 31);
const cron = readFileSync("app/api/cron/plans/route.ts", "utf8");
is("and the plans job runs the dunning job once a run", count(cron, "recoverFailedPayments"), 1);

part("Every call to the database or to Stripe is one the line counts");
const job = readFileSync("lib/payment-recovery.ts", "utf8");
// Counted in DUNNING_STORE_COMMANDS and DUNNING_STRIPE_* (tests/plan-cost-registry.ts): change both together.
const calls = ["redisPipeline", "onAccount", "claimMark", "releaseMark", "countSent", "readListings", "cardLink", "finishCardUpdate", "storesAfter", "sendEmail"];
is("lib/payment-recovery.ts calls, as counted", Object.fromEntries(calls.map((c) => [c, count(job, c)])),
  { redisPipeline: 7, onAccount: 4, claimMark: 2, releaseMark: 4, countSent: 2, readListings: 2, cardLink: 1, finishCardUpdate: 1, storesAfter: 1, sendEmail: 2 });
const card = readFileSync("lib/card-update.ts", "utf8");
const finish = bodyOf(card, "export async function finishCardUpdate");
const subFor = bodyOf(card, "async function subFor");
is("a finished card page: its Stripe calls (session, card set, failed payment paid) and its two database calls (GET, EVAL)", [count(finish, "onAccount"), count(finish, "redisPipeline")], [3, 2]);
is("and the membership it reads (subFor), one Stripe call", [count(subFor, "onAccount"), count(subFor, "redisPipeline")], [1, 0]);
is("a card link, one database command", count(bodyOf(card, "export async function cardLink"), "redisPipeline"), 1);

part("The line");
const line = COST_LINES.find((l) => l.id === "dunning");
is("there is a line for it", Boolean(line), true);
is("the same on every plan, the worst store's", (["creator", "pro", "scale"] as const).map((t) => line?.monthlyUsd(t)), [DUNNING_STORE_MONTH, DUNNING_STORE_MONTH, DUNNING_STORE_MONTH]);
is("a month is its runs", DUNNING_STORE_MONTH, DUNNING_RUNS_PER_MONTH * DUNNING_STORE_RUN);
is("a run is at least its commands, bytes and list pages, and more for the calls waited on", DUNNING_STORE_RUN > DUNNING_STORE_COMMANDS * COMMAND + DUNNING_STORE_BYTES * DB_BYTE + DUNNING_STRIPE_PAGES * STRIPE_LIST_PAGE, true);
const read = FAILED_PAGES * PER_STORE;
const cards = CARD_PAGES * 100;
is("its counts come from the job's own caps", [DUNNING_STRIPE_PAGES, DUNNING_STRIPE_CALLS, DUNNING_STORE_BYTES], [FAILED_PAGES + CARD_PAGES, PER_STORE + CARD_LOOKUPS + (CARD_NOTICES_PER_RUN + 1) * 4, MAX_STORE_BYTES + (read + cards) * READ_LISTING_BYTES]);
is("never zero", DUNNING_STORE_MONTH > 0, true);
console.log("  (worst month a store: $" + DUNNING_STORE_MONTH.toFixed(4) + "; a run: " + DUNNING_STORE_COMMANDS + " commands, " + DUNNING_STRIPE_PAGES + " pages, " + DUNNING_STRIPE_CALLS + " calls)");
done();
