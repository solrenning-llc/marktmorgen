/**
 * The questions someone starting out asks about affiliates (534 [FQ1], unit
 * 18, lib/affiliate-faq.ts; added 2 November 2026). Checked: the studio's
 * own words and its sentences, read from its files; the program set up with
 * no plan, crediting sales once the store can sell; each affiliate's own
 * page; the shared trial answer in both states; no figure; first in the
 * page's own Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { AFFILIATE_WORDS, affiliateBeginnerQuestions } from "@/lib/affiliate-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { MAX_COOKIE_DAYS, NO_AFFILIATES } from "@/lib/affiliate-setting";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const ui = flat(read("components/affiliate-studio.tsx"));
const page = flat(read("app/studio/affiliates/page.tsx"));
const studio = flat(read("app/studio/page.tsx"));
is("the studio tool, for those who may change settings", /may\("settings"\)\s*\?\s*\[\{ href: studioPath\(store, "", "affiliates"\), title: "Affiliates"/.test(studio), true);
is("the program's heading, switch, share, window, memberships and save", [AFFILIATE_WORDS.program, AFFILIATE_WORDS.take, AFFILIATE_WORDS.share, AFFILIATE_WORDS.window, AFFILIATE_WORDS.recurring].every((w) => ui.includes(w)) && ui.includes(`"Saving…" : "${AFFILIATE_WORDS.save}"`), true);
is("the switch opens the affiliate page and starts links earning", ui.includes("Your affiliate page opens, and links start earning."), true);
is("the studio's own sentence on how a sale earns", page.includes("Anyone can apply on your affiliate page and you decide who is in, or you let everyone who buys from you take a link without applying. Each affiliate gets their own link, and a one-time purchase made through it within your window earns them the share you set, worked out from what the buyer paid before tax and taken back if you refund the sale."), true);
is("set up with no plan, sales credited once the store can sell", [page.includes("{!canSell(store) ? ("), page.includes("You can set the program up now. Sales are credited to affiliates once your Stripe account is connected and your plan is running.")], [true, true]);
is("the share and the window come filled in, so they are checked or changed", [NO_AFFILIATES.percent > 0, NO_AFFILIATES.days > 0], [true, true]);
is("a membership earns nothing unless chosen", [NO_AFFILIATES.recurring, ui.includes("Not credited to affiliates")], [0, true]);
is("the directory can show a program's own numbers", ui.includes("Show my program&apos;s numbers there too"), true);
is("saving the program waits on the role, not a plan", [/guardStoreWrite\(request, "settings"/.test(read("app/api/store/affiliates/route.ts")), /isPaidUp|canSell\(/.test(read("app/api/store/affiliates/route.ts"))], [true, false]);
is("the page says the first or the last link wins, and the window up to the code's most, conditionally", [JSON.stringify(findPage("platform", "affiliates")).includes("Last click wins, or the first"), JSON.stringify(findPage("platform", "affiliates")).includes(`a window of up to ${MAX_COOKIE_DAYS} days after a click, for as long as the buyer's browser keeps it`), ui.includes("The first link wins"), [read("lib/help-content.ts"), read("app/mission/page.tsx")].every((t) => t.includes("${MAX_COOKIE_DAYS} days") && !/a window of 1 to 90 days/.test(t))], [true, true, true, true]);

part("The answers");
const now = affiliateBeginnerQuestions(false);
const later = affiliateBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What is an affiliate program here?", "How do I start one?", "Can I try it before paying?", "How many people use affiliates here?"]);
is("start: the studio's own words, in order, who sees it, and when links earn in each state", [(() => { const a = answer(now, "How do I start one?"); const at = [AFFILIATE_WORDS.tool, AFFILIATE_WORDS.program, AFFILIATE_WORDS.take, AFFILIATE_WORDS.share, AFFILIATE_WORDS.window, AFFILIATE_WORDS.save].map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), answer(now, "How do I start one?").includes("The store's owner and Admins see this page."), answer(now, "How do I start one?").endsWith("Paid plans are not on sale yet."), answer(later, "How do I start one?").endsWith("Links start earning once your Stripe account is connected and your plan is running.")], [true, true, true, true]);
is("what it is: the studio's own sentence, and memberships only if chosen", [page.includes(answer(now, "What is an affiliate program here?").slice(answer(now, "What is an affiliate program here?").indexOf("a one-time purchase"), answer(now, "What is an affiliate program here?").indexOf(" Memberships"))), answer(now, "What is an affiliate program here?").includes(`only if you choose so under “${AFFILIATE_WORDS.recurring}”`)], [true, true]);
is("try before paying: the one shared answer, in affiliates' words", [answer(now, "Can I try it before paying?"), answer(later, "Can I try it before paying?")], [tryBeforePaying("An affiliate program", "your affiliate program", false), tryBeforePaying("An affiliate program", "your affiliate program", true, TRIAL_DAYS)]);
is("how many: no count of ours, a creator's own numbers only if they choose", [answer(now, "How many people use affiliates here?").startsWith("We publish no count of how many people use affiliates on Marktmorgen"), answer(now, "How many people use affiliates here?").includes("A creator can choose to show their own program's numbers")], [true, true]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of affiliates or sales, no percent figure, no result promised", /\b\d+\s+(affiliates|clicks|sales|buyers|creators)|\d+%|guarantee|proven|results?\b/i.test(all), false);

part("On the affiliates page");
const faq = (findPage("platform", "affiliates")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
