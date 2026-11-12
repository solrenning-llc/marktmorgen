/**
 * Authorization sweep (claude7/authz-hunt): the funnel file download
 * (GET /api/store/funnel-share?export=<funnel>) spends one of the store's
 * monthly funnel exports before it reads the funnel. The global API guard
 * (proxy.ts guardApi) lets every GET through, and the session cookie is
 * SameSite=Lax, so a page on another site that sends a signed-in creator's
 * browser to that URL a few times (a top-level navigation or popups) used up
 * the month's exports, and with them the "copy" action that spends the same
 * counter. Its sibling downloads (app/api/store/export, forms/export) refuse
 * a request from another site through creatorFrom; this one must as well,
 * before anything is counted. Synthetic store, in-memory Redis, no network.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { GET } from "@/app/api/store/funnel-share/route";
import { store as redis } from "@/tests/redis-stub";
import { done, is, part } from "@/tests/check";

const OWNER = "authz-funnel-export@example.com";
const URL = "https://marktmorgen.com/api/store/funnel-share?export=aaaaaaaaaa";

globalThis.fetch = async () => {
  throw new Error("External fetch forbidden");
};

const exportCounters = (): string[] => redis.keys().filter((key) => key.startsWith("nl:fuse:m:export:"));

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "authzfunnelexport", "Synthetic export", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const get = (site: string | null, origin: string | null = null) => {
    const headers: Record<string, string> = { host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` };
    if (site) headers["sec-fetch-site"] = site;
    if (origin) headers.origin = origin;
    return GET(new NextRequest(URL, { method: "GET", headers }));
  };

  part("a navigation from another site is refused before anything is counted");
  for (let i = 0; i < 6; i++) {
    const response = await get("cross-site");
    is(`cross-site export ${i + 1} is refused`, response.status, 403);
  }
  is("no export of the month was spent by another site", exportCounters(), []);
  const named = await get(null, "https://evil.example");
  is("a request naming another origin is refused", named.status, 403);
  is("still no export spent", exportCounters(), []);

  part("the studio's own download still works as before");
  const own = await get("same-origin");
  is("same-origin request reaches the funnel lookup (unknown funnel)", own.status, 404);
  is("and is counted as before", exportCounters().length, 1);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
