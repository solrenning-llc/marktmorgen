/**
 * Rule 24 on the embedded product card (app/embed/[handle]/[product]/page.tsx),
 * the LOW the review of #3192 found beside it. The card read three things that
 * decide whether it sells, and turned a failed read into "on sale":
 * coming soon (soonOne → not soon), stock (stockLeft → no limit) and licence
 * keys (outOfKeys → keys left). Then it could draw a buy button, or the
 * embedded calendar with its times, for a product that may not be launched or
 * may be sold out. Now any of the three unknown makes the card a plain link to
 * the product's own page, which decides on its own reading: no checkout, and
 * no calendar in the frame (it opens only on a link to the booking page).
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const card = readFileSync("app/embed/[handle]/[product]/page.tsx", "utf8");

part("No failed read is taken for \"on sale\"");
is("coming soon: a failed read is unknown (null), not \"not soon\"", card.includes("soonOne(store, product.id).catch(() => null)"), true);
is("stock: a failed read is its own mark, never \"no limit\" (null)", card.includes("stockLeft(store, product).catch(() => UNREAD)"), true);
is("keys: a failed read is unknown (null), not \"keys left\"", card.includes("outOfKeys(store, product).catch(() => null)"), true);
is("none of the old fallbacks is left", [/soonOne\([^)]*\)\.catch\(\(\) => \(\{ soon: false/, /stockLeft\([^)]*\)\.catch\(\(\) => null\)/, /outOfKeys\([^)]*\)\.catch\(\(\) => false\)/].some((old) => old.test(card)), false);

part("Unknown makes the card a link to the product's own page");
is("any of the three unknown is `unread`", /const unread = coming === null \|\| stock === UNREAD \|\| noKeys === null;/.test(card), true);
is("its action is the product's page, whatever pageAction said: no checkout", card.includes("unread ? { action: { kind: \"link\" as const, href: productPath(store, product) }, label: computed.label }"), true);
is("so no calendar either: the calendar opens only on a link to the booking page", /action\.kind === "link" && action\.href === `\/@\$\{store\.handle\}\/book\/\$\{product\.id\}`/.test(card), true);

done();
