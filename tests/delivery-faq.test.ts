/**
 * The questions someone starting out asks about instant delivery (534 [FQ1],
 * unit 6, lib/delivery-faq.ts; added 2 November 2026). Checked: the product
 * editor's own buttons and labels for a file or a link, read from its file;
 * the largest file; the store's "Get it again"; the download refusing an
 * unpaid or refunded order; the shared trial answer in both states; no
 * figure; first in the page's own Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { DELIVERY_EDITOR_WORDS, deliveryBeginnerQuestions } from "@/lib/delivery-faq";
import { tryBeforePaying, uploadsWait } from "@/lib/beginner-faq";
import { maxFileLabel } from "@/lib/product-file";
import { AUTOMATIC_UPLOAD_CAPS } from "@/lib/upload-budget-policy";
import { en } from "@/lib/buyer-words/en";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const editor = flat(read("components/product-editor.tsx"));
is("the editor's buttons and label for a file or a link, shown while it hands over nothing", [Object.values(DELIVERY_EDITOR_WORDS).every((w) => editor.includes(w)), editor.includes("Nothing on this yet")], [true, true]);
is("the largest file, from the code", maxFileLabel().length > 0 && answer(deliveryBeginnerQuestions(false), "How do I start one?").includes(`up to ${maxFileLabel()}`), true);
is("getting it back emails a link to a page of purchases, kept a while", [read("lib/buyer-orders.ts").includes("ORDERS_LINK_SECONDS"), answer(deliveryBeginnerQuestions(false), "What is instant delivery here?").includes("emails the address they paid with a link to what it bought here")], [true, true]);
is("a pre-order is handed over the day the product goes on sale", flat(read("lib/preorders.ts")).includes("The day the product goes on sale it is handed over"), true);
const route = flat(read("app/api/store/download/route.ts"));
is("the download refuses an unpaid order and a refunded one", [/unpaid: 402/.test(route), /refunded: 410/.test(route)], [true, true]);
is("free files and the free first pages exist, so the refusal is said of paid files only", [JSON.stringify(findPage("platform", "instant-delivery")).includes("The first pages, free to read"), answer(deliveryBeginnerQuestions(false), "Does instant delivery work?").includes("a paid file is never handed over")], [true, true]);

part("The answers");
const now = deliveryBeginnerQuestions(false);
const later = deliveryBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What is instant delivery here?", "How do I start one?", "Can I try it before paying?", "Does instant delivery work?"]);
is("start: the link first, which needs no upload, then the file, each in the editor's own words", (() => { const a = answer(now, "How do I start one?"); const at = [DELIVERY_EDITOR_WORDS.link, DELIVERY_EDITOR_WORDS.where, DELIVERY_EDITOR_WORDS.save, DELIVERY_EDITOR_WORDS.file].map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), true);
is("and says beside the file that uploads wait for a paid plan, from the policy", [AUTOMATIC_UPLOAD_CAPS.setup.opens, AUTOMATIC_UPLOAD_CAPS.trial.opens, answer(now, "How do I start one?").endsWith("; files can be uploaded once a paid plan starts."), flat(read("lib/upload-budget-policy.ts")).includes("New product and lesson file uploads start with a paid plan.")], [0, 0, true, true]);
is("the buttons show on each price option too", editor.includes("Nothing on this yet") && /options/.test(answer(now, "How do I start one?")), true);
is("try before paying: the one shared answer, in delivery's words, with uploads as the policy has them", [answer(now, "Can I try it before paying?"), answer(later, "Can I try it before paying?"), answer(now, "Can I try it before paying?").includes(uploadsWait("setup"))], [tryBeforePaying("A product that hands over a link", "a product that hands over a link", false), tryBeforePaying("A product that hands over a link", "a product that hands over a link", true, TRIAL_DAYS), true]);
is("getting it back in the store's own words", answer(now, "What is instant delivery here?").includes(`“${en.getAgain}”`), true);
is("one space between sentences, never two", /\s{2}/.test(now.map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of downloads, buyers or sales, no percent, no result promised", /\b\d{2,}\s+(downloads|buyers|creators|sales)|%|guarantee|proven|results?\b/i.test(all), false);

part("On the delivery page");
const faq = (findPage("platform", "instant-delivery")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
