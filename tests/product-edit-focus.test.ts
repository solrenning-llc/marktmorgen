/**
 * Editing a product from its card on the studio's start page, from a keyboard
 * (components/product-editor.tsx; AX274 Part A; WCAG 2.2 2.4.3 Focus Order).
 * Seen in Chromium on 11 November 2026, keyboard only: Enter on a card's
 * "Edit" swapped the card for the edit form, and the focus fell to the page's
 * body, since the button it was on was gone; Cancel, and a save, took the form
 * away and dropped it there again.
 *
 * Now the focus follows the form: into its first field, "What you are
 * selling", when it opens, and back to that product's "Edit" when it closes,
 * by Cancel or by a save. Checked against the source here; where the focus
 * lands in a browser is in the pull request.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const editor = readFileSync("components/product-editor.tsx", "utf8");

const editAt = editor.indexOf("onClick={() => startEditing(product)}");
const editButton = editor.slice(editor.lastIndexOf("<button", editAt), editor.indexOf("</button>", editAt));
is("the card's Edit button is found", editAt > 0 && editButton.includes("Edit"), true);
is("it has an id of its own per product, so the focus can come back to it", editButton.includes("id={`product-edit-${product.id}`}"), true);

const effect = /useEffect\(\(\) => \{\s*const was = editedLast\.current;\s*editedLast\.current = editingId;\s*if \(was === editingId\) return;\s*if \(editingId !== null\) requestAnimationFrame\(\(\) => document\.getElementById\(`product-title-\$\{editingId\}`\)\?\.focus\(\)\);\s*else if \(was !== null && !adding\) requestAnimationFrame\(\(\) => document\.getElementById\(`product-edit-\$\{was\}`\)\?\.focus\(\)\);\s*\}, \[editingId, adding\]\);/;
is("opening the form puts the focus in its first field; closing it puts it back on that product's Edit", effect.test(editor), true);
is("but not when the edit closed because a new product is being added: that form keeps the focus", /else if \(was !== null && !adding\)/.test(editor), true);
is("the field it goes to is the form's first, What you are selling", /htmlFor=\{`product-title-\$\{id\}`\}[\s\S]{0,80}What you are selling/.test(editor), true);

done();
