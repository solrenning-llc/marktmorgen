/**
 * The AI crawlers a store can ask to stay out of its own domain (601 [KB22]
 * U8, docs/reviews/c5-kb22-audit.md). When the creator closes the store to
 * them, storeRobots (lib/store-sitemap.ts) adds one "Disallow: /" group per
 * name below to the robots.txt its own domain serves. Nothing else changes:
 * the group for every other crawler, search engines included, stays as it
 * was.
 *
 * A robots.txt rule is a request. A crawler that follows it stays out; one
 * that does not is not stopped by it. Each name is a token its maker
 * documents for robots.txt. Only pages that could be read on the list's date
 * are marked read; the rest were named from their makers' pages earlier and
 * could not be reached from here on that date (the network blocked them), so
 * they are kept, because asking an extra name to stay out can only keep more
 * out, and say so. None is an ordinary search engine's crawler: Google-Extended
 * and Applebot-Extended are separate tokens that do not change Google Search
 * or Apple's search.
 *
 * The choice is kept in the store's own record (Store.aiCrawlers), which the
 * robots route already reads, so it adds no command to any request.
 */

/** The date the list below was last checked. */
export const AI_CRAWLERS_LISTED = "2026-11-06";

export type AiCrawler = {
  /** The token robots.txt names it by. */
  agent: string;
  maker: string;
  /** The maker's page that documents the token. */
  source: string;
  /** AI_CRAWLERS_LISTED when that page was read on that date, else null. */
  read: string | null;
  /** Why the page was not read on that date; empty when it was. */
  unread: string;
};

const BLOCKED = "The page could not be reached from here on 2026-11-06 (network blocked); named from the maker's page before.";

export const AI_CRAWLERS: readonly AiCrawler[] = [
  { agent: "ClaudeBot", maker: "Anthropic", source: "https://support.claude.com/en/articles/8896518", read: AI_CRAWLERS_LISTED, unread: "" },
  { agent: "Claude-User", maker: "Anthropic", source: "https://support.claude.com/en/articles/8896518", read: AI_CRAWLERS_LISTED, unread: "" },
  { agent: "Claude-SearchBot", maker: "Anthropic", source: "https://support.claude.com/en/articles/8896518", read: AI_CRAWLERS_LISTED, unread: "" },
  { agent: "GPTBot", maker: "OpenAI", source: "https://platform.openai.com/docs/bots", read: null, unread: BLOCKED },
  { agent: "OAI-SearchBot", maker: "OpenAI", source: "https://platform.openai.com/docs/bots", read: null, unread: BLOCKED },
  { agent: "ChatGPT-User", maker: "OpenAI", source: "https://platform.openai.com/docs/bots", read: null, unread: BLOCKED },
  { agent: "Google-Extended", maker: "Google", source: "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers", read: null, unread: BLOCKED },
  { agent: "Applebot-Extended", maker: "Apple", source: "https://support.apple.com/en-us/119829", read: null, unread: BLOCKED },
  { agent: "PerplexityBot", maker: "Perplexity", source: "https://docs.perplexity.ai/guides/bots", read: null, unread: BLOCKED },
  { agent: "Perplexity-User", maker: "Perplexity", source: "https://docs.perplexity.ai/guides/bots", read: null, unread: BLOCKED },
  { agent: "CCBot", maker: "Common Crawl", source: "https://commoncrawl.org/ccbot", read: null, unread: BLOCKED },
  { agent: "meta-externalagent", maker: "Meta", source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers", read: null, unread: BLOCKED },
];

/** "open": robots.txt as it always was. "closed": the AI crawlers above are asked to stay out. */
export type AiCrawlers = "open" | "closed";

/**
 * The stored choice, read exactly. A record from before the switch has none
 * and is open, as its robots.txt always was; anything that is not exactly
 * "open" reads as closed, so a damaged value never lets in what the creator
 * shut out.
 */
export function parseAiCrawlers(raw: unknown): AiCrawlers {
  return raw === undefined || raw === "open" ? "open" : "closed";
}

/** The robots.txt groups that ask each AI crawler above to stay out, one group a name. */
export function aiCrawlerGroups(): string[] {
  return AI_CRAWLERS.flatMap((crawler) => [`User-agent: ${crawler.agent}`, "Disallow: /", ""]);
}
