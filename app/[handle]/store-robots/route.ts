import { normaliseHandle, storeForPage } from "@/lib/store";
import { storeRobots } from "@/lib/store-sitemap";

/**
 * The rules a creator's own domain gives crawlers, served there as
 * /robots.txt (proxy.ts, lib/store-sitemap.ts). Under marktmorgen.com the
 * site's own rules apply, as they always did.
 *
 * Kept an hour at the edge and no longer: the studio says a change is in
 * this copy within an hour (components/ai-crawlers-switch.tsx), so there is
 * no stale-while-revalidate to serve the old rules past that. It costs no
 * more calls: a stale copy was refreshed by a call too, at most one an hour.
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
  if (!store) return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(storeRobots(store), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=0, s-maxage=3600" },
  });
}
