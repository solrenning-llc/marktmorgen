/**
 * What an email sold: the tag its links carry, so the answer can be read.
 *
 * A creator sends an email and then knows nothing. No opens, no clicks, and
 * no way to tell the email that sold forty plans from the one that sold none
 * — so "which of these is worth sending again?" was answered by feel.
 *
 * The store already knows how to join a visit to its money: the tags on the
 * page a buyer buys from are written into the checkout on the creator's own
 * Stripe account, and come back attached to the sale (lib/came-from.ts). All
 * an email has to do is arrive at the store wearing one.
 *
 * So a link in an email that points at the creator's own store has three
 * tags added to where it goes: utm_source=email, utm_medium saying whether it
 * was a one-off or a sequence, and utm_campaign naming the email. What the
 * reader sees written in the email is the address as the creator typed it.
 *
 * What the tag is, and is not:
 *
 *   - One per email, never one per reader. Everybody who gets the email gets
 *     the same link, so it says which email a sale came from and nothing
 *     about who bought. No pixel, no redirect through us, no profile. (An
 *     email trying two subject lines has one per subject line instead, each
 *     shared by everybody who got that line: lib/mail-test.ts.)
 *   - Only on links to the creator's own store, here or on their own domain.
 *     Somebody else's address is theirs and is left exactly as typed.
 *   - Never over the creator's own. A link that already carries a utm tag is
 *     one they are measuring their own way, and it is not touched.
 *
 * One exception, only for somebody who ticked a box of its own to allow it:
 * in a sequence's emails, their links to the store carry one more parameter,
 * which says the link was theirs, so the next email can go only to those who
 * used one, or did not (lib/mail-clicks.ts says how, and how it is taken back).
 *
 * And what it counts, said plainly because the page says it too: a sale made
 * on the page the link opened. Somebody who reads the email on Monday and
 * comes back by themselves on Friday is not counted for it (lib/came-from.ts
 * says why that is the honest limit of a store with no cookie of this kind).
 */
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";

/** The utm_source every email of this kind arrives with. */
export const MAIL_SOURCE = "email";

export type MailTag = { medium: "broadcast" | "sequence"; campaign: string };

/** The campaign of a one-off email. Short enough to survive lib/came-from.ts's forty characters. */
export const broadcastCampaign = (broadcastId: string) => `b-${broadcastId}`;
/**
 * The campaign of one subject line's share of a one-off email, when two are
 * being tried (lib/mail-test.ts). One per subject line, shared by everybody
 * who got it, so it still says nothing about who anybody is. Twenty-eight
 * characters: inside the thirty a visit's tag is kept at (lib/stats.ts).
 */
export const variantCampaign = (broadcastId: string, variant: "a" | "b") => `b-${broadcastId}-${variant}`;
/** Every campaign a one-off email's links may carry: its own, and each subject line's. */
export const broadcastCampaigns = (broadcastId: string) => [broadcastCampaign(broadcastId), variantCampaign(broadcastId, "a"), variantCampaign(broadcastId, "b")];
/** The campaign of one email of a sequence, and the start every email of that sequence shares. */
export const stepCampaign = (flowId: string, stepId: string) => `s-${flowId}-${stepId}`;
export const flowCampaignPrefix = (flowId: string) => `s-${flowId}-`;

const UTM = ["utm_source", "utm_medium", "utm_campaign"] as const;

/** Whether an address is one of this store's own pages. */
export function isOwnLink(url: URL, store: Pick<Store, "handle" | "domain">): boolean {
  if (url.protocol !== "https:") return false;
  // A pending domain is not yet the store, and another HTTPS port is another
  // origin. Neither receives the email's tags or the reader's sequence key.
  if (store.domain?.liveAt && url.origin === `https://${store.domain.name.toLowerCase()}`) return true;
  let site: string;
  try {
    site = new URL(SITE_URL).origin;
  } catch {
    return false;
  }
  if (url.origin !== site) return false;
  const home = `/@${store.handle.toLowerCase()}`;
  const path = url.pathname.toLowerCase();
  return path === home || path.startsWith(`${home}/`);
}

/**
 * Where a link in an email goes: the same address, tagged when it is the
 * creator's own store and they have not tagged it themselves. Anything that
 * is not an address this can read comes back unchanged.
 */
export function taggedLink(
  href: string,
  store: Pick<Store, "handle" | "domain">,
  tag: MailTag,
  /** The reader's own key, only when they allowed their link use to be seen (lib/mail-clicks.ts). */
  readerKey?: string,
): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (!isOwnLink(url, store)) return href;
  if (UTM.some((name) => url.searchParams.has(name))) return href;
  url.searchParams.set("utm_source", MAIL_SOURCE);
  url.searchParams.set("utm_medium", tag.medium);
  url.searchParams.set("utm_campaign", tag.campaign);
  if (readerKey && tag.medium === "sequence") url.searchParams.set("mk", readerKey);
  return url.toString();
}
