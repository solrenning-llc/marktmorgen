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
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { NICHE_FIT, STARTER_NICHE_LABELS, type StarterNiche } from "@/lib/funnel-starter-catalog";

/** The heading of the campaigns in the studio (components/funnel-starter-gallery.tsx). */
export const STARTER_GALLERY_TITLE = "Start with a campaign, with first words written";

const quoted = (labels: string[]) => labels.map((label) => `“${label}”`).join(", ");

/** The campaigns that fit a kind of creator, in the order the studio lists them. */
export function nicheCampaignLabels(niche: StarterNiche): string[] {
  return FUNNEL_STARTERS.filter((starter) => NICHE_FIT[niche][starter.id]).map((starter) => starter.label);
}

/** The card on that kind of creator's page: what they are, and where they are. */
export function nicheCampaignFeature(niche: StarterNiche) {
  return {
    icon: "ladder" as const,
    title: `Ready campaigns for ${STARTER_NICHE_LABELS[niche].toLowerCase()}`,
    body: `${quoted(nicheCampaignLabels(niche))}. Find them in your studio under Funnels, in “Start with a campaign”. See how they work.`,
    href: "/platform/funnels",
  };
}

/** The card on the Funnels page: every campaign, how to find the ones that fit, and what their words promise. */
export function startersFeature() {
  return {
    icon: "list" as const,
    title: "Campaigns with first words",
    body: `${FUNNEL_STARTERS.length} campaigns with their first words written: ${quoted(FUNNEL_STARTERS.map((starter) => starter.label))}. In your studio, open Funnels and go to “${STARTER_GALLERY_TITLE}”; choose your kind of creator under “What kind of creator are you?” to see the ones that fit you. Where a step sells something, you choose one of your own products for it. Every sentence is one you can say as it stands, or a part in [brackets] for you to fill in; none states a result, a number or a deadline. Everything is made as a draft for you to check.`,
  };
}
