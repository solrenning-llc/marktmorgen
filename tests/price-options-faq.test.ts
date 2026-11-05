/**
 * The questions someone starting out asks about price options (534 [FQ1],
 * unit 10, lib/price-options-faq.ts; added 2 November 2026). Checked: the
 * product editor's own words, read from its file; the most options; what the
 * server refuses an option on; the checkout reading the price from what was
 * saved; the shared trial answer in both states; no figure; first in the
 * page's own Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { OPTION_WORDS, optionsBeginnerQuestions } from "@/lib/price-options-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { MAX_OPTIONS, comparable } from "@/lib/product-option";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const editor = flat(read("components/product-editor.tsx"));
is("the editor's buttons and its field", Object.values(OPTION_WORDS).every((w) => editor.includes(w)), true);
is("the first button for a product with no option yet, then the next", /options\.length === 0\s*\?\s*"Sell it at several prices"\s*:\s*"Add another price"/.test(editor), true);
is("the most options on one product, the same 50 the page's menu and steps write by hand", [MAX_OPTIONS, JSON.stringify(findPage("platform", "price-options")).includes("Add up to 50 options")], [50, true]);
is("they compare side by side only when at least two say what they include, and become a list above six", [comparable([{ details: ["a"] }, { details: [] }] as unknown as Parameters<typeof comparable>[0]), comparable([{ details: [] }, { details: [] }] as unknown as Parameters<typeof comparable>[0]), /const LIST_ABOVE = 6;/.test(read("components/store-product.tsx"))], [true, false, true]);
const store = flat(read("lib/store.ts"));
const add = store.slice(store.indexOf("export async function addOption("), store.indexOf("export async function addOption(") + 2500);
is("what the server refuses an option on: free, a call, a course or podcast sold as a membership, a bundle, a named price", [/isFree\(product\)\)\s*return \{ ok: false, reason: "free"/.test(add), /product\.call\)\s*return \{ ok: false, reason: "call"/.test(add), /\(product\.course \|\| product\.podcast\) && product\.recurring\)\s*return \{ ok: false, reason: "course"/.test(add), /isBundle\(product\)\)\s*return \{ ok: false, reason: "bundle"/.test(add), /product\.pwyw\)\s*return \{ ok: false, reason: "pwyw"/.test(add)], [true, true, true, true, true]);
is("on a course, a podcast or something shipped, an option opens it or is a size, not a delivery of its own", [editor.includes("const opens = Boolean(product.course || product.podcast || product.shipping);"), editor.includes("const shipped = Boolean(product.shipping);")], [true, true]);
is("the checkout charges the saved option's price, or its payment plan's", /const priceCents = plan \? plan\.amountCents : chosen \? chosen\.priceCents : product\.priceCents;/.test(flat(read("lib/store-checkout.ts"))), true);

part("The answers");
const now = optionsBeginnerQuestions(false);
const later = optionsBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What are price options here?", "How do I add price options?", "Can I try price options before paying?", "Do price options sell more?"]);
is("the most options from the code, the comparison and the list said with their conditions, and what a course, podcast or shipped product hands over", [answer(now, "What are price options here?").startsWith(`Up to ${MAX_OPTIONS} prices on one product`), answer(now, "What are price options here?").includes("Write what each one includes and they stand side by side to compare; more than six become a list"), answer(now, "What are price options here?").includes("on a course or podcast every price opens it, and on a product you ship each is a size or a version")], [true, true, true]);
is("start: the editor's own words, in order", (() => { const a = answer(now, "How do I add price options?"); const at = [OPTION_WORDS.first, OPTION_WORDS.what, OPTION_WORDS.add, OPTION_WORDS.next].map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), true);
is("start: each kind the server refuses is named", ["something free", "a call", "a bundle", "a course or podcast sold as a membership", "names the price"].every((w) => answer(now, "How do I add price options?").includes(w)), true);
is("try before paying: the one shared answer, in price options' words", [answer(now, "Can I try price options before paying?"), answer(later, "Can I try price options before paying?")], [tryBeforePaying("Price options", "a product's price options", false), tryBeforePaying("Price options", "a product's price options", true, TRIAL_DAYS)]);
is("sell more: no figure, how the price is charged", [answer(now, "Do price options sell more?").startsWith("We publish no number"), answer(now, "Do price options sell more?").includes("what is charged is read from the option you saved, never from the page")], [true, true]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of sales or buyers, no percent, no result promised", /\b\d+\s+(sales|buyers|creators)|%|guarantee|proven|results?\b/i.test(all), false);

part("On the price options page");
const faq = (findPage("platform", "price-options")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
