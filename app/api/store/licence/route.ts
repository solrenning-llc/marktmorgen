import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { DEVICE_ID, MAX_DEVICE_ID, MAX_KEY_LENGTH, activateDevice, checkKey } from "@/lib/licence-keys";
import { DataRoomError } from "@/lib/store-data";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { clientIp } from "@/lib/visit";
import { readListing } from "@/lib/catalog";

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
 *
 * A product whose keys are limited to a number of devices (610 [WP9]) is
 * asked with `&device=<an id the app keeps for this machine>` as well: a
 * good key on a device it already has, or on a new one while a place is
 * free, answers `valid`, with `devices: { used, limit }`; with every place
 * taken by other devices it answers `{ "status": "device_limit" }`, and
 * without a device `{ "status": "device_required" }`. A revoked or unknown
 * key never takes a place. The device id itself is never kept: only a
 * one-way fingerprint of it for this product (lib/licence-keys.ts).
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
  const device = (q.get("device") ?? "").trim().slice(0, MAX_DEVICE_ID + 1);
  if (device && !DEVICE_ID.test(device)) return answer(400, { error: `Send device as up to ${MAX_DEVICE_ID} letters, digits or symbols, without spaces.` });
  if (!handle || !productId || !key) {
    return answer(400, { error: "Send store, product and key." });
  }
  if (!isRedisConfigured()) return answer(503, { error: "Not available right now." });

  const bucket = `nl:rl:licence:${createHash("sha256").update(`${clientIp(request)}|${handle}`).digest("hex").slice(0, 32)}`;
  const [, count] = await redisPipeline([
    ["SET", bucket, "0", "EX", WINDOW_SECONDS, "NX"],
    ["INCR", bucket],
  ]);
  if (Number(count) > LIMIT) return answer(429, { error: "Too many checks. Wait a minute." });

  try {
    const store = await storeForHandle(handle);
    const product = (store ? await readListing(store, productId) : null);
    // Checked whether or not the product still hands out keys: a product that
    // stopped still answers for the keys it gave, which stay valid.
    if (!store || !product) return answer(404, { error: "No such product with license keys." });
    // One of the store's public requests for its window (lib/traffic.ts).
    if (!(await takePublicRequest(store, "buyer"))) return answer(429, { error: "Too many checks for this store right now. Try again later." });
    const status = await checkKey(store, product, key);
    // The limit the product has now, also for keys it gave before it stopped handing them out.
    const limit = product.keys?.devices ?? 0;
    if (status !== "valid" || limit === 0) return answer(200, { valid: status === "valid", status });
    if (!device) return answer(200, { valid: false, status: "device_required" });
    const activation = await activateDevice(store, product, key, device, limit);
    const devices = { used: activation.used, limit };
    return activation.state === "active" ? answer(200, { valid: true, status: "valid", devices }) : answer(200, { valid: false, status: "device_limit", devices });
  } catch (error) {
    if (error instanceof DataRoomError) return answer(503, { error: "This store cannot take a new device right now. Ask the seller." });
    console.error("checking a license key failed", error);
    return answer(502, { error: "Could not check right now." });
  }
}
