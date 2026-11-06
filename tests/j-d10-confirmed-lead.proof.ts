/** D10 evidence: actual signup routes, statistics writer and Path reader.
 * Only canonical MemoryRedis, Next after-task scheduling and provider HTTP are synthetic.
 * No fs:* field is inserted by this proof. Opt-in RED; never default-suite discovered.
 */
import { createHash } from "node:crypto";
import { POST as requestJoin } from "@/app/api/store/join/route";
import { POST as confirmRoute } from "@/app/api/store/join/confirm/route";
import { NextRequest, afterTasks } from "./next-server-after-world";
import { claimHandle, ensureListId, ensureStatsId, setJoin, setSubscription, storeForEmail } from "@/lib/store";
import { readPathFacts } from "@/lib/path-facts";
import { readJoinToken } from "@/lib/store-join";
import { leadsKey, parseContact } from "@/lib/contacts";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string | string[]; subject: string; text: string };
const sent: Sent[] = [];
let outside = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin === "https://api.resend.com" && url.pathname === "/emails" && init?.method === "POST") {
    sent.push(JSON.parse(String(init.body)) as Sent);
    return Response.json({ id: "synthetic_d10_email" });
  }
  outside++;
  throw new Error("D10 proof forbids unexpected external requests");
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
function request(path: string, body: Record<string, string>): NextRequest {
  return new NextRequest(ORIGIN + path, { method: "POST", headers: {
    origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin",
    "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "192.0.2.20", "user-agent": "Mozilla/5.0 D10 Synthetic Browser",
  }, body: new URLSearchParams(body) });
}
async function drain() {
  while (afterTasks.length) {
    const task = afterTasks.shift();
    if (typeof task !== "function") throw new Error("Unexpected after task shape");
    await task();
  }
}
const status = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("status") ?? "no_grant";
const mailToken = () => sent.at(-1)?.text.match(/join\?token=([0-9a-f]{48})/)?.[1] ?? "";
const tokenKey = (token: string) => "nl:join:t:" + createHash("sha256").update("nimbus-join:" + token).digest("hex");

async function main() {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_join_only";
  delete process.env.STRIPE_SECRET_KEY;
  const owner = "j-dten@example.com", email = "dana@example.com", handle = "j-dten";
  await claimHandle(owner, handle, "D10 Synthetic Store", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_JDten000001", subscriptionId: "sub_JDten000001", active: true, tier: "creator", cycle: "month", trialEnds: 0, period: paidPeriod() });
  await setJoin(owner, { on: true, heading: "Updates", line: "Confirm to join." });
  const store = (await storeForEmail(owner))!;
  const facts = () => readPathFacts(store, null);
  const listed = () => parseContact(redis.run(["HGET", leadsKey(store.listId!), email]));
  const signup = async (body: Record<string, string>) => {
    const response = await requestJoin(request("/api/store/join", { handle, email, ...body }));
    await drain();
    return response;
  };
  const confirm = async (token: string) => {
    const response = await confirmRoute(request("/api/store/join/confirm", { token }));
    await drain();
    return response;
  };

  part("Controls before any real route writer");
  is("initial Path has no lead", (await facts()).leads, 0);
  is("honeypot gives neutral answer", status(await signup({ website: "bot" })), "sent");
  is("honeypot sends nothing and counts nothing", [sent.length, (await facts()).leads], [0, 0]);
  is("invalid email is refused", status(await signup({ email: "bad@" })), "email");
  is("refused input sends nothing and counts nothing", [sent.length, (await facts()).leads], [0, 0]);

  part("Accepted email, with no confirmation-link use");
  const first = await signup({});
  const token = mailToken();
  is("actual POST accepted synthetic provider email", [first.status, status(first), sent.length, Boolean(token)], [303, "sent", 1, true]);
  is("saved token belongs to the address; contact remains absent", [(await readJoinToken(token))?.e, listed()], [email, null]);
  is("reading the link grant alone does not add a contact", listed(), null);
  const beforeConfirmation = (await facts()).leads;
  console.log(JSON.stringify({ observation: "accepted_without_confirmation", pathLeads: beforeConfirmation, confirmedContact: listed() !== null }));
  is("D10: accepted email alone must leave Path leads at zero", beforeConfirmation, 0);

  part("A resent confirmation still represents one unconfirmed address");
  is("second actual POST accepts another confirmation", status(await signup({})), "sent");
  const rotated = mailToken();
  is("resend has its own valid token", [rotated !== token, Boolean(await readJoinToken(rotated))], [true, true]);
  is("neither token has added a contact", listed(), null);
  is("D10: resending cannot create confirmed Path leads", (await facts()).leads, 0);

  part("Actual confirmation route and repeat controls");
  is("invalid token is rejected", status(await confirm("0".repeat(48))), "no_grant");
  is("valid token confirms", status(await confirm(token)), "joined");
  is("contact now has explicit agreement", listed()?.agreed, true);
  is("consumed token cannot be reused", [await readJoinToken(token), status(await confirm(token))], [null, "no_grant"]);
  is("D10: one confirmed address contributes one Path lead", (await facts()).leads, 1);
  const afterFirst = (await facts()).leads;
  is("second valid token confirms same existing address", status(await confirm(rotated)), "joined");
  is("confirming same address again does not increase the existing count", (await facts()).leads, afterFirst);

  part("Unknown token read never certifies a confirmation");
  await signup({ email: "unknown@example.com" });
  const unknownToken = mailToken(), key = tokenKey(unknownToken), realPipeline = redis.pipeline.bind(redis);
  const beforeUnknown = (await facts()).leads;
  let injected = 0;
  redis.pipeline = (async commands => {
    if (commands.some(c => c[0] === "GET" && c[1] === key)) { injected++; return []; }
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  try {
    is("unknown token evidence refuses the real confirmation route", status(await confirm(unknownToken)), "no_grant");
  } finally { redis.pipeline = realPipeline; }
  is("unknown reply was exercised", injected > 0, true);
  is("unknown confirmation does not increase the existing Path count", (await facts()).leads, beforeUnknown);
  is("unknown address remains absent", parseContact(redis.run(["HGET", leadsKey(store.listId!), "unknown@example.com"])), null);
  is("every attempted provider HTTP request was intercepted", outside, 0);
  console.log(JSON.stringify({ actualRoutes: ["join.POST", "join.confirm.POST"], writer: "countHit -> recordHit", reader: "readPathFacts", providerPosts: sent.length, outsideRequests: outside, redis: "canonical MemoryRedis; isolated process" }));
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
