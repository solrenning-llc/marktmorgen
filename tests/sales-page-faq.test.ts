/**
 * The questions someone starting out asks about sales pages (534 [FQ1], unit
 * 9, lib/sales-page-faq.ts; added 2 November 2026). Checked: the studio's and
 * the editor's own words, read from their files; the most blocks; the page
 * coach's score and what it counts, and when; the shared trial answer in both
 * states; no figure; first in the page's own Questions block, no question
 * asked twice.
 */
import { readFileSync } from "node:fs";
import { SALES_PAGE_WORDS, salesPageBeginnerQuestions } from "@/lib/sales-page-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { MAX_BLOCKS } from "@/lib/sales-page";
import { coachScore } from "@/lib/page-coach";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const editor = flat(read("components/page-editor.tsx"));
const studio = flat(read("app/studio/page.tsx"));
const coach = flat(read("components/page-coach.tsx"));
const pages = flat(read("app/studio/pages/page.tsx"));
is("Sales pages in the studio's tools, a list of products, and the case with none", [studio.includes(`title: "${SALES_PAGE_WORDS.list}"`), pages.includes('<nav aria-label="Products"'), pages.includes("Nothing to build a page for yet")], [true, true, true]);
is("the editor's words to start a page, shown while it has no blocks", [[SALES_PAGE_WORDS.start, SALES_PAGE_WORDS.fromDescription, SALES_PAGE_WORDS.template, SALES_PAGE_WORDS.useTemplate].every((w) => editor.includes(w)), /drafts\.length === 0 \? \(/.test(editor)], [true, true]);
is("the save button's own label", /busy \? "Saving…" : "Save the page"/.test(editor), true);
is("saving a page waits on the role, not a plan", /isPaidUp|canSell\(/.test(read("app/api/store/page/route.ts")), false);
is("the coach's score is out of 100", [coachScore([{ weight: 1, done: true }, { weight: 1, done: false }] as unknown as Parameters<typeof coachScore>[0]), coach.includes("out of 100")], [50, true]);
is("its last 30 days show only once the page was opened", /traffic && traffic\.views > 0/.test(coach), true);
is("the checkout and the email form both wait for a paid-up store", [flat(read("lib/store-checkout.ts")).includes("isPaidUp(store) &&"), flat(read("lib/free.ts")).includes("isPaidUp(store) &&")], [true, true]);

part("The answers");
const now = salesPageBeginnerQuestions(false);
const later = salesPageBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What is a sales page here?", "How do I start a sales page?", "Can I try sales pages before paying?", "Do sales pages work?"]);
is("the most blocks from the code", answer(now, "What is a sales page here?").includes(`up to ${MAX_BLOCKS} blocks`), true);
is("start: the studio's and the editor's own words, in order", (() => { const a = answer(now, "How do I start a sales page?"); const at = Object.values(SALES_PAGE_WORDS).map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), true);
is("try before paying: the one shared answer, in a sales page's words", [answer(now, "Can I try sales pages before paying?"), answer(later, "Can I try sales pages before paying?")], [tryBeforePaying("A sales page", "a product's sales page", false), tryBeforePaying("A sales page", "a product's sales page", true, TRIAL_DAYS)]);
is("the buttons and the email form said for when the store is paid up, and today's state while plans are off sale", [answer(now, "What is a sales page here?").includes("Once your Stripe account is connected and your plan is running, the trial included, its buttons lead to the checkout"), answer(now, "What is a sales page here?").endsWith("Paid plans are not on sale yet, so today no page takes a payment or an email."), answer(later, "What is a sales page here?").includes("not on sale")], [true, true, false]);
is("does it work: no figure, the coach's own counts, sign-ups for something free", [answer(now, "Do sales pages work?").startsWith("We publish no number"), answer(now, "Do sales pages work?").includes("once the page has been opened and your numbers can be read"), answer(now, "Do sales pages work?").includes("or sign-ups for something free")], [true, true, true]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of pages, visits or sales, no percent, no result promised", /\b\d+\s+(pages|visits|visitors|sales|creators)|%|guarantee|proven|results?\b/i.test(all), false);

part("On the sales pages page");
const faq = (findPage("platform", "sales-pages")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
