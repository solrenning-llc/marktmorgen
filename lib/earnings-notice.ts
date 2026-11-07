/**
 * 561 [NE1] (owner, 30 October 2026, 02:58 Fortaleza): one notice, on every
 * public Marktmorgen page, that the software promises nobody sales, income or
 * any other result. The footer shows it on every page and the Terms keep it in
 * their own section, under a fixed anchor, so one place can be linked to.
 *
 * Kept here, once, so the footer and the Terms can never say two different
 * things. Plain US English (AX274, 3.1.5): short sentences, no legal words.
 *
 * The home page is held to 600 words and 30 links (498 [ME3], owner,
 * 28 October 2026), and it already sits close to both, so its footer shows the
 * one sentence that carries the promise (EARNINGS_NOTICE_SHORT), with no new
 * link. Every other page shows the whole notice.
 */

/** The anchor of the Terms section that holds the notice. */
export const EARNINGS_NOTICE_ANCHOR = "no-earnings-claims";

/** Where the notice lives in full. */
export const EARNINGS_NOTICE_HREF = `/terms#${EARNINGS_NOTICE_ANCHOR}`;

/** The whole notice, as the owner approved its meaning, in three sentences. */
export const EARNINGS_NOTICE: readonly string[] = [
  "Marktmorgen is software for selling your own work.",
  "We make no promise that using it will bring you sales, income or any result.",
  "What you earn depends on your products, your audience and your work.",
];

/** The notice as one paragraph. */
export const EARNINGS_NOTICE_TEXT = EARNINGS_NOTICE.join(" ");

/** The sentence that carries the promise, for the home page's short footer. */
export const EARNINGS_NOTICE_SHORT = "Marktmorgen makes no promise of sales, income or any result.";
