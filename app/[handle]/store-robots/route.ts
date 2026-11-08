import { normaliseHandle, storeForPage } from "@/lib/store";
import { storeRobots } from "@/lib/store-sitemap";

/**
 * The rules a creator's own domain gives crawlers, served there as
 * /robots.txt (proxy.ts, lib/store-sitemap.ts). Under marktmorgen.com the
 * site's own rules apply, as they always did.
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
  // A store switched off after a report (lib/takedown.ts) answers as its sitemap does: crawlers then
  // reach its pages, which ask not to be indexed, rather than keep addresses they may no longer read.
  if (store?.suspended) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!store) return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(storeRobots(store), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
