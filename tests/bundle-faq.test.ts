/**
 * The questions someone starting out asks about bundles (534 [FQ1], unit 11,
 * lib/bundle-faq.ts; added 2 November 2026). Checked: the studio's and the
 * editor's own words, read from their files; how many go in and which, from
 * canBeInBundle and whyNotInBundle; the saving line shown only when true; the
 * shared trial answer in both states; no figure; first in the page's own
 * Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { BUNDLE_WORDS, bundleBeginnerQuestions } from "@/lib/bundle-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { MIN_BUNDLE_ITEMS, canBeInBundle, itemsProblem, worthWords } from "@/lib/bundle-rules";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
type L = Parameters<typeof canBeInBundle>[0];
const listing = (over: Partial<L>) => ({ priceCents: 2_700, recurring: null, call: null, bundle: null, options: [], pwyw: null, course: null, file: { name: "a.pdf" }, link: null, stock: null, ...over }) as unknown as L;

part("The studio's own words");
const editor = flat(read("components/bundle-editor.tsx"));
const page = flat(read("app/studio/bundles/page.tsx"));
is("Bundles in the studio's tools, and its New bundle", [flat(read("app/studio/page.tsx")).includes(`title: "${BUNDLE_WORDS.page}"`), page.includes(BUNDLE_WORDS.start)], [true, true]);
is("the editor's name field, its search label, the Add beside each product and its button for a new bundle", [editor.includes(`>${BUNDLE_WORDS.name}</span>`), /htmlFor="bundle-find"[^>]*>\s*Add your products\s*</.test(editor), /<Icon name="plus" size=\{14\} \/> Add\s*</.test(editor), editor.includes(`mode === "create" ? "${BUNDLE_WORDS.add}"`)], [true, true, true, true]);
is("what can go in: paid, once, one set price, a file, a link or a course with lessons; not a named price nor another bundle", [canBeInBundle(listing({})), canBeInBundle(listing({ file: null, link: "https://example.com" } as Partial<L>)), canBeInBundle(listing({ priceCents: 0 })), canBeInBundle(listing({ file: null })), canBeInBundle(listing({ pwyw: { minCents: 100 } } as unknown as Partial<L>)), canBeInBundle(listing({ bundle: ["x", "y"] } as unknown as Partial<L>))], [true, true, false, false, false, false]);
is("a product with a limited number for sale is refused, and a bundle needs at least the minimum", [itemsProblem(["a", "b"], [{ ...listing({ stock: 50 } as Partial<L>), id: "a" }, { ...listing({}), id: "b" }] as L[]), itemsProblem(["a"], [{ ...listing({}), id: "a" }] as L[])], ["kind", "count"]);
is("drafts can go in, and the editor marks them", [canBeInBundle(listing({ hidden: true } as unknown as Partial<L>)), editor.includes("Draft, sold only in bundles")], [true, true]);
is("the store shows the saving line only on a bundle the buyer does not build", flat(read("app/[handle]/p/[product]/page.tsx")).includes("inside && product.bundle && !pick ? worthLine("), true);
is("the saving line only when the products really cost more", [worthWords([{ priceCents: 3_000 }, { priceCents: 3_000 }], 4_900, "usd"), worthWords([{ priceCents: 2_000 }, { priceCents: 2_000 }], 4_900, "usd")], ["$60 of products for $49", null]);

part("The answers");
const now = bundleBeginnerQuestions(false);
const later = bundleBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What is a bundle here?", "How do I start one?", "Can I try it before paying?", "Do bundles sell more?"]);
is("how many from the code, and the buyer who chooses gets only those", [answer(now, "What is a bundle here?").startsWith(`A bundle is ${MIN_BUNDLE_ITEMS} to `), answer(now, "What is a bundle here?").includes("and they get only those")], [true, true]);
is("start: the studio's and editor's own words, in order", (() => { const a = answer(now, "How do I start one?"); const at = [BUNDLE_WORDS.page, BUNDLE_WORDS.start, BUNDLE_WORDS.name, BUNDLE_WORDS.find, BUNDLE_WORDS.pick, BUNDLE_WORDS.add].map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), true);
is("start: what can go in, each kept out by the rules named", ["one set price", "not pay what you want, not another bundle", "a file, a link or a course with lessons", "no limited number for sale", "Drafts can go in too", `at least ${MIN_BUNDLE_ITEMS} of them`].every((w) => answer(now, "How do I start one?").includes(w)), true);
is("try before paying: the one shared answer, in a bundle's words", [answer(now, "Can I try it before paying?"), answer(later, "Can I try it before paying?")], [tryBeforePaying("A bundle", "a bundle of your products", false), tryBeforePaying("A bundle", "a bundle of your products", true, TRIAL_DAYS)]);
is("sell more: no figure, the saving line said as the code shows it", [answer(now, "Do bundles sell more?").startsWith("We publish no number"), answer(now, "Do bundles sell more?").includes(`like “${worthWords([{ priceCents: 3_000 }, { priceCents: 3_000 }], 4_900, "usd")}”, appears only when they really cost more than the bundle; when buyers choose, it counts only the ones they chose`)], [true, true]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of sales or buyers, no percent, no result promised", /\b\d+\s+(sales|buyers|creators)|%|guarantee|proven|results?\b/i.test(all), false);

part("On the bundles page");
const faq = (findPage("platform", "bundles")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
