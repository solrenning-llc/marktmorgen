/** Independent bounded H2 review of #3049: real routes/store/session and
 * MemoryRedis, strictly synthetic Stripe. No customer or live account. */
import { NextRequest } from "next/server";
import { GET } from "@/app/api/stripe/return/route";
import { POST } from "@/app/api/stripe/check/route";
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { is, done } from "./check";

const EMAIL = "h2-stripe@example.test", ACCOUNT = "acct_H2Written";
let http = 0, active = true, rejectProvider = false, checks = 0;
const check = (label: string, got: unknown, expected: unknown) => {
  if (++checks > 500) throw Error("assertion ceiling");
  is(label, got, expected);
};
globalThis.fetch = (async (input: string | URL | Request) => {
  if (++http > 50) throw Error("HTTP ceiling");
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.stripe.com" || url.pathname !== `/v2/core/accounts/${ACCOUNT}`) throw Error("unexpected synthetic request");
  if (rejectProvider) return Response.json({ error: { code: "synthetic_unavailable" } }, { status: 503 });
  return Response.json({ id: ACCOUNT, configuration: { merchant: { capabilities: { card_payments: { status: active ? "active" : "inactive" } } } }, requirements: { summary: {} } });
}) as typeof fetch;

async function main() {
  const original = redis.pipeline;
  const word = (r: Response) => new URL(r.headers.get("location") ?? "", "https://example.test").searchParams.get("stripe");
  for (const route of ["return", "check"] as const) {
    redis.clear();
    process.env.STRIPE_SECRET_KEY = "sk_test_h2_written_only";
    check(`${route}: fixture created`, (await claimHandle(EMAIL, "h2written", "Synthetic", "")).ok, true);
    const token = await openSession(EMAIL), cookie = `${SESSION_COOKIE}=${token}`;
    const call = (signed = true, origin = "https://example.test") => {
      const req = new NextRequest(`https://example.test/api/stripe/${route}`, { method: route === "check" ? "POST" : "GET", headers: { ...(signed ? { cookie } : {}), origin, host: "example.test" } });
      return route === "check" ? POST(req) : GET(req);
    };
    let before = http;
    const out = await call(false);
    check(`${route}: signed out stays outside Stripe`, [new URL(out.headers.get("location")!).pathname, http - before], ["/signin", 0]);
    before = http;
    check(`${route}: missing account does not ask Stripe`, [word(await call()), http - before], ["notstarted", 0]);
    check(`${route}: seed`, (await setStripeAccount(EMAIL, ACCOUNT, false)).ok, true);
    process.env.STRIPE_SECRET_KEY = "";
    before = http;
    check(`${route}: no configuration does not ask Stripe`, [word(await call()), http - before], ["unavailable", 0]);
    process.env.STRIPE_SECRET_KEY = "sk_test_h2_written_only";
    if (route === "check") {
      before = http;
      check("check: foreign Origin refused before provider", [(await call(true, "https://foreign.example.test")).status, http - before], [403, 0]);
    }
    for (const enabled of [true, false]) {
      active = enabled;
      check(`${route}/${enabled}: seed opposite value`, (await setStripeAccount(EMAIL, ACCOUNT, !enabled)).ok, true);
      before = http;
      check(`${route}/${enabled}: real commit matches response`, [word(await call()), (await storeForEmail(EMAIL))?.stripeChargesEnabled, http - before], [enabled ? "ready" : "pending", enabled, 1]);
      rejectProvider = true;
      check(`${route}/${enabled}: provider exception does not change record`, [word(await call()), (await storeForEmail(EMAIL))?.stripeChargesEnabled], ["error", enabled]);
      rejectProvider = false;
      let armed = false;
      redis.pipeline = async commands => {
        if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:store:lock:") && commands[0].includes("NX")) armed = true;
        if (armed && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:store:owner:")) throw Error("synthetic write-read failure");
        return original(commands);
      };
      let response: Response;
      try { response = await call(); } finally { redis.pipeline = original; }
      check(`${route}/${enabled}: thrown persistence read is not success`, [word(response), (await storeForEmail(EMAIL))?.stripeChargesEnabled], ["error", enabled]);
    }
  }
  console.log(JSON.stringify({ checks, http, scope: "actual routes; synthetic provider and MemoryRedis" }));
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
