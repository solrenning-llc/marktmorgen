/**
 * Rule 24 on the embedded product card (app/embed/[handle]/[product]/page.tsx),
 * the LOW the review of #3192 found beside it. The card read three things that
 * decide whether it sells, and turned a failed read into "on sale":
 * coming soon (soonOne → not soon), stock (stockLeft → no limit) and licence
 * keys (outOfKeys → keys left). Then it could draw a buy button, or the
 * embedded calendar with its times, for a product that may not be launched or
 * may be sold out. Now any of the three unknown makes the card say buying is
 * not available just now (cardBuyUnread, as main already did for coming soon
 * and keys): no checkout and no calendar in the frame, and its title still
 * leads to the product's own page.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const card = readFileSync("app/embed/[handle]/[product]/page.tsx", "utf8");

part("No failed read is taken for \"on sale\"");
is("coming soon: a failed read is unknown (null), not \"not soon\"", card.includes("soonOne(store, product.id).catch(() => null)"), true);
is("stock: a failed read is its own mark, never \"no limit\" (null)", card.includes("stockLeft(store, product).catch(() => UNREAD)"), true);
is("keys: a failed read is unknown (null), not \"keys left\"", card.includes("outOfKeys(store, product).catch(() => null)"), true);
is("none of the old fallbacks is left", [/soonOne\([^)]*\)\.catch\(\(\) => \(\{ soon: false/, /stockLeft\([^)]*\)\.catch\(\(\) => null\)/, /outOfKeys\([^)]*\)\.catch\(\(\) => false\)/].some((old) => old.test(card)), false);

part("Unknown stock draws no buy button");
is("a failed stock read is `stockUnread`", card.includes("const stockUnread = stock === UNREAD;"), true);
is("how many are left is not said then", card.includes("const count = noKeys === null || stockUnread ? null : noKeys ? 0 : stock;"), true);
is("pageAction runs only when all three were read", card.includes("const computed = coming && noKeys !== null && !stockUnread\n    ? pageAction("), true);
is("otherwise the card says buying is not available just now: no checkout, no calendar", card.includes(': { action: { kind: "none" as const, text: speech(store).w.cardBuyUnread }, label: "" };'), true);

done();
