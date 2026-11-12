/**
 * IndexNow: telling search engines at once that a page of this site exists.
 *
 * Bing, Yandex, Seznam, Naver and Yep read one shared protocol
 * (indexnow.org): a site posts the addresses it wants read to
 * api.indexnow.org, and proves it owns them with a key it serves at its own
 * root. Google does not take part; it reads the sitemap (app/sitemap.ts).
 *
 * What is announced is the sitemap and nothing else, so a page asked to be
 * kept out of search (noindex) or a creator's store is never sent: the
 * sitemap already leaves those out. Each address is announced once, the
 * first day the daily job sees it; the engines then come back to it on their
 * own, through the same sitemap. Announcing every page every day, or on every
 * deploy, is what the protocol asks sites not to do.
 *
 * The key is public by design (the engines fetch it from the site), so it
 * lives here and in public/<key>.txt, which tests/indexnow.test.ts holds equal.
 *
 *   nl:indexnow:sent    the addresses already announced, a set
 */
import sitemap from "@/app/sitemap";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { SITE_URL } from "@/lib/site-url";

export const INDEXNOW_KEY = "7cf3353593a7c20e70bd0efdaf6db5b7";
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
/** Most addresses the protocol takes in one request. */
export const INDEXNOW_BATCH = 10_000;
const SENT_KEY = "nl:indexnow:sent";
const TIMEOUT_MS = 10_000;

export type IndexNowResult =
  | { ok: true; announced: number }
  | { ok: false; reason: "unavailable" | "refused"; status?: number };

/** The body the protocol reads: the host, the key, where the key is served, and the addresses. */
export function indexNowBody(urls: string[]): { host: string; key: string; keyLocation: string; urlList: string[] } {
  const host = new URL(SITE_URL).host;
  return { host, key: INDEXNOW_KEY, keyLocation: `${SITE_URL}/${INDEXNOW_KEY}.txt`, urlList: urls };
}

/** Every address of the sitemap that is on this site's own host, once each. */
export function sitemapUrls(): string[] {
  const host = new URL(SITE_URL).host;
  const seen = new Set<string>();
  for (const entry of sitemap()) {
    try {
      if (new URL(entry.url).host === host) seen.add(entry.url);
    } catch {
      // Not an address; nothing to announce.
    }
  }
  return [...seen];
}

/**
 * Announces the sitemap's addresses not announced before. An address is
 * remembered only after the protocol accepted it (200 or 202), so a refused
 * or unanswered request is tried again the next day; so is a run whose
 * "already announced?" replies cannot be read, which sends nothing.
 */
export async function announceNewPages(send: typeof fetch = fetch): Promise<IndexNowResult> {
  if (!isRedisConfigured()) return { ok: false, reason: "unavailable" };
  const urls = sitemapUrls();
  if (!urls.length) return { ok: true, announced: 0 };
  // Read exactly (CX-123 rule 24): one reply an address, each 0 (not announced) or 1 (announced). Anything else is
  // not "never announced": the run sends nothing and is tried again the next day.
  const known = repliesFor(await redisPipeline(urls.map((url) => ["SISMEMBER", SENT_KEY, url])), urls.length);
  if (!known || known.some((member) => member !== 0 && member !== 1)) return { ok: false, reason: "unavailable" };
  const fresh = urls.filter((_, i) => known[i] === 0);
  let announced = 0;
  for (let start = 0; start < fresh.length; start += INDEXNOW_BATCH) {
    const batch = fresh.slice(start, start + INDEXNOW_BATCH);
    let status = 0;
    try {
      const answer = await send(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(indexNowBody(batch)),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = answer.status;
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (status !== 200 && status !== 202) return { ok: false, reason: "refused", status };
    await redisPipeline([["SADD", SENT_KEY, ...batch]]);
    announced += batch.length;
  }
  return { ok: true, announced };
}
