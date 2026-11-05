/**
 * The questions someone starting out asks about their numbers (534 [FQ1],
 * unit 23, lib/insights-faq.ts; added 2 November 2026). Checked: the studio's
 * own words, read from its files; who may read the numbers; the store's own
 * people not counted; sales read only once Stripe (or PayPal) is connected;
 * no plan read to show them; each answer in both states; no figure; first in
 * the page's own Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { NUMBERS_WORDS, insightsBeginnerQuestions } from "@/lib/insights-faq";
import { readsSales } from "@/lib/stats";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { TRIAL_DAYS } from "@/lib/plan";
import { can } from "@/lib/team-roles";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = NUMBERS_WORDS;

part("The studio's own words and rules");
const studio = flat(read("app/studio/page.tsx"));
const panel = flat(read("components/stats-panel.tsx"));
is("the jump link and the card only when visits were read, the card's title and its periods", [studio.includes(`...(numbers ? [{ href: "#numbers", label: "${w.jump}" }] : [])`), panel.includes(`> ${w.card} </h2>`), w.ranges.slice(0, -1).every((r) => panel.includes(`label: "${r}" }`)), panel.includes(`> ${w.ranges[w.ranges.length - 1]} </`)], [true, true, true, true]);
is("read by the owner, an Admin or an Editor, not Support", [studio.includes('current && may("stats")'), can("owner", "stats"), can("admin", "stats"), can("editor", "stats"), can("support", "stats")], [true, true, true, true, false]);
is("the empty card's sentence, when nothing is counted, and the Sales tile's note before Stripe, as the card says them", [panel.includes(`${w.empty} Share your store&apos;s address`), panel.includes("const empty = data.totals.all.views === 0 && data.totals.d90.checkouts === 0 && data.totals.d90.sales === 0;"), panel.includes(`? "${w.noStripe}"`), panel.includes(`{ label: "${w.sales}", value: salesHere`)], [true, true, true, true]);
is("sales read only once Stripe or PayPal is connected", [readsSales({ stripeAccountId: undefined, paypalSeller: undefined } as never), readsSales({ stripeAccountId: "acct_x" } as never), readsSales({ paypalSeller: { id: "x" } } as never)], [false, true, true]);
const visit = read("lib/visit.ts");
is("the owner and the team signed in, and a marked device, not counted, on the store's address here only", [visit.includes("if (email === store.email.toLowerCase()) return true;"), visit.includes("if (isMarkedDevice(request.cookies.get(NO_COUNT_COOKIE)?.value, store.sid)) return true;"), read("components/no-count-toggle.tsx").includes(`"${w.device}"`), read("components/no-count-toggle.tsx").includes("not on a domain of your own")], [true, true, true, true]);
is("a store with no plan rests once its visits are used, before anything is counted", read("app/[handle]/page.tsx").includes("if (await isResting(store)) return <StoreResting store={store} />;"), true);

part("The answers, in both states");
const now = insightsBeginnerQuestions(false, TRIAL_DAYS);
const later = insightsBeginnerQuestions(true, TRIAL_DAYS);
is("three questions", now.map((x) => x.q), ["Where do I see my numbers?", "Why are my numbers empty?", "Can I see my numbers before paying?"]);
const where = answer(now, "Where do I see my numbers?");
is("where: the studio's words, the periods in order, who sees them", [(() => { const at = [w.card, w.jump, ...w.ranges].map((x) => where.indexOf(`“${x}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), where.includes("The owner, an Admin or an Editor sees them; Support does not."), where.endsWith("While visits cannot be read, the card and that link are not shown.")], [true, true, true]);
const empty = answer(now, "Why are my numbers empty?");
is("empty: the card's words, own visits while signed in and not on a domain, Stripe or PayPal", [empty.startsWith(`Until a first visit or checkout is counted, the card says “${w.empty}”`), empty.includes("while signed in"), empty.includes(`“${w.device}”`), empty.includes("on a domain of your own, you are counted"), empty.includes(`Until your Stripe account or PayPal is connected, the “${w.sales}” tile says “${w.noStripe}”`)], [true, true, true, true, true]);
is("try before paying: the shared answer, and the visits a store without a plan has", [answer(now, "Can I see my numbers before paying?").startsWith(tryBeforePaying("Your numbers", "your store and see its numbers", false, TRIAL_DAYS)), answer(later, "Can I see my numbers before paying?").startsWith(tryBeforePaying("Your numbers", "your store and see its numbers", true, TRIAL_DAYS)), [now, later].every((l) => answer(l, "Can I see my numbers before paying?").endsWith("Visits are one of those limits: once they are used, your store's pages rest and no more visits are counted until they open again.")), /with or without/.test(answer(now, "Can I see my numbers before paying?"))], [true, true, true, false]);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure but the card's periods and the trial's days, no percent, no result promised", [/\d/.test(all.split(/“\d+ days”/).join("").split(`${TRIAL_DAYS}-day`).join("")), /%|guarantee|proven|more sales|grow your/i.test(all)], [false, false]);

part("On the numbers page");
const topic = findPage("platform", "insights");
const faq = (topic?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 3).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
const shared = [tryBeforePaying("Your numbers", "your store and see its numbers", false, TRIAL_DAYS), tryBeforePaying("Your numbers", "your store and see its numbers", true, TRIAL_DAYS)].join(" ");
const sentences = (text: string) => text.split(/(?<=[.!?”])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && !shared.includes(x));
const rest = JSON.stringify({ ...topic, blocks: (topic?.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faq?.items.slice(3) } : b)) });
is("no sentence of the answers said elsewhere on the page, or twice among them", [now, later].map((l) => { const mine = l.flatMap((x) => sentences(x.a)); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false]);

done();
