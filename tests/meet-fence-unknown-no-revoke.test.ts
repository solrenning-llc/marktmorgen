/**
 * A team host's own Google connection is kept by a fenced write (lib/meet-connect.ts keepConnection, host path,
 * through lib/redis-lock.ts). When that write's acknowledgement cannot be read (a reply in another shape, or the
 * request lost after it reached Redis), the script may already have stored the new grant. That is unknown, not
 * "the lock was somebody else's": finishConsent must not give the grant back to Google, or the connection Redis
 * now holds would point at a revoked grant (#5285 row #3173, Claude 5's LOW).
 *
 * Control: when the lock really was taken by somebody else before the write, nothing is written, the answer is
 * still "busy" and the new grant is still given back, as before.
 *
 * Synthetic store and Redis (tests/redis-stub.ts); Google is a stand-in answering on GOOGLE_API_BASE.
 */
import { finishConsent } from "@/lib/meet-connect";
import { redisPipeline } from "@/lib/redis";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-for-tests";
process.env.GOOGLE_API_BASE = "http://127.0.0.1:9";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "meet-fence-owner@example.com";
const HOST = "b".repeat(24);
const FENCED_SET = "-- marktmorgen:fenced-set:v1\n";

function idToken(email: string): string {
  const part64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part64({ alg: "none" })}.${part64({ iss: "https://accounts.google.com", aud: "client-id.apps.googleusercontent.com", exp: Math.floor(Date.now() / 1000) + 3600, sub: `sub-${email}`, email, email_verified: true })}.sig`;
}

/** The tokens given back to Google. */
let revoked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const body = new URLSearchParams(String(init?.body ?? ""));
  if (url.pathname === "/google/token") {
    const code = body.get("code") ?? "unknown@example.com";
    return answer({ access_token: `at-${code}`, refresh_token: `rt-${code}`, expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/calendar.events", id_token: idToken(code) });
  }
  if (url.pathname === "/google/revoke") {
    revoked.push(body.get("token") ?? url.searchParams.get("token") ?? "");
    return answer({});
  }
  return answer({ error: "not in this test" }, 404);
}) as typeof fetch;

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);
const isFencedSet = (command: (string | number)[]) => command[0] === "EVAL" && String(command[1]).startsWith(FENCED_SET);

/** Every pipeline that carries the host's fenced write goes through `around`; every other one is real. */
function aroundFencedSet(around: (commands: Commands) => Promise<unknown>): void {
  redis.pipeline = (async (commands: Commands) => (commands.some(isFencedSet) ? around(commands) : original(commands))) as typeof redis.pipeline;
}

/** What finishConsent ended with: its result, or the name of what it threw. */
async function connect(statsId: string, handle: string, code: string): Promise<string> {
  try {
    const result = await finishConsent("google", { statsId, code, verifier: "v".repeat(43), by: OWNER, owner: { email: OWNER, handle }, host: HOST, startedAt: Date.now() });
    return result.ok ? "ok" : `refused: ${result.error}`;
  } catch (error) {
    return `threw ${(error as Error).name}: ${(error as Error).message}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle(OWNER, "meet-fence-shop", "Meet Fence Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_MeetFence001", subscriptionId: "sub_MeetFence001", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId as string;
  const hostKey = `nl:meet:conn:hosts:google:h:${HOST}`;
  const keptAccount = async () => {
    const raw = (await redisPipeline([["GET", hostKey]]))[0];
    return typeof raw === "string" ? (JSON.parse(raw) as { account: { email: string } }).account.email : null;
  };

  part("Control: a healthy host connection is kept and nothing is given back");
  revoked = [];
  is("connected", await connect(statsId, store.handle, "first@example.com"), "ok");
  is("kept", await keptAccount(), "first@example.com");
  is("nothing given back", revoked, []);

  const unreadable: [string, (replies: unknown[]) => unknown][] = [
    ["a reply that is text, not 1 or 0", () => ["x"]],
    ["a missing slot", () => [undefined]],
    ["no reply at all (an empty list)", () => []],
    ["a lost answer (the request threw after Redis ran it)", () => {
      throw new Error("socket hang up");
    }],
  ];
  for (const [label, shape] of unreadable) {
    part(`The fenced write ran, then its acknowledgement was ${label}`);
    revoked = [];
    let applied = false;
    const code = `new-${label.length}@example.com`;
    aroundFencedSet(async (commands) => {
      const replies = await original(commands);
      applied = replies[0] === 1;
      return shape(replies);
    });
    const said = await connect(statsId, store.handle, code);
    redis.pipeline = original as typeof redis.pipeline;
    is(`${label}: the write really landed in Redis`, [applied, await keptAccount()], [true, code]);
    is(`${label}: unknown, never "busy"`, said.startsWith("threw UnknownReplyError"), true);
    is(`${label}: the grant Redis may hold is not given back`, revoked, []);
  }

  part("Control: the lock was really taken by somebody else before the write");
  revoked = [];
  aroundFencedSet(async (commands) => {
    const lock = String(commands[0][3]);
    await original([["SET", lock, "somebody-else"]]);
    return original(commands);
  });
  const said = await connect(statsId, store.handle, "late@example.com");
  redis.pipeline = original as typeof redis.pipeline;
  is("busy, as before", said, "threw LockBusyError: the connection changed while it was saved");
  is("nothing written over the connection kept before", (await keptAccount()) !== "late@example.com", true);
  is("the new grant is given back", revoked, ["rt-late@example.com"]);

  done();
}

void main();
