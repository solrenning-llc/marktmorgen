/**
 * 244 [SP1]: free tools for creators, with no sign-up, at /platform/free-tools
 * (under /platform, an address no store can take). Each runs entirely in the
 * visitor's browser: no server work, no provider, nothing kept, nothing sent.
 * Pure and browser-safe.
 */

export const FREE_TOOLS_PATH = "/platform/free-tools";

export type FreeTool = { slug: string; title: string; sentence: string };

/** The tools, in the order the hub lists them. Only tools that work today are listed. */
export const FREE_TOOLS: readonly FreeTool[] = [
  {
    slug: "what-is-left-of-a-sale",
    title: "What is left of a sale",
    sentence: "Type a price and your own fees to see what one sale leaves you, before taxes.",
  },
  {
    slug: "qr-code-for-a-link",
    title: "QR code for a link",
    sentence: "Type a web address to make a QR code you can download and print, made in your browser.",
  },
  {
    slug: "resize-a-picture",
    title: "Resize a picture for a product page",
    sentence: "Make a picture the size a store keeps a product picture at, in your browser, without uploading it.",
  },
];

/**
 * An amount typed by a visitor, in cents: digits, an optional decimal point or comma with one or two digits, and
 * commas between thousands. Anything else, an empty field included, is null: never read as zero.
 */
export function readAmount(raw: string): number | null {
  const text = raw.trim();
  let whole: string;
  let part = "";
  const thousands = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(text);
  const plain = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(text);
  if (thousands) {
    whole = thousands[1].replace(/,/g, "");
    part = thousands[2] ?? "";
  } else if (plain) {
    whole = plain[1];
    part = plain[2] ?? "";
  } else return null;
  const cents = Number(whole) * 100 + Number(part.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** A percentage typed by a visitor, in basis points (2.9 is 290), from 0 to 100 with up to two decimals; else null. */
export function readPercent(raw: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?\s*%?$/.exec(raw.trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bps <= 10_000 ? bps : null;
}

export type TakeHome = { feeCents: number; otherCents: number; leftCents: number; belowZero: boolean };

/**
 * What one sale leaves: the price, less the visitor's percentage fee (rounded to the cent, half up), their fixed fee
 * per sale and any other cost per sale they typed. No tax is added or assumed. A result below zero is said as such.
 */
export function takeHome({ priceCents, percentBps, fixedCents, otherCents }: { priceCents: number; percentBps: number; fixedCents: number; otherCents: number }): TakeHome {
  const feeCents = Math.floor((priceCents * percentBps + 5_000) / 10_000) + fixedCents;
  const leftCents = priceCents - feeCents - otherCents;
  return { feeCents, otherCents, leftCents, belowZero: leftCents < 0 };
}

/**
 * What one visit to a tool page costs to serve, never zero (244 [SP1] (6)): the bytes and requests of a first visit
 * with nothing cached, measured on production builds in Chromium on 15 November 2026, five seconds after the page
 * settled so the menu's and footer's link prefetches are in it. The dearest page and run are used for every tool
 * page: the hub (/platform/free-tools) took up to 31 requests and 621,508 bytes; the sale tool 18 to 24 requests
 * and up to 467,703 bytes; the QR code tool 26 requests and 593,303 bytes. Priced at Vercel's on-demand rates for
 * Fast Data Transfer and CDN requests as its pricing page printed them that day. A plan's included allowance is not
 * counted as free. Not a plan's cost: a company cost (tests/plan-cost-registry.ts, NOT_A_COST.TOOL_PAGE_COST).
 */
export const TOOL_PAGE_COST = {
  bytes: 621_508,
  requests: 31,
  perGbUsd: 0.15,
  perMillionRequestsUsd: 2,
  source: "https://vercel.com/docs/pricing/networking",
  checkedOn: "2026-11-15",
  perVisitUsd(): number {
    return (this.bytes / 1e9) * this.perGbUsd + (this.requests / 1e6) * this.perMillionRequestsUsd;
  },
};
