/**
 * 789 [IV1] step 3, unit 5b (components/publication-choice.tsx): the studio choice where the creator answers whether a
 * product is an e-book, an e-magazine or an e-newspaper, for EU and UK VAT. It holds that:
 *   - it is not shown while EU and UK VAT cannot be collected (both reviewed switches off): before that the answer
 *     changes nothing a buyer sees, and the studio never shows a control that does nothing (rule VR, item 2);
 *   - shown, it is one fieldset with a legend, the help said once and tied to the group, and three labeled radios
 *     (yes, no, not answered), the stored answer checked, each target at least 44px tall;
 *   - while saving, the radios are disabled and the box says it is busy; an error is read out at once;
 *   - it sends only true, false or null, and the editor mounts it beside the other product settings, never on a
 *     shipped product or a live call (goods and calls are refused for other reasons).
 * Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicationChoice, PublicationChoiceView, answerOf } from "@/components/publication-choice";
import { EU_VAT_COLLECT_REVIEWED, UK_VAT_COLLECT_REVIEWED } from "@/lib/vat-registrations";
import type { Product } from "@/lib/store";

const noop = () => {};
// Built with createElement, not JSX, so the file is a .test.ts that tests/run.mjs and CI run (Claude 6's LEVE 2 on #5015).
const view = (answer: "yes" | "no" | "unset", busy = false, error: string | null = null, bundle = false) =>
  renderToStaticMarkup(createElement(PublicationChoiceView, { id: "p1", answer, bundle, busy, error, onChange: noop }));

test("not shown while EU and UK VAT cannot be collected", () => {
  assert.deepEqual([EU_VAT_COLLECT_REVIEWED, UK_VAT_COLLECT_REVIEWED], [false, false]);
  // The real switches: the component answers nothing before it reaches any hook that needs the router.
  assert.equal(PublicationChoice({ product: { id: "p1" } as Product }), null);
});

test("the stored answer maps to one of the three choices", () => {
  assert.deepEqual([answerOf(true), answerOf(false), answerOf(undefined)], ["yes", "no", "unset"]);
});

test("one fieldset with a legend, the help tied to it, and three labeled radios", () => {
  const html = view("unset");
  assert.equal((html.match(/<fieldset/g) ?? []).length, 1);
  assert.match(html, /<fieldset aria-describedby="publication-p1-hint"><legend class="field-label">Is this product an e-book, an e-magazine or an e-newspaper\?<\/legend>/);
  assert.match(html, /<p id="publication-p1-hint"[^>]*>We use your answer to work out the VAT for buyers in the EU and the UK\./);
  assert.equal((html.match(/<input type="radio"[^>]* name="publication-p1"/g) ?? []).length, 3);
  for (const title of ["Yes, it is", "No, it is not", "Not answered yet"]) assert.ok(html.includes(title), title);
  // Every radio sits inside its own label, a target at least 44px tall.
  assert.equal((html.match(/<label class="flex min-h-\[44px\]/g) ?? []).length, 3);
});

test("each choice says what it does: \"Yes\" and \"Not answered yet\" both keep EU and UK buyers out (Claude 6's LEVE 1 on #5015)", () => {
  const html = view("unset");
  assert.match(html, /Yes, it is<\/span><span class="block text-ink-soft">An e-book, an e-magazine or an e-newspaper\. Buyers in the EU and the UK cannot buy it yet\.<\/span>/);
  assert.match(html, /Not answered yet<\/span><span class="block text-ink-soft">Buyers in the EU and the UK cannot buy it until you answer\.<\/span>/);
  assert.equal(html.includes("add the right VAT"), false);
});

test("on a bundle, the help says each product in it needs its own answer", () => {
  assert.match(view("no", false, null, true), /so we never guess\. This is a bundle: each product in it needs its own answer too\.<\/p>/);
  assert.equal(view("no").includes("This is a bundle"), false);
});

test("the stored answer is the one checked", () => {
  for (const [answer, value] of [["yes", "yes"], ["no", "no"], ["unset", "unset"]] as const) {
    const html = view(answer);
    assert.equal((html.match(/checked=""/g) ?? []).length, 1, answer);
    assert.match(html, new RegExp(`checked="" value="${value}"`));
  }
});

test("busy: the radios are disabled and the box says so; an error is read out at once", () => {
  const busy = view("no", true);
  assert.match(busy, /aria-busy="true"/);
  assert.equal((busy.match(/disabled=""/g) ?? []).length, 3);
  const failed = view("no", false, "That answer could not be saved. Pick one of the three choices.");
  assert.match(failed, /<p role="alert"[^>]*>That answer could not be saved\. Pick one of the three choices\.<\/p>/);
  assert.equal(view("no").includes('role="alert"'), false);
});

test("it sends only true, false or null, and the editor mounts it where it belongs", () => {
  const source = readFileSync("components/publication-choice.tsx", "utf8");
  assert.match(source, /const VALUE: Record<PublicationAnswer, boolean \| null> = \{ yes: true, no: false, unset: null \};/);
  assert.match(source, /body: JSON\.stringify\(\{ id: product\.id, publication: VALUE\[next\] \}\)/);
  const editor = readFileSync("components/product-editor.tsx", "utf8");
  assert.match(editor, /\{product\.shipping \|\| product\.call \|\| product\.callPackage \? null : <PublicationChoice product=\{product\} \/>\}/);
});
