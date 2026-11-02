/**
 * Campaigns by the kind of creator (242 [CF5], unit 1; added 2 November
 * 2026): the same kinds as the site's pages for them, each naming only
 * campaigns that exist, with one honest line on how each fits; the gallery
 * filters by it and says that line; nothing new is made.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FunnelStarterGallery } from "@/components/funnel-starter-gallery";
import { NICHE_FIT, STARTER_NICHES, STARTER_NICHE_LABELS, matchingStarters, readStarterNiche, starterCard } from "@/lib/funnel-starter-catalog";
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { PAGES } from "@/lib/site-pages";
import { done, is, part } from "./check";

const cards = FUNNEL_STARTERS.map(starterCard);
const ids = new Set(cards.map((c) => c.id));

part("The kinds of creator");
const forPages = PAGES.filter((p) => p.section === "for");
is("the same kinds as the site's pages for them, named alike", STARTER_NICHES.map((n) => [n, forPages.find((p) => p.slug === n)?.eyebrow]), STARTER_NICHES.map((n) => [n, `For ${STARTER_NICHE_LABELS[n].toLowerCase()}`]));
is("each names only campaigns that exist, at least three", STARTER_NICHES.map((n) => Object.keys(NICHE_FIT[n]).every((id) => ids.has(id)) && Object.keys(NICHE_FIT[n]).length >= 3), STARTER_NICHES.map(() => true));
const lines = STARTER_NICHES.flatMap((n) => Object.values(NICHE_FIT[n]));
is("each line honest: starts with For, one sentence, no figure, no result promised", lines.filter((l) => !/^For [^.]+\.$/.test(l) || /\d|guarantee|results?|earn|money|best|proven/i.test(l)), []);
is("the guide campaign is said as a guide, as its own words are, for every kind", STARTER_NICHES.map((n) => NICHE_FIT[n]["guide-signup"]).filter(Boolean).every((l) => /^For a free (recipe )?guide that starts your list\.$/.test(l)), true);

part("Filtering");
is("a kind of creator shows only its campaigns, in the catalog's order", matchingStarters(cards, "all", "", "designers").map((c) => c.id), cards.filter((c) => NICHE_FIT.designers[c.id]).map((c) => c.id));
is("with a goal and a search too, all must match", [matchingStarters(cards, "services", "call", "coaches").map((c) => c.id), matchingStarters(cards, "teaching", "", "designers").length], [["coaching-application", "paid-call"], 0]);
is("without one, as before", matchingStarters(cards, "all", "").length, cards.length);
is("an unknown kind shows every creator", [readStarterNiche("cooks"), readStarterNiche("chefs"), readStarterNiche(undefined)], ["cooks", "all", "all"]);

part("The gallery");
const html = renderToStaticMarkup(createElement(FunnelStarterGallery, { starters: cards, busy: false, onChoose: () => {} }));
is("a labeled choice of the kind of creator, every kind and any creator", [/<label for="starter-niche" class="block"><span class="field-label">What kind of creator are you\?<\/span><select id="starter-niche"/.test(html), html.includes('<option value="all" selected="">Any creator</option>') || html.includes('<option value="all">Any creator</option>'), STARTER_NICHES.every((n) => html.includes(`<option value="${n}">${STARTER_NICHE_LABELS[n]}</option>`))], [true, true, true]);
is("with no kind chosen, no fit line is shown", lines.some((l) => html.includes(l)), false);
const cooks = renderToStaticMarkup(createElement(FunnelStarterGallery, { starters: cards, busy: false, onChoose: () => {}, initialNiche: "cooks" }));
is("with one chosen, each card says how it fits, and only its campaigns are shown", [Object.values(NICHE_FIT.cooks).every((l) => cooks.includes(l)), cooks.includes(`${Object.keys(NICHE_FIT.cooks).length} of ${cards.length} campaigns shown`)], [true, true]);
is("the line chosen is searched too", matchingStarters(cards, "all", "recipe pack", "cooks").map((c) => c.id), ["digital-product"]);
is("the button's name holds its visible words", html.includes('aria-label="Set up this campaign: '), true);

done();
