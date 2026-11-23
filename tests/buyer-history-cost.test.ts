/**
 * One refund-history check's worst cost is measured against the studio requests it takes (Claude 7's MEDIUM 1 on
 * #3841; rule MR: an unmeasured cost is never zero).
 *
 * lib/buyer-history.ts reads the creator's Stripe account up to REFUND_HISTORY_READS times (one listing per spelling
 * of the address), each waited on for up to REFUND_HISTORY_READ_MS and each an expanded page of up to REFUND_HISTORY_PAGE_BYTES
 * (the most onAccount reads of one listing; Codex X6 on #3841).
 * The route pays it with its own studio request and REFUND_HISTORY_UNITS more. No test held that those units cover
 * the reads. REFUND_HISTORY_READ (tests/plan-cost-registry.ts) is the check at its worst: the route's request, and each
 * read's wait at 2 GB with its page worked through.
 */
import * as history from "@/lib/buyer-history";
import * as registry from "./plan-cost-registry";
import { UNIT_COST } from "./plan-cost-registry";
import { VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR } from "@/lib/spend-cost-table";
import { done, is, part } from "./check";

const MEMORY_SECOND_USD = ((VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR / 1e6) * VERCEL_FUNCTION_GB) / 3600;

part("The check's reads are named figures");
const reads = (history as Record<string, unknown>).REFUND_HISTORY_READS;
const readMs = (history as Record<string, unknown>).REFUND_HISTORY_READ_MS;
is("REFUND_HISTORY_READS: the listings one check may make", reads, 2);
is("REFUND_HISTORY_READ_MS: each one's ceiling", readMs, 8_000);

part("The studio requests it takes cover its worst");
const worst = (registry as Record<string, unknown>).REFUND_HISTORY_READ;
is("REFUND_HISTORY_READ is a cost in dollars", typeof worst === "number" && worst > 0, true);
const each = typeof readMs === "number" ? (readMs / 1000) * MEMORY_SECOND_USD : Number.POSITIVE_INFINITY;
is("at least the route's request and each read's wait at 2 GB", typeof worst === "number" && typeof reads === "number" && worst >= UNIT_COST.studio + reads * each, true);
is("REFUND_HISTORY_PAGE_BYTES: the most one listing is read", history.REFUND_HISTORY_PAGE_BYTES, 1_000_000);
is("each page at its largest is in it too", history.REFUND_HISTORY_PAGE_BYTES > 0 && typeof worst === "number" && worst > UNIT_COST.studio + (typeof reads === "number" ? reads : 0) * each, true);
is("(1 + REFUND_HISTORY_UNITS) studio requests cover it", typeof worst === "number" && (1 + history.REFUND_HISTORY_UNITS) * UNIT_COST.studio >= worst, true);
done();
