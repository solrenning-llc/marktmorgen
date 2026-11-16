/**
 * Issue #4310 follow-up (money, rule 24; Claude 1 cloud's MEDIUM on #4454):
 * a written-down payment row whose money fields do not read exactly is
 * unknown, never a member owed nothing.
 *
 * `paidRowOf` used to check only that `amt`, `ps` and `pe` were finite
 * numbers and never looked at the optional fields the refund reads. A row
 * with a negative or fractional amount, a negative or text total, an empty
 * payment id or an unknown outcome read as valid, so the member was skipped
 * (unused 0), settled "none", or retried forever with an amount Stripe
 * refuses. Now any such row throws UnknownReplyError, which the closing's
 * callers already turn into "held, tried again tomorrow".
 *
 * Against the Redis stand-in only; nothing real is reached.
 */
import { paidKey, paidPeriods } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SUB = "sub_1PaidRowFields";
const NOW_S = Math.floor(Date.now() / 1000);
const BASE = { inv: "in_1PaidRowFields", amt: 1500, tot: 1500, cur: "usd", ps: NOW_S - 10 * 86400, pe: NOW_S + 20 * 86400, e: "member@example.com" };

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("paid-fields@example.com", "paidfields", "Paid Fields", "");
  const store = await storeForEmail("paid-fields@example.com");
  if (!store) throw new Error("the test store was not made");
  const key = paidKey(await storeFolder(storeRef(store)));

  async function withRow(row: Record<string, unknown>): Promise<string> {
    await redis.pipeline([["DEL", key], ["HSET", key, SUB, JSON.stringify(row)]]);
    try {
      await paidPeriods(store!);
      return "read";
    } catch (error) {
      return error instanceof Error && error.name === "UnknownReplyError" ? "threw" : `other: ${String(error)}`;
    }
  }

  part("Rows the writers write still read");
  is("the row as paidPeriodOf writes it", await withRow(BASE), "read");
  is("with its payment id", await withRow({ ...BASE, pi: "pi_1PaidRowFields" }), "read");
  is("a refund done", await withRow({ ...BASE, pi: "pi_1PaidRowFields", r: "done", back: 1200 }), "read");
  is("a refund short, final, emailed", await withRow({ ...BASE, r: "short", f: 1, want: 900, m: 1 }), "read");
  is("an older row with no total", await withRow({ inv: BASE.inv, amt: 1500, cur: "usd", ps: BASE.ps, pe: BASE.pe, e: BASE.e }), "read");

  part("A money field that does not read exactly is unknown");
  is("amt fractional", await withRow({ ...BASE, amt: 1500.5 }), "threw");
  is("amt negative", await withRow({ ...BASE, amt: -1500 }), "threw");
  is("amt zero", await withRow({ ...BASE, amt: 0 }), "threw");
  is("tot negative", await withRow({ ...BASE, tot: -1 }), "threw");
  is("tot a string", await withRow({ ...BASE, tot: "1500" }), "threw");
  is("back a string", await withRow({ ...BASE, back: "x" }), "threw");
  is("want fractional", await withRow({ ...BASE, want: 10.5 }), "threw");
  is("period ending before it starts", await withRow({ ...BASE, pe: BASE.ps - 1 }), "threw");
  is("period start fractional", await withRow({ ...BASE, ps: BASE.ps + 0.5 }), "threw");
  is("currency not three letters", await withRow({ ...BASE, cur: "us dollars" }), "threw");

  part("An id or an outcome that does not read is unknown");
  is("pi empty", await withRow({ ...BASE, pi: "" }), "threw");
  is("pi of another kind", await withRow({ ...BASE, pi: "ch_1PaidRowFields" }), "threw");
  is("r not one of its six values", await withRow({ ...BASE, r: "maybe" }), "threw");
  is("f other than 1", await withRow({ ...BASE, r: "short", f: 2 }), "threw");
  is("m other than 1", await withRow({ ...BASE, m: true }), "threw");
  is("inv of another kind", await withRow({ ...BASE, inv: "pi_1PaidRowFields" }), "threw");

  done();
}

main();
