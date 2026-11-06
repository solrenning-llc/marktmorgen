/** Independent conditional lock and real code-route checks. No production identity/provider. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { emailForSession, SESSION_COOKIE } from "@/lib/auth";
import { cancelReset, checkCode, enterLocked, holdSignIn, lockedFor, lockedUntil, RESET_DAYS, TWO_STEP_COOKIE, twoStepOn } from "@/lib/two-step";
import { finishProvenSignIn } from "@/lib/signin-finish";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { store as redis } from "./redis-stub";

type Cmd = (string | number)[];
let checks = 0, failures = 0;
function check(label: string, work: () => void): void {
  checks++;
  try { work(); console.log(`PASS ${label}`); }
  catch (error) { failures++; console.log(`FAIL ${label}: ${String(error)}`); }
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const recordKey = (email: string) => `nl:2fa:${sha(`nimbus-2fa:${email}`).slice(0, 40)}`;
const codeHash = (code: string) => sha(`nimbus-2fa-code:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`);
const real = redis.pipeline.bind(redis);
const originalNow = Date.now;
async function reply<T>(match: (command: Cmd) => boolean, value: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = async (commands: Cmd[]) => (await real(commands)).map((v, i) => match(commands[i]) ? value : v);
  try { return await work(); } finally { redis.pipeline = real; }
}
const request = (held: string, code: string) => new NextRequest("https://marktmorgen.com/api/auth/code", {
  method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded", cookie: `${TWO_STEP_COOKIE}=${held}` },
  body: new URLSearchParams({ code }),
});
async function seed(email: string, code = "abcd-efgh") {
  await real([["SET", recordKey(email), JSON.stringify({ s: "synthetic-sealed-secret", since: 1, codes: [codeHash(code)], last: -1, reset: 0, backup: "" })]]);
}

async function main(): Promise<void> {
  assert.equal((globalThis as { __j2896NetworkGuard?: boolean }).__j2896NetworkGuard, true, "network controls ran before this graph");
  redis.clear();
  const email = "j-2896-kept@example.com";
  await seed(email);
  const opened = await enterLocked(await holdSignIn(email));
  assert.ok(opened, "actual enterLocked created a real locked session");
  check("real locked session belongs to the synthetic account", () => assert.match(opened.session, /^[0-9a-f]{64}$/));
  const canceled = await reply(c => c[0] === "SMEMBERS" && String(c[1]).startsWith("nl:2fa:lockedset:"), null, () => cancelReset(email, "studio"));
  check("actual Cancel cannot enumerate sessions and promises kept-locked", () => assert.equal(canceled, "kept-locked"));
  const keptKey = `nl:2fa:lockedset:${sha(`nimbus-2fa-lockedset:${email}`).slice(0, 40)}:kept`;
  assert.ok(keptKey, "actual cancellation wrote its kept timestamp");
  const actualKept = (await real([["GET", keptKey]]))[0];
  assert.equal(typeof actualKept, "string");
  const later = originalNow() + (RESET_DAYS + 1) * 86_400_000;
  Date.now = () => later;
  const appStillOn = await twoStepOn(email), currentOwner = await emailForSession(opened.session);
  check("session remains active after the reset day", () => assert.equal(currentOwner, email));
  check("its owner still requires the app", () => assert.equal(appStillOn, true));
  const healthy = await lockedUntil(opened.session);
  check("healthy kept session remains locked after its original day", () => assert.ok(healthy > later));
  const cookieRequest = { cookies: { get: (name: string) => name === SESSION_COOKIE ? { value: opened.session } : undefined } };
  const healthyGate = await lockedFor(cookieRequest, "payments", "");
  check("real protected-action gate refuses that healthy kept session", () => assert.equal(healthyGate, true));
  for (const value of ["", " ", "1e2"]) {
    let injections = 0;
    const observed = await reply(c => { const matched = c[0] === "GET" && c[1] === keptKey; if (matched) injections++; return matched; }, value, async () => ({ until: await lockedUntil(opened.session), gate: await lockedFor(cookieRequest, "payments", "") }));
    assert.equal(injections, 2, "the exact second-stage kept GET was exercised in both helper and gate");
    console.log(JSON.stringify({ keptReply: value, observedUntil: observed.until, protectedPaymentsGate: observed.gate, injections }));
    check(`kept timestamp ${JSON.stringify(value)} is unknown, never unlocks the session`, () => assert.ok(observed.until > later));
    check(`kept timestamp ${JSON.stringify(value)} cannot release the real payments gate`, () => assert.equal(observed.gate, true));
    const readBack = (await real([["GET", keptKey]]))[0];
    check(`the actual persisted kept mark remains intact for ${JSON.stringify(value)}`, () => assert.equal(readBack, actualKept));
  }
  const conservative = await reply(c => c[0] === "GET" && c[1] === keptKey, {}, () => lockedUntil(opened.session));
  check("an object kept timestamp is conservatively locked (control)", () => assert.ok(conservative > later));
  Date.now = originalNow;

  for (const mode of ["healthy", "unknown-first", "unknown-after-open"] as const) {
    redis.clear();
    const who = `j-2896-${mode}@example.com`;
    await seed(who);
    const held = await holdSignIn(who);
    let reads = 0, injected = 0;
    redis.pipeline = async (commands: Cmd[]) => (await real(commands)).map((v, i) => {
      if (commands[i][0] !== "GET" || commands[i][1] !== recordKey(who)) return v;
      reads++;
      if ((mode === "unknown-first" && reads === 1) || (mode === "unknown-after-open" && reads === 3)) { injected++; return {}; }
      return v;
    });
    let response: Response;
    try { response = await codeRoute(request(held, "abcd-efgh")); } finally { redis.pipeline = real; }
    const location = response.headers.get("location");
    const cookie = response.headers.get("set-cookie") ?? "";
    const sessions = redis.keys().filter(k => k.startsWith("nl:auth:session:"));
    console.log(JSON.stringify({ mode, reads, injected, location, sessionKeys: sessions.length }));
    check(`${mode}: route returns a redirect`, () => assert.equal(response.status, 303));
    check(`${mode}: route has the expected exact notice`, () => assert.equal(location, mode === "healthy" ? "https://marktmorgen.com/studio" : mode === "unknown-first" ? "https://marktmorgen.com/signin/code?status=unknown" : "https://marktmorgen.com/signin?status=login-unknown"));
    check(`${mode}: session cookie only follows a fully known right code`, () => assert.equal(cookie.includes(`${SESSION_COOKIE}=`), mode === "healthy"));
    check(`${mode}: no backend session survives an unknown re-read`, () => assert.equal(sessions.length, mode === "healthy" ? 1 : 0));
    if (mode !== "healthy") check(`${mode}: the exact requested unknown slot was exercised`, () => assert.equal(injected, 1));
  }
  redis.clear();
  const empty = "j-2896-empty-secret@example.com";
  await real([["SET", recordKey(empty), JSON.stringify({ s: "", since: 1, codes: [], last: -1, reset: 0, backup: "" })]]);
  const stillOn = await twoStepOn(empty), unreadable = await checkCode(empty, "123456");
  const link = await finishProvenSignIn(new NextRequest("https://marktmorgen.com/api/auth/callback"), empty, "link", "/studio");
  check("empty secret is still two-step ON, not a link-login bypass (refutation control)", () => assert.equal(stillOn, true));
  check("empty secret cannot validate an app code (refutation control)", () => assert.equal(unreadable, "unreadable"));
  check("empty secret link still goes to the second-step page (refutation control)", () => assert.equal(link.headers.get("location"), "https://marktmorgen.com/signin/code"));
  check("empty secret produces no session cookie (refutation control)", () => assert.equal((link.headers.get("set-cookie") ?? "").includes(`${SESSION_COOKIE}=`), false));
  console.log(`J2896 ${checks} checks, ${failures} failures.`);
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Date.now = originalNow; redis.pipeline = real; });
