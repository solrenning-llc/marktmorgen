/**
 * Review of the whole copy of a person's payment requests (R19 MEDIUM 2,
 * 9 November 2026), MEDIUM: the copy refused a person's set past
 * MAX_PER_PERSON x 2 (48) members before reading one. A member whose record
 * is gone (an orphan: a request that ran out, or one whose creation was
 * undone while the undo's SREM was lost) is still a member, so a person
 * with one live request and 48 orphans could never get their copy, until
 * the next request made for them happened to prune the set.
 *
 * And the undo that leaves such an orphan behind swallowed its own failure
 * (`.catch(() => undefined)`): nothing said that an id stayed counted in the
 * store's lists and the person's set without a record.
 */
import { personKey } from "@/lib/person-key";
import { COPIERS } from "@/lib/person-copy";
import { erasureScope } from "@/lib/person-erasure";
import { MAX_PER_PERSON } from "@/lib/payment-request-rules";
import { createRequest } from "@/lib/payment-request-store";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "orphan-copy-owner@example.com";
const TESS = "tess.orphans@example.com";
const OLLY = "olly.orphans@example.com";
const hex = (n: number) => ("e" + n.toString(16)).padStart(32, "0");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "orphancopy", "Orphan copy", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_orphancopy01", true);
  await setSubscription(OWNER, { customerId: "cus_orphancopy", subscriptionId: "sub_orphancopy", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const made = await createRequest(store, { email: TESS, name: "Tess", lines: [{ text: "Synthetic work", quantity: 1, cents: 1_000 }], note: "", dueDate: "", autoReminders: 0, total: 1_000 });
  if (!made.ok) throw new Error(`Tess's request was not kept: ${made.message}`);

  part("One live request and 48 orphan members (their records gone)");
  const set = `nl:payreq:p:${store.sid}:${personKey(store.sid, TESS)}`;
  await redis.pipeline([["SADD", set, ...Array.from({ length: 48 }, (_, i) => hex(i))]]);
  const scope = (await erasureScope(store, TESS))!;
  let copied: unknown[] | string;
  try {
    copied = await COPIERS["lib/payment-request-store.ts"](scope);
  } catch (error) {
    copied = `threw: ${(error as Error).message}`;
  }
  is("her copy has her one live request, the orphans skipped", Array.isArray(copied) ? copied.map((r) => (r as { id: string }).id) : copied, [made.request.id]);

  part("An undo whose SREM is lost says so in the log, and the refusal still stands");
  const olly = `nl:payreq:p:${store.sid}:${personKey(store.sid, OLLY)}`;
  const full = Array.from({ length: MAX_PER_PERSON }, (_, i) => ("f" + i.toString(16)).padStart(32, "0"));
  await redis.pipeline([...full.map((id) => ["SET", `nl:payreq:r:${id}`, "{}"]), ["SADD", olly, ...full]]);
  const original = redis.pipeline.bind(redis);
  const logged: string[] = [];
  const log = console.error;
  redis.pipeline = async (commands) => {
    if (commands.length === 3 && commands[0][0] === "ZREM" && commands[2][0] === "SREM") throw new Error("synthetic: the undo's pipeline was lost");
    return original(commands);
  };
  console.error = (...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  let refused;
  try {
    refused = await createRequest(store, { email: OLLY, name: "Olly", lines: [{ text: "Synthetic work", quantity: 1, cents: 1_000 }], note: "", dueDate: "", autoReminders: 0, total: 1_000 });
  } finally {
    redis.pipeline = original;
    console.error = log;
  }
  is("the 25th request for one person is refused for the person's count", refused.ok ? "kept" : refused.reason, "person");
  is("the lost undo is in the log, with its error", logged.some((line) => /undo/i.test(line) && line.includes("synthetic: the undo's pipeline was lost")), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
