import type { NextRequest } from "next/server";
import { isBot } from "@/lib/source-rules";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { countDepth } from "@/lib/page-depth";
import { READ_PER_CONNECTION, READ_WINDOW_SECONDS, STORE_SCOPE, reachField, readTokenStats } from "@/lib/page-read";
import { countReach } from "@/lib/stats";

const MAX_BODY_BYTES = 600;

const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

/**
 * How a page was read, sent by one visitor in eight as they leave it
 * (lib/page-read.ts): the furthest block of a sales page, or the furthest
 * item of the store's page and the one clicked.
 *
 * Built to cost two commands: the page's own signed token says which store's
 * numbers it writes to, so the store is not read; one connection's beacons
 * for one store are counted only within READ_PER_CONNECTION in ten minutes
 * (MM-SA-43, as app/api/store/hit), so a script cannot skew the creator's
 * numbers. The answer is always empty.
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
  // Asked only for a beacon whose signed token names a store: one connection's beacons to that store, in a window.
  const within = (statsId: string) => withinLimit("read", `${clientAddress(request)}|${statsId}`, READ_PER_CONNECTION, READ_WINDOW_SECONDS).catch(() => false);

  if (body.k === "d") {
    // A sales page: the product it belongs to, and the furthest block seen.
    const product = text("p", 40);
    const statsId = readTokenStats(token, product);
    if (statsId && (await within(statsId))) await countDepth(statsId, product, text("b", 12), text("w", 10), text("v", 20));
  } else if (body.k === "s") {
    // The store's own page: where the furthest item seen stood, which it was, and the one clicked.
    const statsId = readTokenStats(token, STORE_SCOPE);
    const field = statsId ? reachField(body.n, text("b", 42), text("c", 42)) : null;
    if (statsId && field && (await within(statsId))) await countReach(statsId, field);
  }
  return done();
}
