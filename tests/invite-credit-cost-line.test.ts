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
import { COST_LINES, STRIPE_WAIT_SECONDS } from "./plan-cost-registry";
import { VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR } from "@/lib/spend-cost-table";
import { TIERS } from "@/lib/plan";
import { done, is, part } from "./check";

part("The invite-credit job has its own cost line");
const line = COST_LINES.find((l) => l.id === "invite-credit-reads");
is("there is a line for it", Boolean(line), true);
const names = (file: string) => (line?.sources ?? []).filter((s) => s.file === file).flatMap((s) => s.names);
is(
  "it names every Stripe read of the job",
  ["paidInvoices", "takenBackOn", "disputedOn", "paidNow", "stillOwed", "creditedAt", "INVOICE_PAGES", "HISTORY_PAGES"].every((n) => names("lib/creator-invite-credit.ts").includes(n)),
  true,
);
is("and the bound it is priced by: the plans cron, once a day, at most maxDuration", [names("app/api/cron/plans/route.ts").includes("maxDuration = 60"), names("app/api/cron/plans/route.ts").includes("settleInvites(deadline)"), names("vercel.json").includes("/api/cron/plans")], [true, true, true]);

part("Its figure is the whole job's ceiling at the registry's memory rate, never zero");
const memorySecondUsd = (VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR / 1e6) * VERCEL_FUNCTION_GB / 3600;
const ceiling = 31 * 60 * memorySecondUsd;
for (const tier of TIERS) {
  const usd = line ? line.monthlyUsd(tier) : 0;
  is(`${tier}: 31 runs of at most 60 s at 2 GB`, Math.abs(usd - ceiling) < 1e-9 && usd > 0, true);
}
is("each Stripe call is counted as a wait the registry already uses", STRIPE_WAIT_SECONDS > 0, true);
done();
