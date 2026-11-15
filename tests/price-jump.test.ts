/**
 * 569 [NC1], complement (b) of 2 November 2026: a price typed wrong by the
 * creator. A published product's price saved at PRICE_JUMP_FACTOR times or
 * more, or a PRICE_JUMP_FACTOR-th or less, of its price now is a likely typo
 * ($1,000 for $10.00, $1 for $100): buyers would be charged it at once. The
 * studio's "Check what buyers pay" already shows every price change before it
 * is saved (lib/price-review.ts); this makes the big jump say so, and makes the
 * server refuse it unless the save names the new price exactly, so a stale
 * tab or a script cannot skip the check.
 *
 * What fails here:
 *   - a jump of 10 times up or down that is saved without its confirmation, or
 *     with the confirmation of another amount;
 *   - a smaller change, a draft, a first price or a move to free that is asked
 *     to confirm (nothing a buyer is charged needs it);
 *   - the check made outside the store's lock (it reads the price now under it);
 *   - the route not passing what the creator confirmed, or the studio not
 *     saying the jump and sending it.
 */
import { readFileSync } from "node:fs";
import { PRICE_JUMP_FACTOR, confirmedPrice, priceJump, priceJumpWords } from "@/lib/price-jump-rules";
import { addProduct, claimHandle, editProduct, setProductHidden, setSubscription } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";

async function main(): Promise<void> {
  part("The rule");
  is("the factor is ten", PRICE_JUMP_FACTOR, 10);
  is("$10 to $100 is a jump up of 10 times", priceJump(1000, 10000), { way: "up", times: 10 });
  is("$10 to $1,000 is 100 times", priceJump(1000, 100000), { way: "up", times: 100 });
  is("$100 to $10 is a jump down of 10 times", priceJump(10000, 1000), { way: "down", times: 10 });
  is("$100 to $1 is 100 times down", priceJump(10000, 100), { way: "down", times: 100 });
  is("$10 to $99.99 is not", priceJump(1000, 9999), null);
  is("$100 to $10.01 is not", priceJump(10000, 1001), null);
  is("a first price (from free) is not", priceJump(0, 100000), null);
  is("a move to free is not", priceJump(10000, 0), null);
  is("the same price is not", priceJump(1000, 1000), null);
  is("an unreadable price is not judged here", [priceJump(Number.NaN, 1000), priceJump(1000, -5), priceJump(1.5, 1000)], [null, null, null]);
  is("a confirmation names the new price exactly", [confirmedPrice(100000), confirmedPrice("100000"), confirmedPrice(1.5), confirmedPrice(-1), confirmedPrice(null), confirmedPrice(undefined)], [100000, 100000, null, null, null, null]);
  const said = priceJumpWords({ way: "up", times: 100 }, "$10.00", "$1,000.00");
  is("the words say both prices and how many times", [said.includes("$10.00"), said.includes("$1,000.00"), said.includes("100 times")], [true, true, true]);
  is("down says less", priceJumpWords({ way: "down", times: 10 }, "$100.00", "$10.00").includes("a tenth"), true);

  part("The save, under the store's lock");
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_price_jump_only_a_stand_in";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Workbook", "", "10", null);
  if (!made.ok) throw new Error("the product was not added");
  const id = made.product.id;
  const priceNow = async () => (await readListing((await storeForEmail(OWNER))!, id))?.priceCents;

  const unconfirmed = await editProduct(OWNER, id, "Workbook", "", "1000", null, null, { confirmedCents: null });
  is("$10 to $1,000 without confirming is refused, with both prices", unconfirmed.ok ? "saved" : [unconfirmed.reason, unconfirmed.priceJump], ["price_check", { beforeCents: 1000, afterCents: 100000, way: "up", times: 100 }]);
  is("and the price stays $10", await priceNow(), 1000);
  const other = await editProduct(OWNER, id, "Workbook", "", "1000", null, null, { confirmedCents: 10000 });
  is("confirming another amount is refused", other.ok ? "saved" : other.reason, "price_check");
  is("and the price stays $10", await priceNow(), 1000);
  const small = await editProduct(OWNER, id, "Workbook", "", "25", null, null, { confirmedCents: null });
  is("$10 to $25 needs no confirmation", small.ok, true);
  const confirmed = await editProduct(OWNER, id, "Workbook", "", "1000", null, null, { confirmedCents: 100000 });
  is("$25 to $1,000 confirmed at exactly $1,000 is saved", [confirmed.ok, await priceNow()], [true, 100000]);
  const down = await editProduct(OWNER, id, "Workbook", "", "1", null, null, { confirmedCents: null });
  is("$1,000 to $1 without confirming is refused", down.ok ? "saved" : down.reason, "price_check");
  const free = await editProduct(OWNER, id, "Workbook", "", "0", null, null, { confirmedCents: null });
  is("$1,000 to free needs no confirmation (nobody is charged)", free.ok, true);
  await editProduct(OWNER, id, "Workbook", "", "10", null, null, { confirmedCents: null });
  is("free to $10 needs none either", await priceNow(), 1000);
  const hidden = await setProductHidden(OWNER, id, true);
  is("hidden as a draft", hidden.ok, true);
  const draft = await editProduct(OWNER, id, "Workbook", "", "1000", null, null, { confirmedCents: null });
  is("a draft, which no buyer can pay for, needs none", draft.ok, true);
  await setProductHidden(OWNER, id, false);
  const internal = await editProduct(OWNER, id, "Workbook", "", "10");
  is("a save from the code itself (no check asked, the demo's reset) is not held", internal.ok, true);

  part("The route and the studio");
  const route = readFileSync("app/api/store/product/route.ts", "utf8");
  is("the route passes what the creator confirmed", /editProduct\(ref, id, title, summary, price, recurring, suggested, \{ confirmedCents: confirmedPrice\(body\.confirmPrice\) \}\)/.test(route), true);
  is("the route answers price_check with both prices", /priceJump: result\.priceJump/.test(route), true);
  const store = readFileSync("lib/store.ts", "utf8");
  is("the price now is read under the lock (inside onProduct)", /onProduct<[^>]*"price_check"/.test(store) && /priceJump\(product\.priceCents, fields\.priceCents\)/.test(store), true);
  const editor = readFileSync("components/product-editor.tsx", "utf8");
  is("the studio sends the price it showed", /confirmPrice:/.test(editor), true);
  is("the studio says a price_check refusal in words", /data\.error === "price_check"/.test(editor), true);
  const review = readFileSync("lib/price-review.ts", "utf8");
  is("Check what buyers pay says the jump", /priceJumpWords\(/.test(review), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
