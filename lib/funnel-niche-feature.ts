/**
 * The ready campaigns (lib/funnel-starters.ts) as the site's pages say them
 * (242 [CF5], unit 2; added 2 November 2026): every one on the Funnels page,
 * and on each page for a kind of creator those that fit it (lib/funnel-
 * starter-catalog.ts, NICHE_FIT). Read from the campaigns themselves, so a
 * page never names one the studio does not have, nor a wrong count. The
 * cards point to the public Funnels page, which says how to find them in the
 * studio: a link into the studio would lose its place for anyone signed out.
 * Server-only: it reads every campaign.
 */
import { FUNNEL_STARTERS, forShipping } from "@/lib/funnel-starters";
import { NICHE_FIT, STARTER_NICHE_LABELS, type StarterNiche } from "@/lib/funnel-starter-catalog";

/** The heading of the campaigns in the studio (components/funnel-starter-gallery.tsx). */
export const STARTER_GALLERY_TITLE = "Start with a campaign, with first words written";

/** “A”, “B” and “C”. */
const quoted = (labels: string[]) => {
  const all = labels.map((label) => `“${label}”`);
  return all.length > 1 ? `${all.slice(0, -1).join(", ")} and ${all.at(-1)}` : all.join("");
};

/** The campaigns that fit a kind of creator, in the order the studio lists them. */
export function nicheCampaignLabels(niche: StarterNiche): string[] {
  return FUNNEL_STARTERS.filter((starter) => NICHE_FIT[niche][starter.id]).map((starter) => starter.label);
}

/**
 * How many campaigns fit, named when there are a few, and otherwise three of
 * them, so the card stays short enough to read as one link: the first ones
 * in the order of NICHE_FIT, which lists the most particular to that kind
 * of creator first, with one for something they ship among them when there
 * is one.
 */
export const NAMED_ON_CARD = 3;
export function nicheCampaignNamed(niche: StarterNiche): string[] {
  const fitting = Object.keys(NICHE_FIT[niche]).map((id) => FUNNEL_STARTERS.find((s) => s.id === id)).filter((s) => s !== undefined);
  if (fitting.length <= NAMED_ON_CARD) return fitting.map((s) => s.label);
  const picked = fitting.slice(0, NAMED_ON_CARD);
  const shipped = fitting.find(forShipping);
  if (shipped && !picked.some(forShipping)) picked[NAMED_ON_CARD - 1] = shipped;
  return picked.map((s) => s.label);
}
export function nicheCampaignWords(niche: StarterNiche): string {
  const labels = nicheCampaignLabels(niche);
  const named = nicheCampaignNamed(niche);
  return labels.length <= NAMED_ON_CARD ? `${quoted(named)}.` : `${labels.length} campaigns, such as ${quoted(named)}.`;
}

/** The card on that kind of creator's page: what they are, and where they are. */
export function nicheCampaignFeature(niche: StarterNiche) {
  return {
    icon: "ladder" as const,
    title: `Ready campaigns for ${STARTER_NICHE_LABELS[niche].toLowerCase()}`,
    body: `${nicheCampaignWords(niche)} Find them in your studio under Funnels, in “Start with a campaign”. See how campaigns work on the Funnels page.`,
    href: "/platform/funnels",
  };
}

/** The card on the Funnels page: every campaign counted, in two groups, with a few named of the larger one; how to find the ones that fit, and what their words promise. */
export function startersFeature() {
  const online = FUNNEL_STARTERS.filter((s) => !forShipping(s)).map((s) => s.label);
  const shipped = FUNNEL_STARTERS.filter(forShipping).map((s) => s.label);
  return {
    icon: "list" as const,
    title: "Campaigns with first words",
    body: `${FUNNEL_STARTERS.length} campaigns with their first words written. ${online.length} for what you sell, teach or offer online, such as ${quoted(online.slice(0, NAMED_ON_CARD))}. ${shipped.length} for something you ship: ${quoted(shipped)}. In your studio, open Funnels and go to “${STARTER_GALLERY_TITLE}”; choose your kind of creator under “What kind of creator are you?” to see the ones that fit you. Where a step sells something, you choose one of your own products for it. Every sentence is one you can say as it stands, or a part in [brackets] for you to fill in; none states a result, a number or a deadline. Everything is made as a draft for you to check.`,
  };
}
