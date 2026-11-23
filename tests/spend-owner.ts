/**
 * A synthetic live store for a test that writes ad spend lines under a bare statsId (lib/ad-spend.ts addSpend, whose
 * writes are fenced on the store being live since row 100 of #5010): its id key is written to hold its own ref, by
 * the rule of lib/live-fence.ts, each time the owner is asked for, because these tests clear the stand-in Redis
 * between cases. Used only by the tests that predate the fence; the fence itself is tested in
 * tests/ad-spend-erasure-fence.test.ts, never with this helper.
 */
import { createHash } from "node:crypto";
import type { SpendOwner } from "@/lib/ad-spend";
import { storeIdCommand, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";

/** The owner of `statsId`'s spend lines, live now: its id key holds its ref. */
export function spendOwner(statsId: string): SpendOwner {
  const sid = createHash("sha256").update(`spend-owner:${statsId}`).digest("hex").slice(0, 32);
  const owner: SpendOwner = { email: `spend-owner-${sid.slice(0, 12)}@example.com`, sid, extra: false, statsId };
  redis.run(["SET", storeIdCommand(sid)[1], storeRef(owner)]);
  return owner;
}

/** Whether a pipeline holds an ad spend line's write: the fenced EVAL (or, for older helpers, a plain HSET or HSETNX). */
export const isSpendWrite = (commands: (string | number)[][]): boolean =>
  commands.some((c) => c[0] === "HSET" || c[0] === "HSETNX" || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:ad-spend-live:")));
