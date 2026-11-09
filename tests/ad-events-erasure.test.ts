/**
 * A membership's renewals are sent to the ad platforms with the cookies and
 * click ids its first checkout carried (lib/ad-events.ts, keepForRenewals,
 * nl:adsrv:sub:<subscription>, 400 days). Audit 12 (privacy, Claude 6) found
 * that record was never noted for erasure: deleting the person, by the real
 * door (lib/person-erasure.ts, erasePerson), left their _fbp, _fbc, _ttp, _ga
 * and click ids in place, and every renewal after it still went to Meta with
 * a hash of their address.
 *
 * What fails here:
 *   - the record still there after the person is deleted;
 *   - a renewal sent to an ad platform after the person is deleted, also for a
 *     record kept before the fix (written without a note);
 *   - the note sent after the write, or not with it (it must go first, in the
 *     same pipeline, so a write is never left without its way to be deleted);
 *   - a record kept for a checkout with no address (nothing could find it);
 *   - a record kept for an address already deleted from the store.
 */
import { normaliseEmail } from "@/lib/auth";
import { sendRenewals, sendServerPurchase, setServerToken, subKey } from "@/lib/ad-events";
import { erasePerson } from "@/lib/person-erasure";
import { NO_PIXELS } from "@/lib/pixels";
import { ensureListId, setAdsServer, setPixels, storeForEmail } from "@/lib/store";
import { suppressCommand } from "@/lib/suppression";
import { OWNER, makeWorld } from "./erasure-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_ad_events_erasure_stand_in";

const NOW = Date.now();
const SEC = Math.floor(NOW / 1000);
const META_TOKEN = "EAAB" + "m".repeat(60);
const BUYER = "Member@Example.com";
const COOKIES = { _fbp: "fb.1.1700000000.111", _fbc: "fb.1.1700000000.IwAR0abc", _ttp: "ttp0abc", _ga: "GA1.1.123.456", fbclid: "IwAR0abc", clickAt: String(SEC - 3600) };

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

const paid = (id: string, email: string | null, sub: string) => ({
  id,
  status: "complete",
  payment_status: "paid",
  amount_total: 4900,
  currency: "usd",
  created: SEC - 120,
  ...(email ? { customer_details: { email } } : {}),
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

async function main(): Promise<void> {
  redis.clear();
  const world = await makeWorld();
  const statsId = world.store.statsId as string;
  await setServerToken(statsId, "meta", META_TOKEN);
  await setAdsServer(OWNER, ["meta"]);
  await setPixels(OWNER, { ...NO_PIXELS, meta: "123456789012345" });
  await ensureListId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const buyer = { ip: "203.0.113.9", userAgent: "Mozilla/5.0", url: "https://marktmorgen.com/@erase-shop/thanks", cookies: COOKIES };

  part("The record a membership's renewals go with is noted for erasure, first and with its write");
  const SUB = "sub_Member0000001";
  sessions = [paid("cs_test_member000001", BUYER, SUB)];
  const sent: (string | number)[][][] = [];
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sent.push(commands);
    return real(commands);
  }) as typeof redis.pipeline;
  is("the purchase is sent", await sendServerPurchase(store, "cs_test_member000001", buyer, NOW), "sent");
  redis.pipeline = real;
  const kept = redis.run(["GET", subKey(SUB)]);
  is("its cookies and clicks are kept for the renewals", typeof kept === "string" && JSON.parse(kept as string)._fbp, COOKIES._fbp);
  const writing = sent.find((batch) => batch.some((c) => c.includes(subKey(SUB)) && (c[0] === "SET" || c[0] === "EVAL")));
  const writeAt = writing ? writing.findIndex((c) => c.includes(subKey(SUB)) && (c[0] === "SET" || c[0] === "EVAL")) : -1;
  const noteAt = writing ? writing.findIndex((c) => c[0] === "ZADD" && String(c[1]).startsWith("nl:erase:ix:") && c[3] === subKey(SUB)) : -1;
  is("the note goes in the same pipeline as the write, before it", [writing !== undefined, noteAt >= 0, noteAt < writeAt], [true, true, true]);

  part("Deleting the person, by the real door, deletes it");
  const erased = await erasePerson(store, BUYER, { kind: "person" });
  is("the erasure finishes", erased.ok, true);
  is("nothing kept under the membership any more", redis.run(["GET", subKey(SUB)]), null);

  part("And no renewal goes to an ad platform after it");
  invoices = [renewal("in_Member0000001", normaliseEmail(BUYER), SUB)];
  toMeta = 0;
  is("no renewal sent", await sendRenewals(store, NOW), 0);
  is("Meta asked nothing", toMeta, 0);

  part("A record kept before the fix, without a note, is never sent for a deleted address");
  const OLD = "sub_Legacy00000001";
  const LEGACY = "legacy@example.com";
  redis.run(["SET", subKey(OLD), JSON.stringify({ _fbp: "fb.1.1.legacy" }), "EX", 400 * 86_400]);
  redis.run(suppressCommand(store.listId as string, LEGACY));
  invoices = [renewal("in_Legacy00000001", LEGACY, OLD)];
  toMeta = 0;
  is("no renewal sent for it", await sendRenewals(store, NOW), 0);
  is("Meta asked nothing", toMeta, 0);
  is("and what was kept for it goes", redis.run(["GET", subKey(OLD)]), null);

  part("A renewal of somebody not deleted still goes, once");
  const LIVE = "sub_Living00000001";
  sessions = [paid("cs_test_living000001", "living@example.com", LIVE)];
  is("the purchase is sent", await sendServerPurchase(store, "cs_test_living000001", buyer, NOW), "sent");
  invoices = [renewal("in_Living00000001", "living@example.com", LIVE)];
  toMeta = 0;
  is("the renewal is sent", await sendRenewals(store, NOW), 1);
  is("to Meta", toMeta, 1);

  part("Nothing is kept that nothing could find, or for an address already deleted");
  const NOMAIL = "sub_NoMail00000001";
  sessions = [paid("cs_test_nomail000001", null, NOMAIL)];
  await sendServerPurchase(store, "cs_test_nomail000001", buyer, NOW);
  is("a checkout with no address keeps nothing for renewals", redis.run(["GET", subKey(NOMAIL)]), null);
  const GONE = "sub_Gone0000000001";
  redis.run(suppressCommand(store.listId as string, "gone@example.com"));
  sessions = [paid("cs_test_gone00000001", "gone@example.com", GONE)];
  await sendServerPurchase(store, "cs_test_gone00000001", buyer, NOW);
  is("an address already deleted keeps nothing for renewals", redis.run(["GET", subKey(GONE)]), null);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
