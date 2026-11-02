/**
 * The ready campaigns as the site's pages say them (242 [CF5], unit 2; added
 * 2 November 2026): every one on the Funnels page, and on each page for a
 * kind of creator those that fit it, read from the campaigns themselves, with
 * where they are in the studio in the studio's own words.
 */
import { readFileSync } from "node:fs";
import { FEATURE_PAGES } from "@/lib/feature-pages";
import { PAGES } from "@/lib/site-pages";
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { NICHE_FIT, STARTER_NICHES, STARTER_NICHE_LABELS } from "@/lib/funnel-starter-catalog";
import { NAMED_ON_CARD, STARTER_GALLERY_TITLE, nicheCampaignFeature, nicheCampaignLabels, nicheCampaignNamed, startersFeature } from "@/lib/funnel-niche-feature";
import { forShipping } from "@/lib/funnel-starters";
import { done, is, part } from "./check";

const featuresOf = (section: string, slug: string) =>
  (PAGES.find((p) => p.section === section && p.slug === slug)?.blocks ?? []).flatMap((block) => (block.kind === "features" ? block.items : []));

part("On each page for a kind of creator");
is(
  "each has the card once, as made",
  STARTER_NICHES.map((n) => featuresOf("for", n).filter((item) => item.title.startsWith("Ready campaigns for"))),
  STARTER_NICHES.map((n) => [nicheCampaignFeature(n)]),
);
is("the title says for whom", nicheCampaignFeature("coaches").title, "Ready campaigns for coaches and teachers");
is(
  "the coaches' campaigns, in the studio's order",
  nicheCampaignLabels("coaches"),
  ["Free guide, then your first offer", "Recorded workshop", "Coaching application", "Free lesson, then the course", "A paid call", "Launch a complete course", "Sell a printed book", "A kit to go with your course"],
);
is("every campaign that fits exists", STARTER_NICHES.map((n) => nicheCampaignLabels(n).length), STARTER_NICHES.map((n) => Object.keys(NICHE_FIT[n]).length));
is(
  "the card counts them and names three, the most particular to that kind first, one for something they ship among them",
  STARTER_NICHES.map((n) => nicheCampaignNamed(n)),
  [
    ["Coaching application", "A paid call", "Sell a printed book"],
    ["Free guide, then your first offer", "Sell a digital product", "Sell a printed book"],
    ["Membership, with a page that sells it", "Recorded workshop", "A kit to go with your course"],
    ["Sell a digital product", "A paid call", "Sell something you ship"],
  ],
);
is(
  "named as the card says them",
  STARTER_NICHES.filter((n) => {
    const { body } = nicheCampaignFeature(n);
    const named = nicheCampaignNamed(n).map((l) => `“${l}”`);
    return !body.startsWith(`${nicheCampaignLabels(n).length} campaigns, such as ${named.slice(0, -1).join(", ")} and ${named.at(-1)}.`);
  }),
  [],
);
is(
  "short enough to read as one link, and it says it leads to how they work",
  STARTER_NICHES.filter((n) => {
    const { title, body } = nicheCampaignFeature(n);
    return title.length + body.length > 320 || !body.endsWith("See how they work.");
  }),
  [],
);

part("On the Funnels page");
const funnels = featuresOf("platform", "funnels");
is("the page exists and holds the card once", [FEATURE_PAGES.some((p) => p.section === "platform" && p.slug === "funnels"), funnels.filter((i) => i.title === "Campaigns with first words").length], [true, 1]);
const { body } = startersFeature();
const online = FUNNEL_STARTERS.filter((s) => !forShipping(s));
const shipped = FUNNEL_STARTERS.filter(forShipping);
is(
  "it counts every campaign in two groups, names a few of the first and every one of the second",
  [
    body.startsWith(`${FUNNEL_STARTERS.length} campaigns with their first words written. ${online.length} for what you sell, teach or offer online, such as `),
    online.slice(0, NAMED_ON_CARD).every((s) => body.includes(`“${s.label}”`)),
    body.includes(`${shipped.length} for something you ship: `),
    shipped.every((s) => body.includes(`“${s.label}”`)),
    shipped.length === 5,
  ],
  [true, true, true, true, true],
);
is("no count of them is typed anywhere else on the page", funnels.filter((i) => /\b(Six|Seven|Eight|Nine|Ten) (funnels|campaigns|starters)\b/i.test(`${i.title} ${i.body}`)).map((i) => i.title), []);
is(
  "it says products are chosen only where a step sells something, since some campaigns have none",
  [FUNNEL_STARTERS.some((s) => s.bundle.products.length === 0), body.includes("Where a step sells something, you choose one of your own products for it."), /uses your own products/.test(body)],
  [true, true, false],
);

part("Where they are");
const gallery = readFileSync("components/funnel-starter-gallery.tsx", "utf8");
const panel = readFileSync("components/funnel-share-panel.tsx", "utf8");
const studio = readFileSync("app/studio/page.tsx", "utf8");
is(
  "the studio's words they repeat are the studio's",
  [gallery.includes(`>${STARTER_GALLERY_TITLE}<`), gallery.includes("What kind of creator are you?"), gallery.includes("created as a draft"), panel.includes("<FunnelStarterGallery"), /title: "Funnels"/.test(studio)],
  [true, true, true, true, true],
);
is("the Funnels card says where and how to choose", [body.includes(`open Funnels and go to “${STARTER_GALLERY_TITLE}”`), body.includes("“What kind of creator are you?”")], [true, true]);
is(
  "each kind's card names the section, and links to the public page, not into the studio",
  STARTER_NICHES.filter((n) => {
    const card = nicheCampaignFeature(n);
    return !card.body.includes("under Funnels, in “Start with a campaign”") || card.href !== "/platform/funnels";
  }),
  [],
);
is("the kinds named are the studio's", STARTER_NICHES.map((n) => gallery.includes("STARTER_NICHE_LABELS") && STARTER_NICHE_LABELS[n].length > 0), STARTER_NICHES.map(() => true));
// Only the bodies: the titles hold the kind's label, and the Funnels card's count is computed.
is("no result, figure or haste is promised, past the computed count", STARTER_NICHES.filter((n) => /\d|guarantee|proven|best|fast|\bnow\b|today|limited|only/i.test(nicheCampaignFeature(n).body.replace(/^\d+ campaigns/, ""))), []);
// Its counts are computed: each is a number of campaigns, or of a group of them.
const uncounted = body.replace(/\b\d+ (campaigns|for)\b/g, "");
is("nor on the Funnels card, past its computed counts", /guarantee|proven|best|fast|\bnow\b|today|limited|\d/i.test(uncounted), false);

done();
