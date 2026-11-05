import { normaliseHandle, storeForPage } from "@/lib/store";
import { paidStoreSitemap, sitemapXml } from "@/lib/store-sitemap";

/**
 * A store's map for search engines (lib/store-sitemap.ts): at
 * /@handle/sitemap.xml, and at /sitemap.xml on the creator's own domain
 * (proxy.ts). Kept by caches for an hour: a product added shows in it soon,
 * and a crawler asking often costs a read an hour, and each read is paid for
 * in the store's public requests first (sitemapUnits).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle: raw } = await params;
  let decoded = "";
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  if (!store || store.suspended) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  // Paid for in the store's public requests before it is read (lib/store-sitemap.ts, paidStoreSitemap).
  // With no room this month, a crawler is told to come back later and nothing is read.
  const entries = await paidStoreSitemap(store);
  if (!entries) return new Response("Try again later", { status: 503, headers: { "Retry-After": "3600", "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(sitemapXml(entries), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
