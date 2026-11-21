/**
 * A sale's license key is shown to the buyer with whether it was revoked
 * (lib/licence-keys.ts, keyOfSale, read by keyForSale on the thanks page,
 * the list of purchases and the emails). Whether it was revoked is on the
 * key's own record (its info). Read as follows (CX-123 rule 24):
 *
 *   - a record that reads: revoked or not, as it says;
 *   - no record at all (Redis answers null): not revoked, which is exact,
 *     since nothing can revoke a key without its record (setRevoked refuses);
 *   - a record that does not read (a reply that is neither text nor null,
 *     or text that is not the record): not known. It throws, so each caller
 *     says the key could not be read ("error"), never that it is good;
 *   - the same for the sale's own line (which key it has, whether it waits
 *     for one): a reply in another shape is not known, never "no key yet".
 *
 * Synthetic store; replies injected per case; no network.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { readListing } from "@/lib/catalog";
import { keyForSale, setRevoked } from "@/lib/licence-keys";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let infoKey = "";
let saleKey = "";
let inject: unknown[] | null = null;
let injectSale: unknown[] | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (inject && batch.length === 1 && batch[0][0] === "HGET" && batch[0][1] === infoKey) return inject;
  if (injectSale && batch.length === 2 && batch[0][0] === "HGET" && batch[0][1] === saleKey) return injectSale;
  return real(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No external provider in this test");
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_licence_key_info_stand_in";
  redis.clear();
  const owner = "licence-info@example.test";
  await claimHandle(owner, "licenceinfo", "Licence Info", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_LicInfo0001", subscriptionId: "sub_LicInfo0001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(owner, "acct_1LicenceInfo001", true);
  const app = await addProduct(owner, "Desktop app", "A synthetic app.", "40", null);
  if (!app.ok) throw new Error("key product fixture");
  await setProductLink(owner, app.product.id, "https://example.test/app");
  const keyed = await setProductKeys(owner, app.product.id, DEFAULT_KEYS);
  if (!keyed.ok) throw new Error("keys fixture");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, app.product.id))!;
  infoKey = `nl:keys:${store.statsId}:${product.id}:info`;
  saleKey = `nl:keys:${store.statsId}:${product.id}:sale`;

  /** The sale's key as the buyer is shown it, or that it could not be read. */
  const shown = async (reference: string) => {
    try {
      const key = await keyForSale(store, product, reference, "buyer@example.test");
      return key?.state === "issued" ? { state: key.state, revoked: key.revoked } : key;
    } catch {
      return "error";
    }
  };

  part("A record that reads: as it says");
  const given = await keyForSale(store, product, "cs_test_licinfo0001", "buyer@example.test");
  const key = given?.state === "issued" ? given.key : "";
  is("a key is given to the sale", Boolean(key), true);
  is("not revoked", await shown("cs_test_licinfo0001"), { state: "issued", revoked: false });
  is("revoked by the creator", await setRevoked(store, product, key, true), true);
  is("revoked", await shown("cs_test_licinfo0001"), { state: "issued", revoked: true });

  part("No record at all: not revoked, since nothing can revoke a key without one");
  inject = [null];
  is("issued, not revoked", await shown("cs_test_licinfo0001"), { state: "issued", revoked: false });

  part("A record that does not read: not known, never shown as good");
  const garbled: [string, unknown[]][] = [
    ["text that is not the record", ["not a record"]],
    ["a number", [7]],
    ["a list", [["a", "b"]]],
    ["no reply", []],
    ["more replies than asked", ['{"r":"cs_test_licinfo0001","e":"buyer@example.test","at":1}', null]],
  ];
  for (const [what, reply] of garbled) {
    inject = reply;
    is(`${what}: could not be read`, await shown("cs_test_licinfo0001"), "error");
  }
  inject = null;

  part("The sale's own line in another shape: not known, never \"no key yet\"");
  const lines: [string, unknown[]][] = [
    ["the key as a number", [7, 0]],
    ["waiting as text", [null, "1"]],
    ["one reply for two", [null]],
  ];
  for (const [what, reply] of lines) {
    injectSale = reply;
    is(`${what}: could not be read`, await shown("cs_test_licinfo0001"), "error");
  }
  injectSale = null;

  part("Control: the record read again as it is");
  is("revoked, as written", await shown("cs_test_licinfo0001"), { state: "issued", revoked: true });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
