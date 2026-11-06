/**
 * Proof (sweep A6, CX-123 rule 24/30): reads that decide what happens to a
 * deleted person, or what is said about used allowance, take an unknown reply
 * for "no".
 *
 *   - lib/suppression.ts wasSuppressed (`Number(reply) === 1`), used by
 *     lib/contacts.ts upsertContact, lib/checkout-recovery.ts and
 *     lib/product-updates.ts: an HEXISTS reply of another shape is "not
 *     deleted", so a person erased from the store is put back on its list as
 *     agreeing to its email by a purchase that did not ask (no own yes);
 *     lib/review-requests.ts already reads the same command exactly
 *     (reviewRecipientState);
 *   - lib/store-readings.ts forgetReadingsPerson (`Number(gone) || 0`): a DEL
 *     reply of another shape is "0 copies removed", a finished step of the
 *     erasure, where its sibling lib/segments.ts forgetLedgerCopy throws so
 *     lib/person-erasure.ts records the step as not finished;
 *   - lib/store-allowance.ts allowanceUsed: an unknown GET is 0 used, while
 *     lib/store-copy.ts planFor expects null for "unknown" (its `unitsUsed ===
 *     null` branch can never run); allowancesUsedStrict answers null.
 *
 * The "defect" tests assert the fail-closed behavior and FAIL ON PURPOSE on
 * main; each "control" passes. Synthetic records and the in-memory Redis only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { leadsKey, parseContact, upsertContact } from "@/lib/contacts";
import { suppressCommand } from "@/lib/suppression";
import { forgetReadingsPerson } from "@/lib/store-readings";
import { forgetLedgerCopy } from "@/lib/segments";
import { allowanceUsed, allowancesUsedStrict, takeAllowance } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { paidPeriod } from "./billing-period-fixture";

type Pipe = (commands: (string | number)[][]) => Promise<unknown[]>;
async function intercept<T>(when: (commands: (string | number)[][]) => boolean, answer: (commands: (string | number)[][], real: Pipe) => Promise<unknown[]>, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  const real: Pipe = (commands) => original.call(redis, commands);
  redis.pipeline = (async (commands: (string | number)[][]) => (when(commands) ? answer(commands, real) : real(commands))) as typeof redis.pipeline;
  try { return await run(); } finally { redis.pipeline = original; }
}
const contact = async (list: string, email: string) => parseContact((await redis.pipeline([["HGET", leadsKey(list), email]]))[0]);
const isCheck = (commands: (string | number)[][]) => commands.length === 3 && commands[2][0] === "HEXISTS";

test("control: a person deleted from the store is not put back as agreeing by a purchase without their own yes", async () => {
  await redis.pipeline([suppressCommand("sweepa6list1", "erased@example.com")]);
  await upsertContact("sweepa6list1", "erased@example.com", { agreed: true, explicit: false, source: "buyer" }, ROOM);
  assert.equal((await contact("sweepa6list1", "erased@example.com"))?.agreed, false);
});

test("defect: an HEXISTS reply of another shape must not put an erased person back on the list as agreeing", async () => {
  await redis.pipeline([suppressCommand("sweepa6list2", "erased@example.com")]);
  await intercept(isCheck, async (commands, real) => (await real(commands)).slice(0, 2), () =>
    upsertContact("sweepa6list2", "erased@example.com", { agreed: true, explicit: false, source: "buyer" }, ROOM)).catch(() => null);
  const after = await contact("sweepa6list2", "erased@example.com");
  assert.notEqual(after?.agreed, true, `the erased address is on the list again with agreed=${after?.agreed}`);
});

const isDel = (commands: (string | number)[][]) => commands.length === 1 && commands[0][0] === "DEL";

test("control: the segments ledger copy refuses to report an unknown DEL as done", async () => {
  await assert.rejects(intercept(isDel, async () => [], () => forgetLedgerCopy("sweepa6stats")));
});

test("defect: forgetReadingsPerson must not report an unknown DEL as 0 copies removed", async () => {
  await redis.pipeline([["SET", "nl:reading:sales:sweepa6stats", "{\"names\":[\"erased@example.com\"]}"]]);
  await assert.rejects(intercept(isDel, async () => [], () => forgetReadingsPerson("sweepa6stats")), "forgetReadingsPerson resolved 0: lib/person-erasure.ts records the step finished");
});

const shop = { sid: "sweep-a6-allowance", tier: "scale", subscriptionActive: true, subscriptionId: "sub_sweep_a6", trialEnds: 0, planEndedAt: "", period: paidPeriod() } as unknown as Parameters<typeof allowanceUsed>[0];
const isGet = (commands: (string | number)[][]) => commands.every((c) => c[0] === "GET") && String(commands[0][1]).startsWith("nl:allow:studio:");

test("control: allowancesUsedStrict says unknown (null) for an unknown GET, and both read 5 when Redis answers", async () => {
  const taken = await takeAllowance(shop, "studio", 5);
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.equal(await allowanceUsed(shop, "studio"), 5);
  assert.equal((await allowancesUsedStrict(shop, ["studio"]))?.[0]?.used, 5);
  assert.equal(await intercept(isGet, async () => [], () => allowancesUsedStrict(shop, ["studio"])), null);
});

test("defect: allowanceUsed must not say 0 used for an unknown GET (lib/store-copy.ts waits for null)", async () => {
  const used = await intercept(isGet, async () => [], () => allowanceUsed(shop, "studio"));
  assert.notEqual(used, 0, "allowanceUsed answered 0 used for a store that has used 5");
});
