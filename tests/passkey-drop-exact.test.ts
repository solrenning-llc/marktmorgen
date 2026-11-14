/**
 * The passkey removal record read exactly (lib/passkeys.ts readDrop; CX-123 rules 24 and 30; sweep A5, finding 1).
 *
 * A passkey the owner set to be removed, whose wait has run out, never logs in. When the GET of the removal record
 * answers in a shape this code never wrote (a number, an object, no reply, text that is not JSON, a record whose
 * moments are not numbers), what it says is unknown: never "no removal was asked". signInWith refuses the passkey
 * with UnknownReplyError (the sign-in route answers an honest temporary error and opens no session), and the due
 * removal is neither applied nor called off: the record stays as it was, and the next read that comes back whole
 * applies it. listPasskeys beside it is read the same way (lot L10b). Synthetic records only; no network.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { PASSKEY_COOKIE, listPasskeys, pendingNow, pendingRemoval, signInOptions, signInWith } from "@/lib/passkeys";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as passkeySignIn } from "@/app/api/auth/passkey/signin/route";
import { makePasskey } from "./passkey-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
const ORIGIN = "https://marktmorgen.com";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const dropKey = (email: string) => `nl:pk:drop:${sha(`nimbus-passkey-drop:${email}`).slice(0, 40)}`;
const original = redis.pipeline.bind(redis);

async function login(key: ReturnType<typeof makePasskey>) {
  const { options, nonce } = await signInOptions();
  return signInWith(nonce, key.answer(options.challenge) as AuthenticationResponseJSON);
}
/** What a call came to: its answer, "unknown" when it threw UnknownReplyError, or the other error's text. */
async function outcome<T>(work: () => Promise<T>): Promise<T | string> {
  try {
    return await work();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : String(error);
  }
}
async function stored(email: string): Promise<unknown> {
  return (await original([["GET", dropKey(email)]]))[0];
}
/** Two passkeys; `lost` is set to be removed at `at` (an hour ago unless said otherwise). */
async function setUp(email: string, at = Date.now() - 3_600_000) {
  const lost = makePasskey(email, `lost-${email}`);
  const kept = makePasskey(email, `kept-${email}`);
  await lost.keep();
  await kept.keep();
  await redis.pipeline([["SET", dropKey(email), JSON.stringify({ atOf: { [`lost-${email}`]: at }, told: Date.now() - 8 * 86_400_000 })]]);
  return { lost, kept };
}
/** The GET of this account's removal record answers `reply` (undefined: no reply at all); every other read is real. */
function dropAnswers(email: string, reply: unknown) {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === dropKey(email)) return reply === undefined ? [] : [reply];
    return original(commands);
  }) as typeof redis.pipeline;
}
const ids = async (email: string) => (await listPasskeys(email)).map((p) => p.id);

async function main() {
  redis.clear();

  part("Healthy control: a passkey with no removal asked logs in");
  {
    const email = "plain@example.com";
    const key = makePasskey(email, "plain-key");
    await key.keep();
    const signed = await login(key);
    is("logs in, not set to go", [signed?.email, signed?.doomed], [email, false]);
  }

  part("Healthy control: a passkey whose removal is due is refused and removed");
  {
    const email = "due@example.com";
    const { lost } = await setUp(email);
    is("refused", await login(lost), null);
    is("removed from the account", await ids(email), [`kept-${email}`]);
    is("its request is applied, so none waits", await pendingNow(email), null);
  }

  part("Healthy control: a passkey whose removal is still days away logs in, as set to go, and the request stays");
  {
    const email = "future@example.com";
    const at = Date.now() + 3 * 86_400_000;
    const { lost } = await setUp(email, at);
    const signed = await login(lost);
    is("logs in, marked as set to go", [signed?.email, signed?.doomed], [email, true]);
    is("still on the account", await ids(email), [`lost-${email}`, `kept-${email}`]);
    is("its request still waits, at its own moment", await pendingNow(email), { ids: [`lost-${email}`], atOf: { [`lost-${email}`]: at } });
  }

  part("Healthy control: an old record (one moment for every passkey) is still read and applied");
  {
    const email = "legacy@example.com";
    const { lost } = await setUp(email);
    await redis.pipeline([["SET", dropKey(email), JSON.stringify({ ids: [`lost-${email}`], at: Date.now() - 3_600_000, told: 0 })]]);
    is("refused", await login(lost), null);
    is("removed from the account", await ids(email), [`kept-${email}`]);
  }

  part("The GET of the removal record answers in an unknown shape: refused, nothing removed and nothing called off");
  for (const [label, reply] of [["a number", 1], ["an object", { atOf: {} }], ["a list", ["x"]], ["no reply", undefined]] as const) {
    const email = `shape-${label.replace(/\s/g, "")}@example.com`;
    const { lost } = await setUp(email);
    const before = await stored(email);
    dropAnswers(email, reply);
    const signed = await outcome(() => login(lost));
    const pending = await outcome(() => pendingRemoval(email));
    const now = await outcome(() => pendingNow(email));
    redis.pipeline = original;
    is(`${label}: the passkey set to go is refused as unknown, never logs in`, signed, "unknown");
    is(`${label}: pendingRemoval says it could not read, never "none waiting"`, pending, "unknown");
    is(`${label}: pendingNow says it could not read, never "none waiting"`, now, "unknown");
    is(`${label}: still on the account (nothing applied on what was not read)`, (await ids(email)).includes(`lost-${email}`), true);
    is(`${label}: the removal request is kept exactly as it was`, await stored(email), before);
    is(`${label}: once the record reads whole, the next login is refused and the removal applied`, await login(lost), null);
    is(`${label}: and the passkey is gone`, await ids(email), [`kept-${email}`]);
  }

  part("The removal record holds text this code never wrote: refused, nothing removed and nothing called off");
  const atOfLost = (email: string, at: unknown) => ({ atOf: { [`lost-${email}`]: at }, told: 0 });
  for (const [label, body] of [
    ["not JSON", () => "{not json"],
    ["a JSON list", () => "[1,2]"],
    ["a JSON number", () => "5"],
    ["a JSON null", () => "null"],
    ["a moment that is not a number", (email: string) => JSON.stringify(atOfLost(email, "soon"))],
    ["a moment that is not finite", (email: string) => JSON.stringify(atOfLost(email, null))],
    ["moments that are a list", (email: string) => JSON.stringify({ atOf: [`lost-${email}`], told: 0 })],
    ["neither moments nor an old record", () => JSON.stringify({ told: 0 })],
    ["an old record whose moment is not a number", (email: string) => JSON.stringify({ ids: [`lost-${email}`], at: "soon" })],
    ["an old record whose ids are not names", () => JSON.stringify({ ids: [7], at: 1 })],
    ["untold that is not a list", (email: string) => JSON.stringify({ ...atOfLost(email, 1), untold: "all" })],
    ["a notice going out of another shape", (email: string) => JSON.stringify({ ...atOfLost(email, 1), telling: "now" })],
    ["told that is not a number", (email: string) => JSON.stringify({ ...atOfLost(email, 1), told: "yesterday" })],
    ["more passkeys than an account holds", (email: string) => JSON.stringify({ atOf: Object.fromEntries([`lost-${email}`, ...Array.from({ length: 12 }, (_, i) => `x${i}`)].map((id) => [id, 1])), told: 0 })],
  ] as const) {
    const email = `text-${label.replace(/\W/g, "").toLowerCase()}@example.com`;
    const { lost } = await setUp(email);
    const text = body(email);
    await redis.pipeline([["SET", dropKey(email), text]]);
    is(`${label}: the passkey is refused as unknown`, await outcome(() => login(lost)), "unknown");
    is(`${label}: pendingRemoval says it could not read`, await outcome(() => pendingRemoval(email)), "unknown");
    is(`${label}: still on the account`, (await ids(email)).includes(`lost-${email}`), true);
    is(`${label}: the record is left as it was`, await stored(email), text);
  }

  part("The sign-in route: an unknown removal record opens no session and says so honestly, as a temporary error");
  {
    const email = "route@example.com";
    const { lost } = await setUp(email);
    const options = await passkeySignIn(new NextRequest(`${ORIGIN}/api/auth/passkey/signin`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" }, body: JSON.stringify({ action: "options" }) }));
    const nonce = (options.headers.get("set-cookie") ?? "").match(new RegExp(`${PASSKEY_COOKIE}=([^;]*)`))?.[1] ?? "";
    const { challenge } = ((await options.json()) as { options: { challenge: string } }).options;
    dropAnswers(email, 1);
    const verified = await passkeySignIn(
      new NextRequest(`${ORIGIN}/api/auth/passkey/signin`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${PASSKEY_COOKIE}=${nonce}`, "x-forwarded-for": "198.51.100.7" },
        body: JSON.stringify({ action: "verify", response: lost.answer(challenge) }),
      }),
    );
    redis.pipeline = original;
    is("answered as a temporary failure (503), never a login", verified.status, 503);
    is("no session cookie is set", /nl_session=[^;]+/.test(verified.headers.get("set-cookie") ?? ""), false);
    is("the body says only that something went wrong (no detail leaks)", await verified.json(), { ok: false, error: "server_error" });
    is("the passkey is still on the account, its removal still waiting", [(await ids(email)).includes(`lost-${email}`), (await pendingNow(email))?.ids], [true, [`lost-${email}`]]);
  }

  done();
}
main();
