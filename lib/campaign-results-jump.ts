/**
 * "See campaign results" in the promotion planner (components/promotion-planner.tsx) moves to the Campaigns section
 * (components/campaign-results.tsx, #numbers-posts). That section is drawn only when the period has a campaign row or a
 * recorded ad; before, with none, the button did nothing at all (VR site sweep, 12/11/2026). Now it either moves there
 * and puts the focus on the section's heading, so a keyboard or screen-reader user lands there too (2.4.3), or says
 * plainly that there are no campaign results for this period yet.
 */
export const CAMPAIGN_RESULTS_ID = "numbers-posts";

export const NO_CAMPAIGN_RESULTS = "No campaign results for this period yet. They show up below once a visit or a payment comes from one of your campaign links.";

/**
 * The section is also left out while the ad spend does not read (components/stats-panel.tsx draws it only with the
 * spend known): the campaigns may have visits and payments then, so "none yet" would be untrue (Claude 6 on #4094,
 * rule 24). The planner says this instead, with the way to see them.
 */
export const CAMPAIGN_RESULTS_HIDDEN = "Campaign results are not shown while ad spend could not be read in full. Reload to try again.";

/** What the planner says when the Campaigns section is not on the page: hidden by an unread ad spend, or none yet. */
export function campaignResultsMissing(spendUnread: boolean): string {
  return spendUnread ? CAMPAIGN_RESULTS_HIDDEN : NO_CAMPAIGN_RESULTS;
}

type Heading = { scrollIntoView(options: ScrollIntoViewOptions): void; focus(options?: FocusOptions): void };

/** Moves to the Campaigns section when it is on the page; false when it is not, so the caller says so. */
export function showCampaignResults(find: (id: string) => Heading | null, reduceMotion: boolean): boolean {
  const heading = find(CAMPAIGN_RESULTS_ID);
  if (!heading) return false;
  heading.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  heading.focus({ preventScroll: true });
  return true;
}
