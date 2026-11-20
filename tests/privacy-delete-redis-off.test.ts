/**
 * Codex X5's CHANGES on #2970 @8d785c5: with Redis not configured, storeForHandleExact answered null, "no such
 * store", so the deletion page for one store's address fell silently to the every-store form, without the notice
 * that this store could not be read. Unavailable is not absent (rule 24): it now throws UnknownReplyError, and the
 * page says the store could not be loaded and links back to it. Real lib/redis.ts with no Redis variables set.
 */
import { renderToStaticMarkup } from "react-dom/server";
import DeletePage from "@/app/privacy/delete/page";
import { storeForHandleExact } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { done, is, part } from "./check";

for (const name of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[name];

async function main(): Promise<void> {
  part("Redis not there: the store is not known, never absent");
  const read = await storeForHandleExact("harbor").then(() => "answered", (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : "other"));
  is("the exact read throws as unknown", read, "unknown");

  part("The deletion page for one store says it could not load it");
  const html = renderToStaticMarkup(await DeletePage({ searchParams: Promise.resolve({ store: "harbor" }) }));
  is("the notice that this store could not be loaded", html.includes("We could not load that store just now"), true);
  is("with a way back to it", html.includes('href="/privacy/delete?store=harbor"'), true);
  is("never only the every-store hint, as if there were no such store", html.includes("To delete your data from one store only, use the link"), false);
  done();
}

void main();
