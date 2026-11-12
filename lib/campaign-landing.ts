/**
 * A landing page for one ad campaign, made from the product's own sales page:
 * 632 [AA2] (m), unit 1 (owner, 2 November 2026). Pure; where it is kept and
 * the address it is served at (never indexed by search engines) come next.
 *
 * Someone who clicks an ad should land on the words the ad promised. So the
 * landing is the sales page as the creator published it, with only the words
 * the ad said put where a visitor reads first: the top block's headline and
 * the line under it, and the button's words. Nothing else changes, nothing is
 * added: no block, no countdown, no "only today", no review, no figure. The
 * price, the guarantee, the reviews and everything else are the page's own.
 *
 * It is made only from words that passed the ad check (lib/ad-creative-check.ts,
 * checkAdText: no promise of fast money, no earnings claim, no false urgency,
 * no price that is not the product's, no testimonial that is not a verified
 * review), so the page can never say what the ad would have been refused for.
 * Words that do not fit a place are refused, never cut: the creator shortens
 * them, so nothing they wrote is changed without them (the handoff's rule on
 * customer content).
 *
 * A countdown already on the page is kept only while its moment is ahead:
 * one whose moment passed is left out rather than shown at zero. A headline or
 * page test of the sales page does not run on it, so the ad's words are the
 * words shown.
 */
import type { AdCheck, AdText } from "@/lib/ad-creative-check";
import { MAX_CTA_LABEL, MAX_HEADLINE, MAX_SUBHEADLINE, type SalesPage } from "@/lib/sales-page";

/** A campaign's tag as the numbers count it (lib/came-from.ts keeps utm_campaign the same way). */
export const CAMPAIGN_TAG = /^[a-z0-9._-]{1,40}$/;

export type CampaignLanding = {
  /** The campaign it is for: the utm_campaign its ad links carry. */
  campaign: string;
  headline: string;
  sub: string;
  /** The button's words; "" keeps the page's own. */
  button: string;
};

export type LandingRefusal = "campaign" | "not_checked" | "headline" | "headline_long" | "sub_long" | "button_long" | "no_hero";

/** What each refusal says to the creator, in plain US English. */
export const LANDING_REFUSALS: Readonly<Record<LandingRefusal, string>> = {
  campaign: "Give the campaign a short name of letters, numbers, dots, dashes or underscores, as in its links.",
  not_checked: "Fix what the ad check found first: the page uses the same words.",
  headline: "The ad needs a headline for the top of the page.",
  headline_long: `Shorten the headline to ${MAX_HEADLINE} characters for the top of the page.`,
  sub_long: `Shorten the ad's text to ${MAX_SUBHEADLINE} characters for the line under the headline.`,
  button_long: `Shorten the button to ${MAX_CTA_LABEL} characters.`,
  no_hero: "Add a top block (Hero) to the sales page first: that is where the ad's words go.",
};

const words = (raw: string) => raw.replace(/\s+/g, " ").trim();

/** The ad's words for its landing page, when the ad passed the check and each fits its place. */
export function landingFrom(ad: AdText, check: AdCheck, campaign: string): { ok: true; landing: CampaignLanding } | { ok: false; error: LandingRefusal } {
  if (!CAMPAIGN_TAG.test(campaign)) return { ok: false, error: "campaign" };
  if (!check.sendable) return { ok: false, error: "not_checked" };
  const headline = words(ad.headline);
  const sub = words(ad.text);
  const button = words(ad.button);
  if (!headline) return { ok: false, error: "headline" };
  if (headline.length > MAX_HEADLINE) return { ok: false, error: "headline_long" };
  if (sub.length > MAX_SUBHEADLINE) return { ok: false, error: "sub_long" };
  if (button.length > MAX_CTA_LABEL) return { ok: false, error: "button_long" };
  return { ok: true, landing: { campaign, headline, sub, button } };
}

/** The sales page with the campaign's words in place. Refused when the page has no top block to hold them. */
export function landingPage(page: SalesPage, landing: CampaignLanding, nowSeconds: number): { ok: true; page: SalesPage } | { ok: false; error: LandingRefusal } {
  const first = page.blocks.findIndex((block) => block.kind === "hero");
  if (first < 0) return { ok: false, error: "no_hero" };
  const blocks = page.blocks
    // A countdown to a moment already gone would read as zero, or as a trick: left out.
    .filter((block) => block.kind !== "countdown" || block.until > nowSeconds)
    .map((block) => {
      if (block.kind === "hero" && block.id === page.blocks[first].id) return { ...block, headline: landing.headline, sub: landing.sub };
      if (block.kind === "cta" && landing.button) return { ...block, label: landing.button };
      return block;
    });
  // A headline or page test of the sales page would show other words in place of the ad's: none runs here.
  return { ok: true, page: { ...page, blocks, test: null, variant: null } };
}
