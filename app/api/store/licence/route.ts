import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { MAX_KEY_LENGTH, checkKey } from "@/lib/licence-keys";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { clientIp } from "@/lib/visit";
import { readListing } from "@/lib/catalog";
import { countOf, repliesFor } from "@/lib/redis-reply";

/**
 * The public check a creator's own software can make: is this licence key
 * one this product gave, and is it still good?
 *
 *   GET /api/store/licence?store=<handle>&product=<product id>&key=<key>
 *
 * answers `{ "status": "valid" }`, `{ "status": "revoked" }` or
 * `{ "status": "unknown" }`, and `valid: true` only for the first. It says
 * nothing else — not who bought the key, not when — because anyone can ask.
 * It can be called from a browser on any site, and from an app. Each
 * connection may ask 120 times a minute per store, which a real app never
 * comes near and which makes guessing keys pointless on top of their 60 bits
 * or more.
 */
const LIMIT = 120;
const WINDOW_SECONDS = 60;

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};

function answer(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: HEADERS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: HEADERS });
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const handle = normaliseHandle(q.get("store") ?? "");
  const productId = (q.get("product") ?? "").slice(0, 40);
  const key = (q.get("key") ?? "").trim().slice(0, MAX_KEY_LENGTH + 1);
  if (!handle || !productId || !key) {
    return answer(400, { error: "Send store, product and key." });
  }
  if (!isRedisConfigured()) return answer(503, { error: "Not available right now." });

  const bucket = `nl:rl:licence:${createHash("sha256").update(`${clientIp(request)}|${handle}`).digest("hex").slice(0, 32)}`;
  // The count only in its exact shape (CX-123 rule 24): a reply that is
  // missing, cut short or of another shape, or no answer at all, reads
  // nothing of the store and says the check could not be made.
  let count: number | null = null;
  try {
    const replies = repliesFor(await redisPipeline([
      ["SET", bucket, "0", "EX", WINDOW_SECONDS, "NX"],
      ["INCR", bucket],
    ]), 2);
    if (replies && (replies[0] === "OK" || replies[0] === null)) count = countOf(replies[1]);
  } catch (error) {
    console.error("counting license checks failed", error);
  }
  if (count === null || count < 1) return answer(502, { error: "Could not check right now." });
  if (count > LIMIT) return answer(429, { error: "Too many checks. Wait a minute." });

  try {
    const store = await storeForHandle(handle);
    if (!store) return answer(404, { error: "No such product with license keys." });
    // One of the store's public requests for its window (lib/traffic.ts), taken
    // before the product or the key is read (4 November 2026): refused, nothing
    // of the store's is read.
    if (!(await takePublicRequest(store, "buyer"))) return answer(429, { error: "Too many checks for this store right now. Try again later." });
    const product = await readListing(store, productId);
    // Checked whether or not the product still hands out keys: a product that
    // stopped still answers for the keys it gave, which stay valid.
    if (!product) return answer(404, { error: "No such product with license keys." });
    const status = await checkKey(store, product, key);
    return answer(200, { valid: status === "valid", status });
  } catch (error) {
    console.error("checking a license key failed", error);
    return answer(502, { error: "Could not check right now." });
  }
}
