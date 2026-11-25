/** Receipt numbers must not recreate the records a closing store erased. */
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";
import { claimHandle, closeStoreRecord, createStore, ensureStatsId, ERASING_KEY, erasingField, storeForEmail, storeForId, storeIdCommand, storeRef } from "@/lib/store";
import { RECEIPT_NUMBER, assignReceiptNumber, receiptCounterKey, receiptNumbersKey } from "@/lib/receipt-number";
import { dataKey } from "@/lib/store-data";

async function main(): Promise<void> {
  redis.clear();
  const pipeline = redis.pipeline.bind(redis);
  const make = async (label: string) => {
    const email = `${label}@example.test`;
    await claimHandle(email, label, "Synthetic receipt store", "");
    await ensureStatsId(email);
    return (await storeForEmail(email))!;
  };
  const reference = "cs_test_erasureReceipt00001";
  const keys = (store: Awaited<ReturnType<typeof make>>) => [receiptNumbersKey(store.sid), receiptCounterKey(store.sid), dataKey(store)!];
  const missing = async (names: string[]) => pipeline(names.map((key) => ["EXISTS", key]));
  const live = await make("receiptliveproof");
  part("Live numbering remains stable and atomic");
  is("a live store gets its first number", await assignReceiptNumber(live, reference), { ok: true, number: "R-000001" });
  is("concurrent re-downloads keep the same number", await Promise.all([assignReceiptNumber(live, reference), assignReceiptNumber(live, reference)]), [{ ok: true, number: "R-000001" }, { ok: true, number: "R-000001" }]);

  part("A closing marker appearing at the write refuses the number");
  const closing = await make("receiptclosingproof");
  const field = await erasingField(storeRef(closing));
  let marked = false;
  redis.pipeline = async (commands) => {
    if (!marked && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:receipt-number:v"))) {
      marked = true;
      await pipeline([["HSET", ERASING_KEY, field, String(Date.now())], ["DEL", ...keys(closing)]]);
    }
    return pipeline(commands);
  };
  const during = await assignReceiptNumber(closing, reference);
  redis.pipeline = pipeline;
  is("the marker was written at the actual numbering boundary", marked, true);
  is("the store id is still present during its walk", (await pipeline([["EXISTS", storeIdCommand(closing.sid)[1]]]))[0], 1);
  is("no number is certified while closing", during, { ok: false, reason: "unknown" });
  is("no receipt, counter or room is recreated during closing", await missing(keys(closing)), [0, 0, 0]);
  is("another live store's number still reads", await assignReceiptNumber(live, reference), { ok: true, number: "R-000001" });

  part("A complete real store-record closure at the write leaves nothing to number");
  const gone = await make("receiptgoneproof");
  await assignReceiptNumber(gone, reference);
  let closed = false;
  redis.pipeline = async (commands) => {
    if (!closed && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:receipt-number:v"))) {
      redis.pipeline = pipeline;
      closed = await closeStoreRecord(gone, keys(gone));
    }
    return pipeline(commands);
  };
  const after = await assignReceiptNumber(gone, "cs_test_lateReceipt0000001");
  redis.pipeline = pipeline;
  is("closeStoreRecord completed before the pending EVAL", closed, true);
  is("the store record is actually gone", await storeForId(gone.sid), null);
  is("a stale store snapshot gets no new number", after, { ok: false, reason: "unknown" });
  is("no receipt, counter or room returns after closure", await missing(keys(gone)), [0, 0, 0]);

  part("The store's id moved to another ref whose erasure began: the fence reads the ref, not only that the id exists");
  // Claude 5 icEJ's MEDIUM on #5224 (store-cache-live:v3, Codex L-20261121-0043): a numbering read under the old ref,
  // after the id was pointed to the new ref and that ref's erasure began, must not number nor recreate anything.
  const moved = await make("receiptmovedproof");
  const movedTo = "receipt-moved-to@example.test";
  await pipeline([["SET", storeIdCommand(moved.sid)[1], movedTo], ["HSET", ERASING_KEY, await erasingField(movedTo), String(Date.now())]]);
  is("the id key now names another ref", (await pipeline([["GET", storeIdCommand(moved.sid)[1]]]))[0], movedTo);
  is("a number under the old ref is refused", await assignReceiptNumber(moved, "cs_test_movedReceipt000001"), { ok: false, reason: "unknown" });
  is("no receipt, counter or room is created under the moved id", await missing(keys(moved)), [0, 0, 0]);
  await pipeline([["HDEL", ERASING_KEY, await erasingField(movedTo)]]);
  is("even with no erasure on the new ref, the old ref's snapshot gets no number", await assignReceiptNumber(moved, "cs_test_movedReceipt000002"), { ok: false, reason: "unknown" });
  is("still nothing created under the moved id", await missing(keys(moved)), [0, 0, 0]);

  // Claude 5 icEJ's LOW on #5224: the script's keys and arguments changed shape, so its name moves to v2.
  is("the script's new shape carries a new name", RECEIPT_NUMBER.startsWith("-- marktmorgen:receipt-number:v2\n"), true);

  part("An extra store uses its own erasing field, independently of its owner's first store");
  const created = await createStore(live.email, "receiptextraproof", "Synthetic extra store", "");
  if (!created.ok) throw new Error("Expected a synthetic extra store");
  const extra = created.store;
  await pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(live)), "1"]]);
  is("closing the owner's first store does not close the extra store", await assignReceiptNumber(extra, reference), { ok: true, number: "R-000001" });
  await pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(extra)), "1"]]);
  is("the extra store's own closing mark refuses a new number", await assignReceiptNumber(extra, "cs_test_extraLateReceipt01"), { ok: false, reason: "unknown" });
  is("the refused extra-store number changes no ledger", await pipeline([["GET", receiptCounterKey(extra.sid)], ["HEXISTS", receiptNumbersKey(extra.sid), "cs_test_extraLateReceipt01"]]), ["1", 0]);
  done();
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
