/**
 * 610 [WP9]: a license key limited to a number of devices, through the real
 * public check and the real studio route. A good key takes a place per new
 * device up to the limit, the same device asking again takes none, a new
 * device past it is refused, a check without a device is asked for one, a
 * revoked or unknown key never takes a place, and the creator frees a key's
 * devices from the studio. The device id is never kept, and the store's data
 * room grows with each place.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { DEFAULT_KEYS, MAX_DEVICES, parseKeySetup, readKeySetup } from "@/lib/key-setup";
import { devicesBytes, keyForSale, setRevoked } from "@/lib/licence-keys";
import { createHash } from "node:crypto";
import { dataKey } from "@/lib/store-data";
import { GET as check } from "@/app/api/store/licence/route";
import { GET as studioGet, POST as studioPost } from "@/app/api/store/keys/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "devices@example.com";

async function main(): Promise<void> {
  part("The setting");
  is("no limit by default, as every key was before", [DEFAULT_KEYS.devices, parseKeySetup({ source: "generated" })?.devices], [0, 0]);
  is("1 to MAX_DEVICES kept; past it, the old setting", [parseKeySetup({ source: "pool", devices: 3 })?.devices, parseKeySetup({ source: "pool", devices: MAX_DEVICES + 1 })?.devices], [3, 0]);
  const form = { source: "generated", prefix: "", groups: "4", groupLength: "4", lowAt: "" };
  is("the studio's form reads it, and names a wrong one", [(readKeySetup({ ...form, devices: "2" }) as { devices: number }).devices, readKeySetup({ ...form, devices: "11" }), readKeySetup({ ...form, devices: "-1" })], [2, "devices", "devices"]);

  redis.clear();
  await claimHandle(OWNER, "keyshop", "Key Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Keys00001", subscriptionId: "sub_Keys00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Synth Plugin", "A plugin.", "49", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  is("keys limited to two devices", (await setProductKeys(OWNER, id, { ...DEFAULT_KEYS, devices: 2 })).ok, true);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, id))!;
  const sold = await keyForSale(store, product, "cs_test_" + "a".repeat(58), "buyer@example.com");
  const other = await keyForSale(store, product, "cs_test_" + "b".repeat(58), "second@example.com");
  if (sold?.state !== "issued" || other?.state !== "issued") throw new Error("no keys given");
  const key = sold.key;

  const ask = async (k: string, device?: string) => {
    const url = new URL("https://marktmorgen.com/api/store/licence");
    url.searchParams.set("store", "keyshop");
    url.searchParams.set("product", id);
    url.searchParams.set("key", k);
    if (device !== undefined) url.searchParams.set("device", device);
    const response = await check(new NextRequest(url, { headers: { "x-forwarded-for": "198.51.100.4" } }));
    return { code: response.status, body: (await response.json()) as { valid?: boolean; status?: string; devices?: { used: number; limit: number }; error?: string } };
  };

  part("A place per new device, up to the limit");
  is("without a device: asked for one", (await ask(key)).body, { valid: false, status: "device_required" });
  const slot = () => Number(redis.run(["HGET", dataKey(store)!, `lk:dev:${id}:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`])) || 0;
  is("the first device takes a place", (await ask(key, "machine-A-1234")).body, { valid: true, status: "valid", devices: { used: 1, limit: 2 } });
  is("the store's data room holds that place", slot(), devicesBytes(1));
  is("the same device again takes none", (await ask(key, "machine-A-1234")).body.devices, { used: 1, limit: 2 });
  is("a second device takes the last place", (await ask(key, "machine-B-5678")).body.devices, { used: 2, limit: 2 });
  is("and the room holds two", slot(), devicesBytes(2));
  is("a third is refused, with the count", (await ask(key, "machine-C-9999")).body, { valid: false, status: "device_limit", devices: { used: 2, limit: 2 } });
  is("the two devices that have it still pass", [(await ask(key, "machine-A-1234")).body.valid, (await ask(key, "machine-B-5678")).body.valid], [true, true]);
  is("another key has its own places", (await ask(other.key, "machine-C-9999")).body.devices, { used: 1, limit: 2 });
  is("a device id with a space is refused, never cut", (await ask(key, "machine A")).code, 400);

  part("The device id is never kept");
  const read = (k: string): unknown => {
    for (const command of [["GET", k], ["HGETALL", k], ["SMEMBERS", k], ["LRANGE", k, 0, -1], ["ZRANGE", k, 0, -1]] as (string | number)[][]) {
      try {
        return redis.run(command);
      } catch {
        // Another type: try the next.
      }
    }
    return null;
  };
  const everything = JSON.stringify(redis.keys().map((k) => [k, read(k)]));
  is("no device id anywhere in the database", ["machine-A-1234", "machine-B-5678", "machine-C-9999"].some((d) => everything.includes(d)), false);

  part("Revoked and unknown keys take no place");
  await setRevoked(store, product, other.key, true);
  is("revoked: said, no place taken", (await ask(other.key, "machine-D-0000")).body, { valid: false, status: "revoked" });
  is("unknown: said", (await ask("NOPE-NOPE-NOPE-NOPE", "machine-D-0000")).body, { valid: false, status: "unknown" });

  part("The creator frees a key's devices");
  const session = await openSession(OWNER);
  const studio = (body: unknown) =>
    studioPost(new NextRequest("https://marktmorgen.com/api/store/keys", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const listed = (await (await studioGet(new NextRequest(`https://marktmorgen.com/api/store/keys?id=${id}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } }))).json()) as { keys: { key: string; devices?: number }[] };
  is("the studio lists each key's devices", listed.keys.find((k) => k.key === key)?.devices, 2);
  is("a key this product never gave is refused", (await studio({ action: "free", id, key: "NOPE-NOPE-NOPE-NOPE" })).status, 404);
  const freed = (await (await studio({ action: "free", id, key })).json()) as { ok: boolean; freed: number };
  is("both freed", [freed.ok, freed.freed], [true, 2]);
  is("the room they took is given back", slot(), 0);
  is("a new device now gets a place", (await ask(key, "machine-C-9999")).body.devices, { used: 1, limit: 2 });

  part("No limit: as before");
  await setProductKeys(OWNER, id, { ...DEFAULT_KEYS, devices: 0 });
  is("a good key passes without a device and takes no place", (await ask(key)).body, { valid: true, status: "valid" });

  part("The editor");
  const editor = readFileSync("components/licence-key-editor.tsx", "utf8");
  is("a labeled choice, with no limit first, and a way to free a key's devices", [editor.includes("Devices per key"), editor.includes('<option value="0">No limit</option>'), editor.includes("Free its devices")], [true, true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
