import type { NextRequest } from "next/server";
import { isBot } from "@/lib/source-rules";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { countDepth } from "@/lib/page-depth";
import { STORE_SCOPE, reachField, readTokenStats } from "@/lib/page-read";
import { countReach } from "@/lib/stats";

const MAX_BODY_BYTES = 600;

const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

/**
 * How a page was read, sent by one visitor in eight as they leave it
 * (lib/page-read.ts): the furthest block of a sales page, or the furthest
 * item of the store's page and the one clicked.
 *
 * Built to cost one command: the page's own signed token says which store's
 * numbers it writes to, so the store is not read, and nothing else is asked.
 * The answer is always empty.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return done();
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return done();
  if (isBot(request.headers.get("user-agent") ?? "")) return done();
  let body: Record<string, unknown> = {};
  try {
    const raw = await (await limited(request, MAX_BODY_BYTES)).text();
    if (raw.length > MAX_BODY_BYTES) return done();
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    return done();
  }
  const text = (name: string, max: number) => (typeof body[name] === "string" ? (body[name] as string).slice(0, max) : "");
  const token = text("t", 80);

  if (body.k === "d") {
    // A sales page: the product it belongs to, and the furthest block seen.
    const product = text("p", 40);
    const statsId = readTokenStats(token, product);
    if (statsId) await countDepth(statsId, product, text("b", 12), text("w", 10), text("v", 20), body.s);
  } else if (body.k === "s") {
    // The store's own page: where the furthest item seen stood, which it was, and the one clicked.
    const statsId = readTokenStats(token, STORE_SCOPE);
    const field = statsId ? reachField(body.n, text("b", 42), text("c", 42)) : null;
    if (statsId && field) await countReach(statsId, field);
  }
  return done();
}
