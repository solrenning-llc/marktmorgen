/**
 * 422 [PT2], review of #3014: the creator's marks of the membership benefits
 * handed to one person are in that person's copy of their data
 * (lib/person-copy.ts), as the erasure deletes them (lib/tier-benefits.ts,
 * forgetBenefitPerson). The copy says which benefit, on which membership,
 * for which month and when it was marked; never which teammate marked it,
 * never anybody else's marks. A mark kept in a shape that cannot be read
 * fails the copy, never leaves it out; after the erasure, nothing is found.
 */
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { personKey } from "@/lib/person-key";
import { ERASERS, erasureScope } from "@/lib/person-erasure";
import { COPIERS, COPY_PLAN } from "@/lib/person-copy";
import { benefitMarksOf } from "@/lib/tier-benefits";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "benefitcopy@example.com";
const TEAMMATE = "helper@example.com";
const PERSON = "lin@example.com";
const OTHER = "someone@example.com";
const MODULE = "lib/tier-benefits.ts";

async function failure(read: () => Promise<unknown>): Promise<string> {
  try {
    await read();
    return "read";
  } catch {
    return "failed";
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "benefitshop", "Benefit Shop", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const person = personKey(statsId, PERSON);
  const other = personKey(statsId, OTHER);
  const marks = `nl:tben:given:${statsId}:${person}`;
  // As lib/tier-benefits.ts keeps them: the benefits, each person's marks, and who has marks.
  redis.run(["HSET", `nl:tben:${statsId}`, "b0123456789ab", JSON.stringify({ product: "prodtier01", text: "A signed print", cadence: "once", since: 1_790_000_000, retired: 0 })]);
  redis.run(["HSET", `nl:tben:${statsId}`, "bfedcba987654", JSON.stringify({ product: "prodtier01", text: "A call with me", cadence: "monthly", since: 1_790_000_000, retired: 1_795_000_000 })]);
  redis.run(["HSET", marks, "b0123456789ab:sub_lin0000001:once", JSON.stringify({ at: 1_791_000_000, by: TEAMMATE })]);
  redis.run(["HSET", marks, "bfedcba987654:sub_lin0000001:m1790000000", JSON.stringify({ at: 1_790_500_000, by: TEAMMATE })]);
  redis.run(["HSET", `nl:tben:given:${statsId}:${other}`, "b0123456789ab:sub_other00001:once", JSON.stringify({ at: 1_791_000_000, by: TEAMMATE })]);
  redis.run(["SADD", `nl:tben:who:${statsId}`, person, other]);

  part("The copy reads the person's benefit marks");
  is("the module is copied, with its reader", [COPY_PLAN[MODULE]?.how, typeof COPIERS[MODULE]], ["copied", "function"]);
  const scope = (await erasureScope(store, PERSON))!;
  const found = await COPIERS[MODULE](scope);
  is("each mark: which benefit, on which membership, for when, and when it was marked, oldest first", found, [
    { benefit: "A call with me", membership: "prodtier01", subscription: "sub_lin0000001", cadence: "monthly", forMonthFrom: "2026-09-21T14:13:20.000Z", given: "2026-09-27T09:06:40.000Z" },
    { benefit: "A signed print", membership: "prodtier01", subscription: "sub_lin0000001", cadence: "once", forMonthFrom: null, given: "2026-10-03T04:00:00.000Z" },
  ]);
  const text = JSON.stringify(found);
  is("never the teammate who marked it", text.includes(TEAMMATE), false);
  is("never another person's marks", text.includes("sub_other00001"), false);
  is("an address the store keeps no marks for has none", await benefitMarksOf(store, personKey(statsId, "nobody@example.com")), []);

  part("A mark that cannot be read fails the copy, never leaves it out");
  redis.run(["HSET", marks, "b0123456789ab:sub_lin0000001:m1793000000", "{not json"]);
  is("a mark in another shape", await failure(() => COPIERS[MODULE](scope)), "failed");
  redis.run(["HDEL", marks, "b0123456789ab:sub_lin0000001:m1793000000"]);
  redis.run(["HSET", marks, "nobenefit:sub_lin0000001:once", JSON.stringify({ at: 1_791_000_000, by: TEAMMATE })]);
  is("a mark under a field in another shape", await failure(() => COPIERS[MODULE](scope)), "failed");
  redis.run(["HDEL", marks, "nobenefit:sub_lin0000001:once"]);
  redis.run(["HSET", `nl:tben:${statsId}`, "b0123456789ab", "{not json"]);
  is("the benefits themselves in another shape", await failure(() => COPIERS[MODULE](scope)), "failed");
  redis.run(["HSET", `nl:tben:${statsId}`, "b0123456789ab", JSON.stringify({ product: "prodtier01", text: "A signed print", cadence: "once", since: 1_790_000_000, retired: 0 })]);
  // The database answering the person's marks in another shape than a hash's list.
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: (string | number)[][]) => {
    const replies = await pipeline(commands);
    return commands.map((c, i) => (c[0] === "HGETALL" && c[1] === marks ? "a string where a list was" : replies[i]));
  };
  is("the person's marks answered in another shape", await failure(() => COPIERS[MODULE](scope)), "failed");
  redis.pipeline = pipeline;
  is("read again once it can be", (await COPIERS[MODULE](scope)).length, 1);

  part("After the erasure, nothing is found");
  await ERASERS.find((e) => e.module === MODULE)!.run(scope, [], new Set());
  is("nothing left to copy", await COPIERS[MODULE](scope), []);
  is("the other person's marks stay", redis.run(["HLEN", `nl:tben:given:${statsId}:${other}`]), 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
