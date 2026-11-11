/**
 * The buyers' copy kept an hour (lib/segments.ts, LEDGER_SECONDS; owner, C3-80 (b)) is priced for the time it is
 * stored, not only for the bytes written and read (Codex R1 on #3226, MÉDIO): one reading of the buyers
 * (tests/plan-cost-registry.ts, BUYER_LEDGER) carries its copy's stored bytes for LEDGER_SECONDS at Upstash's
 * GB-month rate (lib/spend-cost-table.ts), and BUYER_LEDGER_UNITS still pays for the whole reading.
 *
 * Why per reading: the copy is written only by a reading, and one copy lives at most LEDGER_SECONDS after it, so a
 * store read back to back holds its copy all the time and pays each hour of it with the reading that made it.
 */
import { BUYER_LEDGER_UNITS, LEDGER_SECONDS } from "@/lib/segments";
import { readFileSync } from "node:fs";
import * as registry from "./plan-cost-registry";
import { BUYER_LEDGER, BUYER_LEDGER_BYTES, DB_BYTE_MONTH, UNIT_COST } from "./plan-cost-registry";
import { done, is, part } from "./check";

// Read by name, so a registry without the line fails its checks instead of the build.
const BUYER_LEDGER_COPY_KEPT = (registry as Record<string, unknown>).BUYER_LEDGER_COPY_KEPT;

part("The one-hour copy's storage is in the reading's cost");
const kept = BUYER_LEDGER_BYTES * DB_BYTE_MONTH * (LEDGER_SECONDS / (30 * 86_400));
is("the copy is kept an hour", LEDGER_SECONDS, 3_600);
is("its storage is priced: the copy's bytes, at the GB-month rate, for LEDGER_SECONDS", typeof BUYER_LEDGER_COPY_KEPT === "number" && Math.abs(BUYER_LEDGER_COPY_KEPT - kept) < 1e-15, true);
is("and is more than nothing", typeof BUYER_LEDGER_COPY_KEPT === "number" && BUYER_LEDGER_COPY_KEPT > 0, true);
is("a reading of the buyers carries it", typeof BUYER_LEDGER_COPY_KEPT === "number" && BUYER_LEDGER >= BUYER_LEDGER_COPY_KEPT, true);
const line = readFileSync("tests/plan-cost-registry.ts", "utf8").split("\n").find((l) => l.startsWith("export const BUYER_LEDGER = ")) ?? "";
is("the reading's own line adds it, so it is never left out of BUYER_LEDGER", line.includes("+ BUYER_LEDGER_COPY_KEPT"), true);
is("and its studio requests still pay for the whole reading", BUYER_LEDGER <= UNIT_COST.studio * BUYER_LEDGER_UNITS, true);

done();
