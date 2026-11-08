import QRCode from "qrcode";
import { postName, qrFileName, qrSvg } from "@/lib/share-links";

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

/** The campaign tag as it is counted, or why it is refused. */
export function campaignQrTag(name: string): { tag: string } | { refused: "empty" | "personal" } {
  if (PERSONAL.test(name)) return { refused: "personal" };
  const tag = postName(name);
  return tag ? { tag } : { refused: "empty" };
}

/**
 * The page's address with only the QR tags: the page's own path, with other
 * query values and anchors left out, so nothing from the creator's address bar
 * is printed. Null when the page is not a web address or a name is refused.
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
  const query = new URLSearchParams({ utm_source: CAMPAIGN_QR_SOURCE, utm_medium: CAMPAIGN_QR_MEDIUM, utm_campaign: name.tag });
  if (variant) query.set("utm_content", variant);
  return `${page.origin}${page.pathname}?${query.toString()}`;
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
