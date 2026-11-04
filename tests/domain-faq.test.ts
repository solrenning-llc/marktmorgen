/**
 * The questions someone starting out asks about a store on its own domain
 * (534 [FQ1], unit 22, lib/domain-faq.ts; added 2 November 2026). Checked:
 * the studio's own words, read from its files; the card shown only where
 * domains are switched on and to whoever may change settings; the domain used
 * only on an active Studio or Scale plan, a trial included; the studio's
 * label for Studio; the three days a domain is held; the marktmorgen.com
 * address never moved to the domain; each answer in every state (domains on
 * or off, plans on sale or not), never saying a domain can be added or tried
 * where it cannot; no sentence said twice on the page; no figure; first in
 * the page's own Questions block.
 */
import { readFileSync } from "node:fs";
import { DOMAIN_WORDS, domainBeginnerQuestions } from "@/lib/domain-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { UNPROVED_SECONDS, canUseDomain } from "@/lib/domains";
import { PLAN_TITLES, TRIAL_DAYS } from "@/lib/plan";
import { can } from "@/lib/team-roles";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = DOMAIN_WORDS;

part("The studio's own words and rules");
const studio = flat(read("app/studio/page.tsx"));
const editor = flat(read("components/domain-editor.tsx"));
is("the card only where domains are on, to whoever may change settings, labeled with the studio's name for Studio", [studio.includes('{domainsOn && may("settings") ? ('), studio.includes(`>${w.card}</p> <span className="tag tag-brand">${w.studioPlan}</span>`), can("owner", "settings"), can("admin", "settings"), can("editor", "settings"), can("support", "settings")], [true, true, true, true, false, false]);
is("the field and the button, as the editor says them", [editor.includes(`>${w.field}</span>`), editor.includes(` ${w.add} </button>`)], [true, true]);
is("the records in the domain's DNS settings and the three days, as the editor says", [editor.includes("where you bought the domain, in its DNS settings"), editor.includes("The domain is held for your store for three days while you do this."), UNPROVED_SECONDS === 3 * 24 * 60 * 60], [true, true, true]);
is("the domain only on an active Studio or Scale plan (a trial is active)", [canUseDomain({ subscriptionActive: true, tier: "pro" }), canUseDomain({ subscriptionActive: true, tier: "scale" }), canUseDomain({ subscriptionActive: true, tier: "creator" }), canUseDomain({ subscriptionActive: false, tier: "pro" })], [true, true, false, false]);
is("the plans' names where somebody chooses", [PLAN_TITLES.creator, PLAN_TITLES.pro, PLAN_TITLES.scale], ["Store", "Studio", "Scale"]);
is("the marktmorgen.com address is never moved to the domain", read("app/[handle]/page.tsx").includes("if (asked !== store.handle && !reachedOn) permanentRedirect("), true);

part("The answers, in every state");
const states = [[true, false], [true, true], [false, false], [false, true]] as const;
const lists = states.map(([on, sale]) => domainBeginnerQuestions(on, sale, TRIAL_DAYS));
is("three questions in each", lists.map((l) => l.map((x) => x.q).join("|")), states.map(() => "What is a domain, and do I need one?|How do I add my domain?|Can I put my store on my own domain before paying?"));
const [onNow, onLater, offNow, offLater] = lists;
const how = answer(onNow, "How do I add my domain?");
is("adding: both plans, the studio's label, owner or Admin, the studio's words in order, the three days", [how.includes(`part of the ${PLAN_TITLES.pro} and ${PLAN_TITLES.scale} plans`), how.includes(`${PLAN_TITLES.pro} is labeled “${w.studioPlan}”`), how.includes("the owner or an Admin"), how.indexOf(`“${w.field}”`) < how.indexOf(`“${w.add}”`), how.includes("held for your store for three days")], [true, true, true, true, true]);
is("domains off: never told how to add or try one", [offNow, offLater].flatMap((l) => [answer(l, "How do I add my domain?"), answer(l, "Can I put my store on my own domain before paying?")]).map((a) => /“|types it|can be set up/.test(a)), [false, false, false, false]);
is("try before paying, not on sale: not yet, both plans named", answer(onNow, "Can I put my store on my own domain before paying?").startsWith(`Not yet. Your own domain needs the ${PLAN_TITLES.pro} or ${PLAN_TITLES.scale} plan`), true);
const trial = answer(onLater, "Can I put my store on my own domain before paying?");
is("try before paying, on sale: the shared answer, the plans in the same sentence, the Store plan's trial said", [trial.startsWith(tryBeforePaying(`Your own domain, on ${PLAN_TITLES.pro} or ${PLAN_TITLES.scale},`, "", true, TRIAL_DAYS)), trial.includes(`Your own domain, on ${PLAN_TITLES.pro} or ${PLAN_TITLES.scale}, can be set up during the trial`), trial.endsWith(`On a trial of the ${PLAN_TITLES.creator} plan, the domain card only offers the upgrade.`)], [true, true, true]);
const all = lists.flat().map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure but the trial's days, no percent, no result promised", [/\d/.test(all.split(`${TRIAL_DAYS}-day`).join("")), /%|guarantee|proven|results?\b/i.test(all)], [false, false]);

part("On the domain page");
const page = findPage("platform", "domain");
const faq = (page?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 3).map((x) => x.q), onNow.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20);
const rest = JSON.stringify({ ...page, blocks: (page?.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faq?.items.slice(3) } : b)) });
is("no sentence of the answers said elsewhere on the page, or twice among them, in any state", lists.map((l) => { const mine = l.flatMap((x) => sentences(x.a)).filter((x) => !x.startsWith("To see a store working") && !x.startsWith("Yes. An eligible") && !x.startsWith("Files and lesson videos")); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false, false, false]);

done();
