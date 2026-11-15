/**
 * Stops the clock at the moment this module loads, for a test whose fixtures
 * name the calendar month at load time while the code under test reads the
 * month again on every call (lib/ai-spend.ts reserveAiSpend, through
 * lib/ai-spend-policy.ts isAiSpendPolicyValid, takes no clock of its own).
 * A run that crossed 00:00 UTC on a month's last day would see the policy of
 * the old month refused and its ledger key differ from the code's. Import it
 * first, before any module that reads the date while it loads. Only Date is
 * frozen: timers and performance.now() run as usual.
 */
import { mock } from "node:test";

export const FROZEN_NOW = Date.now();
mock.timers.enable({ apis: ["Date"], now: FROZEN_NOW });
