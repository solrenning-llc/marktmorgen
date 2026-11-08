/** Independent synthetic settlement proof. Real stores/records; only provider and receipt faults are stand-ins. */
import { claimHandle, setSubscription } from "@/lib/store";
import { creditKey, OWED_KEY, type Credit } from "@/lib/creator-invites";
import { settleInvites } from "@/lib/creator-invite-credit";
import { store as redis } from "../../../tests/redis-stub";
import { paidPeriod } from "../../../tests/billing-period-fixture";
import { is, done, part } from "../../../tests/check";

type Commands = (string | number)[][];
type Txn = { id: string; amount: number; metadata: { nimbus_invite_credit: string } };
const real = redis.pipeline.bind(redis), now = Date.UTC(2026, 9, 16, 12);
const txns: Txn[] = [], requests: { method: string; key: string | null; bytes: number }[] = [];
let historyMode: "healthy" | "unknown" | "ten-pages" = "healthy", dropAfterApplied = false;
let historyReads = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input)), method = init?.method ?? "GET";
  requests.push({ method, key: new Headers(init?.headers).get("Idempotency-Key"), bytes: Buffer.byteLength(String(init?.body ?? "")) });
  if (!url.pathname.endsWith("/balance_transactions")) throw new Error("Unexpected synthetic provider path");
  if (method === "GET") {
    historyReads++;
    if (historyMode === "unknown") return new Response(JSON.stringify({ object: "list", data: null, has_more: false }));
    if (historyMode === "ten-pages") return new Response(JSON.stringify({ object: "list", data: [{ id: `cbtxn_page${historyReads}`, amount: 0, metadata: null }], has_more: true }));
    return new Response(JSON.stringify({ object: "list", data: txns, has_more: false }));
  }
  if (method !== "POST") throw new Error("Unexpected provider method");
  const form = new URLSearchParams(String(init?.body ?? ""));
  const txn = { id: `cbtxn_z${txns.length}`, amount: Number(form.get("amount")), metadata: { nimbus_invite_credit: form.get("metadata[nimbus_invite_credit]") ?? "" } };
  // Apply first. Deliberately no provider idempotency enforcement: recovery must find real metadata history.
  txns.push(txn);
  if (dropAfterApplied) { dropAfterApplied = false; throw new Error("Response lost after synthetic provider applied the credit"); }
  return new Response(JSON.stringify(txn));
}) as typeof fetch;
const state = (id: string) => JSON.parse(String(redis.run(["GET", creditKey(id)]))) as Credit;
const owed = (id: string) => redis.run(["SISMEMBER", OWED_KEY, id]);
async function run(fault?: (commands: Commands, replies: unknown[]) => unknown) {
  const before = requests.length, trace: Commands[] = [];
  redis.pipeline = (async (commands: Commands) => {
    trace.push(commands);
    // Acknowledgments may be changed only after real commands, except the explicitly modeled write transport failure.
    if (failDone && commands.some(c => c[0] === "SET" && String(c[1]).startsWith("nl:ref:c:") && String(c[2]).includes('"state":"done"'))) {
      failDone = false; throw new Error("Done persistence transport failed before dispatch");
    }
    const replies = await real(commands);
    return fault ? fault(commands, replies) : replies;
  }) as typeof redis.pipeline;
  const oldError = console.error; console.error = () => {};
  try {
    const counts = await settleInvites(Date.now() + 60_000, now);
    return { counts, requests: requests.slice(before), commands: trace.flat().length, commandBytes: trace.reduce((n,c) => n + Buffer.byteLength(JSON.stringify(c)), 0) };
  } finally { redis.pipeline = real; console.error = oldError; }
}
let failDone = false;
async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_only_no_network";
  redis.clear();
  const made = await claimHandle("z-owner@example.com", "z-owner", "Synthetic owner", "");
  if (!made.ok) throw new Error("Synthetic store not created");
  await setSubscription("z-owner@example.com", { customerId: "cus_Zowner01", subscriptionId: "sub_Zowner01", active: true, period: paidPeriod() });
  const sid = made.store.sid;
  const ref = String(redis.run(["GET", `nl:store:id:${sid}`]));
  // Discover exact owner key from real store reader's observed command, not a guessed hash.
  let ownerKey = "";
  redis.pipeline = (async (commands: Commands) => { const replies = await real(commands); for (let i = 0; i < commands.length; i++) if (commands[i][0] === "GET" && typeof replies[i] === "string" && String(replies[i]).includes('"sid":"' + sid + '"')) ownerKey = String(commands[i][1]); return replies; }) as typeof redis.pipeline;
  const { storeForIdExactly } = await import("@/lib/store-exact");
  await storeForIdExactly(sid); redis.pipeline = real;
  if (!ownerKey || !ref) throw new Error("No actual owner key observed");
  const owe = (id: string) => { const c: Credit = { id, kind: "bonus", to: sid, from: sid, cents: 700, cur: "usd", at: Math.floor(now / 1000) - 60 * 86_400, state: "owed" }; redis.run(["SET", creditKey(id), JSON.stringify(c)]); redis.run(["SADD", OWED_KEY, id]); };

  part("Healthy id reference plus unreadable real owner record retains actual owed credit");
  for (const [i, malformed] of [[], [null], [1], ["{bad"], [null, null]].entries()) {
    const id = `bonus_zowner${i}`; owe(id);
    const out = await run((commands, replies) => commands.some(c => c[0] === "GET" && c[1] === ownerKey) ? malformed : replies);
    is(`owner ${i}: unavailable, incomplete, no Stripe request`, [out.counts.failed, out.counts.complete, out.requests.length], [1, false, 0]);
    is(`owner ${i}: actual owed record and membership retained`, [state(id).state, owed(id)], ["owed", 1]);
    console.log("Z_OWNER_VOLUME", JSON.stringify({ i, commands: out.commands, commandBytes: out.commandBytes, retainedCents: state(id).state === "owed" ? state(id).cents : 0 }));
    // Each vector is independent; remove fixture before the next vector without changing the product oracle.
    redis.run(["SREM", OWED_KEY, id]); redis.run(["DEL", creditKey(id)]);
  }

  part("Applied credit plus lost local done write recovers from actual provider metadata, without provider deduplication");
  owe("bonus_zlostwrite"); failDone = true;
  const failedWrite = await run();
  is("local write failure retains owed after one applied 700-cent credit", [failedWrite.counts.failed, state("bonus_zlostwrite").state, owed("bonus_zlostwrite"), txns.map(t => t.amount)], [1, "owed", 1, [-700]]);
  const healedWrite = await run();
  is("next run finds metadata and finishes without a second POST", [healedWrite.counts.added, state("bonus_zlostwrite").state, owed("bonus_zlostwrite"), healedWrite.requests.filter(r => r.method === "POST").length, txns.length], [1, "done", 0, 0, 1]);
  is("actual outgoing idempotency header names the credit", failedWrite.requests.find(r => r.method === "POST")?.key, "nimbus-invite-bonus_zlostwrite");

  part("Provider response lost after applying the credit has the same recovery");
  owe("bonus_zlostresponse"); dropAfterApplied = true;
  const lost = await run();
  is("network failure preserves owed after provider application", [lost.counts.failed, state("bonus_zlostresponse").state, owed("bonus_zlostresponse"), txns.length], [1, "owed", 1, 2]);
  const healedResponse = await run();
  is("history closes credit once, with no new POST", [healedResponse.counts.added, state("bonus_zlostresponse").state, healedResponse.requests.filter(r => r.method === "POST").length, txns.length], [1, "done", 0, 2]);

  part("Unknown and bounded incomplete history never authorize payment");
  owe("bonus_zunknownhistory"); historyMode = "unknown";
  const unknown = await run();
  is("unknown list remains owed and incomplete with no POST", [unknown.counts.failed, unknown.counts.complete, state("bonus_zunknownhistory").state, unknown.requests.filter(r => r.method === "POST").length], [1, false, "owed", 0]);
  historyMode = "ten-pages"; historyReads = 0;
  const long = await run();
  is("history bound is ten requests, never payment or completion", [historyReads, long.counts.failed, long.counts.complete, long.requests.filter(r => r.method === "POST").length, owed("bonus_zunknownhistory")], [10, 1, false, 0, 1]);
  historyMode = "healthy";
  const healedHistory = await run();
  is("healthy history pays the pending credit once", [healedHistory.counts.added, state("bonus_zunknownhistory").state, txns.map(t => t.amount)], [1, "done", [-700, -700, -700]]);
  const again = await run();
  is("later run makes no request and pays nothing more", [again.requests.length, txns.length], [0, 3]);
  console.log("Z_PROVIDER_VOLUME", JSON.stringify({ requests: requests.length, posts: requests.filter(r => r.method === "POST").length, formBodyBytes: requests.reduce((n,r) => n+r.bytes,0), creditedCents: txns.reduce((n,t) => n-t.amount,0) }));
  done();
}
void main();
