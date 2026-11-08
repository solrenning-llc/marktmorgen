/**
 * Where a visit came from, in a word — and whether it was a person at all.
 *
 * Pure, and kept apart from lib/stats.ts so the proxy can use the very same
 * rules on the first request of a visit (lib/visit-channel.ts): a channel
 * remembered for a sale is named exactly as the visit was counted.
 */

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python|node-fetch|axios|go-http|java\/|okhttp|scrapy|httpclient/i;

export function isBot(userAgent: string): boolean {
  return !userAgent || BOT.test(userAgent);
}

/** Referring sites grouped under the name a creator knows them by. */
const KNOWN: [RegExp, string][] = [
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "facebook"],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, "x"],
  [/(^|\.)threads\.(net|com)$/, "threads"],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, "linkedin"],
  [/(^|\.)(pinterest\.[a-z.]+|pin\.it)$/, "pinterest"],
  [/(^|\.)snapchat\.com$/, "snapchat"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/(^|\.)(linktr\.ee|linktree\.com)$/, "linktree"],
  // The AI assistants (added 11 October 2026): somebody who asked ChatGPT or
  // Perplexity for a course and was handed the store's address. Before Google,
  // whose rule would otherwise take Gemini's address as a search.
  [/(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com)$/, "chatgpt"],
  [/(^|\.)perplexity\.ai$/, "perplexity"],
  [/(^|\.)claude\.ai$/, "claude"],
  [/(^|\.)(gemini\.google\.com|bard\.google\.com)$/, "gemini"],
  [/(^|\.)(copilot\.microsoft\.com|copilot\.cloud\.microsoft)$/, "copilot"],
  [/(^|\.)chat\.deepseek\.com$/, "deepseek"],
  [/(^|\.)grok\.com$/, "grok"],
  // Webmail before Google, whose rule would otherwise take Gmail for a search.
  [/(^|\.)(mail\.google\.com|outlook\.live\.com|mail\.yahoo\.com)$/, "email"],
  [/(^|\.)google\.[a-z.]+$/, "google"],
  [/(^|\.)bing\.com$/, "bing"],
  [/(^|\.)duckduckgo\.com$/, "duckduckgo"],
];

/** The names of the in-app browsers that send no referrer at all. */
const IN_APP: [RegExp, string][] = [
  [/Instagram/i, "instagram"],
  [/FBAN|FBAV|FB_IAB/i, "facebook"],
  [/musical_ly|BytedanceWebview|TikTok/i, "tiktok"],
  [/Pinterest/i, "pinterest"],
  [/Snapchat/i, "snapchat"],
  [/LinkedInApp/i, "linkedin"],
  [/Twitter/i, "x"],
];

/**
 * Tags the assistants put on the links they hand out themselves — ChatGPT adds
 * utm_source=chatgpt.com — counted under the same word as a visit they sent
 * without one, so one assistant is one row. Meta's ads fill
 * utm_source={{site_source_name}} with fb, ig, msg or an: counted under
 * the words Meta's own spend is read under (lib/meta-ads-rules.ts).
 */
const TAG_ALIASES: Record<string, string> = {
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  openai: "chatgpt",
  "perplexity.ai": "perplexity",
  "claude.ai": "claude",
  "gemini.google.com": "gemini",
  "copilot.microsoft.com": "copilot",
  "grok.com": "grok",
  fb: "facebook",
  ig: "instagram",
  msg: "facebook",
  an: "facebook",
};

/** The AI assistants a visit can come from, by the word it is counted under. */
export const AI_SOURCES = new Set(["chatgpt", "perplexity", "claude", "gemini", "copilot", "deepseek", "grok"]);

/**
 * A utm_source as it is counted: the assistants' own tags under their usual word. Only the map's own entries: a tag
 * is typed by whoever wrote the link, so "__proto__" or "constructor" stays its own word, never Object.prototype or
 * Object (which made proxy.ts's touchFrom throw on a store page opened with it; tests/proto-keys.test.ts).
 */
export function sourceAlias(tag: string): string {
  return Object.hasOwn(TAG_ALIASES, tag) ? TAG_ALIASES[tag] : tag;
}

/**
 * Where a visit came from, in a word.
 *
 * A campaign tag the creator put on their own link wins, then the site that
 * sent the visitor, then the app whose built-in browser opened the page —
 * Instagram and TikTok send no referrer, and that is where most of a
 * creator's visitors are. What is left is "direct".
 */
/**
 * The tag a visit is counted under from its own address: utm_source, or, on
 * a link with an affiliate's ?via= code and no utm_source of its own,
 * "affiliates" (added 12 October 2026), so the program is a channel in the
 * numbers like any other, visits and money alike.
 */
export function sourceTag(params: URLSearchParams): string {
  const utm = params.get("utm_source") ?? "";
  if (utm.trim()) return utm.slice(0, 60);
  return /^[a-z0-9]{3,20}$/i.test(params.get("via") ?? "") ? "affiliates" : "";
}

export function classifySource(input: { referrer: string; utm: string; userAgent: string; ownHost: string }): string {
  const utm = input.utm.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 30);
  if (utm) return sourceAlias(utm);
  let host = "";
  try {
    host = input.referrer ? new URL(input.referrer).hostname.toLowerCase() : "";
  } catch {
    host = "";
  }
  if (host && host !== input.ownHost) {
    for (const [pattern, name] of KNOWN) if (pattern.test(host)) return name;
    return host.replace(/^www\./, "").slice(0, 60);
  }
  for (const [pattern, name] of IN_APP) if (pattern.test(input.userAgent)) return name;
  return "direct";
}


/**
 * A utm_medium or utm_campaign tag as it is counted: lower case, letters,
 * digits, dots, dashes and underscores, at most thirty characters; an empty
 * string when nothing is left.
 */
export function cleanTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 30);
}

/**
 * The kind of device a page was opened on, from the browser's own words:
 * "tablet", "mobile" or "desktop". An iPad that asks for the desktop site
 * says it is a Mac and is counted as one; nothing here pretends to know more
 * than the browser said.
 */
export function deviceOf(userAgent: string): "mobile" | "tablet" | "desktop" {
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobi)/i.test(userAgent)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone|Opera Mini/i.test(userAgent)) return "mobile";
  return "desktop";
}

/** A country as the host reads it, two capital letters, or "" when it does not say. */
export function countryOf(header: string | null | undefined): string {
  return header && /^[A-Z]{2}$/.test(header) && header !== "XX" ? header : "";
}
