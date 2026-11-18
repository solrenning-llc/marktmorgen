/**
 * A store from before lists (no listId; every store made since #1680 has
 * one) and a copy of it read before a person was deleted (Codex M on #3324,
 * CXM-20261109-0153-DELTA). Deleting the person by the real door
 * (lib/person-erasure.ts, erasePerson) gives the store its list first and
 * writes the deleted address there; a copy of the store read before that
 * still says it has no list. Sent with that copy, a later sale of the
 * deleted person kept its cookies again (a plain SET, nothing to ask) and
 * its renewal went to Meta.
 *
 * What fails here:
 *   - with the old copy, a sale of the deleted person sent, or its cookies
 *     kept again for renewals;
 *   - with the old copy, a renewal of the deleted person sent;
 *   - a store with no list that cannot be given one sending anything;
 *   - a store with no list no longer sending at all for somebody not deleted
 *     (it is given its list, once, and then sends).
 */
import { normaliseEmail } from "@/lib/auth";
import { sendRenewals, sendServerPurchase, setServerToken, subKey } from "@/lib/ad-events";
import { erasePerson } from "@/lib/person-erasure";
import { NO_PIXELS } from "@/lib/pixels";
import { setAdsServer, setPixels, storeForEmail } from "@/lib/store";
import { OWNER, makeWorld } from "./erasure-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_ad_events_legacy_stand_in";

const NOW = Date.now();
const SEC = Math.floor(NOW / 1000);
const META_TOKEN = "EAAB" + "m".repeat(60);
const COOKIES = { _fbp: "fb.1.1700000000.222", _fbc: "fb.1.1700000000.IwAR0def", fbclid: "IwAR0def", clickAt: String(SEC - 3600) };

let sessions: Record<string, unknown>[] = [];
let invoices: Record<string, unknown>[] = [];
let toMeta = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "graph.facebook.com") {
    toMeta += 1;
    return json({ events_received: 1 });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = sessions.find((s) => s.id === one[1]);
    return found ? json(found) : json({ error: { message: "No such checkout session" } }, 404);
  }
  if (path === "/invoices") return json({ object: "list", data: invoices, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const paid = (id: string, email: string, sub: string) => ({
  id,
  status: "complete",
  payment_status: "paid",
  amount_total: 4900,
  currency: "usd",
  created: SEC - 120,
  customer_details: { email },
  subscription: sub,
  metadata: { store: "erase-shop", product: "club000001" },
});

const renewal = (id: string, email: string, sub: string) => ({
  id,
  status: "paid",
  billing_reason: "subscription_cycle",
  amount_paid: 4900,
  currency: "usd",
  customer_email: email,
  created: SEC - 60,
  status_transitions: { paid_at: SEC - 60 },
  parent: { subscription_details: { subscription: sub, metadata: { store: "erase-shop", product: "club000001", ads: "a".repeat(24) } } },
});

/** Takes the list off the kept store record, as a store from before lists has none. */
function unlist(): void {
  const keys = redis.keys().filter((key) => key.startsWith("nl:store:owner:"));
  for (const key of keys) {
    const raw = redis.run(["GET", key]);
    if (typeof raw !== "string") continue;
    const record = JSON.parse(raw) as Record<string, unknown>;
    if (record.email !== OWNER) continue;
    record.listId = null;
    redis.run(["SET", key, JSON.stringify(record)]);
  }
}

async function main(): Promise<void> {
  redis.clear();
  const world = await makeWorld();
  const statsId = world.store.statsId as string;
  await setServerToken(statsId, "meta", META_TOKEN);
  await setAdsServer(OWNER, ["meta"]);
  await setPixels(OWNER, { ...NO_PIXELS, meta: "123456789012345" });
  unlist();
  const old = (await storeForEmail(OWNER))!;
  const buyer = { ip: "203.0.113.9", userAgent: "Mozilla/5.0", url: "https://marktmorgen.com/@erase-shop/thanks", cookies: COOKIES };

  part("A store from before lists");
  is("its record has no list", old.listId, null);

  part("Somebody not deleted, sent with a copy that has no list: it still goes, and the store is given its list");
  const LIVE = "sub_LegacyLive0001";
  sessions = [paid("cs_test_legacylive01", "alive@example.com", LIVE)];
  toMeta = 0;
  is("the purchase is sent", await sendServerPurchase(old, "cs_test_legacylive01", buyer, NOW), "sent");
  is("to Meta", toMeta, 1);
  is("its cookies are kept for the renewals", typeof redis.run(["GET", subKey(LIVE)]), "string");
  is("the store has a list now", typeof (await storeForEmail(OWNER))!.listId, "string");
  invoices = [renewal("in_LegacyLive00001", "alive@example.com", LIVE)];
  toMeta = 0;
  is("its renewal is sent with the old copy too", await sendRenewals(old, NOW), 1);
  is("to Meta", toMeta, 1);

  part("Deleted by the real door; then a sale and a renewal sent with the copy read before");
  unlist();
  const stale = (await storeForEmail(OWNER))!;
  is("the copy has no list", stale.listId, null);
  const BUYER = "Gone@Example.com";
  const SUB = "sub_LegacyGone0001";
  sessions = [paid("cs_test_legacygone01", BUYER, SUB), paid("cs_test_legacygone02", BUYER, SUB)];
  is("the first purchase is sent", await sendServerPurchase(stale, "cs_test_legacygone01", buyer, NOW), "sent");
  is("the erasure finishes", (await erasePerson((await storeForEmail(OWNER))!, BUYER, { kind: "person" })).ok, true);
  is("nothing kept under the membership", redis.run(["GET", subKey(SUB)]), null);
  toMeta = 0;
  is("a later sale with the old copy is not sent", await sendServerPurchase(stale, "cs_test_legacygone02", buyer, NOW), "off");
  is("and its cookies are not kept again", redis.run(["GET", subKey(SUB)]), null);
  invoices = [renewal("in_LegacyGone00001", normaliseEmail(BUYER), SUB)];
  is("no renewal sent with the old copy", await sendRenewals(stale, NOW), 0);
  is("Meta asked nothing", toMeta, 0);
  is("nor with a fresh one", await sendRenewals((await storeForEmail(OWNER))!, NOW), 0);
  is("Meta still asked nothing", toMeta, 0);

  part("A store with no list that cannot be given one sends nothing");
  unlist();
  const nolist = (await storeForEmail(OWNER))!;
  const real = redis.pipeline.bind(redis);
  // Nothing under the store's own keys can be written: no list can be given.
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((c) => (c[0] === "SET" || c[0] === "EVAL") && String(c[1]).startsWith("nl:store:")) ? commands.map(() => null) : real(commands)) as typeof redis.pipeline;
  sessions = [paid("cs_test_legacyfail01", "maybe@example.com", "sub_LegacyFail0001")];
  toMeta = 0;
  const failed = await sendServerPurchase(nolist, "cs_test_legacyfail01", buyer, NOW);
  redis.pipeline = real;
  is("not sent", [failed, toMeta], ["off", 0]);
  is("nothing kept for renewals", redis.run(["GET", subKey("sub_LegacyFail0001")]), null);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
