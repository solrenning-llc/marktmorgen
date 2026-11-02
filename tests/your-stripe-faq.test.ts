/**
 * The questions someone starting out asks about selling on their own Stripe
 * account (534 [FQ1], unit 8, lib/your-stripe-faq.ts; added 2 November
 * 2026). Checked: the studio card's own words, its sentence about what is
 * kept, the country Stripe fixes, what it says when connecting is off, that
 * the card waits on no plan; the shared trial answer in both states; no
 * figure; first in the page's own Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { STRIPE_CARD_WORDS, stripeBeginnerQuestions } from "@/lib/your-stripe-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const studio = flat(read("app/studio/page.tsx"));
const cardStart = studio.indexOf('<div id="stripe"');
const cardEnd = studio.indexOf("Stripe will ask for the details it needs to pay you.");
is("the card is found whole", [cardStart >= 0, cardEnd > cardStart], [true, true]);
const card = studio.slice(cardStart, cardEnd);
is("the card's title, its country question and its button", [card.includes(STRIPE_CARD_WORDS.title), card.includes(STRIPE_CARD_WORDS.country), card.includes(STRIPE_CARD_WORDS.connect)], [true, true, true]);
is("what the card says is kept, and where payouts go", [card.includes("We keep the account&apos;s identifier and nothing else — no key to it, and never the money in it."), card.includes("the payouts go to your bank")], [true, true]);
is("the country is fixed by Stripe when the account is opened", card.includes("Stripe fixes this when the account is opened and it cannot be changed afterward"), true);
is("with connecting off, the card shows no button and says so", [/\{\s*!connectReady\s*\?/.test(card), card.includes("Connecting is not switched on yet on our side, so there is nothing here to press.")], [true, true]);
const route = flat(read("app/api/stripe/connect/route.ts"));
is("the card and the route are the owner's alone, and the route needs no plan", [/may\("payments"\)\s*\?\s*\(\s*<div id="stripe"/.test(studio), route.includes('creatorFrom(request, "payments")'), /isPaidUp\(|canSell\(|subscriptionActive|hasPro\(/.test(route), /owner:[^\n]*"payments"/.test(read("lib/team-roles.ts")) || read("lib/team-roles.ts").includes('"payments"')], [true, true, false, true]);
const connect = read("lib/stripe-connect.ts");
is("the account opened has a full dashboard of its own, with Stripe's fees and losses its own", [/dashboard: "full"/.test(connect), /fees_collector: "?stripe/.test(connect), /losses_collector: "?stripe/.test(connect)], [true, true, true]);
is("a store takes no payment until Stripe says the account can", flat(read("lib/store-checkout.ts")).includes("store.stripeChargesEnabled &&"), true);

part("The answers");
const now = stripeBeginnerQuestions(false);
const later = stripeBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What does “your own Stripe” mean here?", "How do I connect my Stripe account?", "Can I connect my own Stripe before paying?", "Does selling on my own Stripe work?"]);
is("connect: the card's own words, in order, and the case with no button", [(() => { const a = answer(now, "How do I connect my Stripe account?"); const at = Object.values(STRIPE_CARD_WORDS).map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), answer(now, "How do I connect my Stripe account?").includes("If the owner sees no button there, connecting is not switched on yet on our side")], [true, true]);
const noPlan = " Connecting your Stripe account needs no plan, once connecting is switched on on our side.";
const first = "Yes, once connecting is switched on on our side: connecting your Stripe account needs no plan. ";
is("try before paying: the connection first, said to need no plan, then the one shared answer", [answer(now, "Can I connect my own Stripe before paying?"), answer(later, "Can I connect my own Stripe before paying?")], [first + tryBeforePaying("Your store", "your products", false).replace(/^Yes\. /, ""), first + tryBeforePaying("Your store", "your products", true, TRIAL_DAYS).replace(/^Yes\. /, "")]);
is("the answers say what the card and the code say", [answer(now, "What does “your own Stripe” mean here?").includes("pays it out to your bank; your sales never sit with us"), answer(now, "What does “your own Stripe” mean here?").startsWith("When your store sells,"), answer(now, "How do I connect my Stripe account?").includes("Only the store's owner sees this."), answer(now, "How do I connect my Stripe account?").includes("Stripe fixes it when the account is opened")], [true, true, true, true]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of accounts, sales or payouts, no percent, no result promised", /\b\d+\s+(accounts|sales|payouts|creators)|%|guarantee|proven|results?\b/i.test(all), false);

part("On the page");
const faq = (findPage("platform", "your-stripe")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
