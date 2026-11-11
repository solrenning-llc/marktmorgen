import type { NextRequest } from "next/server";
import { followSentLink } from "@/lib/sent-links";

/**
 * A changeable link of a sent email (124 [F2-EDIT-SENT-LINKS], unit 2;
 * lib/sent-links.ts). The same address for every reader: nothing here notes
 * who followed it. Nothing writes such a link into an email yet.
 */
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };

const words = (status: number, text: string) =>
  new Response(text, { status, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8", ...(status === 503 ? { "Retry-After": "60" } : {}) } });

export async function GET(request: NextRequest, { params }: { params: Promise<{ sid: string; id: string; n: string }> }) {
  const { sid, id, n } = await params;
  const query = new URL(request.url).searchParams;
  const answer = await followSentLink({ sid, id, n, query: { u: query.get("u") ?? undefined, s: query.get("s") ?? undefined }, now: Date.now() });
  if (answer.kind === "go") return new Response(null, { status: 302, headers: { ...HEADERS, Location: answer.to } });
  if (answer.kind === "resting") return new Response(null, { status: 303, headers: { ...HEADERS, Location: `${new URL(request.url).origin}/@${encodeURIComponent(answer.handle)}/resting` } });
  if (answer.kind === "invalid") return words(404, "This link is not one we know. Check that it was copied whole.");
  return words(503, "This link could not be checked just now. Please try again in a minute.");
}

export const HEAD = GET;
