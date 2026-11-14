import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { announceNewPages } from "@/lib/indexnow";
import { sendHeldNoticeDigest } from "@/lib/takedown-mail";
import { SITE_URL } from "@/lib/site-url";

export const maxDuration = 60;

/**
 * Run every day by Vercel: tells Bing and the other IndexNow engines about
 * pages of the sitemap they have not been told about (lib/indexnow.ts). Only
 * the production deployment announces, because only it serves the key at
 * marktmorgen.com. Nobody else can start it: only Vercel's scheduled call
 * carries the secret.
 */
export async function GET(request: NextRequest) {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (process.env.VERCEL_ENV !== "production") {
    return Response.json({ ok: true, skipped: "not production" }, { headers: { "Cache-Control": "no-store" } });
  }
  // The day's digest of notices past the report form's email ceiling (lib/takedown-mail.ts): once a day, apart from the
  // engines' answer.
  const digest = await sendHeldNoticeDigest(SITE_URL).catch((error: unknown) => (console.error("the held notices' digest failed", error), null));
  if (digest && digest.sent > 0) console.log(`report digest: ${JSON.stringify(digest)}`);
  const result = await announceNewPages();
  console.log(`indexnow: ${JSON.stringify(result)}`);
  return Response.json(result, { status: result.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
