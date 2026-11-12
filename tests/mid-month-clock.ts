/**
 * Moves this test process's clock to noon UTC on the 15th of the current UTC month, still running.
 *
 * Contract admission (lib/contract-funding.ts, lib/contract-resource-window.ts) refuses, by design, any check made
 * in another UTC month than the review's fundedExposure.month, which the synthetic fixtures take from the clock when
 * they are built (tests/margin-test-fixtures.ts zeroExposureFixture). A file that runs for minutes and crosses a
 * month boundary therefore failed whichever subtest was running then (seen with the whole suite under a shifted
 * clock at 2027-06-30T23:59Z and 2027-12-31T23:59:50Z). Import this first in such a file: the clock keeps running,
 * but more than two weeks from either month boundary and twelve hours from either UTC day boundary, so neither can
 * change under one fixture. The day matters too: tests/readings-erasure.test.ts clears the reading allowance of the
 * UTC day it read once at the start, and failed when a run crossed midnight UTC (2027-12-31T23:59:50Z).
 * Test-only; never imported by product code.
 */
const RealDate = globalThis.Date;
const realNow = RealDate.now.bind(RealDate);
const start = new RealDate(realNow());
const offset = RealDate.UTC(start.getUTCFullYear(), start.getUTCMonth(), 15, 12) - start.getTime();

function MidMonthDate(this: unknown, ...args: unknown[]): unknown {
  if (!new.target) return new RealDate(realNow() + offset).toString();
  return Reflect.construct(RealDate, args.length ? args : [realNow() + offset], new.target);
}
Object.setPrototypeOf(MidMonthDate, RealDate);
MidMonthDate.prototype = RealDate.prototype;
Object.defineProperty(MidMonthDate, "name", { value: "Date" });
Object.assign(MidMonthDate, { now: () => realNow() + offset, parse: RealDate.parse, UTC: RealDate.UTC });
globalThis.Date = MidMonthDate as unknown as DateConstructor;

export const MID_MONTH_CLOCK_OFFSET_MS = offset;
