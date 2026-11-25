/**
 * SG2(17): every paid-email admission that used the fail-open withinLimit now
 * fails closed on an unknown counter, and still tells a real excess apart from
 * a counter that could not be read (essentialLimitState, lib/request-guard.ts).
 *
 * Behaviour, not source text (Claude 1 / Claude 5 LOW on #2674): each caller is
 * run on the in-memory Redis twice per scope, once with its counter full (a real
 * excess) and once with Redis throwing on that counter only (unknown). Nothing
 * is sent in either case. The three MEDIUMs of #2674 are the first three parts.
 *
 * Positive controls (Claude 6's MEDIUM on #2674, 7057694750): the inbound relay, the notice, the waitlist and the
 * list sign-up each first really send with their counter below its limit, so an "unknown" case answering 0 sent is
 * the guard's work and not a fixture that could never send. The sending key is one the synthetic Resend fixture
 * knows (tests/resend-fixture-credentials.ts); with an unknown key every send was refused before the provider and
 * the unknown cases held with the guard removed.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setJoin, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { makeKey } from "@/lib/api-keys";
import { forwardInbound } from "@/lib/inbound-mail";
import { fileReport } from "@/lib/takedown";
import type { ReportInput } from "@/lib/takedown-rules";
import { requestErasureLink } from "@/lib/erasure-request";
import { joinWaitlist, setSoon } from "@/lib/waitlist";
import { askToJoin } from "@/lib/store-join";
import { readListing } from "@/lib/catalog";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { POST as postAccess } from "@/app/api/v1/access/route";
import { POST as postResend } from "@/app/api/store/resend/route";
import { POST as postJoin } from "@/app/api/auth/join/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ORIGIN = "https://marktmorgen.com";
const INBOUND_ID = "9ef9a417-02e9-4d39-ad75-9611e0fcc33c";
// A second message for the positive control: the first one's count-once mark (nl:inbound:counted:<id>) holds what
// its own cases decided, so a send with room is made on a message of its own.
const INBOUND_ROOM_ID = "9ef9a417-02e9-4d39-ad75-9611e0fcc34d";
const RECEIVED = /^\/emails\/receiving\/([0-9a-f-]{36})$/;
let sent = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com" && (init?.method ?? "GET") === "POST") { sent += 1; return new Response(JSON.stringify({ id: `email_${sent}` })); }
  const received = RECEIVED.exec(url.pathname);
  if (received) {
    return new Response(JSON.stringify({ object: "email", id: received[1], from: "Lee <lee@example.org>", to: ["harborkitchen@mail.marktmorgen.com"], received_for: ["harborkitchen@mail.marktmorgen.com"], reply_to: [], subject: "Re: menu", text: "Is the pie still on?", headers: {} }));
  }
  if (url.pathname.endsWith("/attachments")) return new Response(JSON.stringify({ object: "list", has_more: false, data: [] }));
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

// One counter scope at a time: "full" puts it far past any limit before the
// caller's own SET NX + INCR; "unknown" makes Redis throw on that counter only.
// "room" sets nothing: the caller's counters are below their limits, the positive control.
type Mode = "full" | "unknown" | "room";
const modes = new Map<string, Mode>();
const filled = new Set<string>();
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const [scope, mode] of modes) {
    const hit = commands.find((c) => String(c[1] ?? "").startsWith(`nl:rl:${scope}:`));
    if (!hit) continue;
    if (mode === "unknown") throw new Error("Redis timed out (synthetic)");
    filled.add(String(hit[1]));
    await real([["SET", String(hit[1]), "1000000000", "EX", 86_400]]);
  }
  return real(commands);
}) as typeof redis.pipeline;

async function under<T>(scope: string, mode: Mode, run: () => Promise<T>): Promise<{ value: T; sent: number }> {
  modes.clear();
  if (mode !== "room") modes.set(scope, mode);
  const before = sent;
  try {
    return { value: await run(), sent: sent - before };
  } finally {
    modes.clear();
    // Each case starts from counters with room: a filled one never leaks into the next.
    if (filled.size) await real([["DEL", ...filled]]);
    filled.clear();
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_sending_only";
  process.env.RESEND_INBOUND_API_KEY = "re_test_reading_only";
  process.env.SUPPORT_FORWARD_TO = "inbox@example.net";
  process.env.MARKETING_FROM_DOMAIN = "mail.marktmorgen.com";
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

  const OWNER = "ana@example.org";
  await claimHandle(OWNER, "harborkitchen", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Harbor0001", subscriptionId: "sub_Harbor0001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "The Guide", "", "12", null);
  if (!made.ok) throw new Error("setup: product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide");
  await setJoin(OWNER, { on: true });
  const store = async () => (await storeForEmail(OWNER))!;

  part("MEDIUM 1, inbound mail to a creator (lib/inbound-mail.ts)");
  const inboundRoom = await under("creator-inbound", "room", () => forwardInbound(INBOUND_ROOM_ID));
  is("control: with room, a message to the store is forwarded", inboundRoom.value, "sent");
  is("control: and one email went out", inboundRoom.sent, 1);
  const inboundUnknown = await under("creator-inbound", "unknown", () => forwardInbound(INBOUND_ID));
  is("an unreadable counter is a retry (500, seen mark cleared), never skipped and lost", inboundUnknown.value, "retry");
  is("and nothing is forwarded on that try", inboundUnknown.sent, 0);
  const inboundFull = await under("creator-inbound", "full", () => forwardInbound(INBOUND_ID));
  is("past the hour's limit it is skipped", inboundFull.value, "skipped");

  part("MEDIUM 2, notices and deletion links say limited only when limited");
  const report = {} as ReportInput; // the limit is read before the notice is
  const reportRoom = await under("report", "room", () => fileReport(report, "9.9.9.8", ORIGIN));
  is("control: with room, a notice is sent on", [reportRoom.value, reportRoom.sent > 0], ["sent", true]);
  is("a sixth notice from one connection: limited", (await under("report", "full", () => fileReport(report, "9.9.9.9", ORIGIN))).value, "limited");
  const reportUnknown = await under("report", "unknown", () => fileReport(report, "9.9.9.9", ORIGIN));
  is("a notice whose count cannot be read: error, never limited, nothing sent", [reportUnknown.value, reportUnknown.sent], ["error", 0]);
  const erase = () => requestErasureLink({ email: "lee@example.org", ip: "7.7.7.7", origin: ORIGIN });
  is("deletion links past the connection's hour: limited", (await under("erase-ip", "full", erase)).value, "limited");
  is("past the address's hour: limited", (await under("erase-address", "full", erase)).value, "limited");
  is("the connection's count unreadable: error", (await under("erase-ip", "unknown", erase)).value, "error");
  is("the address's count unreadable: error", (await under("erase-address", "unknown", erase)).value, "error");

  part("MEDIUM 3, the API's daily gives (lib/api-write.ts)");
  const writer = await makeKey((await store()).sid!, "Zapier", Date.now(), true);
  if (!writer.ok) throw new Error("setup: key");
  const give = async () => {
    const response = await postAccess(new Request(`${ORIGIN}/api/v1/access`, { method: "POST", headers: { Authorization: `Bearer ${writer.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ email: "cy@example.com", product: made.product.id }) }));
    return [response.status, ((await response.json()) as { error?: string }).error];
  };
  is("past the day's gives: 429 daily_limit, as the developers page says", (await under("api-give", "full", give)).value, [429, "daily_limit"]);
  is("the count unreadable: 503 unavailable, try again", (await under("api-give", "unknown", give)).value, [503, "unavailable"]);

  part("LOW, sign-up boxes never blame the visitor for an unreadable count");
  const product = (await readListing(await store(), made.product.id))!;
  await setSoon(await store(), product.id, true);
  const wait = async () => joinWaitlist({ store: await store(), product, email: "dana@example.com", consent: true, ip: "1.1.1.1", origin: ORIGIN });
  const waitRoom = await under("waitlist-address", "room", async () => joinWaitlist({ store: await store(), product, email: "dana.room@example.com", consent: true, ip: "1.1.1.3", origin: ORIGIN }));
  is("control: waitlist with room sends its confirmation", [waitRoom.value, waitRoom.sent], ["sent", 1]);
  is("waitlist, the address past its hour: limited", (await under("waitlist-address", "full", wait)).value, "limited");
  const waitUnknown = await under("waitlist-address", "unknown", wait);
  is("waitlist, the address's count unreadable: error, nothing sent", [waitUnknown.value, waitUnknown.sent], ["error", 0]);
  const join = async () => askToJoin({ store: await store(), email: "erin@example.com", ip: "1.1.1.2", origin: ORIGIN });
  const joinRoom = await under("join-address", "room", async () => askToJoin({ store: await store(), email: "erin.room@example.com", ip: "1.1.1.4", origin: ORIGIN }));
  is("control: list sign-up with room sends its confirmation", [joinRoom.value, joinRoom.sent], ["sent", 1]);
  is("list sign-up, the address past its hour: limited", (await under("join-address", "full", join)).value, "limited");
  const joinUnknown = await under("join-address", "unknown", join);
  is("list sign-up, the address's count unreadable: error, nothing sent", [joinUnknown.value, joinUnknown.sent], ["error", 0]);

  part("LOW, sending a purchase email again (app/api/store/resend)");
  const session = await openSession(OWNER);
  const resend = async () => {
    const response = await postResend(new NextRequest(`${ORIGIN}/api/store/resend`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ reference: `cs_test_${"a".repeat(24)}` }) }));
    return [response.status, ((await response.json()) as { error?: string }).error];
  };
  is("one sale past its day: 429 limited", (await under("resend-sale", "full", resend)).value, [429, "limited"]);
  is("the store past its hour: 429 limited", (await under("resend-store", "full", resend)).value, [429, "limited"]);
  is("the sale's count unreadable: 503 unavailable", (await under("resend-sale", "unknown", resend)).value, [503, "unavailable"]);
  is("the store's count unreadable: 503 unavailable", (await under("resend-store", "unknown", resend)).value, [503, "unavailable"]);

  part("LOW, accepting a team invitation (app/api/auth/join)");
  const accept = async () => {
    const response = await postJoin(new NextRequest(`${ORIGIN}/api/auth/join`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, host: "marktmorgen.com" }, body: new URLSearchParams({ token: "x" }) }));
    return response.headers.get("location");
  };
  is("too many tries from one connection: invite-slow", (await under("join", "full", accept)).value, `${ORIGIN}/signin?status=invite-slow`);
  is("the tries unreadable: invite-error, never 'slow down'", (await under("join", "unknown", accept)).value, `${ORIGIN}/signin?status=invite-error`);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
