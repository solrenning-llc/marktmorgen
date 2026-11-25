/**
 * The invite-credit job's Stripe reads have a cost line (Claude 7's money review of #4514, MÉDIO; rule MR/FX275: an
 * unknown cost is never zero).
 *
 * The daily job (lib/creator-invite-credit.ts settleInvites, from app/api/cron/plans) reads every invited store's paid
 * invoices, the refunds and disputes of each payment, a credit's invoice again before it is sent, and the balance
 * history it is sent to. No line of tests/plan-cost-registry.ts priced any of those reads. This file holds that one
 * line does, naming the reads and the bound it is priced by (the cron's maxDuration, once a day), and that its figure
 * is that bound at the registry's own function-memory rate, for every plan.
 */
import { readFileSync } from "node:fs";
import { CLAWBACK_RECORD_BYTES, COMMAND, COST_LINES, DB_BYTE, DB_BYTE_MONTH, INVITE_CLAWBACK_MONTH_USD, INVITE_CLAWBACK_RUNS_PER_MONTH, INVITE_CREDIT_JOB, INVITE_JOB_LIST_BYTES, INVITE_JOB_MONTH_USD, INVITE_JOB_RUNS_PER_MONTH, NOT_A_COST, STRIPE_WAIT_SECONDS } from "./plan-cost-registry";
import { INVITE_RUN_COMMANDS } from "@/lib/creator-invite-credit";
import { CLAWBACKS_PER_RUN, CLAWBACK_COMMANDS, CLAWBACK_STRIPE_CALLS } from "@/lib/creator-invite-clawback";
import { VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR } from "@/lib/spend-cost-table";
import { done, is, part } from "./check";

part("The invite-credit job is priced whole as a company fixed cost (the owner's decision of 18 November 2026 on #4514)");
const line = INVITE_CREDIT_JOB;
is("not a line of each plan: one job for every store together", COST_LINES.some((l) => l.id === "invite-credit-reads"), false);
is("named in NOT_A_COST as a company fixed cost, with its figure", /company fixed cost/.test(NOT_A_COST.INVITE_CREDIT_JOB ?? "") && /INVITE_JOB_MONTH_USD/.test(NOT_A_COST.INVITE_CREDIT_JOB ?? ""), true);
// What a plan's line would be checked for (tests/plan-cost-registry.test.ts): every name it cites is in its file.
is("every name it cites is in its file", line.sources.every((s) => s.names.every((n) => readFileSync(s.file, "utf8").includes(n))), true);
const names = (file: string) => line.sources.filter((s) => s.file === file).flatMap((s) => s.names);
is(
  "it names every Stripe read of the job",
  ["paidInvoices", "takenBackOn", "disputedOn", "paidNow", "stillOwed", "creditedAt", "INVOICE_PAGES", "HISTORY_PAGES"].every((n) => names("lib/creator-invite-credit.ts").includes(n)),
  true,
);
is("and the bound it is priced by: the plans cron, once a day, at most maxDuration", [names("app/api/cron/plans/route.ts").includes("maxDuration = 60"), names("app/api/cron/plans/route.ts").includes("settleInvites(deadline)"), names("vercel.json").includes("/api/cron/plans")], [true, true, true]);

part("Its figure is the whole job's ceiling at the registry's memory, command and byte rates, never zero");
const memorySecondUsd = (VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR / 1e6) * VERCEL_FUNCTION_GB / 3600;
// Since #4514 (Claude 7's and Claude 5's MEDIUM): the run's Redis commands, held in code to INVITE_RUN_COMMANDS, and
// its two list windows' bytes are priced with its memory (tests/invite-credit-command-ceiling.test.ts holds the code).
// Every second day since the owner's decision of 17 November 2026: at most 16 runs a month (invite-every-second-day).
// Since the owner's decision of 19 November 2026 on #4514 (part (b)), with the credit a late lost dispute takes back:
// every day, at most CLAWBACKS_PER_RUN, each at its command, Stripe-wait and record-byte ceilings (lib/creator-invite-clawback.ts).
const clawback = 31 * CLAWBACKS_PER_RUN * (CLAWBACK_COMMANDS * COMMAND + CLAWBACK_STRIPE_CALLS * STRIPE_WAIT_SECONDS * memorySecondUsd + 2 * CLAWBACK_RECORD_BYTES * (DB_BYTE + DB_BYTE_MONTH));
is("the clawback's month: every day, its runs at their ceilings, never zero", [INVITE_CLAWBACK_RUNS_PER_MONTH, Math.abs(INVITE_CLAWBACK_MONTH_USD - clawback) < 1e-9, INVITE_CLAWBACK_MONTH_USD > 0], [31, true, true]);
const ceiling = INVITE_JOB_RUNS_PER_MONTH * (60 * memorySecondUsd + INVITE_RUN_COMMANDS * COMMAND + INVITE_JOB_LIST_BYTES * DB_BYTE) + clawback;
is("16 runs of at most 60 s at 2 GB, INVITE_RUN_COMMANDS commands and their list bytes, and the clawback", INVITE_JOB_RUNS_PER_MONTH === 16 && Math.abs(INVITE_JOB_MONTH_USD - ceiling) < 1e-9 && INVITE_JOB_MONTH_USD > 16 * 60 * memorySecondUsd, true);
is("each Stripe call is counted as a wait the registry already uses", STRIPE_WAIT_SECONDS > 0, true);
done();
