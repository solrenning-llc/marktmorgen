import { normaliseHandle, storeForPage } from "@/lib/store";
import { storeRobots } from "@/lib/store-sitemap";
import { offDomainNotFound } from "@/lib/domain-gate";

/**
 * The rules a creator's own domain gives crawlers, served there as
 * /robots.txt (proxy.ts, lib/store-sitemap.ts). Under marktmorgen.com the
 * site's own rules apply, as they always did.
 */
export async function GET(request: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle: raw } = await params;
  let decoded = "";
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  if (!store) return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  // On a creator's domain only while it is this store's and the store is on Pro (lib/domain-gate.ts).
  const offDomain = offDomainNotFound(store, request.headers);
  if (offDomain) return offDomain;
  return new Response(storeRobots(store), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
