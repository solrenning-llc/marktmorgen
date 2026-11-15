/**
 * Issue #4753 (MEDIUM, money; Codex L, transcribed by Claude 2), RED before the fix: the creator's decision on
 * affiliate leads (decideLeads: approve, reverse, reopen) sent one HSET per lead and ignored every reply, so a write
 * that did not land, or whose answer came back in another shape, was answered { ok: true, changed: n }: the studio
 * told the creator a commission was approved, or a fake lead reversed, while the money record was unchanged, and a
 * lost reversal left the commission payable. Now each HSET has exactly one reply of its own, the integer 0 or 1, or
 * the decision throws UnknownReplyError (the route answers 503 "unavailable") and is never reported as made. Controls:
 * a healthy reverse and reopen. Synthetic only: the in-memory Redis double, through lib/affiliate-leads.ts and the
 * real route app/api/store/affiliates/route.ts.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { type LeadRecord, leadsKey } from "@/lib/affiliate-lead-rules";
import { decideLeads } from "@/lib/affiliate-leads";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** How the next lead write is answered: as Redis does, or in another shape with nothing written. */
let answer: "real" | "missing" | "null" | "text" | "short" | "two" = "real";
redis.pipeline = (async (commands: (string | number)[][]) => {
  const writes = commands.length > 0 && commands.every((c) => c[0] === "HSET" && /^nl:aff:[^:]+:leads$/.test(String(c[1])));
  if (!writes || answer === "real") return real(commands);
  if (answer === "missing") return [];
  if (answer === "null") return commands.map(() => null);
  if (answer === "text") return commands.map(() => "OK");
  if (answer === "two") return commands.map(() => 2);
  return commands.slice(1).map(() => 1);
}) as typeof redis.pipeline;

const NOW = Math.floor(Date.now() / 1000);
const OLD = ((at: Date) => Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 2, 2, 12) / 1000)(new Date(NOW * 1000));
const id = (n: number) => n.toString(16).padStart(24, "0");
const lead = (n: number, over: Partial<LeadRecord> = {}): LeadRecord => ({
  id: id(n),
  aff: "aaaaaaaaaaaa",
  kind: "signup",
  at: OLD + n,
  end: 0,
  ref: "",
  pi: "",
  paid: 0,
  title: "",
  email: `p${n}@example.com`,
  cents: 500,
  currency: "usd",
  hold: 7,
  daily: 10,
  budget: 1_000,
  state: "open",
  d: 0,
  why: "",
  ...over,
});

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    return `returned ${JSON.stringify(await run())}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "threw" : `other: ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "lead-replies@example.com";
  await claimHandle(OWNER, "leadreplies", "Lead Replies", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, `acct_1${"leadreplies".padEnd(15, "x")}`, true);
  await setSubscription(OWNER, { customerId: "cus_leadreplies", subscriptionId: "sub_leadreplies", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const key = leadsKey(store.statsId as string);
  const session = await openSession(OWNER);
  const put = async (leads: LeadRecord[]) => {
    await real([["DEL", key]]);
    await real([["HSET", key, ...leads.flatMap((l) => [l.id, JSON.stringify(l)])]]);
  };
  const stateOf = async (n: number) => (JSON.parse(String((await real([["HGET", key, id(n)]]))[0])) as LeadRecord).state;

  part("A decision whose HSET reply is not one 0 or 1 of its own is never reported as made");
  for (const shape of ["missing", "null", "text", "short", "two"] as const) {
    await put([lead(1), lead(2)]);
    answer = shape;
    const result = await outcome(() => decideLeads(store, [id(1), id(2)], "reverse", "fake"));
    answer = "real";
    is(`reverse, the writes answered ${shape}: unknown, never "changed"`, result, "threw");
  }

  part("Through the studio's route, an unknown write is 503 unavailable, never ok");
  await put([lead(3)]);
  answer = "null";
  const response = await affiliatesRoute(
    new NextRequest("https://marktmorgen.com/api/store/affiliates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ action: "leads", ids: [id(3)], decision: "reverse", why: "fake" }),
    }),
  );
  answer = "real";
  const body = (await response.json()) as { ok?: boolean };
  is("the route's answer is not ok", [response.status, body.ok === true], [503, false]);

  part("Controls: a healthy reverse and reopen");
  await put([lead(4)]);
  is("reverse saved", await decideLeads(store, [id(4)], "reverse", "fake"), { ok: true, changed: 1 });
  is("its state is reversed", await stateOf(4), "reversed");
  is("reopen saved", await decideLeads(store, [id(4)], "reopen"), { ok: true, changed: 1 });
  is("its state is open again", await stateOf(4), "open");
  done();
}

void main();
