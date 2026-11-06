/**
 * The public API: keys, the door, and what is allowed out.
 *
 * Three things matter most here, and each has checks below:
 *
 *   - a key opens its own store and no other, and a revoked key opens nothing
 *     from the very next request;
 *   - what is stored is a fingerprint, never the key;
 *   - every object goes out field by field from a written list, so a secret
 *     kept on a record — a contact's unsubscribe token — can never ride out
 *     with it.
 */
import { MAX_KEYS, keyFromHeader, listKeys, makeKey, resolveKey, revokeKey } from "@/lib/api-keys";
import { apiStore, apiWriter } from "@/lib/api-guard";
import { leads } from "@/lib/api-read";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const A = "a".repeat(32);
const B = "b".repeat(32);

async function main(): Promise<void> {
  part("Making a key");
  redis.clear();
  const made = await makeKey(A, "Zapier");
  if (!made.ok) throw new Error("no key made");
  is("it looks like a key, so one pasted in the wrong place is recognisable", /^nl_live_[0-9a-f]{40}$/.test(made.key), true);
  is("it needs a name", (await makeKey(A, "   ")).ok, false);
  // Read each value by its Redis type; a hash is not a missing string.
  const stored = JSON.stringify(redis.keys().map((key) => {
    switch (redis.run(["TYPE", key])) {
      case "string": return redis.run(["GET", key]);
      case "hash": return redis.run(["HGETALL", key]);
      case "set": return redis.run(["SMEMBERS", key]);
      case "zset": return redis.run(["ZRANGEBYSCORE", key, "-inf", "+inf"]);
      case "list": return redis.run(["LRANGE", key, 0, -1]);
      case "none": return null;
      default: throw new Error("Unrecognized synthetic API value type");
    }
  }));
  is("the key itself is stored nowhere", stored.includes(made.key), false);
  is("the list shows its start and never the whole", (await listKeys(A)).map((k) => k.hint), [made.key.slice(8, 14)]);

  part("A key opens its own store and no other");
  const other = await makeKey(B, "CRM");
  if (!other.ok) throw new Error("no key made");
  is("A's key opens A", (await resolveKey(made.key))?.sid, A);
  is("B's key opens B", (await resolveKey(other.key))?.sid, B);
  is("B's list does not hold A's key", (await listKeys(B)).some((k) => k.id === made.made.id), false);
  is("a key one character off opens nothing", await resolveKey(made.key.slice(0, -1) + (made.key.endsWith("0") ? "1" : "0")), null);
  is("nothing opens nothing", await resolveKey(""), null);
  // Revoking takes A's key by its id from B's store: it must not work.
  is("B cannot revoke A's key", await revokeKey(B, made.made.id), false);
  is("and A's key still works", (await resolveKey(made.key))?.sid, A);

  part("Revoking");
  is("A revokes its own", await revokeKey(A, made.made.id), true);
  is("the very next request with it is refused", await resolveKey(made.key), null);
  is("and it is gone from the list", (await listKeys(A)).length, 0);
  is("revoking twice says so", await revokeKey(A, made.made.id), false);

  part("At most five a store");
  redis.clear();
  for (let i = 0; i < MAX_KEYS; i += 1) await makeKey(A, `Key ${i}`);
  is(`${MAX_KEYS} made`, (await listKeys(A)).length, MAX_KEYS);
  is("a sixth is refused", (await makeKey(A, "One too many")).ok, false);
  is("and another store is not counted against it", (await makeKey(B, "Theirs")).ok, true);

  part("Reading the header");
  is("the usual form", keyFromHeader("Bearer nl_live_abc"), "nl_live_abc");
  is("any case, extra spaces", keyFromHeader("  bearer   nl_live_abc  "), "nl_live_abc");
  is("a Basic header is not a key", keyFromHeader("Basic dXNlcjpwYXNz"), "");
  is("no header, no key", keyFromHeader(null), "");

  part("The door refuses before it reads anything");
  redis.clear();
  const status = async (auth: string | null) => {
    const answer = await apiStore(new Request("https://marktmorgen.com/api/v1/store", { headers: auth ? { authorization: auth } : {} }));
    return answer instanceof Response ? answer.status : 200;
  };
  is("no key: 401", await status(null), 401);
  is("a malformed key: 401", await status("Bearer hello"), 401);
  is("a well-formed key nobody made: 401", await status(`Bearer nl_live_${"0".repeat(40)}`), 401);
  const revoked = await makeKey(A, "Old");
  if (!revoked.ok) throw new Error("no key made");
  await revokeKey(A, revoked.made.id);
  is("a revoked key: 401, the same as never made", await status(`Bearer ${revoked.key}`), 401);
  const refusal = await apiStore(new Request("https://marktmorgen.com/api/v1/store"));
  is("and it says how to send one", refusal instanceof Response && (await refusal.json()).error, "unauthorized");
  is("with no CORS header, so a web page cannot use a key", refusal instanceof Response && refusal.headers.get("access-control-allow-origin"), null);

  part("Marked funded read-only API work needs the paid resource month");
  const fundedOwner = "funded-api@example.com";
  await claimHandle(fundedOwner, "fundedapi", "Synthetic API", "");
  await ensureStatsId(fundedOwner);
  await setSubscription(fundedOwner, { customerId: "cus_FundedApi001", subscriptionId: "sub_FundedApi001", active: true, tier: "creator", period: { ...paidPeriod(), funded: true } });
  const fundedStore = (await storeForEmail(fundedOwner))!;
  const fundedKey = await makeKey(fundedStore.sid, "Synthetic writer", Date.now(), true);
  if (!fundedKey.ok) throw new Error("no synthetic key");
  const fundedRequest = () => new Request("https://marktmorgen.com/api/v1/store", { headers: { authorization: `Bearer ${fundedKey.key}` } });
  const noFunds = await apiStore(fundedRequest());
  is("missing actual funding approval refuses read-only API work", noFunds instanceof Response && [noFunds.status, (await noFunds.json()).error], [429, "unavailable"]);
  is("the refused read takes no API allowance", await allowanceUsed(fundedStore, "api"), 0);
  const cleanupAuth = await apiWriter(fundedRequest());
  is("the writer authorization used by access removal retains its existing path", !(cleanupAuth instanceof Response) && cleanupAuth.store.sid, fundedStore.sid);
  await revokeKey(fundedStore.sid, fundedKey.made.id);
  const afterRevoke = await apiStore(fundedRequest());
  is("key revocation still refuses before financial admission", afterRevoke instanceof Response && afterRevoke.status, 401);

  part("Only the written fields go out");
  redis.clear();
  // A contact as the store keeps it, with its unsubscribe token.
  await redis.pipeline([
    [
      "HSET",
      "nl:store:leads:list1",
      "dana@example.com",
      JSON.stringify({
        agreed: true,
        agreedAt: "2026-09-12T14:03:22.000Z",
        firstAt: "2026-09-12T14:03:22.000Z",
        lastAt: "2026-09-20T09:41:10.000Z",
        titles: ["Free Pantry Guide"],
        ids: ["p8w2m4q9zz"],
        source: "free",
        unsub: false,
        unsubAt: "",
        t: "f".repeat(40),
        name: "",
        tags: [],
        importedAt: "",
      }),
    ],
    [
      "HSET",
      "nl:store:leads:list1",
      "gone@example.com",
      JSON.stringify({ agreed: true, agreedAt: "2026-09-01T00:00:00.000Z", firstAt: "", lastAt: "", titles: [], ids: [], source: "free", unsub: true, unsubAt: "2026-09-05T00:00:00.000Z", t: "e".repeat(40), name: "", tags: [], importedAt: "" }),
    ],
  ]);
  const page = await leads({ listId: "list1" } as unknown as Store, null, false);
  const out = JSON.stringify(page);
  is("the unsubscribe token never leaves", out.includes("f".repeat(40)) || out.includes("e".repeat(40)), false);
  is(
    "every field is one the developers page lists",
    Object.keys(page.data[0]).sort(),
    ["agreed", "agreed_at", "email", "first_at", "last_at", "name", "product_ids", "products", "source", "tags", "unsubscribed", "unsubscribed_at"],
  );
  const agreed = await leads({ listId: "list1" } as unknown as Store, null, true);
  is("agreed=true leaves out whoever unsubscribed", agreed.data.map((r) => r.email), ["dana@example.com"]);
  is("an empty time is null, never an empty string", page.data.find((r) => r.email === "gone@example.com")?.first_at, null);

  done();
}

void main();
