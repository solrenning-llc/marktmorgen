/**
 * WCAG 1.3.1 and 2.4.1 on the email sign-up card a creator's site opens
 * with the checkout script (app/embed/[handle]/join): opened in the script's
 * frame, as on a page of its own, the card is the page's one main landmark
 * (id "content", where every skip link points), as the product card is
 * (app/embed/[handle]/[product]). The page waits for the request
 * (connection()), so it is not rendered here: the one function that wraps
 * its body, in both modes, is read from its source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("app/embed/[handle]/join/page.tsx", "utf8");
const shell = source.match(/const shell = \(body: React\.ReactNode[\s\S]*?\n {4}\);\n/);
assert.ok(shell, "the sign-up card still wraps its body in one shell, framed or as a page");
const [framed, page] = shell[0].split(/\n {4}\) : \(\n/);
assert.ok(framed && page, "the shell has its framed and its page branch");
for (const [mode, branch] of [["framed", framed], ["as a page", page]] as const) {
  const mains = [...branch.matchAll(/<main\b[^>]*>/g)].map(([tag]) => tag);
  assert.equal(mains.length, 1, `${mode}: the card is in exactly one main landmark`);
  assert.match(mains[0], /id="content"/, `${mode}: the main landmark is #content, where the skip link points`);
  assert.ok(branch.indexOf("<main") < branch.indexOf("{body}") && branch.indexOf("{body}") < branch.indexOf("</main>"), `${mode}: the card's words are inside it`);
}
console.log("Embed sign-up card: one main landmark, #content, framed and as a page");
