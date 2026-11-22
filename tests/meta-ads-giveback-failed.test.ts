/**
 * A give-back that did not happen is never told as one (VR item 2; Claude 4 2Wb's note on #4159 @585ae77e6e,
 * comment 7074499130; coordinator 20261122T050537Z-claude-1-coord-5aff).
 *
 * disconnectMeta gives Meta's permission back (DELETE /me/permissions) when no other store uses the login. Before,
 * a call that failed (Meta unreachable, a 5xx, an error answer, a token that could not be opened) was swallowed and
 * the disconnect still answered "removed", so the studio and the email said the permission was given back while it
 * was still granted at Meta. Now only Meta's own success answer is "removed"; anything else is "failed", and the
 * creator is told to remove Marktmorgen in their Facebook settings. The connection and what was read are deleted
 * either way. Synthetic data only.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { disconnectMeta, finishMeta } from "@/lib/meta-ads";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { accountChangeWords } from "@/lib/account-notice";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SECRET = "meta-app-secret-for-tests-0123456789";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const USER = "10150000000000033";
/** How Meta answers DELETE /me/permissions in this run. */
let revoke: "ok" | "server-error" | "unreachable" | "error-body" | "no-success" | "empty" = "ok";
let revokeCalls = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "graph.facebook.com") return json({ object: "list", data: [], has_more: false });
  const path = url.pathname.replace(/^\/v25\.0/, "");
  const method = init?.method ?? "GET";
  if (path === "/oauth/access_token") {
    if (url.searchParams.get("grant_type") === "fb_exchange_token") return json({ access_token: `EAAlong-${USER}`, expires_in: 5_184_000 });
    return json({ access_token: `EAAshort-${USER}` });
  }
  const token = url.searchParams.get("access_token") ?? "";
  if (url.searchParams.get("appsecret_proof") !== createHmac("sha256", SECRET).update(token).digest("hex")) return json({ error: { code: 190 } }, 400);
  if (path === "/me/permissions" && method === "DELETE") {
    revokeCalls += 1;
    if (revoke === "unreachable") throw new Error("synthetic: connection reset");
    if (revoke === "server-error") return json({ error: { code: 2, message: "Service temporarily unavailable" } }, 503);
    if (revoke === "error-body") return json({ error: { code: 190, message: "Error validating access token" } }, 400);
    if (revoke === "no-success") return json({ success: false });
    // The old control of tests/meta-spend-review-2924.test.ts: Meta answering "{}" (coordinator e0c0, condition 2).
    if (revoke === "empty") return json({});
    return json({ success: true });
  }
  if (path === "/me/permissions") return json({ data: [{ permission: "ads_read", status: "granted" }] });
  if (path === "/me") return json({ id: USER });
  if (path === "/me/adaccounts") return json({ data: [{ id: "act_555", account_id: "555", name: "Ads", currency: "USD", account_status: 1 }] });
  return json({ data: [] });
}) as typeof fetch;

const redirect = "https://marktmorgen.com/api/integrations/meta/callback";

async function connectedStore(email: string, handle: string) {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  const s = (await storeForEmail(email))!;
  const result = await finishMeta({ statsId: s.statsId!, sid: s.sid, code: "good-code", redirect, by: s.email, owner: { email: s.email, handle: s.handle }, currency: s.currency, startedAt: Date.now() });
  is(`store ${handle} connects`, result.ok, true);
  return s;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("Meta answers the give-back with its success: removed");
  revoke = "ok";
  const ok = await connectedStore("giveback-ok@example.com", "giveback-ok");
  const removed = await disconnectMeta(ok.statsId!);
  is("the disconnect says the permission was given back", removed && removed.metaAccess, "removed");

  for (const failure of ["server-error", "unreachable", "error-body", "no-success", "empty"] as const) {
    part(`Meta's give-back does not succeed (${failure}): failed, never removed`);
    revoke = failure;
    const before = revokeCalls;
    const s = await connectedStore(`giveback-${failure}@example.com`, `giveback-${failure}`);
    const gone = await disconnectMeta(s.statsId!);
    is("the give-back was asked of Meta", revokeCalls - before, 1);
    is("the disconnect never says the permission was given back", gone && gone.metaAccess, "failed");
    is("the connection is still forgotten here", [...redis.keys()].some((k) => k === `nl:metaads:conn:${s.statsId}`), false);
    is("the account it read is still answered", gone && gone.account?.id, "act_555");
  }

  part("A token that cannot be opened: Meta is never asked, and it is failed, never removed");
  revoke = "ok";
  const sealedBad = await connectedStore("giveback-unsealed@example.com", "giveback-unsealed");
  const key = `nl:metaads:conn:${sealedBad.statsId}`;
  const record = JSON.parse(String(redis.run(["GET", key])));
  redis.run(["SET", key, JSON.stringify({ ...record, token: "not-a-sealed-token" })]);
  const callsBefore = revokeCalls;
  const unsealed = await disconnectMeta(sealedBad.statsId!);
  is("Meta is not asked with a token that cannot be opened", revokeCalls - callsBefore, 0);
  is("and the disconnect says it failed", unsealed && unsealed.metaAccess, "failed");

  part("What the creator is told when the give-back failed");
  const line = accountChangeWords({ kind: "metaads-disconnected", failed: true }).line;
  is("the email never says the permission was given back, and says how to remove it", [/given back/i.test(line), /could not remove (its|the) permission at Meta/i.test(line), /Facebook settings/.test(line)], [false, true, true]);
  const routes = readFileSync("lib/meta-routes.ts", "utf8");
  is("the route sends a failed give-back to its own studio notice", routes.includes('failed ? "disconnected-failed"'), true);
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  const at = studio.indexOf('"disconnected-failed": {');
  const notice = at < 0 ? "" : studio.slice(at, at + 400);
  is("that notice says the permission could not be removed at Meta, never given back", [notice.length > 0, /could not remove its permission at Meta/.test(notice), /given back/i.test(notice), /Facebook settings/.test(notice)], [true, true, false, true]);
  const help = readFileSync("lib/help-content.ts", "utf8").replace(/\s+/g, " ");
  is("the help center says what happens when Meta does not answer", help.includes("If Meta does not confirm it, your studio says so, and you can remove Marktmorgen in your Facebook settings."), true);

  done();
}

const report = console.error;
main().catch((error) => {
  report(error);
  process.exit(1);
});
