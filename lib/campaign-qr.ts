import QRCode from "qrcode";
import { postName, qrFileName, qrSvg, withTags } from "@/lib/share-links";

/**
 * A campaign QR code for events and printed material (632 [AA2](q)).
 *
 * The code opens the page with the campaign's own tag, the utm_campaign that
 * checkout reads (lib/came-from.ts) and lib/campaign-results.ts groups visits
 * and paid records by, under the QR source and medium the share panel already
 * uses for its untagged QR (lib/share-links.ts taggedFor). So a scan at a
 * fair is counted with the same campaign as its posts, links and ad spend,
 * and nothing new is recorded anywhere: it is drawn here, from the code's
 * grid, with no network call and no stored value.
 *
 * The tag is printed on paper for anyone to read, so a name that looks like
 * an email address or a phone number is refused rather than printed.
 */

export const CAMPAIGN_QR_SOURCE = "qr";
export const CAMPAIGN_QR_MEDIUM = "qr-code";

/** An email address, or seven or more digits in a row with only spaces, dots, dashes, brackets or a plus between them. */
const PERSONAL = /@|\d(?:[\s().+-]*\d){6,}/;

/**
 * A calendar date written year first with one separator (2026-11-27,
 * 2026.11.27, 2026/11/27): at most four digits in a row, so it is set aside
 * before the digit count. Not when more digits are joined to it, so a phone
 * number written beside or around a date is still counted whole.
 */
const DATE = /(?<!\d[\s().+-]*)(?:19|20)\d\d([-./])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12]\d|3[01])(?![\s().+-]*\d)/g;

/** The campaign tag as it is counted, or why it is refused. */
export function campaignQrTag(name: string): { tag: string } | { refused: "empty" | "personal" } {
  if (PERSONAL.test(name.replace(DATE, " "))) return { refused: "personal" };
  const tag = postName(name);
  return tag ? { tag } : { refused: "empty" };
}

/**
 * The page's address with the QR tags, made exactly as the campaign link is
 * (lib/share-links.ts withTags): the utm_* tags are set, a stale utm_content
 * is removed, and everything else the page's address carries is kept, above
 * all an affiliate's ?via= (proxy.ts credits the affiliate only from it) and
 * a discount ?code=. Every caller passes an address built on the server.
 * Null when the page is not a web address or a name is refused.
 */
export function campaignQrLink(pageUrl: string, campaign: string, content = ""): string | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  if (page.protocol !== "https:" && page.protocol !== "http:") return null;
  const name = campaignQrTag(campaign);
  if (!("tag" in name)) return null;
  let variant = "";
  if (content.trim()) {
    const own = campaignQrTag(content);
    if (!("tag" in own)) return null;
    variant = own.tag;
  }
  return withTags(pageUrl, { utm_source: CAMPAIGN_QR_SOURCE, utm_medium: CAMPAIGN_QR_MEDIUM, utm_campaign: name.tag, utm_content: variant });
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** What the code opens, in words: its text alternative and the SVG's title. */
export function campaignQrLabel(title: string, tag: string): string {
  return `QR code that opens ${title}, campaign ${tag}`;
}

export type CampaignQrCode = { tag: string; link: string; label: string; svg: string; fileName: string };

/** The campaign's link, its drawing as a titled SVG and its file name; the same for the same campaign every time. */
export function campaignQr(pageUrl: string, campaign: string, title: string, content = ""): CampaignQrCode | null {
  const link = campaignQrLink(pageUrl, campaign, content);
  const name = campaignQrTag(campaign);
  if (!link || !("tag" in name)) return null;
  let drawing: string;
  try {
    const code = QRCode.create(link, { errorCorrectionLevel: "M" });
    drawing = qrSvg(Array.from(code.modules.data, Boolean), code.modules.size);
  } catch {
    return null;
  }
  const label = campaignQrLabel(title, name.tag);
  const svg = drawing.replace(/^<svg ([^>]*)>/, (_, attributes: string) => `<svg role="img" aria-label="${xml(label)}" ${attributes}><title>${xml(label)}</title>`);
  return { tag: name.tag, link, label, svg, fileName: qrFileName(`${name.tag} campaign`, "svg") };
}
