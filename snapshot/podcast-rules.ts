/**
 * A private podcast: a product whose buyers listen in their own podcast app,
 * as rules the browser can read too. Kept in lib/podcast.ts; who may listen
 * is lib/podcast-access.ts.
 *
 * Measured before it was built (30 September 2026): Kajabi's private podcasts
 * play in Kajabi's own app (help.kajabi.com, "Kajabi Podcasts FAQs"); Stan,
 * Skool, Circle, Mighty Networks and Whop document none.
 *
 * Here each buyer gets a feed of their own, a private address that Apple
 * Podcasts, Overcast, Pocket Casts and most other apps take, and new episodes
 * arrive in the app like any show's. The feed asks, every time an app reads
 * it and every time an episode is fetched, whether that buyer still holds the
 * product: a refund, or a membership that ends, empties it within minutes.
 * Search engines and podcast directories are told to keep out of it.
 */

export const PODCAST_ID = /^[0-9a-f]{32}$/;
export const EPISODE_ID = /^[a-z0-9]{12}$/;
export const FEED_TOKEN = /^[0-9a-f]{48}$/;
export const MAX_EPISODES = 300;
export const MAX_EPISODE_TITLE = 150;
export const MAX_EPISODE_NOTES = 4_000;
/** What an episode may be: the audio every podcast app plays. */
export const EPISODE_TYPES = ["audio/mpeg", "audio/mp4"] as const;
export const EPISODE_ACCEPT = ".mp3,.m4a";

export type Episode = {
  id: string;
  title: string;
  notes: string;
  pathname: string;
  bytes: number;
  contentType: string;
  /** When it went out, in seconds: its date in the listener's app. */
  at: number;
};

export type Podcast = { id: string; episodes: Episode[] };

export type PodcastRef = { id: string; episodes: number };

export function parsePodcastRef(raw: unknown): PodcastRef | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || !PODCAST_ID.test(v.id)) return null;
  const episodes = Number(v.episodes);
  return { id: v.id, episodes: Number.isInteger(episodes) && episodes >= 0 ? episodes : 0 };
}

export function parsePodcast(raw: unknown): Podcast | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as { id?: unknown; episodes?: unknown };
    if (typeof v.id !== "string" || !PODCAST_ID.test(v.id)) return null;
    const episodes = (Array.isArray(v.episodes) ? v.episodes : [])
      .map((e): Episode | null => {
        if (!e || typeof e !== "object") return null;
        const x = e as Record<string, unknown>;
        if (typeof x.id !== "string" || !EPISODE_ID.test(x.id) || typeof x.pathname !== "string") return null;
        return {
          id: x.id,
          title: typeof x.title === "string" ? x.title : "Untitled episode",
          notes: typeof x.notes === "string" ? x.notes : "",
          pathname: x.pathname,
          bytes: Number(x.bytes) || 0,
          contentType: typeof x.contentType === "string" ? x.contentType : "audio/mpeg",
          at: Number(x.at) || 0,
        };
      })
      .filter((e): e is Episode => e !== null)
      .slice(0, MAX_EPISODES);
    return { id: v.id, episodes };
  } catch {
    return null;
  }
}

function xml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The feed one buyer's app reads: newest episode first, each fetched through `audio`. */
export function feedXml(input: {
  title: string;
  summary: string;
  author: string;
  page: string;
  image: string | null;
  episodes: Episode[];
  audio: (episode: Episode) => string;
  /** The store's language, as RSS writes one ("es-es"); "en-us" unless given. */
  language?: string;
}): string {
  const items = [...input.episodes]
    .sort((a, b) => b.at - a.at)
    .map(
      (e) => `    <item>
      <title>${xml(e.title)}</title>
      <description>${xml(e.notes)}</description>
      <guid isPermaLink="false">${e.id}</guid>
      <pubDate>${new Date(e.at * 1000).toUTCString()}</pubDate>
      <enclosure url="${xml(input.audio(e))}" length="${e.bytes}" type="${xml(e.contentType)}"/>
    </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${xml(input.title)}</title>
    <link>${xml(input.page)}</link>
    <description>${xml(input.summary || input.title)}</description>
    <language>${xml(input.language || "en-us")}</language>
    <itunes:author>${xml(input.author)}</itunes:author>
    <itunes:block>Yes</itunes:block>
    <itunes:explicit>false</itunes:explicit>
${input.image ? `    <itunes:image href="${xml(input.image)}"/>\n` : ""}${items}
  </channel>
</rss>
`;
}

/** The buttons that add a feed to an app, each by that app's own address for it. */
export function appLinks(feed: string): { name: string; href: string }[] {
  const bare = feed.replace(/^https?:\/\//, "");
  return [
    { name: "Apple Podcasts", href: `podcast://${bare}` },
    { name: "Overcast", href: `overcast://x-callback-url/add?url=${encodeURIComponent(feed)}` },
    { name: "Pocket Casts", href: `pktc://subscribe/${bare}` },
  ];
}
