/**
 * Making an API key needs a login from the last FRESH_LOGIN_SECONDS
 * (app/api/store/api-keys/route.ts, "make"; lib/auth.ts isFreshSession).
 *
 * A key outlives the session that makes it: "Log out of all devices"
 * (lib/auth.ts endAllSessions) ends sessions, never keys. Before this check,
 * a session cookie taken from an account without a passkey or an
 * authenticator app could make a key at any time in its 30 days, and the key
 * kept reading the store (and, with `write`, giving products) after the
 * owner logged every device out. Adding a passkey, a recovery address or an
 * address change already asks for the same fresh login, for the same reason.
 *
 * Synthetic stores and sessions only; nothing leaves the process.
 */
import { NextRequest } from "next/server";
import { POST as keysRoute } from "@/app/api/store/api-keys/route";
import { FRESH_LOGIN_SECONDS, SESSION_COOKIE, endAllSessions, openSession } from "@/lib/auth";
import { resolveKey } from "@/lib/api-keys";
import { type Store, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const OWNER = "owner-fresh-keys@example.com";

async function newStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, handle, "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/-/g, "")}`, subscriptionId: `sub_${handle.replace(/-/g, "")}`, active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  if (!store.sid) throw new Error("no store id");
  return store;
}

type KeyAnswer = { ok: boolean; error?: string; key?: string };

async function make(store: Store, session: string, name: string, write = false): Promise<{ status: number; body: KeyAnswer }> {
  const response = await keysRoute(
    new NextRequest(`${ORIGIN}/api/store/api-keys?store=${store.sid}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, host: "marktmorgen.com" },
      body: JSON.stringify({ action: "make", name, write }),
    }),
  );
  return { status: response.status, body: (await response.json()) as KeyAnswer };
}

async function main(): Promise<void> {
  redis.clear();
  const store = await newStore(OWNER, "fresh-keys");

  part("A login from the last fifteen minutes makes a key");
  const fresh = await openSession(OWNER);
  const made = await make(store, fresh, "Zapier");
  is("made", [made.status, made.body.ok, typeof made.body.key], [200, true, "string"]);

  part("An older session is asked to log in again, and nothing is made");
  const old = await openSession(OWNER);
  advance((FRESH_LOGIN_SECONDS + 60) * 1000);
  const late = await make(store, old, "Taken cookie", true);
  is("refused with reauth", [late.status, late.body.ok, late.body.error, "key" in late.body], [403, false, "reauth", false]);
  const lateRead = await make(store, old, "Taken cookie, read only");
  is("a key that only reads too", [lateRead.status, lateRead.body.error], [403, "reauth"]);

  part("Logging in again makes it");
  const again = await openSession(OWNER);
  const remade = await make(store, again, "Make");
  is("made after a new login", [remade.status, remade.body.ok], [200, true]);

  part("Log out of all devices still leaves the keys a fresh login made");
  // Keys are the creator's own automations: ending sessions never revokes them (revoking is its own action).
  await endAllSessions(OWNER);
  is("the key made from a fresh login still reads", Boolean(await resolveKey(made.body.key!)), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
