/** Separate G derivative: original six oracles, unreadable paused_at between first unknown and retry. Original stays immutable. */
/**
 * A member pressing "Resume now" twice during a pause (lib/membership-pause.ts,
 * resumeMembership). Resuming inside a pause starts a new period that day with
 * a payment (`billing_cycle_anchor=now`): each such request Stripe carries out
 * charges the member again. Two presses that both read the membership as
 * paused, before either change lands, must not both send it; the second waits
 * for the first and then reads the membership as it is, no longer paused.
 * Synthetic Stripe and Redis only.
 */
import { addMonths } from "@/lib/membership-pause-rules";
import { resumeMembership } from "@/lib/membership-pause";
import { createHash } from "node:crypto";
import { claimHandle, ensureStatsId, setPauseMonths, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const NOW = Math.floor(Date.UTC(2026, 9, 11, 12) / 1000);
const PERIOD_END = Math.floor(Date.UTC(2026, 9, 31, 9) / 1000);

let sub: Record<string, unknown> = {
  id: "sub_Member0000001",
  status: "active",
  billing_mode: { type: "classic" },
  customer: "cus_Member000001",
  pause_collection: { behavior: "void", resumes_at: addMonths(PERIOD_END, 2) },
  metadata: { store: "club", product: "prod000001", pause_from: String(PERIOD_END), paused_at: String(NOW) },
  items: { data: [{ current_period_end: PERIOD_END, price: { unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
};
const charges: string[] = [];
let failFirst = false;
let lateCommit = false;
let pending: (() => void) | null = null;
const applied = new Set<string>();

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
    const apply = () => {
      if (key && applied.has(key)) return;
      if (key) applied.add(key);
      if (body.get("billing_cycle_anchor") === "now") charges.push(key);
      const metadata = { ...(sub.metadata as Record<string, string>) };
      if (body.has("metadata[pause_from]")) metadata.pause_from = body.get("metadata[pause_from]") ?? "";
      sub = { ...sub, metadata, pause_collection: body.has("pause_collection") ? null : sub.pause_collection };
    };
    if (failFirst) {
      failFirst = false;
      if (lateCommit) pending = apply;
      throw new TypeError("synthetic: client stopped waiting; provider may still apply");
    }
    apply();
    return json(sub);
  }
  return json({ data: [], has_more: false });
}) as typeof fetch;

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_g3090_unknown";
  const owner = "club@example.com";
  await claimHandle(owner, "club", "Supper Club", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestClub000001", true);
  await setPauseMonths(owner, 2);
  const store = (await storeForEmail(owner))!;
  const token = "ab".repeat(32);
  const linkKey = `nl:manage:link:${createHash("sha256").update(`nimbus-manage:${token}`).digest("hex").slice(0,40)}`;
  await redis.pipeline([["SET", linkKey, JSON.stringify({a:store.stripeAccountId,c:"cus_Member000001",h:store.handle}), "EX", 3600]]);
  const reset = () => {
    charges.length = 0;
    applied.clear();
    pending = null;
    failFirst = true;
    sub = { ...sub, pause_collection: { behavior: "void", resumes_at: addMonths(PERIOD_END,2) }, metadata: { store:"club",product:"prod000001",pause_from:String(PERIOD_END),paused_at:String(NOW) } };
  };
  const resume = () => resumeMembership(store, token, "sub_Member0000001", PERIOD_END + DAY);
  reset();
  lateCommit = false;
  const unavailable = await resume();
  const healthy = await resume();
  is("control: failed before application, healthy retry charges once", [unavailable.ok, healthy.ok, charges.length], [false,true,1]);

  reset();
  lateCommit = true;
  const unknown = await resume();
  const [lock] = await redis.pipeline([["GET", "nl:tier:sub_Member0000001:lock"]]);
  is("first client ended, lock released naturally, provider still reports paused", [unknown.ok, lock, Boolean(sub.pause_collection), typeof pending], [false,null,true,"function"]);
  // Separate G fixture: a later provider reply has an unreadable metadata field, not a new pause.
  sub = { ...sub, metadata: { ...(sub.metadata as Record<string, unknown>), paused_at: 7 } };
  const again = await resume();
  is("retry reads still-paused provider state and completes one change", [again.ok, charges.length], [true,1]);
  const flush = pending as (() => void) | null;
  if (!flush) throw Error("provider operation was not deferred");
  flush();
  is("late first application never charges a second period", charges.length, 1);
  is("provider state is resumed after both applications", sub.pause_collection, null);
  const last = await resume();
  is("further press changes nothing and total remains one charge", [last.ok, charges.length], [false,1]);
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
