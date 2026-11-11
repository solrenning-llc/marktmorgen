/**
 * Removing a product from its card on the studio's start page, from a
 * keyboard (components/product-editor.tsx; AX274 Part A; WCAG 2.2 2.4.3 Focus
 * Order, 4.1.3, 3.3.4/3.3.6). Seen in Chromium on 11 November 2026, keyboard
 * only: Enter on a card's "Remove" swapped the button for the question
 * ("Remove <product> from your store. Its files … cannot be brought back") and
 * the focus fell to the page's body; the question was not read out, and
 * "Keep it" dropped the focus there again. The options editor in the same
 * file already does it right (its removeSaid / refocusRemove); the product
 * card now does the same:
 *
 * - opening the question puts the focus on it, so it is read at once;
 * - "Keep it" puts the focus back on that product's "Remove";
 * - once the product is removed, the focus goes to "Add something to sell"
 *   when it can take it, else to the next product's "Edit".
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const editor = readFileSync("components/product-editor.tsx", "utf8");
const main = editor.slice(editor.indexOf("export function ProductEditor("));

const askAt = main.indexOf("Remove{\" \"}\n                      <strong className=\"text-ink\">{product.title}</strong>");
const question = main.slice(main.lastIndexOf("<p ", askAt), askAt);
is("the card's remove question is found", askAt > 0, true);
is("the question can take the focus, so it is read at once", /<p ref=\{productRemoveAsked\} tabIndex=\{-1\}/.test(question), true);

const removeAt = main.indexOf("setRemovingId(product.id);");
const removeButton = main.slice(main.lastIndexOf("<button", removeAt), main.indexOf("</button>", removeAt));
is("each card's Remove has an id of its own", removeButton.includes("id={`product-remove-${product.id}`}"), true);

const keepAt = main.indexOf("Keep it", askAt);
const keep = main.slice(main.lastIndexOf("<button", keepAt), keepAt);
is("Keep it marks that the focus goes back to Remove", /onClick=\{\(\) => \{\s*productRemoveKept\.current = true;\s*setRemovingId\(null\);\s*\}\}/.test(keep), true);

is("Add something to sell has an id, so the focus can go there after a removal", /<button\s+id="product-add"\s+type="button"[\s\S]{0,120}onClick=\{startAdding\}/.test(main), true);

const effect = /useEffect\(\(\) => \{\s*const was = productRemovedLast\.current;\s*productRemovedLast\.current = removingId;\s*if \(was === removingId\) return;\s*if \(removingId !== null\) \{\s*productRemoveAsked\.current\?\.focus\(\);\s*return;\s*\}\s*if \(was === null\) return;\s*if \(productRemoveKept\.current\) \{\s*productRemoveKept\.current = false;\s*requestAnimationFrame\(\(\) => document\.getElementById\(`product-remove-\$\{was\}`\)\?\.focus\(\)\);\s*return;\s*\}\s*requestAnimationFrame\(\(\) => \{\s*const add = document\.getElementById\("product-add"\) as HTMLButtonElement \| null;\s*if \(add && !add\.disabled\) add\.focus\(\);\s*else document\.querySelector<HTMLElement>\(`\[id\^="product-edit-"\]:not\(#product-edit-\$\{was\}\)`\)\?\.focus\(\);\s*\}\);\s*\}, \[removingId\]\);/;
is("the focus follows the question: onto it, back to Remove on Keep it, on to Add or the next Edit once removed", effect.test(main), true);

// Claude 4 (cloud L)'s review of this PR: a removal the server refuses.
const yesAt = main.indexOf('"Yes, remove it"');
const yes = main.slice(main.lastIndexOf("<button", yesAt), yesAt);
is("Yes, remove it is never turned off under the focus while it sends; it says it is busy", /(?<![-\w])disabled=\{/.test(yes), false);
is("it is marked unavailable while it sends, and a press then does nothing", /aria-disabled=\{busy \|\| undefined\}/.test(yes) && /onClick=\{\(\) => \{\s*if \(busy\) return;/.test(yes), true);
const questionBlock = main.slice(main.indexOf("{removingId === product.id ? (\n                  <div"), main.indexOf("{open ? (", askAt));
is("a refused removal is said inside the question, which stays open", /\{error \? \(\s*<p className="notice notice-error mt-3" role="alert">\s*\{error\}\s*<\/p>\s*\) : null\}/.test(questionBlock), true);

done();
