/** Explicit DERIVATIVE of immutable T lease diagnostic ca5a48f9f8eb2676381e4cd96111741e16009e53d467b39634cf12653a97c43f.
 * Same held first POST, Redis+121s, second call, first release, later third call.
 * Difference: model equal nonempty keys as in flight (409), and count applications separately from requests.
 * This is an in-memory contract model, not Stripe execution or a global provider-policy certificate.
 */
import { addMonths } from "@/lib/membership-pause-rules";
import { resumeMembership } from "@/lib/membership-pause";
import { createHash } from "node:crypto";
import { claimHandle, ensureStatsId, setPauseMonths, setStripeAccount, storeForEmail } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const NOW = Math.floor(Date.UTC(2026, 9, 11, 12) / 1000);
const PERIOD_END = Math.floor(Date.UTC(2026, 9, 31, 9) / 1000);

let sub: Record<string, unknown> = {
  id: "sub_Member0000001",
  status: "active",
  customer: "cus_Member000001",
  pause_collection: { behavior: "void", resumes_at: addMonths(PERIOD_END, 2) },
  metadata: { store: "club", product: "prod000001", pause_from: String(PERIOD_END), paused_at: String(NOW) },
  items: { data: [{ current_period_end: PERIOD_END, price: { unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
};
const charges: string[] = [];
const requests: string[] = [];
const inFlight = new Set<string>();
let signal!: () => void;
let release!: () => void;
const arrived = new Promise<void>(resolve => { signal=resolve; });
const held = new Promise<void>(resolve => { release=resolve; });
let firstPost=true;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/customers" && method === "GET") return json({ data: [{ id: "cus_Member000001" }], has_more: false });
  if (path === "/customers/cus_Member000001") return json({ id: "cus_Member000001", email: "member@example.com" });
  if (path === "/subscriptions" && method === "GET") return json({ data: [sub], has_more: false });
  if (path === "/subscriptions/sub_Member0000001" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    requests.push(key);
    if (key && inFlight.has(key)) return json({error:{type:"idempotency_error",message:"Still in progress"}},409);
    if (key) inFlight.add(key);
    // The synthetic first call remains pending while the Redis lease expires.
    if(firstPost){firstPost=false;signal();await held;}
    // One synthetic application after an admitted request; repeats under an in-flight key were refused above.
    if (body.get("billing_cycle_anchor") === "now") charges.push(key);
    const metadata = { ...(sub.metadata as Record<string, string>) };
    if (body.has("metadata[pause_from]")) metadata.pause_from = body.get("metadata[pause_from]") ?? "";
    sub = { ...sub, metadata, pause_collection: body.has("pause_collection") ? null : sub.pause_collection };
    if (key) inFlight.delete(key);
    return json(sub);
  }
  return json({ data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_resume_only_a_stand_in";
  const OWNER = "club@example.com";
  await claimHandle(OWNER, "club", "Supper Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestClub000001", true);
  await setPauseMonths(OWNER, 2);
  const store = (await storeForEmail(OWNER))!;
  // The member's emailed link, as requestManageLink keeps it (lib/membership-manage.ts, tokenKey): this test is
  // about the presses, not the email that carries the link.
  const token = "ab".repeat(32);
  const linkKey = `nl:manage:link:${createHash("sha256").update(`nimbus-manage:${token}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", linkKey, JSON.stringify({ a: store.stripeAccountId, c: "cus_Member000001", h: store.handle }), "EX", 3600]]);

  part("Two presses of Resume now inside the pause");
  const when = PERIOD_END + DAY;
  const firstPending=resumeMembership(store, token, "sub_Member0000001", when);
  await arrived;
  // Synthetic scheduler suspension: no real provider latency, no claim of a supported >120s call.
  advance(121_000);
  const second=await resumeMembership(store, token, "sub_Member0000001", when);
  release();
  const first=await firstPending;
  is("one application in the idempotency-aware model", charges.length, 1);
  is("two requests carry the SAME nonempty key", [requests.length, !!requests[0], requests[0]===requests[1]], [2,true,true]);
  is("second in-flight press is unknown, not successful", second, {ok:false,reason:"error"});
  is("one press resumes it; the other finds it no longer paused", [first.ok, second.ok].filter(Boolean).length, 1);
  is("and the membership is running again", sub.pause_collection, null);

  part("A press after it resumed");
  const again = await resumeMembership(store, token, "sub_Member0000001", when);
  is("finds nothing to resume and charges nothing", [again.ok, charges.length], [false, 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
