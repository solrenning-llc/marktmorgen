/**
 * 632 [AA2](q): a campaign QR code for events and printed material, with the
 * same sales measurement as the campaign's links (lib/campaign-qr.ts,
 * components/campaign-qr.tsx, components/share-panel.tsx).
 *
 * The link carries exactly the campaign tag lib/campaign-results.ts groups by
 * (utm_campaign, read by lib/came-from.ts at checkout), under the QR source
 * the share panel already uses; it carries nothing personal; it is the same
 * for the same campaign every time; the SVG is drawn locally from the code's
 * grid, with a title; the component has a text alternative, a named
 * download of at least 44 px, readable tokens and no meaning by color alone.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QRCode from "qrcode";
import { cameFrom } from "@/lib/came-from";
import { campaignResultsFrom } from "@/lib/campaign-results";
import { campaignLink, postName } from "@/lib/share-links";
import { viaCookieName } from "@/lib/affiliate-setting";
import { codeCookieName } from "@/lib/code-link";
import { proxy } from "@/proxy";
import { campaignQr, campaignQrLink, campaignQrTag, CAMPAIGN_QR_MEDIUM, CAMPAIGN_QR_SOURCE } from "@/lib/campaign-qr";
import { CampaignQr } from "@/components/campaign-qr";
import { done, is, part } from "./check";

const page = "https://marktmorgen.com/@harbor/p/knife-skills";

part("The link carries exactly the campaign tag");
const link = campaignQrLink(page, "Spring Fair 2026");
is("a link is made", typeof link, "string");
const url = new URL(link ?? "https://x.invalid/");
is("same page", url.origin + url.pathname, "https://marktmorgen.com/@harbor/p/knife-skills");
is("campaign tag is the counted post name", url.searchParams.get("utm_campaign"), postName("Spring Fair 2026"));
is("campaign tag value", url.searchParams.get("utm_campaign"), "spring-fair-2026");
is("source is the QR source the share panel uses", url.searchParams.get("utm_source"), "qr");
is("medium is the QR medium the share panel uses", url.searchParams.get("utm_medium"), "qr-code");
is("constants say the same", [CAMPAIGN_QR_SOURCE, CAMPAIGN_QR_MEDIUM], ["qr", "qr-code"]);
is("only the tracking tags travel", [...url.searchParams.keys()].sort(), ["utm_campaign", "utm_medium", "utm_source"]);
const read = cameFrom(link, "marktmorgen.com");
is("checkout reads back the same campaign", read.campaign, "spring-fair-2026");
is("checkout reads back the QR source", read.source, "qr");
const withVariant = campaignQrLink(page, "Spring Fair 2026", "Flyer A");
is("optional printed variant is the content tag", new URL(withVariant ?? "https://x.invalid/").searchParams.get("utm_content"), "flyer-a");
const entries = (address: string | null) => [...new URL(address ?? "https://x.invalid/").searchParams.entries()].sort();
is("existing tracking tags are replaced, a stale variant removed", entries(campaignQrLink(page + "?utm_campaign=old&utm_content=stale", "Spring Fair 2026")), entries(link));

part("The link keeps what the campaign link keeps: the affiliate code and the discount code");
const untracked = (address: string | null) => {
  const out = new URL(address ?? "https://x.invalid/");
  for (const key of [...out.searchParams.keys()]) if (key.startsWith("utm_")) out.searchParams.delete(key);
  return out.toString();
};
const affiliatePage = page + "?via=ana7";
const affiliateQr = campaignQrLink(affiliatePage, "Spring Fair");
is("an affiliate's QR keeps ?via=", new URL(affiliateQr ?? "https://x.invalid/").searchParams.get("via"), "ana7");
is("an affiliate's QR keeps what the campaign link keeps", untracked(affiliateQr), untracked(campaignLink(affiliatePage, "instagram", "Spring Fair")));
is("an affiliate's QR still carries the QR tags", ["utm_source", "utm_medium", "utm_campaign"].map(key => new URL(affiliateQr ?? "https://x.invalid/").searchParams.get(key)), ["qr", "qr-code", "spring-fair"]);
const codePage = page + "?code=SPRING&via=ana7";
const codeQr = campaignQrLink(codePage, "Spring Fair", "Flyer A");
is("a discount link's QR keeps ?code=", new URL(codeQr ?? "https://x.invalid/").searchParams.get("code"), "SPRING");
is("a discount link's QR keeps what the campaign link keeps", untracked(codeQr), untracked(campaignLink(codePage, "instagram", "Spring Fair", "post", "Flyer A")));
const otherValues = page + "?utm_campaign=old&ref=someone";
is("other values: exactly what the campaign link keeps, no more, no less", untracked(campaignQrLink(otherValues, "Spring Fair")), untracked(campaignLink(otherValues, "instagram", "Spring Fair")));
is("an affiliate's QR is the same every time", campaignQrLink(affiliatePage, "spring-fair"), affiliateQr);

is("a page that is not a web address makes no link", campaignQrLink("javascript:alert(1)", "Spring Fair 2026"), null);
is("an empty campaign makes no link", campaignQrLink(page, "  !!!  "), null);

part("Sales are grouped under the same tag");
const results = campaignResultsFrom({ sales: "ok", partial: false, days: [{ date: "2026-11-01" }],
  posts: { d7: [{ campaign: read.campaign, source: read.source, sources: ["qr"], visits: 12, sales: 2, cents: 9800 }], d30: [], d90: [] } } as never, "d7", []);
is("the campaign row is the QR's tag", results?.rows.map(row => [row.campaign, row.paidRecords, row.gross]), [["spring-fair-2026", 2, 9800]]);

part("The tag never carries personal data");
is("an email address is refused", campaignQrTag("Fair for ana.silva@example.com"), { refused: "personal" });
is("a phone number is refused", campaignQrTag("Call 555-201-4477"), { refused: "personal" });
is("a long run of digits is refused", campaignQrTag("member 123456789"), { refused: "personal" });
is("a plain campaign name with a year is kept", campaignQrTag("Spring Fair 2026"), { tag: "spring-fair-2026" });
is("a name with a dashed date is kept", campaignQrTag("sale-2026-11-27"), { tag: "sale-2026-11-27" });
is("a name with a dotted date is kept", campaignQrTag("launch 2026.11.27"), { tag: "launch-2026.11.27" });
is("a name with a slashed date is kept", campaignQrTag("Fair 2026/11/27"), { tag: "fair-2026-11-27" });
is("a dated name makes a link", new URL(campaignQrLink(page, "sale-2026-11-27") ?? "https://x.invalid/").searchParams.get("utm_campaign"), "sale-2026-11-27");
is("a phone number without separators is refused", campaignQrTag("Call 5552014477"), { refused: "personal" });
is("seven digits in a row are refused", campaignQrTag("sale 2026112"), { refused: "personal" });
is("a phone written with dots is refused", campaignQrTag("Call 555.201.4477"), { refused: "personal" });
is("a phone beside a date is still refused", campaignQrTag("sale-2026-11-27 555-201-4477"), { refused: "personal" });
is("a date followed by more digits is not a date", campaignQrTag("2026-11-2744"), { refused: "personal" });
is("an email address beside a date is still refused", campaignQrTag("sale-2026-11-27 ana@example.com"), { refused: "personal" });
is("no link from a personal name", campaignQrLink(page, "ana.silva@example.com"), null);
is("no link from a personal variant", campaignQrLink(page, "Spring Fair", "ana.silva@example.com"), null);
is("the link holds no @ and no store or account id", /@harbor\/p\/knife-skills\?utm/.test(link ?? "") && !/acct_|store=|email|%40/.test(link ?? ""), true);

part("Stable for the campaign");
const one = campaignQr(page, "Spring Fair 2026", "Knife skills");
const two = campaignQr(page, "spring-fair-2026", "Knife skills");
is("the same link every time", one && two ? one.link === two.link : false, true);
is("the same drawing every time", one && two ? one.svg === two.svg : false, true);
is("the same file name every time", one && two ? one.fileName === two.fileName : false, true);
is("another campaign, another code", campaignQr(page, "Summer Fair", "Knife skills")?.svg === one?.svg, false);

part("The SVG");
const svg = one?.svg ?? "";
is("one svg element", (svg.match(/<svg\b/g) ?? []).length === 1 && svg.endsWith("</svg>"), true);
is("has a title saying what it opens", svg.includes("<title>QR code that opens Knife skills, campaign spring-fair-2026</title>"), true);
is("is labeled as an image", /<svg [^>]*role="img"/.test(svg) && /<svg [^>]*aria-label="QR code that opens Knife skills, campaign spring-fair-2026"/.test(svg), true);
const code = QRCode.create(one?.link ?? "", { errorCorrectionLevel: "M" });
const dark = Array.from(code.modules.data, Boolean).filter(Boolean).length;
is("drawn from the code's own grid: one square per dark module", (svg.match(/h8v8h-8z/g) ?? []).length, dark);
is("black on white", svg.includes('fill="#ffffff"') && svg.includes('fill="#000000"'), true);
const odd = campaignQr(page, "Fair", "Tom & \"Jerry\" <b>")?.svg ?? "";
is("title text is escaped", odd.includes("Tom &amp; &quot;Jerry&quot; &lt;b&gt;") && !odd.includes("<b>"), true);
is("no external address inside the drawing", /https?:\/\//.test(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")), false);
is("file name names the campaign", one?.fileName, "spring-fair-2026-campaign-qr.svg");

part("The component");
const html = renderToStaticMarkup(createElement(CampaignQr, { url: page, title: "Knife skills", campaign: "Spring Fair 2026" }));
is("an image with a text alternative", html.includes('alt="QR code that opens Knife skills, campaign spring-fair-2026"'), true);
is("the address written out", html.includes(`>${(link ?? "").replace(/&/g, "&amp;")}</p>`), true);
const download = /<a [^>]*download="spring-fair-2026-campaign-qr.svg"[^>]*>([^<]*)<\/a>/.exec(html);
is("a download as SVG", Boolean(download), true);
is("the download's name says what and which format", download?.[1], "Download the QR code for spring-fair-2026 (SVG)");
const css = readFileSync("app/globals.css", "utf8");
const minHeight = (name: string) => Number(new RegExp("\\n\\." + name + "\\s*\\{[^}]*min-height:\\s*(\\d+)px").exec(css)?.[1] ?? 0);
const controls = [...html.matchAll(/<(a|button) [^>]*class="([^"]*)"/g)].map(match => match[2].split(/\s+/));
is("two controls: download and copy", controls.length, 2);
is("every control is at least 44 px tall", controls.every(classes => classes.includes("btn") && Math.max(minHeight("btn"), 0) >= 44 && (!classes.includes("btn-sm") || minHeight("btn-sm") >= 44)), true);
const token = (name: string) => new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})").exec(css)?.[1] ?? "";
const luminance = (hex: string) => {
  const [r, g, b] = (hex.slice(1).match(/../g) ?? []).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
};
const contrast = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const textTokens = [...new Set([...html.matchAll(/\btext-(ink(?:-[a-z]+)?|danger|mint-text)\b/g)].map(match => match[1]))];
is("text uses existing color tokens", textTokens.length > 0 && textTokens.every(name => token(name) !== ""), true);
is("every text token keeps 7:1 on paper and white", textTokens.every(name => contrast(token(name), token("paper")) >= 7 && contrast(token(name), "#ffffff") >= 7), true);
is("explains in words how sales are counted", html.includes("same campaign tag") && html.includes("QR code"), true);
const refused = renderToStaticMarkup(createElement(CampaignQr, { url: page, title: "Knife skills", campaign: "ana.silva@example.com" }));
is("a refused name says why in words, as a status", /role="status"[^>]*>[^<]*email address or phone number/.test(refused), true);
is("a refused name draws no code and offers no download", !refused.includes("<img") && !refused.includes("download="), true);
is("no meaning by color alone: no color-only danger text", !/text-danger/.test(html + refused), true);

part("Where it is shown");
const panel = readFileSync("components/share-panel.tsx", "utf8");
// Only the optional variant looks personal (Claude 1's LOW on #3194): the sentence names the variant, never the name.
const variantRefused = renderToStaticMarkup(createElement(CampaignQr, { url: page, title: "Knife skills", campaign: "spring-fair", content: "call 85 99999-1234" }));
is("a variant that looks like a phone number: no code, and the sentence names the variant, not the campaign name", [variantRefused.includes("<svg"), variantRefused.includes("No QR code for this variant"), variantRefused.includes("No QR code for this name")], [false, true, false]);
is("the share panel shows it beside the campaign link", panel.includes('import { CampaignQr } from "@/components/campaign-qr";') && panel.includes("<CampaignQr url={url} title={title} campaign={post} content={postContent} />"), true);
const lib = readFileSync("lib/campaign-qr.ts", "utf8") + readFileSync("components/campaign-qr.tsx", "utf8");
is("drawn locally: no network, no store write", !/fetch\(|@\/lib\/redis|https:\/\/api\./.test(lib), true);

part("A scan of the affiliate's QR credits the affiliate, through the real proxy");
void proxy(new NextRequest(codeQr ?? "https://x.invalid/", { headers: { host: "marktmorgen.com", "x-vercel-ip-country": "US" } })).then(scan => {
  is("the affiliate cookie is set from the scanned link", scan.cookies.get(viaCookieName("harbor"))?.value?.split("~")[0]?.split(".")[0] ?? null, "ana7");
  is("the discount code cookie is set from the scanned link", scan.cookies.get(codeCookieName("harbor"))?.value ?? null, "SPRING");
  done();
});
