/**
 * Claude 5 iZByNH's LEVE 1 on #5476 (7115106748): a team host's connection was listed in its account's index (SADD
 * h:<host>) before it was kept (setIfHeld). When the lock was lost while saving, the keep threw with the member still
 * listed and no connection behind it: the new grant was neither kept nor given back (grantStillUsed saw the member),
 * and every later store disconnect of that account kept the grant and said a team calendar still used it.
 *
 * The host's connection is now kept and listed in one step, only while the lock is ours (KEEP_HOST), as a store's is:
 * a lost lock writes neither, and the grant this flow was holding goes back when nothing here uses that account.
 *
 * Synthetic only: fetch is a stand-in for Google, every token is made up here, no provider is reached.
 */
import { createHash } from "node:crypto";
import { finishConsent } from "@/lib/meet-connect";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-for-tests";
process.env.GOOGLE_API_BASE = "http://127.0.0.1:9";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const SID = "s0000000000000000-hostkeep1";
const HOST = "0123456789abcdef0123cafe";
const EMAIL = "host-keep@example.test";
const SUB = `sub-${EMAIL}`;

function idToken(email: string): string {
  const part64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part64({ alg: "none" })}.${part64({ iss: "https://accounts.google.com", aud: "client-id.apps.googleusercontent.com", exp: Math.floor(Date.now() / 1000) + 3600, sub: `sub-${email}`, email, email_verified: true })}.sig`;
}

const revoked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.pathname === "/google/token") {
    return answer({ access_token: "at-synthetic", refresh_token: "rt-synthetic", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/calendar.events", id_token: idToken(EMAIL) });
  }
  if (url.pathname === "/google/revoke") {
    revoked.push(new URLSearchParams(String(init?.body ?? "")).get("token") ?? "");
    return answer({});
  }
  return answer({ error: "not in this test" }, 404);
}) as typeof fetch;

const userKey = `nl:meet:user:google:${createHash("sha256").update(`meet-user:google:${SUB}`).digest("hex").slice(0, 40)}`;
const connKey = `nl:meet:conn:hosts:google:h:${HOST}`;
const original = redis.pipeline.bind(redis);
/** The connection's write, fenced by the lock: the lock is taken away just before it runs. */
const writesConnection = (c: (string | number)[]) =>
  c[0] === "EVAL" && (String(c[1]).startsWith("-- marktmorgen:fenced-set:") || String(c[1]).startsWith("-- marktmorgen:meet-keep-host:")) && c[4] === connKey;

async function connect(loseLock: boolean): Promise<string> {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const fenced = loseLock ? commands.find(writesConnection) : undefined;
    if (fenced) await original([["DEL", String(fenced[3])]]);
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    const result = await finishConsent("google", { statsId: SID, code: "code", verifier: "v".repeat(43), by: EMAIL, owner: { email: "owner@example.test", handle: "fixture" }, host: HOST, startedAt: Date.now() });
    return result.ok ? "kept" : `refused ${result.error}`;
  } catch (error) {
    return (error as Error).name;
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  console.error = () => {};
  part("control: a host's keep with the lock held keeps and lists it");
  redis.clear();
  is("the keep answers kept", await connect(false), "kept");
  is("the connection is kept", typeof (await original([["GET", connKey]]))[0], "string");
  is("and the host is listed under its account", (await original([["SMEMBERS", userKey]]))[0], [`h:${HOST}`]);

  part("a host's keep that loses the lock while saving lists nothing and keeps nothing");
  redis.clear();
  revoked.length = 0;
  is("the keep fails as a lost lock", await connect(true), "LockBusyError");
  is("no connection is kept", (await original([["GET", connKey]]))[0], null);
  is("the host is not left in its account's index", (await original([["SCARD", userKey]]))[0], 0);
  is("and the grant this flow held goes back, nothing here using that account", revoked, ["rt-synthetic"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
