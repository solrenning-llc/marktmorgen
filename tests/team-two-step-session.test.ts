/**
 * A team that asks for two-step sign-in reads how the session was opened,
 * not what the account owns (lib/auth.ts sessionSecondStep, lib/team.ts
 * teamTwoStepBlocks). A member who has only a passkey and logs in with the
 * emailed link is held until the second step; the same member logging in
 * with the passkey, or a member logging in with the app's code or a recovery
 * code, is let in. A session from before the mark existed, a session read
 * without its id and somebody else's session are held. The owner, and a
 * store that does not ask, never are. Synthetic records, a key pair made
 * here, and no email leaves.
 */
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { emailForSession, endSession, openSession, sessionSecondStep } from "@/lib/auth";
import { finishSetup, startSetup } from "@/lib/two-step";
import { PASSKEY_COOKIE, RP_ID } from "@/lib/passkeys";
import { SITE_URL } from "@/lib/site-url";
import { SECOND_STEP_WORDS, putMember, secondStepWay, setRequireTwoStep, teamTwoStepBlocks } from "@/lib/team";
import { resolveAccess, studioAccess } from "@/lib/studio-route";
import { claimHandle, ensureStoreId, storeForEmail } from "@/lib/store";
import { POST as callback } from "@/app/api/auth/callback/route";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { POST as passkeyRoute } from "@/app/api/auth/passkey/signin/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_team_two_step_session_only";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest();
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const OWNER = "owner-session@example.com";
const PIA = "pia-passkey@example.com";
const ARI = "ari-app@example.com";
const NED = "ned-nothing@example.com";
const ORIGIN = "https://marktmorgen.com";

async function linkFor(email: string): Promise<string> {
  const token = hex(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${token}`).slice(0, 40)}`, email, "EX", 900]]);
  return token;
}
const form = (url: string, fields: Record<string, string>, cookie = "") =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields) });
const json = (url: string, body: unknown, cookie = "") =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = (response: Response, name: string) => (response.headers.get("set-cookie") ?? "").match(new RegExp(`${name}=([^;]*)`))?.[1] ?? "";

/** A passkey made here: a P-256 key pair, its public half kept as the account's, in COSE form. */
function makePasskey(email: string, id: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  // {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  const record = { id, publicKey: cose.toString("base64url"), counter: 0, transports: ["internal"], name: "Phone", createdAt: "", lastUsedAt: "", synced: true };
  let counter = 0;
  return {
    async keep() {
      await redis.pipeline([
        ["SET", `nl:pk:${hex(`nimbus-passkeys:${email}`).slice(0, 40)}`, JSON.stringify([record])],
        ["SET", `nl:pk:cred:${hex(`nimbus-passkey-id:${id}`).slice(0, 40)}`, email],
      ]);
    },
    /** What a browser answers to the sign-in options, signed by this key. */
    answer(challenge: string) {
      counter += 1;
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([sha(RP_ID), Buffer.from([0x05]), count]);
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: SITE_URL, crossOrigin: false }));
      const signer = createSign("SHA256");
      signer.update(Buffer.concat([authData, sha(clientData)]));
      const signature = signer.sign(privateKey);
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: { authenticatorData: authData.toString("base64url"), clientDataJSON: clientData.toString("base64url"), signature: signature.toString("base64url") },
      };
    },
  };
}

async function signInWithPasskey(key: ReturnType<typeof makePasskey>, previous = ""): Promise<string> {
  const options = await passkeyRoute(json(`${ORIGIN}/api/auth/passkey/signin`, { action: "options" }));
  const nonce = cookieOf(options, PASSKEY_COOKIE);
  const { options: asked } = (await options.json()) as { options: { challenge: string } };
  const verified = await passkeyRoute(json(`${ORIGIN}/api/auth/passkey/signin`, { action: "verify", response: key.answer(asked.challenge) }, `${PASSKEY_COOKIE}=${nonce}${previous ? `; nl_session=${previous}` : ""}`));
  return cookieOf(verified, "nl_session");
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "team-session", "Team Session", "");
  const store = (await ensureStoreId((await storeForEmail(OWNER))!.email)) ?? (await storeForEmail(OWNER))!;
  if (!store.sid) throw new Error("no store id");
  await claimHandle("other-owner@example.com", "no-rule-store", "No Rule", "");
  const free = (await ensureStoreId((await storeForEmail("other-owner@example.com"))!.email)) ?? (await storeForEmail("other-owner@example.com"))!;
  for (const email of [PIA, ARI, NED]) {
    await putMember(store, email, "editor");
    await putMember(free, email, "editor");
  }
  await setRequireTwoStep(store, true, OWNER);
  const blocks = (email: string, session?: string) => teamTwoStepBlocks(store, email, "editor", session);

  part("A member who has only a passkey, logging in with the emailed link");
  const pia = makePasskey(PIA, "cred-pia-1");
  await pia.keep();
  const byLink = cookieOf(await callback(form(`${ORIGIN}/api/auth/callback`, { token: await linkFor(PIA) })), "nl_session");
  is("the link opens a session", [byLink.length, await emailForSession(byLink)], [64, PIA]);
  is("with no second step written on it", await sessionSecondStep(byLink, PIA), null);
  is("the team holds it at the door", await blocks(PIA, byLink), true);
  is("and says to log in again with the passkey", await secondStepWay(PIA), "passkey");
  const reason = async (email: string, session: string) => {
    const r = await resolveAccess(email, { pinned: store.sid, session }, null);
    return r.ok ? "open" : r.reason;
  };
  const route = async (session: string) => {
    const r = await studioAccess(new NextRequest(`${ORIGIN}/api/store/x?store=${store.sid}`, { method: "POST", headers: { cookie: `nl_session=${session}` } }), "products");
    return r.ok ? "open" : r.reason;
  };
  is("the studio refuses the store to it", await reason(PIA, byLink), "two_step");
  is("and so does every studio route", await route(byLink), "two_step");

  part("The same member, logging in with the passkey");
  const byPasskey = await signInWithPasskey(pia, byLink);
  is("a session opens", [byPasskey.length, await emailForSession(byPasskey)], [64, PIA]);
  is("opened with the passkey", await sessionSecondStep(byPasskey, PIA), "passkey");
  is("the team lets it in", await blocks(PIA, byPasskey), false);
  is("the studio opens the store to it", await reason(PIA, byPasskey), "open");
  is("the link's session was replaced: it is gone", await emailForSession(byLink), null);

  part("A member with an authenticator app: the link waits for the code");
  const setup = await startSetup(ARI, "c".repeat(64), "ari-backup@example.org");
  if (typeof setup === "string") throw new Error(setup);
  const backup = /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === "ari-backup@example.org")?.text ?? "")?.[1] ?? "";
  const secret = base32Decode(setup.secret)!;
  const finished = await finishSetup(ARI, "c".repeat(64), codeAt(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS)), backup);
  if (typeof finished === "string") throw new Error(finished);
  const held = await callback(form(`${ORIGIN}/api/auth/callback`, { token: await linkFor(ARI) }));
  is("the link opens no session", cookieOf(held, "nl_session"), "");
  const next = codeAt(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1);
  const byCode = cookieOf(await codeRoute(form(`${ORIGIN}/api/auth/code`, { code: next }, `nl_2fa=${cookieOf(held, "nl_2fa")}`)), "nl_session");
  is("the app's code opens one, marked so", [byCode.length, await sessionSecondStep(byCode, ARI)], [64, "app"]);
  is("the team lets it in", await blocks(ARI, byCode), false);
  is("the studio opens the store to it", await reason(ARI, byCode), "open");
  const held2 = await callback(form(`${ORIGIN}/api/auth/callback`, { token: await linkFor(ARI) }));
  const byRecovery = cookieOf(await codeRoute(form(`${ORIGIN}/api/auth/code`, { code: finished.codes[0] }, `nl_2fa=${cookieOf(held2, "nl_2fa")}`)), "nl_session");
  is("a recovery code opens one, marked so", [byRecovery.length, await sessionSecondStep(byRecovery, ARI)], [64, "recovery"]);
  is("the team lets that in too", await blocks(ARI, byRecovery), false);

  part("What has no second step is held, and has a way out");
  const old = await openSession(ARI);
  is("a session from before the mark existed", [await sessionSecondStep(old, ARI), await blocks(ARI, old)], [null, true]);
  is("a session left out of the question", await blocks(ARI), true);
  is("somebody else's session does not count", [await sessionSecondStep(byPasskey, ARI), await blocks(ARI, byPasskey)], [null, true]);
  is("an app user is told to log in again with the code", await secondStepWay(ARI), "app");
  const ned = cookieOf(await callback(form(`${ORIGIN}/api/auth/callback`, { token: await linkFor(NED) })), "nl_session");
  is("a member with neither is held, and told to set one up", [await blocks(NED, ned), await secondStepWay(NED)], [true, "set_up"]);
  is(
    "every way out has a title, words and a place to go, and keeps what was typed",
    Object.values(SECOND_STEP_WORDS).every((w) => w.title && w.action && w.href && w.body.includes("Anything you typed in another tab stays there")),
    true,
  );
  await endSession(byPasskey);
  is("a session logged out loses its mark with it", [await sessionSecondStep(byPasskey, PIA), await blocks(PIA, byPasskey)], [null, true]);

  part("The owner, and a store that does not ask, do not change");
  is("the owner is never held, whatever the session", await teamTwoStepBlocks(store, OWNER, "owner", undefined), false);
  const ownerOpen = await resolveAccess(OWNER, { pinned: store.sid }, null);
  is("the owner opens the store", ownerOpen.ok, true);
  for (const [email, session] of [[PIA, byLink], [NED, ned]] as const) {
    is(`${email} on a store that does not ask is never held`, await teamTwoStepBlocks(free, email, "editor", session), false);
    const opened = await resolveAccess(email, { pinned: free.sid }, null);
    is(`${email} opens the store that does not ask`, opened.ok, true);
  }

  done();
}

void main();
