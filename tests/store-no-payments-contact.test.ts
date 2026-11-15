/**
 * "This store cannot take payments yet" on a store page and a product page (issue #4306, creator funnel, Claude 1,
 * 12/11/2026). Found by walking main as a new creator on this computer with synthetic services: a new
 * store, with no Stripe account, told every visitor "To buy, write to <store> directly." with no contact
 * form, no address and no link anywhere on the page: an instruction that could not be followed, in all
 * seven buyer languages. Now the note says what is true, and the way to write is a link to the store's
 * contact form, drawn only while that form is on the page (lib/store-contact.ts, contactOpen). Checked in
 * a browser on the same walk: no link with the form off; "Write to Shop" to #contact with it on, from
 * both pages, landing on the form.
 */
import { readFileSync } from "node:fs";
import { wordsIn } from "@/lib/buyer-words";
import { done, is, part } from "./check";

const LANGS = ["en", "es", "fr", "de", "it", "nl", "pt"] as const;

part("What the note says, in every buyer language");
for (const code of LANGS) {
  const w = wordsIn(code);
  is(`${code}: the note names no one to write to`, [typeof w.noPaymentsBody, typeof w.noPaymentsBodyOne], ["string", "string"]);
  is(`${code}: the way to write names the store`, w.noPaymentsWrite("Ana Bakes").includes("Ana Bakes"), true);
}
is("in English, no instruction that cannot be followed", [/write to|directly/i.test(wordsIn("en").noPaymentsBody), /write to|directly/i.test(wordsIn("en").noPaymentsBodyOne)], [false, false]);

part("The link only where the form is");
const store = readFileSync("app/[handle]/page.tsx", "utf8");
const product = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
is("store page: to the form on the same page, only while it is shown", /\{shown\.contact \? <> <a href="#contact"[^>]*>\{w\.noPaymentsWrite\(store\.name\)\}<\/a><\/> : null\}/.test(store), true);
is("store page: the form it points at is the one drawn when contact is shown", [/contact: contactOpen\(store\)/.test(store), readFileSync("components/store-contact-box.tsx", "utf8").includes('<section id="contact"')], [true, true]);
is("product page: to the store page's form, only while it is open", /\{contactOpen\(store\) \? <> <a href=\{`\/@\$\{store\.handle\}#contact`\}[^>]*>\{w\.noPaymentsWrite\(store\.name\)\}<\/a><\/> : null\}/.test(product), true);
is("neither page calls the note with a name any more", [/noPaymentsBody(One)?\(/.test(store), /noPaymentsBody(One)?\(/.test(product)], [false, false]);

done();
