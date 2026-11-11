/**
 * A non-null removal record with no passkey in it is unknown, never "no removal" (lib/passkeys.ts readDrop; #2874,
 * finding by Codex D2 on e46c69c5, proof codex/d-review-2874-passkey-drop@5b87461a tests/d2-2874.proof.ts, kept here
 * unchanged as the permanent regression).
 *
 * writeDrop DELs an empty record and never stores one, so only a GET that answers null means nothing waits. A record
 * such as {atOf:{},told:0}, or an old {ids:[],at,told}, is not one this code wrote: read as "nothing waits", a passkey
 * whose removal is due would sign in (200 and a session cookie). Real P-256 verification, the local sign-in POST and
 * the in-memory Redis; all provider fetches synthetic. Ceilings are installed before any fixture setup or request.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { PASSKEY_COOKIE, listPasskeys } from "@/lib/passkeys";
import { POST } from "@/app/api/auth/passkey/signin/route";
import { makePasskey } from "./passkey-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const original = redis.pipeline.bind(redis);
const COMMAND_CEILING = 5_000, FETCH_CEILING = 20;
let commandsUsed = 0, syntheticFetches = 0;
let injected: { key: string; raw: string } | null = null;
redis.pipeline = async commands => {
  if (commandsUsed + commands.length > COMMAND_CEILING) throw new Error("D2 synthetic command ceiling exceeded");
  commandsUsed += commands.length;
  if (injected && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === injected.key) return [injected.raw];
  return original(commands);
};
globalThis.fetch = async () => {
  if (++syntheticFetches > FETCH_CEILING) throw new Error("D2 synthetic fetch ceiling exceeded");
  return new Response("{}", { status: 404 });
};
const origin = "https://marktmorgen.com";
const dropKey = (email: string) => "nl:pk:drop:" + createHash("sha256").update("nimbus-passkey-drop:" + email).digest("hex").slice(0, 40);
const hasSession = (response: Response) => new RegExp(SESSION_COOKIE + "=[^;]+").test(response.headers.get("set-cookie") ?? "");
async function request(key: ReturnType<typeof makePasskey>): Promise<Response> {
  const options = await POST(new NextRequest(origin + "/api/auth/passkey/signin", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.8" },
    body: JSON.stringify({ action: "options" }),
  }));
  const nonce = (options.headers.get("set-cookie") ?? "").match(new RegExp(PASSKEY_COOKIE + "=([^;]*)"))?.[1] ?? "";
  const { challenge } = (await options.json() as { options: { challenge: string } }).options;
  return POST(new NextRequest(origin + "/api/auth/passkey/signin", {
    method: "POST", headers: { "content-type": "application/json", cookie: PASSKEY_COOKIE + "=" + nonce, "x-forwarded-for": "198.51.100.8" },
    body: JSON.stringify({ action: "verify", response: key.answer(challenge) }),
  }));
}
async function setup(email: string) {
  const key = makePasskey(email, "lost-" + email), kept = makePasskey(email, "kept-" + email);
  await key.keep(); await kept.keep();
  const raw = JSON.stringify({ atOf: { ["lost-" + email]: Date.now() - 3_600_000 }, told: Date.now() - 8 * 86_400_000 });
  await redis.pipeline([["SET", dropKey(email), raw]]);
  return { key, raw };
}
async function main(): Promise<void> {
  redis.clear();
  part("Healthy local-route controls");
  const plain = makePasskey("plain-d2@example.com", "plain-d2-key"); await plain.keep();
  const accepted = await request(plain);
  is("no removal: successful sign-in with its actual session cookie", [accepted.status, hasSession(accepted)], [200, true]);
  const due = await setup("due-d2@example.com");
  const refused = await request(due.key);
  is("actual due removal: refused with no session cookie", [refused.status, hasSession(refused)], [401, false]);

  part("Non-null removal records the writer never stores must not mean no removal");
  const vectors: [string, (email: string) => unknown][] = [
    ["empty modern map", () => ({ atOf: {}, told: 0 })],
    ["empty legacy ids", () => ({ ids: [], at: Date.now() - 3_600_000, told: 0 })],
    ["empty modern map with a contradictory legacy target", email => ({ atOf: {}, ids: ["lost-" + email], at: Date.now() - 3_600_000, told: 0 })],
  ];
  for (const [label, body] of vectors) {
    const email = "empty-d2-" + label.replace(/[^a-z]/g, "-") + "@example.com";
    const { key, raw } = await setup(email);
    injected = { key: dropKey(email), raw: JSON.stringify(body(email)) };
    const response = await request(key);
    injected = null;
    console.log(JSON.stringify({ label, observedStatus: response.status, sessionCookie: hasSession(response) }));
    is(label + ": unknown refuses before giving a session", [response.status, hasSession(response)], [503, false]);
    is(label + ": genuine due request stays byte-identical", await original([["GET", dropKey(email)]]), [raw]);
    const retried = await request(key);
    is(label + ": a sound read applies removal and refuses the same key", [retried.status, hasSession(retried), (await listPasskeys(email)).some(p => p.id === "lost-" + email)], [401, false, false]);
  }
  console.log(JSON.stringify({ commandsUsed, commandCeiling: COMMAND_CEILING, syntheticFetches, fetchCeiling: FETCH_CEILING }));
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
