/**
 * Giving a Meta permission back is said to be done only when Meta confirmed it (VR item 2; CX-123 rule 24;
 * lib/meta-ads.ts revokeToken, disconnectMetaFor, finishMeta).
 *
 * Before: every DELETE /me/permissions ended in `.catch(() => ({}))` or `.catch(console.error)`, and its answer was
 * never read. A Meta that was down, refused, or answered {"success": false} left the token valid on Meta's side,
 * while the studio said "The permission was given back to Meta" and the email said "its permission given back".
 *
 * Checked, with Meta answering each way (confirmed, busy once, busy every time, refused, success false, a body that
 * cannot be read, a token that no longer works):
 *
 *   - disconnecting forgets the connection and what was read whatever Meta says, and the studio is sent
 *     `metaads=disconnected` only when Meta confirmed, `metaads=disconnected-unconfirmed` otherwise;
 *   - a busy or unreachable Meta is asked once more, never more than GIVE_BACK_TRIES times; a refusal is not
 *     asked again;
 *   - each connect that ends without keeping anything (permission missing, no ad account, Meta's deletion notice
 *     during the flow, a flow that ran out of time) says `providerAccessRemoved: false` when the give-back was not
 *     confirmed, and the callback sends the studio `<error>-unconfirmed`;
 *   - the studio's and the email's words for an unconfirmed give-back never say it was given back, and say how to
 *     remove it on Facebook.
 */
import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import * as metaAds from "@/lib/meta-ads";
import { beginMeta, finishMeta, metaView } from "@/lib/meta-ads";
import * as metaRules from "@/lib/meta-ads-rules";
import { accountChangeWords } from "@/lib/account-notice";
import { finishMetaConnect, stopMeta } from "@/lib/meta-routes";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SECRET = "meta-app-secret-for-tests-0123456789";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const USER = "10150000000000077";
const ORIGIN = "https://marktmorgen.com";
const REDIRECT = `${ORIGIN}/api/integrations/meta/callback`;
const FLOW_MS = 2 * 600 * 1000;

/** How Meta answers DELETE /me/permissions. */
type DeleteAnswer = "ok" | "busy" | "busy-once" | "refused" | "false" | "garbled" | "auth";
let deleteAnswer: DeleteAnswer = "ok";
let deletes = 0;
let adsRead = true;
let noAccounts = false;
/** Added to the clock from the moment the ad accounts are listed: a flow that runs out of time on its way. */
let shiftOnAccounts = 0;
const realNow = Date.now.bind(Date);
let shift = 0;
Date.now = () => realNow() + shift;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "graph.facebook.com") return json({ object: "list", data: [], has_more: false });
  const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
  const method = init?.method ?? "GET";
  const token = url.searchParams.get("access_token");
  if (token && url.searchParams.get("appsecret_proof") !== createHmac("sha256", SECRET).update(token).digest("hex")) return json({ error: { code: 190 } }, 400);
  if (path === "/oauth/access_token") return url.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "EAAlong", expires_in: 5_184_000 }) : json({ access_token: "EAAshort" });
  if (path === "/me/permissions" && method === "DELETE") {
    deletes += 1;
    if (deleteAnswer === "busy-once") {
      deleteAnswer = "ok";
      return json({ error: { code: 2, message: "Service temporarily unavailable" } }, 503);
    }
    if (deleteAnswer === "busy") return json({ error: { code: 2, message: "Service temporarily unavailable" } }, 503);
    if (deleteAnswer === "refused") return json({ error: { code: 100, message: "Unsupported delete request" } }, 400);
    if (deleteAnswer === "false") return json({ success: false });
    if (deleteAnswer === "garbled") return new Response("OK", { status: 200 });
    if (deleteAnswer === "auth") return json({ error: { code: 190, message: "Error validating access token" } }, 400);
    return json({ success: true });
  }
  if (path === "/me/permissions") return json({ data: [{ permission: "ads_read", status: adsRead ? "granted" : "declined" }] });
  if (path === "/me") return json({ id: USER });
  if (path === "/me/adaccounts") {
    shift += shiftOnAccounts;
    return json({ data: noAccounts ? [] : [{ id: "act_555", account_id: "555", name: "Honest Ads", currency: "USD", account_status: 1 }] });
  }
  if (path === "/act_555/insights") return json({ data: [] });
  return json({ error: { code: 803, message: "unknown" } }, 404);
}) as typeof fetch;

const goneKey = (user: string) => `nl:metaads:gone:${createHash("sha256").update(`metaads-gone:${user}`).digest("hex").slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("honest-meta@example.com", "honest-meta", "Honest Meta Shop", "");
  await ensureStatsId("honest-meta@example.com");
  const store = (await storeForEmail("honest-meta@example.com"))!;
  const statsId = store.statsId!;
  const session = await openSession("honest-meta@example.com");
  const cookie = `${SESSION_COOKIE}=${session}`;
  const owner = { email: store.email, handle: store.handle };
  const finish = (startedAt = Date.now()) => finishMeta({ statsId, sid: store.sid, code: "good-code", redirect: REDIRECT, by: store.email, owner, currency: store.currency, startedAt });
  const connect = async () => {
    deleteAnswer = "ok";
    const made = await finish();
    if (!made.ok) throw new Error(`not connected: ${made.error}`);
  };
  const disconnectByRoute = async (): Promise<string | null> => {
    const answer = await stopMeta(new NextRequest(`${ORIGIN}/api/integrations/meta/disconnect?store=${store.sid}`, { method: "POST", headers: { host: "marktmorgen.com", origin: ORIGIN, cookie } }));
    return new URL(answer.headers.get("location") ?? "https://none.invalid/").searchParams.get("metaads");
  };
  const tries = (metaAds as Record<string, unknown>).GIVE_BACK_TRIES;
  is("a give-back is asked of Meta at most twice: once, and once more only when Meta was busy or out of reach", tries, 2);

  part("Disconnecting: the studio is told it was given back only when Meta confirmed it");
  const cases: [DeleteAnswer, string, number][] = [
    ["ok", "disconnected", 1],
    ["busy-once", "disconnected", 2],
    ["auth", "disconnected", 1],
    ["busy", "disconnected-unconfirmed", 2],
    ["refused", "disconnected-unconfirmed", 1],
    ["false", "disconnected-unconfirmed", 1],
    ["garbled", "disconnected-unconfirmed", 2],
  ];
  for (const [answer, word, asked] of cases) {
    await connect();
    deleteAnswer = answer;
    deletes = 0;
    const said = await disconnectByRoute();
    const view = await metaView(statsId, store.currency);
    const [conn, lines] = await redis.pipeline([["EXISTS", `nl:metaads:conn:${statsId}`], ["EXISTS", `nl:stats:${statsId}:spend:meta`]]);
    is(`Meta answers ${answer}: the studio says ${word}, Meta asked ${asked} time(s), and nothing is kept here`, [said, deletes, view?.connected ?? false, conn, lines], [word, asked, false, 0, 0]);
  }
  const forFn = (metaAds as Record<string, unknown>).disconnectMetaFor;
  is("disconnectMetaFor says whether Meta confirmed", typeof forFn, "function");
  if (typeof forFn === "function") {
    await connect();
    deleteAnswer = "busy";
    const outcome = await (forFn as (id: string) => Promise<unknown>)(statsId);
    is("not confirmed: the account, and providerAccessRemoved false", outcome, { account: { id: "act_555", name: "Honest Ads", currency: "usd" }, providerAccessRemoved: false });
    is("nothing connected: false", await (forFn as (id: string) => Promise<unknown>)(statsId), false);
  }

  part("Connecting that keeps nothing: a give-back Meta did not confirm is said");
  deleteAnswer = "busy";
  adsRead = false;
  deletes = 0;
  is("permission missing, Meta busy: not confirmed, asked twice", [await finish(), deletes], [{ ok: false, error: "permission", providerAccessRemoved: false }, 2]);
  deleteAnswer = "ok";
  is("permission missing, Meta confirms: nothing more is said", await finish(), { ok: false, error: "permission" });
  adsRead = true;

  noAccounts = true;
  deleteAnswer = "refused";
  deletes = 0;
  is("no ad account, Meta refuses: not confirmed, asked once", [await finish(), deletes], [{ ok: false, error: "accounts", providerAccessRemoved: false }, 1]);
  deleteAnswer = "ok";
  is("no ad account, Meta confirms", await finish(), { ok: false, error: "accounts" });
  noAccounts = false;

  await redis.pipeline([["SET", goneKey(USER), String(Date.now()), "EX", 86_400]]);
  deleteAnswer = "false";
  is("Meta's deletion notice during the flow, Meta answers success false: not confirmed", await finish(Date.now() - 1_000), { ok: false, error: "removed", providerAccessRemoved: false });
  deleteAnswer = "ok";
  is("Meta's deletion notice during the flow, Meta confirms", await finish(Date.now() - 1_000), { ok: false, error: "removed" });
  await redis.pipeline([["DEL", goneKey(USER)]]);

  shiftOnAccounts = 2 * FLOW_MS;
  deleteAnswer = "garbled";
  is("a flow that ran out of time on its way, Meta's answer unreadable: not confirmed", await finish(), { ok: false, error: "expired", providerAccessRemoved: false });
  shiftOnAccounts = 0;
  shift = 0;

  part("The callback sends the studio the word that says so");
  adsRead = false;
  deleteAnswer = "busy";
  const consent = await beginMeta({ statsId, sid: store.sid, sessionCookie: session, email: store.email, redirect: REDIRECT });
  const query = new URLSearchParams({ state: new URL(consent).searchParams.get("state") ?? "", code: "good-code" });
  const back = await finishMetaConnect(new NextRequest(`${REDIRECT}?${query}`, { headers: { host: "marktmorgen.com", cookie } }));
  is("permission missing and not given back: permission-unconfirmed", new URL(back.headers.get("location") ?? "https://none.invalid/").searchParams.get("metaads"), "permission-unconfirmed");
  adsRead = true;

  part("The words never say it was given back when Meta did not confirm it");
  const notice = (metaRules as Record<string, unknown>).metaUnconfirmedNotice;
  is("the studio's words come from one function", typeof notice, "function");
  if (typeof notice === "function") {
    for (const word of ["disconnected", "permission", "accounts", "removed", "expired"]) {
      const n = (notice as (w: string) => { title: string; body: string } | undefined)(`${word}-unconfirmed`);
      is(`${word}-unconfirmed: says Meta did not confirm, how to remove it on Facebook, and never that it was given back`, [Boolean(n?.title), /did not confirm/.test(n?.body ?? ""), /Business integrations/.test(n?.body ?? ""), /given back/i.test(`${n?.title} ${n?.body}`)], [true, true, true, false]);
    }
    // Pre-review (9 November 2026): on "permission" Meta never gave the permission to read the ads, so the words for
    // an unconfirmed give-back must not say that permission may stay on (the title says it was not given).
    const missing = (notice as (w: string) => { title: string; body: string } | undefined)("permission-unconfirmed");
    is("permission-unconfirmed: never says the permission to read the ads, which Meta did not give, may stay on", /permission to read your ads, so that access may stay on/.test(missing?.body ?? ""), false);
    is("any other word is no notice", ["connected-unconfirmed", "constructor-unconfirmed", "__proto__-unconfirmed", "disconnected", ""].map((w) => (notice as (w: string) => unknown)(w)), [undefined, undefined, undefined, undefined, undefined]);
  }
  const page = readFileSync("app/studio/page.tsx", "utf8");
  is("the studio page reads those words", page.includes("metaUnconfirmedNotice("), true);
  const email = accountChangeWords({ kind: "metaads-disconnected", providerAccessRemoved: false } as Parameters<typeof accountChangeWords>[0]);
  is("the email for an unconfirmed disconnect says so, and how to remove it", [/given back/i.test(email.line), /did not confirm/.test(email.line), /Business integrations/.test(email.line)], [false, true, true]);
  is("the email for a confirmed disconnect is unchanged", accountChangeWords({ kind: "metaads-disconnected" }).line, "Your store's Meta ad account was disconnected and its permission given back. What was read from it was deleted; what you typed yourself stays.");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
