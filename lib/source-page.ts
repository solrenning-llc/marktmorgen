/**
 * The creator's own public page, read once for the AI's first draft of their
 * store (219 [OP5] unit 2: "Paste your link or tell us what you sell").
 *
 * A link-in-bio page (Linktree, Stan, Beacons and the like) or the creator's
 * own site says what they already sell and at what price, in their words. The
 * draft is better made from that than from a sentence typed in a hurry, and a
 * price the page states counts as one the creator named (statedPrice in
 * lib/ai.ts), so nothing is invented.
 *
 * How it is kept honest and bounded:
 *   - Off: SOURCE_PAGE_READING_ON is false until the owner switches it on with
 *     its cost in the plan's worst month (MR, 27 October 2026). Nothing shows
 *     the link field while it is off.
 *   - Read only inside the store-setup AI job, which is one of the month's AI
 *     jobs, counted before the model is called: one page per job, so no new
 *     counter and no new stored key.
 *   - Through lib/safe-fetch.ts: https, public hosts only, at most 3
 *     redirects, SOURCE_PAGE_BYTES and SOURCE_PAGE_MS at most.
 *   - Kept nowhere. What the page says is used for that one draft and dropped;
 *     only what the creator keeps from the draft is saved.
 *   - Data, never instructions: the text goes to the model quoted, with < and
 *     > neutralized, and with email addresses, phone numbers and links taken
 *     out, so neither contact details nor a planted instruction ride along.
 */
import { SafeFetchError, checkUrl, safeFetch } from "@/lib/safe-fetch";
import { pageText } from "@/lib/outreach-rules";
import { SITE_URL } from "@/lib/site-url";

/** The switch. Off until the owner turns it on, after its cost is in the plans (219 [OP5] item 12). */
export const SOURCE_PAGE_READING_ON: boolean = false;

/** Tests turn reading on here; production never calls this. */
let onForTests: boolean | null = null;
export function setSourceReadingForTests(on: boolean | null): void {
  onForTests = on;
}
export function sourceReadingOn(): boolean {
  return onForTests ?? SOURCE_PAGE_READING_ON;
}

export const SOURCE_PAGE_BYTES = 1_000_000;
export const SOURCE_PAGE_MS = 8_000;
/** What the model is given of the page, in characters. */
export const SOURCE_TEXT_CHARS = 3_000;

const READER = `MarktmorgenStoreSetup/1.0 (+${SITE_URL}/help)`;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// "ana [at] example [dot] com" and the like.
const HIDDEN_EMAIL = /\S+\s*[[(]\s*at\s*[\])]\s*\S+(?:\s*[[(]\s*dot\s*[\])]\s*\S+)*/gi;
const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;
// A bare address: "linktr.ee/ana", "instagram.com/ana", "ana.example.com".
const DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/gi;
// A phone number as people write one: international with +, or (555) 010-2030 / 555-010-2030, or nine or more digits in a row.
// Prices ("$12000.00", "€1 200 000"), years ("2019-2026") and dates ("10.12.2026") are left alone.
const PHONE = /\+\d[\d\s().-]{7,}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|(?<![\d$€£¥.,])\b\d{9,}\b(?![.,]\d)/g;

/** A page's HTML as the words a visitor reads, without contact details or links, quoted for a model. */
export function sourceText(html: string): { title: string; text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const clean = (text: string) =>
    text
      .replace(EMAIL, " ")
      .replace(HIDDEN_EMAIL, " ")
      .replace(LINK, " ")
      .replace(DOMAIN, " ")
      .replace(PHONE, " ")
      .replace(/</g, "‹")
      .replace(/>/g, "›")
      // The page's words go into the prompt between triple quotes: no quote mark of the page's may close them.
      .replace(/"/g, "”")
      .replace(/\s+/g, " ")
      .trim();
  const title = clean(pageText(titleMatch?.[1] ?? "")).slice(0, 120);
  // pageText keeps what a mailto: link points at; EMAIL above takes it out again.
  const text = clean(pageText(html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, " "))).slice(0, SOURCE_TEXT_CHARS);
  return { title, text };
}

export type SourceRead = { ok: true; title: string; text: string; url: string } | { ok: false; reason: "off" | "address" | "unreadable" };

/** Test seam for the fetch; production passes nothing. */
export type SourceHooks = Pick<Parameters<typeof safeFetch>[1], "resolve" | "agent">;

/** Reads the page at the creator's link, or says why not. Never throws. */
export async function readSourcePage(raw: string, hooks: SourceHooks = {}): Promise<SourceRead> {
  if (!sourceReadingOn()) return { ok: false, reason: "off" };
  try {
    if (!/^https:\/\//i.test(raw.trim())) return { ok: false, reason: "address" };
    checkUrl(raw.trim());
  } catch {
    return { ok: false, reason: "address" };
  }
  try {
    const answer = await safeFetch(raw.trim(), {
      maxBytes: SOURCE_PAGE_BYTES,
      timeoutMs: SOURCE_PAGE_MS,
      maxRedirects: 3,
      headers: { "User-Agent": READER, Accept: "text/html,text/plain;q=0.8" },
      ...hooks,
    });
    if (answer.status !== 200) return { ok: false, reason: "unreadable" };
    const type = (answer.headers["content-type"] ?? "").toLowerCase();
    if (!/^(?:text\/html|text\/plain|application\/xhtml\+xml)\b/.test(type)) return { ok: false, reason: "unreadable" };
    const charset = /charset=["']?([\w-]+)/.exec(type)?.[1] ?? "utf-8";
    let html: string;
    try {
      html = new TextDecoder(charset).decode(answer.body);
    } catch {
      html = answer.body.toString("utf8");
    }
    const { title, text } = sourceText(html);
    if (!text) return { ok: false, reason: "unreadable" };
    return { ok: true, title, text, url: answer.url };
  } catch (error) {
    if (!(error instanceof SafeFetchError)) console.error("reading a creator's page failed", error);
    return { ok: false, reason: error instanceof SafeFetchError && error.problem === "scheme" ? "address" : "unreadable" };
  }
}
