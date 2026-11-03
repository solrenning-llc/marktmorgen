import type { NextRequest } from "next/server";
import { StoreFullError, setProductKeys, storeForEmail } from "@/lib/store";
import { jsonAccess } from "@/lib/studio-route";
import { guardStoreWrite, text } from "@/lib/store-request";
import { originFrom } from "@/lib/request-origin";
import {
  MAX_KEY_FILE_BYTES,
  MAX_KEY_LENGTH,
  activeKeys,
  addKeys,
  checkKey,
  clearPool,
  devicesOfKeys,
  freeDevices,
  issuedKeys,
  keyCounts,
  readKeyList,
  readKeySetup,
  sampleKey,
  setRevoked,
} from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";

/**
 * A product's license keys, for the creator who sells it.
 *
 * GET `?id=<product>&q=<search>`: how many keys are left, given, revoked and
 * waiting, and the most recent keys given — or the ones matching the search.
 *
 * POST, one action at a time:
 *   `{ action: "setup", id, source, prefix, groups, groupLength, lowAt }`
 *   `{ action: "off", id }` — stops handing out keys; given keys stay valid
 *   `{ action: "upload", id, text }` — keys, one per line or a CSV
 *   `{ action: "clear", id }` — empties the pool of keys not yet given
 *   `{ action: "revoke", id, key, revoked }`
 *
 * The product is always found in the signed-in creator's own store, so
 * nothing here can reach another store's keys.
 */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "products");
  if (access instanceof Response) return access;
  const id = request.nextUrl.searchParams.get("id") ?? "";
  const query = (request.nextUrl.searchParams.get("q") ?? "").slice(0, MAX_KEY_LENGTH);
  try {
    const store = access.store;
    const product = await readListing(store, id);
    if (!store || !product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    const setup = activeKeys(product);
    if (!setup) return Response.json({ ok: true, on: false }, { headers: { "Cache-Control": "private, no-store" } });
    const [counts, list] = await Promise.all([keyCounts(store, product), issuedKeys(store, product, query, 50)]);
    // Each listed key's devices, when the product limits them (610 [WP9]).
    const devices = setup.devices > 0 ? await devicesOfKeys(store, product, list.keys.map((k) => k.key)) : null;
    const keys = devices ? list.keys.map((k, i) => ({ ...k, devices: devices[i] })) : list.keys;
    return Response.json(
      { ok: true, on: true, setup, sample: sampleKey(setup), counts, keys, matching: list.total },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("reading license keys failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", MAX_KEY_FILE_BYTES + 4_000);
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const action = text(body.action, 10);
  const id = text(body.id, 40);
  if (!id) return Response.json({ ok: false, error: "unknown" }, { status: 400 });

  try {
    const store = await storeForEmail(ref);
    const product = store ? await readListing(store, id) : null;
    if (!store || !product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });

    if (action === "setup") {
      const setup = readKeySetup(body);
      if (typeof setup === "string") return Response.json({ ok: false, error: setup }, { status: 400 });
      const result = await setProductKeys(ref, id, setup);
      if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
      return Response.json({ ok: true });
    }

    if (action === "off") {
      const result = await setProductKeys(ref, id, null);
      if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
      return Response.json({ ok: true });
    }

    if (!activeKeys(product) || !store.statsId) return Response.json({ ok: false, error: "off" }, { status: 400 });

    if (action === "upload") {
      const raw = typeof body.text === "string" ? body.text : "";
      if (raw.length > MAX_KEY_FILE_BYTES) return Response.json({ ok: false, error: "too_big" }, { status: 413 });
      const list = readKeyList(raw);
      if (list.tooMany) return Response.json({ ok: false, error: "too_many" }, { status: 400 });
      if (list.keys.length === 0) return Response.json({ ok: false, error: "no_keys", refused: list.refused }, { status: 400 });
      const result = await addKeys(store, product, list.keys, originFrom(request));
      return Response.json({ ok: true, ...result, refused: list.refused, repeated: list.repeated });
    }

    if (action === "clear") {
      const removed = await clearPool(store, product);
      return Response.json({ ok: true, removed });
    }

    if (action === "revoke") {
      const key = text(body.key, MAX_KEY_LENGTH);
      const done = await setRevoked(store, product, key, body.revoked === true);
      if (!done) return Response.json({ ok: false, error: "unknown_key" }, { status: 404 });
      return Response.json({ ok: true });
    }

    if (action === "free") {
      // Every device the key was activated on, freed: the buyer moved to a new computer (610 [WP9]).
      const key = text(body.key, MAX_KEY_LENGTH);
      if (!key || (await checkKey(store, product, key)) === "unknown") return Response.json({ ok: false, error: "unknown_key" }, { status: 404 });
      const freed = await freeDevices(store, product, key);
      return Response.json({ ok: true, freed });
    }

    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    // The set-up is kept on the product, in the store record, which refuses
    // to grow past its ceiling; the keys themselves live in records of their own.
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("changing license keys failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
