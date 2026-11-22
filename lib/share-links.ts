/**
 * The links a creator shares a page with (components/share-panel.tsx), each
 * tagged with where it was shared, so the studio's numbers say which place
 * brought the visits and the sales (lib/came-from.ts reads the same tags).
 *
 * Every one opens the network's own page to post from, with the words filled
 * in; nothing is posted for the creator, and nothing is sent to any of them
 * from here. The plain link to copy is left untagged, since nobody can tell
 * where it will be pasted.
 */

export const SHARE_MEDIUM = "share";

export type SharePlace = "x" | "facebook" | "linkedin" | "whatsapp" | "email" | "qr" | "device" | "instagram";

/** Replace attribution tags without duplicates, preserving other query values and anchors. */
export function withTags(url: string, tags: Record<string, string>): string {
  const hash = url.indexOf("#");
  const fragment = hash < 0 ? "" : url.slice(hash);
  const address = hash < 0 ? url : url.slice(0, hash);
  const question = address.indexOf("?");
  const base = question < 0 ? address : address.slice(0, question);
  const params = new URLSearchParams(question < 0 ? "" : address.slice(question + 1));
  for (const [name, value] of Object.entries(tags)) {
    if (value) params.set(name, value);
    else params.delete(name);
  }
  const query = params.toString();
  return base + (query ? "?" + query : "") + fragment;
}

/** The address with the tags naming where it was shared. */
export function taggedFor(url: string, place: SharePlace): string {
  return withTags(url, { utm_source: place, utm_medium: place === "qr" ? "qr-code" : SHARE_MEDIUM });
}

/** Where a post can go, for a link made for that one post (postLink). */
export const POST_PLACES: { place: string; label: string }[] = [
  { place: "instagram", label: "Instagram" },
  { place: "tiktok", label: "TikTok" },
  { place: "youtube", label: "YouTube" },
  { place: "x", label: "X" },
  { place: "threads", label: "Threads" },
  { place: "facebook", label: "Facebook" },
  { place: "linkedin", label: "LinkedIn" },
  { place: "pinterest", label: "Pinterest" },
  { place: "google", label: "Google" },
  { place: "bing", label: "Bing" },
  { place: "email", label: "Email" },
  { place: "newsletter", label: "Newsletter" },
  { place: "podcast", label: "Podcast" },
];

/** A post's name as it is counted: what lib/came-from.ts keeps of a campaign tag. */
export function postName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * The address tagged for one post (added 11 October 2026): where it goes, and
 * the post's own name as its campaign, so the studio can say which post — not
 * only which network — brought the visits and the money.
 */
export type CampaignMedium = "post" | "paid" | "email";
export const CAMPAIGN_MEDIA: { value: CampaignMedium; label: string }[] = [
  { value: "post", label: "Organic post" },
  { value: "paid", label: "Paid ad" },
  { value: "email", label: "Email campaign" },
];

/** A campaign and optional creative, using exactly the tag shape checkout reads. */
export function campaignLink(url: string, place: string, name: string, medium: CampaignMedium = "post", content = ""): string {
  const where = POST_PLACES.some(p => p.place === place) ? place : "other";
  const kind = CAMPAIGN_MEDIA.some(m => m.value === medium) ? medium : "post";
  return withTags(url, { utm_source: where, utm_medium: kind, utm_campaign: postName(name), utm_content: postName(content) });
}

export function postLink(url: string, place: string, name: string): string {
  return campaignLink(url, place, name);
}

/** Where each network's own page to post from opens, with the words in. */
export function shareLinks(url: string, text: string): { place: Exclude<SharePlace, "qr" | "device">; label: string; href: string }[] {
  const e = encodeURIComponent;
  const at = (place: SharePlace) => taggedFor(url, place);
  return [
    { place: "x", label: "X", href: `https://x.com/intent/post?text=${e(text)}&url=${e(at("x"))}` },
    { place: "facebook", label: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${e(at("facebook"))}` },
    { place: "linkedin", label: "LinkedIn", href: `https://www.linkedin.com/sharing/share-offsite/?url=${e(at("linkedin"))}` },
    { place: "whatsapp", label: "WhatsApp", href: `https://wa.me/?text=${e(`${text} ${at("whatsapp")}`)}` },
    { place: "email", label: "Email", href: `mailto:?subject=${e(text)}&body=${e(`${text}\n\n${at("email")}`)}` },
  ];
}

/**
 * A QR code as an SVG drawing: one path of dark squares on a white field with
 * the four-square quiet border scanners need. `modules` is the code's grid,
 * row by row, true for dark.
 */
export function qrSvg(modules: boolean[], size: number, scale = 8): string {
  const quiet = 4;
  const full = (size + quiet * 2) * scale;
  let path = "";
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y * size + x]) path += `M${(x + quiet) * scale} ${(y + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${full}" height="${full}" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/><path fill="#000000" d="${path}"/></svg>`;
}

/** A file name from a title: "knife-skills-qr.svg". */
export function qrFileName(title: string, ext: "svg" | "png"): string {
  const base = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "page"}-qr.${ext}`;
}
