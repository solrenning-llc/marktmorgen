/**
 * The questions someone starting out asks about currencies and ways to pay
 * (534 [FQ1], unit 25, lib/currency-faq.ts; added 2 November 2026). Checked:
 * the studio's own words, read from its files; the currency a new store
 * starts in; the currency field for whoever may change settings, with no plan
 * read by its route; the Stripe link only once Stripe is connected; every
 * store checkout asking Stripe not to convert; the shared trial answer in both
 * states; no sentence said twice on the page; no figure; first in the page's
 * own Questions block.
 */
import { readFileSync, readdirSync } from "node:fs";
import { CURRENCY_WORDS, currencyBeginnerQuestions } from "@/lib/currency-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { DEFAULT_CURRENCY, currencyLabel } from "@/lib/money";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = CURRENCY_WORDS;

part("The studio's own words and rules");
const studio = flat(read("app/studio/page.tsx"));
const panel = flat(read("components/payments-panel.tsx"));
is("the currency field, its button, its confirm step and its mark only when Stripe answered, as the studio says them", [panel.includes(`>Your store&apos;s currency</label>`), panel.includes(`"${w.save}"`), panel.includes('role="alertdialog" aria-labelledby="currency-confirm-title"'), panel.includes(` — ${w.off}`), panel.includes("allowed !== null && !allowed.includes(rule.code) && rule.code !== currency"), studio.includes("chargeableCurrencies(current).catch(() => null)")], [true, true, true, true, true, true]);
is("for whoever may change settings, with no plan read by its route", [studio.includes('{may("settings") ? ( <PaymentsPanel'), /planOf\(|PLANS_ON_SALE|canUse\(|isPaidUp\(|canSell\(/.test(read("app/api/store/currency/route.ts")), read("app/api/store/currency/route.ts").includes('guardStoreWrite(request, "settings"')], [true, false, true]);
is("a new store starts in the default currency", [read("lib/store.ts").includes("currency: DEFAULT_CURRENCY,"), currencyLabel(DEFAULT_CURRENCY)], [true, "US dollar (USD)"]);
is("the Stripe link only once Stripe is connected", [panel.includes(`ways.state !== "none" ? (`), panel.indexOf(`ways.state !== "none" ? (`) < panel.indexOf(w.more), studio.includes(': [null, { state: "none" as const }, null];')], [true, true, true]);
// lib/earnings-read.ts only lists checkout sessions already paid (426 [BX2]), it never makes one.
const checkouts = readdirSync("lib").filter((f) => f.endsWith(".ts") && f !== "card-update.ts" && f !== "earnings-read.ts").map((f) => [f, read(`lib/${f}`)] as const).filter(([, t]) => t.includes("onAccount(") && /["`]\/checkout\/sessions["`]/.test(t));
is("every buyer checkout on the creator's account asks Stripe not to convert", [checkouts.length > 4, checkouts.filter(([, t]) => !t.includes("inTheCurrencyShown(body);")).map(([f]) => f), read("lib/instant-pay.ts").includes('body.set("adaptive_pricing[enabled]", "false");')], [true, [], true]);
const earningsCalls = read("lib/earnings-read.ts").match(/onAccount\(\s*[^,]*,/g) ?? [];
is("the earnings reading left out above only reads from the creator's account", [earningsCalls.length > 0, earningsCalls.filter((c) => !/^onAccount\(\s*"GET",$/.test(c))], [true, []]);
is("a payment request keeps the currency it was sent in", read("lib/payment-requests.ts").includes("request.currency"), true);

part("The answers, in both states");
const now = currencyBeginnerQuestions(false, TRIAL_DAYS);
const later = currencyBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["How do I choose my store's currency?", "Can my buyers pay in their own currency?", "How do I add Apple Pay or Klarna?", "Can I choose my currency before paying?"]);
const choose = answer(now, "How do I choose my store's currency?");
is("choosing: the start, the studio's words in order, the confirm step, the mark only when Stripe answers", [choose.startsWith(`A new store starts with “${currencyLabel(DEFAULT_CURRENCY)}” chosen.`), choose.indexOf(`“${w.field}”`) < choose.indexOf(`“${w.save}”`), choose.includes("you are asked to confirm first"), choose.includes(`When Stripe tells us which currencies your connected account can charge in`)], [true, true, true, true]);
const own = answer(now, "Can my buyers pay in their own currency?");
is("own currency: no conversion, never the price as written, the payment request said", [own.startsWith("No. Our checkout asks Stripe not to convert"), /price you wrote|as written/.test(own), own.includes("A payment request sent before you changed the currency")], [true, false, true]);
is("ways to pay: where Stripe offers them, in Stripe, the button once connected", [answer(now, "How do I add Apple Pay or Klarna?").startsWith("Where Stripe offers them for your country"), answer(now, "How do I add Apple Pay or Klarna?").includes(`After you connect it, the “${w.more}” button`)], [true, true]);
is("try before paying: the one shared answer", [answer(now, "Can I choose my currency before paying?"), answer(later, "Can I choose my currency before paying?")], [tryBeforePaying("Your currency", "your store's currency", false, TRIAL_DAYS), tryBeforePaying("Your currency", "your store's currency", true, TRIAL_DAYS)]);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure but the trial's days, no percent, no result promised", [/\d/.test(all.split(`${TRIAL_DAYS}-day`).join("")), /%|guarantee|more sales|proven/i.test(all)], [false, false]);

part("On the currencies page");
const topic = findPage("platform", "currencies-and-ways-to-pay");
const faq = (topic?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
const shared = [tryBeforePaying("Your currency", "your store's currency", false, TRIAL_DAYS), tryBeforePaying("Your currency", "your store's currency", true, TRIAL_DAYS)].join(" ");
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && !shared.includes(x));
const rest = JSON.stringify({ ...topic, blocks: (topic?.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faq?.items.slice(4) } : b)) });
is("no sentence of the answers said elsewhere on the page, or twice among them", [now, later].map((l) => { const mine = l.flatMap((x) => sentences(x.a)); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false]);

done();
