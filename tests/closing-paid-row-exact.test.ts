/**
 * A closing's member payment row is read with every field in the shape its writers give it (Claude 7's note 1 on
 * #4454, CX-123 rule 24): paidPeriodOf writes inv, pi when Stripe named one, amt, tot, cur, ps, pe and e;
 * savePaidPeriod adds r, f, back, want and m. Amounts and times are safe whole numbers from 0, the money three
 * lower-case letters, r one of its six outcomes, f and m only 1. A corrupted row is unknown (UnknownReplyError):
 * never read as one still to refund, which an odd `r` would be. Against the Redis stand-in only.
 */
import { paidKey, paidPeriods } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW_S = Math.floor(Date.now() / 1000);
const BASE = { inv: "in_1RowExact", amt: 1500, tot: 1800, cur: "usd", ps: NOW_S - 10 * 86400, pe: NOW_S + 20 * 86400, e: "member@example.com" };
const SUB = "sub_1RowExactMember";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("row-exact@example.com", "rowexact", "Row Exact", "");
  const store = await storeForEmail("row-exact@example.com");
  if (!store) throw new Error("the test store was not made");
  const key = paidKey(await storeFolder(storeRef(store)));
  const read = async (row: unknown): Promise<string> => {
    await redis.pipeline([["DEL", key], ["HSET", key, SUB, JSON.stringify(row)]]);
    try {
      return `read ${(await paidPeriods(store)).size}`;
    } catch (error) {
      return error instanceof Error && error.name === "UnknownReplyError" ? "threw" : `other: ${String(error)}`;
    }
  };

  part("Every row its writers give still reads");
  is("as paidPeriodOf writes it", await read(BASE), "read 1");
  is("with the payment it was paid by", await read({ ...BASE, pi: "pi_1RowExactPay" }), "read 1");
  is("an address left empty", await read({ ...BASE, e: "" }), "read 1");
  for (const r of ["done", "pending"] as const) is(`settled ${r}, with what was given back`, await read({ ...BASE, r, back: 900 }), "read 1");
  for (const r of ["disputed", "none"] as const) is(`settled ${r}`, await read({ ...BASE, r }), "read 1");
  for (const r of ["short", "over"] as const) is(`settled ${r}, final, with what was to be given`, await read({ ...BASE, r, f: 1, want: 900 }), "read 1");
  is("a short one the member was told about", await read({ ...BASE, r: "short", f: 1, want: 900, m: 1 }), "read 1");

  part("A corrupted row is unknown, never a refund still to make");
  is("an amount with a fraction", await read({ ...BASE, amt: 15.5 }), "threw");
  is("a negative amount", await read({ ...BASE, amt: -1 }), "threw");
  is("an amount past a safe whole number", await read({ ...BASE, amt: 2 ** 60 }), "threw");
  is("a total that is not a whole number", await read({ ...BASE, tot: "1800" }), "threw");
  is("a start with a fraction", await read({ ...BASE, ps: 1.5 }), "threw");
  is("a negative end", await read({ ...BASE, pe: -5 }), "threw");
  is("money in capitals", await read({ ...BASE, cur: "USD" }), "threw");
  is("money that is not three letters", await read({ ...BASE, cur: "dollars" }), "threw");
  is("an outcome that is none of the six", await read({ ...BASE, r: "refunded" }), "threw");
  is("f other than 1", await read({ ...BASE, r: "short", f: true }), "threw");
  is("m other than 1", await read({ ...BASE, m: "yes" }), "threw");
  is("given back that is not a whole number", await read({ ...BASE, r: "done", back: "900" }), "threw");
  is("to give that is negative", await read({ ...BASE, r: "short", want: -900 }), "threw");
  is("a payment that is not a string", await read({ ...BASE, pi: 42 }), "threw");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
