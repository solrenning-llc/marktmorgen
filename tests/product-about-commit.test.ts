/**
 * Codex N1 on #4238 @5a1cf14ebd (MEDIUM, integrity): editProduct wrote the description inside its change, before the
 * catalog commit. When that commit then failed, the save answered as failed, yet the new description was kept while the
 * product's `rev` had not moved, so another tab open on that `rev` still looked current and could write over it.
 * The description and the product's record (which carries `rev`) must land together or not at all. Synthetic store,
 * in-memory Redis, no provider.
 */
import { addProduct, claimHandle, editProduct, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { readAbout } from "@/lib/product-about";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = async () => { throw Error("No external provider in this test"); };

type Commands = (string | number)[][];

async function main() {
  redis.clear();
  const owner = "about-commit@example.test";
  await claimHandle(owner, "about-commit", "Synthetic store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_AboutCommit", true);
  await setSubscription(owner, { customerId: "cus_AboutCommit", subscriptionId: "sub_AboutCommit", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Weekly letters", "One letter a week.", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw Error("The product fixture failed");
  const id = made.product.id;
  const edit = (rev: number, about: string) =>
    editProduct(owner, id, "Weekly letters", "One letter a week.", "20", made.product.recurring, null, rev, { about });
  const state = async () => {
    const shop = (await storeForEmail(owner))!;
    return { about: await readAbout(shop.statsId, id), rev: (await readProduct(shop, id))?.rev ?? 0 };
  };

  const first = await edit(made.product.rev ?? 0, "The old description.");
  if (!first.ok) throw Error("The first description failed");
  const before = await state();
  is("control: the old description is saved", before.about, "The old description.");

  part("The catalog commit fails where the product's record is written: nothing of the save is kept");
  const pipeline = redis.pipeline.bind(redis);
  let failed = 0;
  redis.pipeline = (async (commands: Commands) => {
    const writesProduct = commands.some((command) =>
      (command[0] === "SET" && /^nl:catalog:[^:]+:l:/.test(String(command[1]))) ||
      (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:product-with-about:")),
    );
    if (writesProduct && failed === 0) {
      failed += 1;
      throw Error("synthetic Redis failure on the catalog commit");
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
  let answer: string;
  try {
    const result = await edit(before.rev, "The new description.");
    answer = result.ok ? "saved" : result.reason;
  } catch {
    answer = "threw";
  } finally {
    redis.pipeline = pipeline;
  }
  const after = await state();
  is("the commit failed, and the save did not answer saved", [failed, answer === "saved"], [1, false]);
  is("the description and the revision are both as before", after, before);

  part("Control: the same save with Redis answering writes both, and moves the revision once");
  const saved = await edit(before.rev, "The new description.");
  is("saved", saved.ok, true);
  is("the new description with the next revision", await state(), { about: "The new description.", rev: before.rev + 1 });
  done();
}

void main();
