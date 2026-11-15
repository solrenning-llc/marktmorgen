/**
 * "See campaign results" in the promotion planner (components/promotion-planner.tsx) moves to the Campaigns section
 * (components/campaign-results.tsx, #numbers-posts). That section is drawn only when the period has a campaign row or a
 * recorded ad; before, with none, the button did nothing at all (VR site sweep, 12/11/2026). Now it either moves there
 * and puts the focus on the section's heading, so a keyboard or screen-reader user lands there too (2.4.3), or says
 * plainly that there are no campaign results for this period yet.
 *
 * The section is also left out while ad spend could not be read in full (components/stats-panel.tsx draws it only with
 * the spend known). Then "no campaign results yet" would be untrue, since the campaign may have visits and payments that
 * are only hidden, so the note says the spend is unread instead (Claude 6 on #4094; rule 24: unknown is never zero).
 */
export const CAMPAIGN_RESULTS_ID = "numbers-posts";

export const NO_CAMPAIGN_RESULTS = "No campaign results for this period yet. They show up below once a visit or a payment comes from one of your campaign links.";

export const CAMPAIGN_RESULTS_SPEND_UNREAD = "Campaign results are hidden while your ad spend could not be read in full. Reload the page to try again.";

/** The status line after "See campaign results": empty when the section was found, else why it is not there. */
export function campaignResultsNote(found: boolean, spendsUnread: boolean): string {
  if (found) return "";
  return spendsUnread ? CAMPAIGN_RESULTS_SPEND_UNREAD : NO_CAMPAIGN_RESULTS;
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
