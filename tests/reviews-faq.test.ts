/**
 * The questions someone starting out asks about reviews (534 [FQ1], unit 24,
 * lib/reviews-faq.ts; added 2 November 2026). Checked: the studio's own words,
 * read from its files; the email that asks switched by the settings
 * permission, only on Studio or Scale with email set up; a store taking
 * payments only with a plan or inside its trial; each answer in both states;
 * no sentence said twice on the page; no figure; first in the page's own
 * Questions block.
 */
import { readFileSync } from "node:fs";
import { REVIEWS_WORDS, reviewsBeginnerQuestions } from "@/lib/reviews-faq";
import { PLAN_TITLES } from "@/lib/plan";
import { can } from "@/lib/team-roles";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = REVIEWS_WORDS;

part("The studio's own words and rules");
const studio = flat(read("app/studio/page.tsx"));
const page = flat(read("app/studio/reviews/page.tsx"));
const panel = flat(read("components/review-studio.tsx"));
is("the studio tool, for whoever may handle reviews", [studio.includes(`href: studioPath(store, "", "reviews"), title: "${w.tool}"`), studio.includes('may("reviews")')], [true, true]);
is("the tab, the reply buttons and the ask box, as the studio says them", [page.includes(`tab("all", "${w.all}")`), panel.includes(`review.reply ? "${w.edit}" : "${w.reply}"`), panel.includes(`"${w.post}"`), panel.includes(` ${w.askBox} </label>`), panel.includes(`"${w.save}"`)], [true, true, true, true, true]);
is("the email that asks: its heading, switched by settings, and needing email on Pro", [page.includes(`>${w.ask}</h2>`), page.includes('can(view.role, "settings") ? ( <ReviewAskEditor'), can("owner", "settings"), can("admin", "settings"), can("editor", "settings"), read("lib/mail.ts").includes('if (!canUse(store, "email")) return 0;')], [true, true, true, true, false, true]);
const checkout = flat(read("lib/store-checkout.ts").replace(/\n\s*\/\/ /g, " "));
is("a store takes payments only paid up, a trial included", [checkout.includes("isPaidUp(store) &&"), checkout.includes("A creator inside the trial passes this too")], [true, true]);
const proof = read("lib/review-proof.ts");
is("a review only for a paid order, read from Stripe, and never on the demo store", [proof.includes('session.payment_status !== "paid") return { state: "no" };'), proof.includes('session.amount_total <= 0) return { state: "no" };'), proof.includes("product.priceCents > 0 && !product.call"), read("lib/house-store.ts").includes("It takes no reviews.")], [true, true, true, true]);

part("The answers, in both states");
const now = reviewsBeginnerQuestions(false);
const later = reviewsBeginnerQuestions(true);
is("three questions", now.map((x) => x.q), ["How do I get my first reviews?", "Where do I see and answer reviews?", "Can I get reviews before I pay for a plan?"]);
const first = answer(now, "How do I get my first reviews?");
is("first reviews: from buyers, none promised, nothing to switch on, the email's steps on Studio or Scale", [first.startsWith("Only a buyer can write one"), first.includes("a sale does not bring one by itself"), first.includes("Nothing has to be switched on"), (() => { const at = [w.ask, w.askBox, w.save].map((x) => first.indexOf(`“${x}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), first.endsWith(`it needs your email set up on ${PLAN_TITLES.pro} or ${PLAN_TITLES.scale}.`)], [true, true, true, true, true]);
const where = answer(now, "Where do I see and answer reviews?");
is("answering: the studio's words in order", (() => { const at = [w.tool, w.all, w.reply, w.edit, w.post].map((x) => where.indexOf(`“${x}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), true);
const today = answer(now, "Can I get reviews before I pay for a plan?");
is("try before paying: today, the page with no card, a new store not selling, the demo taking none; later, yes once the store takes payments", [today.includes("a new store cannot take payments"), today.endsWith("The live demo store takes no reviews, because its purchases cost nothing."), /no store takes payments|To see a store working/.test(today), answer(later, "Can I get reviews before I pay for a plan?").startsWith("Yes, once your store can take payments")], [true, true, false, true]);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure, no percent, no number of reviews promised", [/\d/.test(all), /%|guarantee|more reviews|proven/i.test(all)], [false, false]);

part("On the reviews page");
const topic = findPage("platform", "reviews");
const faq = (topic?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 3).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && !x.startsWith("To see a store working"));
const rest = JSON.stringify({ ...topic, blocks: (topic?.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faq?.items.slice(3) } : b)) });
is("no sentence of the answers said elsewhere on the page, or twice among them", [now, later].map((l) => { const mine = l.flatMap((x) => sentences(x.a)); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false]);

done();
