import { normaliseHandle, storeForPage } from "@/lib/store";
import { postForMembers, postSegment, publishedPosts } from "@/lib/store-blog";
import { letterWords } from "@/lib/buyer-words/letters";
import { speech } from "@/lib/buyer-words";
import { SITE_URL } from "@/lib/site-url";

/** Escapes text for the feed: nothing a creator typed is read as markup. */
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * A store's blog as an RSS feed (lib/store-blog.ts): the newest posts, each
 * with its title, address, date and first lines, for a reader app or a
 * newsletter tool to follow. A post kept for members gives its title, address
 * and date and says it is for members: never its words or first lines.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ handle: string }> }) {
  const decoded = decodeURIComponent((await params).handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  if (!store || store.posts === 0 || store.suspended) return new Response("Not found", { status: 404 });
  const { posts } = await publishedPosts(store.statsId, 1);
  const base = `${SITE_URL}/@${store.handle}`;
  const title = speech(store).w.blogOf(store.name);
  const membersLabel = letterWords(store.language).membersLabel;
  const items = posts
    .map((post) => {
      const url = `${base}/blog/${postSegment(post)}`;
      return `<item><title>${xml(post.title)}</title><link>${xml(url)}</link><guid isPermaLink="true">${xml(url)}</guid><pubDate>${new Date(post.publishedAt * 1000).toUTCString()}</pubDate><description>${xml(postForMembers(post) ? membersLabel : post.excerpt)}</description></item>`;
    })
    .join("");
  const body = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xml(title)}</title><link>${xml(`${base}/blog`)}</link><description>${xml(store.bio || title)}</description><language>${xml(store.language)}</language>${items}</channel></rss>`;
  return new Response(body, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=600" } });
}
