/**
 * #3014 (422 [PT2]) against 619 [SZ3]: the erasure reaches lib/tier-benefits.ts
 * (the creator's marks of the membership benefits handed to a member), so the
 * person's copy must hold them too. The copy carries the benefit's words, the
 * membership (its product id, as reviews and waitlists are copied), the
 * period (a monthly one as the date its month began, never the internal
 * "m<seconds>" key) and when it was marked; the teammate who marked it is theirs, left
 * out (as on a note or a deal). A mark that cannot be read in
 * its exact shape fails the copy: a copy that silently leaves it out is not
 * the copy the law asks for.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { personKey } from "@/lib/person-key";
import { addBenefit } from "@/lib/tier-benefits";
import { erasureScope } from "@/lib/person-erasure";
import { COPIERS, COPY_PLAN } from "@/lib/person-copy";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "benefits-copy@example.com";
const PERSON = "ada@example.com";
const TEAMMATE = "helper@example.com";
const SINCE = Date.UTC(2027, 0, 1, 9);
const AT = Math.floor(Date.UTC(2027, 0, 5, 12) / 1000);
/** The second the member's month began, as the rules key a monthly period. */
const MONTH_FROM = Math.floor(Date.UTC(2027, 1, 3, 9) / 1000);
const MONTH_AT = Math.floor(Date.UTC(2027, 1, 4, 12) / 1000);

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "benefitcopy", "Benefit Copy", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const product = await addProduct(OWNER, "Inner circle", "", "10", { interval: "month" as const, trialDays: 0, payments: 0 });
  if (!product.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const print = await addBenefit(store, { product: product.product.id, text: "A signed print", cadence: "once" }, SINCE);
  if (!print.ok) throw new Error("no benefit");
  const call = await addBenefit(store, { product: product.product.id, text: "A monthly call", cadence: "monthly" }, SINCE);
  if (!call.ok) throw new Error("no monthly benefit");
  const statsId = store.statsId!;
  const person = personKey(statsId, PERSON);
  await redis.pipeline([
    ["HSET", `nl:tben:given:${statsId}:${person}`, `${print.benefit.id}:sub_adamember01:once`, JSON.stringify({ at: AT, by: TEAMMATE })],
    ["HSET", `nl:tben:given:${statsId}:${person}`, `${call.benefit.id}:sub_adamember01:m${MONTH_FROM}`, JSON.stringify({ at: MONTH_AT, by: TEAMMATE })],
    ["SADD", `nl:tben:who:${statsId}`, person],
  ]);

  part("The plan");
  is("the benefit marks are copied, not just said", COPY_PLAN["lib/tier-benefits.ts"]?.how, "copied");
  const copier = COPIERS["lib/tier-benefits.ts"];
  is("and they have their reader", typeof copier, "function");
  if (!copier) return done();

  part("The copy");
  const scope = (await erasureScope(store, PERSON))!;
  const records = await copier(scope);
  is("the person's mark, with the benefit's words, membership, period and when", records, [
    { benefit: "A signed print", membership: product.product.id, subscription: "sub_adamember01", period: "once", given: new Date(AT * 1000).toISOString() },
    { benefit: "A monthly call", membership: product.product.id, subscription: "sub_adamember01", period: new Date(MONTH_FROM * 1000).toISOString(), given: new Date(MONTH_AT * 1000).toISOString() },
  ]);
  is("the monthly period is a date, not the internal key", JSON.stringify(records).includes(`m${MONTH_FROM}`), false);
  is("the teammate who marked it is left out", JSON.stringify(records).includes(TEAMMATE), false);
  const nobody = await copier((await erasureScope(store, "nobody@example.com"))!);
  is("an address with no marks: nothing", nobody, []);

  part("A mark that cannot be read");
  await redis.pipeline([["HSET", `nl:tben:given:${statsId}:${person}`, `${call.benefit.id}:sub_adamember01:mlater`, JSON.stringify({ at: MONTH_AT, by: TEAMMATE })]]);
  const oddPeriod = await copier(scope).then((r) => JSON.stringify(r), () => "failed");
  is("a period not in its exact shape fails the copy, never shown raw", oddPeriod, "failed");
  await redis.pipeline([["HDEL", `nl:tben:given:${statsId}:${person}`, `${call.benefit.id}:sub_adamember01:mlater`]]);
  await redis.pipeline([["HSET", `nl:tben:given:${statsId}:${person}`, `${print.benefit.id}:sub_adamember02:once`, "{not json"]]);
  const failed = await copier(scope).then(() => "copied", () => "failed");
  is("the copy fails instead of leaving it out", failed, "failed");
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
