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
 *
 * And what a checkout opened with the yes keeps for its sale
 * (nl:adsrv:ctx:<token>, four days, written before the address is known):
 *   - a sale or a lead of a deleted address still sent to an ad platform,
 *     from the thanks page or from the five-minute pass;
 *   - what the checkout kept left in place once its sale is known, whether
 *     it was sent or its buyer was deleted.
 */
import { normaliseEmail } from "@/lib/auth";
import { newLeadId, sendPaidOrders, sendRenewals, sendServerLead, sendServerPurchase, setServerToken, subKey } from "@/lib/ad-events";
import { adsCookieName, nextAdsCookie } from "@/lib/ad-consent";
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

const paid = (id: string, email: string | null, sub: string, ads?: string) => ({
  id,
  status: "complete",
  payment_status: "paid",
  amount_total: 4900,
  currency: "usd",
  created: SEC - 120,
  ...(email ? { customer_details: { email } } : {}),
  subscription: sub,
  metadata: { store: "erase-shop", product: "club000001", ...(ads ? { ads } : {}) },
});

const ctxKey = (token: string) => `nl:adsrv:ctx:${token}`;
const keepCtx = (token: string) =>
  redis.run(["SET", ctxKey(token), JSON.stringify({ ip: "203.0.113.7", userAgent: "Mozilla/5.0", url: "https://marktmorgen.com/@erase-shop/club", cookies: { _fbp: "fb.1.1.ctx" } }), "EX", 4 * 86_400]);
const asking = (cookies: Record<string, string>) => ({
  headers: new Headers({ "x-forwarded-for": "203.0.113.8", "user-agent": "Mozilla/5.0" }),
  cookies: { get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined) },
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

  part("A person deleted while a renewal pass is between its reads and its send: nothing goes (Codex P on #3324)");
  // The pass reads the kept cookies and the deleted addresses first; the
  // person is then deleted by the real door before the pass claims and
  // sends. Read at the claim, the deletion is seen: nothing goes to Meta.
  const RACE = "sub_Racing0000001";
  const RACER = "racing@example.com";
  sessions = [paid("cs_test_racing000001", RACER, RACE)];
  is("the purchase is sent", await sendServerPurchase(store, "cs_test_racing000001", buyer, NOW), "sent");
  invoices = [renewal("in_Racing00000001", RACER, RACE)];
  let erasedMidway: boolean | null = null;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    if (erasedMidway === null && commands.some((c) => c[0] === "GET" && c[1] === subKey(RACE)) && commands.some((c) => c[0] === "HMGET")) {
      redis.pipeline = real;
      erasedMidway = (await erasePerson(store, RACER, { kind: "person" })).ok;
    }
    return replies;
  }) as typeof redis.pipeline;
  toMeta = 0;
  const raced = await sendRenewals(store, NOW);
  redis.pipeline = real;
  is("the erasure ran between the pass's reads and its send, and finished", erasedMidway, true);
  is("what was kept for the membership is gone", redis.run(["GET", subKey(RACE)]), null);
  is("no renewal sent", raced, 0);
  is("Meta asked nothing", toMeta, 0);

  part("The same, for a record kept before the fix, which the erasure cannot find: the deleted address is asked again at the claim");
  const RACE_OLD = "sub_RacingOld00001";
  const RACER_OLD = "racing-old@example.com";
  redis.run(["SET", subKey(RACE_OLD), JSON.stringify({ _fbp: "fb.1.1.racingold" }), "EX", 400 * 86_400]);
  invoices = [renewal("in_RacingOld00001", RACER_OLD, RACE_OLD)];
  let erasedOld: boolean | null = null;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    if (erasedOld === null && commands.some((c) => c[0] === "GET" && c[1] === subKey(RACE_OLD)) && commands.some((c) => c[0] === "HMGET")) {
      redis.pipeline = real;
      erasedOld = (await erasePerson(store, RACER_OLD, { kind: "person" })).ok;
    }
    return replies;
  }) as typeof redis.pipeline;
  toMeta = 0;
  const racedOld = await sendRenewals(store, NOW);
  redis.pipeline = real;
  is("the erasure ran between the pass's reads and its send, and finished", erasedOld, true);
  is("no renewal sent", racedOld, 0);
  is("Meta asked nothing", toMeta, 0);
  is("and what was kept for it goes", redis.run(["GET", subKey(RACE_OLD)]), null);

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

  part("A sale of a person deleted before it was sent goes to no ad platform, and what its checkout kept goes");
  const LATE = "late@example.com";
  const T1 = "c".repeat(24);
  const T2 = "d".repeat(24);
  keepCtx(T1);
  keepCtx(T2);
  sessions = [paid("cs_test_late00000001", LATE, "sub_Late00000001", T1), paid("cs_test_late00000002", LATE, "sub_Late00000002", T2)];
  is("the person is deleted", (await erasePerson(store, LATE, { kind: "person" })).ok, true);
  toMeta = 0;
  is("the thanks page sends nothing", await sendServerPurchase(store, "cs_test_late00000001", buyer, NOW), "off");
  is("the five-minute pass sends nothing", await sendPaidOrders(store, [sessions[1]], NOW), 0);
  is("Meta asked nothing", toMeta, 0);
  is("what either checkout kept is gone", [redis.run(["GET", ctxKey(T1)]), redis.run(["GET", ctxKey(T2)])], [null, null]);
  is("and nothing is kept for renewals", [redis.run(["GET", subKey("sub_Late00000001")]), redis.run(["GET", subKey("sub_Late00000002")])], [null, null]);

  part("A lead of a deleted address goes to no ad platform");
  const yes = { [adsCookieName("erase-shop")]: nextAdsCookie(undefined, "?fbclid=IwAR0abc", SEC - 3600), _fbp: "fb.1.1.lead" };
  toMeta = 0;
  is("not sent", await sendServerLead(store, asking(yes), { id: newLeadId(), email: LATE, product: "guide00001" }, NOW), false);
  is("Meta asked nothing", toMeta, 0);
  is("a lead of somebody not deleted still goes", await sendServerLead(store, asking(yes), { id: newLeadId(), email: "lead@example.com", product: "guide00001" }, NOW), true);
  is("to Meta", toMeta, 1);

  part("What a checkout kept goes once its sale is sent: the address is known then, and nothing reads it after");
  const T3 = "e".repeat(24);
  const T4 = "f".repeat(24);
  keepCtx(T3);
  keepCtx(T4);
  sessions = [paid("cs_test_kept00000001", "kept@example.com", "sub_Kept00000001", T3), paid("cs_test_kept00000002", "kept@example.com", "sub_Kept00000002", T4)];
  toMeta = 0;
  is("the thanks page sends it", await sendServerPurchase(store, "cs_test_kept00000001", buyer, NOW), "sent");
  is("the five-minute pass sends the other", await sendPaidOrders(store, [sessions[1]], NOW), 1);
  is("both to Meta", toMeta, 2);
  is("what either checkout kept is gone", [redis.run(["GET", ctxKey(T3)]), redis.run(["GET", ctxKey(T4)])], [null, null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
