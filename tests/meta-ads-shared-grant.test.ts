/**
 * One Meta login, two stores (issue #4011, Meta part; decision ALL-160). Meta's
 * DELETE /me/permissions ends the person's whole grant to the app, not one
 * store's token, so every store connected with that login stops working.
 *
 * Disconnecting one store (lib/meta-ads.ts disconnectMeta), or connecting it
 * again with another login (finishMeta, the old login's give-back), gives the
 * permission back to Meta only when no other store still uses that login;
 * otherwise this store forgets it locally and the other store keeps reading.
 * The last store to disconnect gives it back. An index that cannot be read
 * keeps the grant: one store's action never breaks another's connection.
 *
 * Before: both paths always called DELETE /me/permissions, so the other store
 * was cut off at Meta while still showing as connected.
 */
import { createHmac } from "node:crypto";
import { disconnectMeta, finishMeta, readMetaSpend } from "@/lib/meta-ads";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { accountChangeWords } from "@/lib/account-notice";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SECRET = "meta-app-secret-for-tests-0123456789";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const USER_1 = "10150000000000011";
const USER_2 = "10150000000000022";
const today = new Date().toISOString().slice(0, 10);
/** The Meta login the next consent is made with. */
let loginAs = USER_1;
/** Each login's grant to the app: DELETE /me/permissions ends it for every token of that login. */
const granted = new Map<string, boolean>();
const revokedFor: string[] = [];
/** Set to move the clock a day on once Meta lists the accounts: the flow goes stale while Meta is being read. */
let staleOnAccounts = false;
const realNow = Date.now.bind(Date);
let skewMs = 0;
Date.now = () => realNow() + skewMs;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "graph.facebook.com") return json({ object: "list", data: [], has_more: false });
  const path = url.pathname.replace(/^\/v25\.0/, "");
  const method = init?.method ?? "GET";
  if (path === "/oauth/access_token") {
    if (url.searchParams.get("grant_type") === "fb_exchange_token") return json({ access_token: `EAAlong-${url.searchParams.get("fb_exchange_token")?.slice(9)}`, expires_in: 5_184_000 });
    granted.set(loginAs, true);
    return json({ access_token: `EAAshort-${loginAs}` });
  }
  const token = url.searchParams.get("access_token") ?? "";
  if (url.searchParams.get("appsecret_proof") !== createHmac("sha256", SECRET).update(token).digest("hex")) return json({ error: { code: 190 } }, 400);
  const user = token.replace(/^EAA(long|short)-/, "");
  // A token of a login whose grant was given back no longer works, for any store.
  if (!granted.get(user)) return json({ error: { code: 190, message: "Error validating access token: the user has not authorized application" } }, 400);
  if (path === "/me/permissions" && method === "DELETE") {
    granted.set(user, false);
    revokedFor.push(user);
    return json({ success: true });
  }
  if (path === "/me/permissions") return json({ data: [{ permission: "ads_read", status: "granted" }] });
  if (path === "/me") return json({ id: user });
  if (path === "/me/adaccounts" && staleOnAccounts) skewMs += 86_400_000;
  if (path === "/me/adaccounts") return json({ data: [{ id: "act_444", account_id: "444", name: "Shared Ads", currency: "USD", account_status: 1 }] });
  if (path === "/act_444/insights") return json({ data: [{ campaign_id: "1", campaign_name: "Reel", spend: "12.00", date_start: today, publisher_platform: "instagram" }] });
  return json({ error: { code: 803, message: "unknown" } }, 404);
}) as typeof fetch;

const redirect = "https://marktmorgen.com/api/integrations/meta/callback";

async function makeStore(email: string, handle: string) {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  return (await storeForEmail(email))!;
}

async function connect(s: Awaited<ReturnType<typeof makeStore>>, as: string) {
  loginAs = as;
  const result = await finishMeta({ statsId: s.statsId!, sid: s.sid, code: "good-code", redirect, by: s.email, owner: { email: s.email, handle: s.handle }, currency: s.currency, startedAt: Date.now() });
  is(`store ${s.handle} connects with login ${as}`, result.ok, true);
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const a = await makeStore("shared-a@example.com", "shared-a");
  const b = await makeStore("shared-b@example.com", "shared-b");

  part("Disconnecting one of two stores on one Meta login");
  await connect(a, USER_1);
  await connect(b, USER_1);
  const first = await disconnectMeta(a.statsId!);
  is("the store is disconnected and says Meta's permission was kept for the other store", first && first.metaAccess, "kept");
  is("the login's grant at Meta is not given back while another store uses it", [granted.get(USER_1), revokedFor], [true, []]);
  is("the other store still reads Meta", await readMetaSpend(b.statsId!, b.currency), "read");
  is("the disconnected store reads nothing", await readMetaSpend(a.statsId!, a.currency), "none");

  part("The last store on that login gives it back");
  const last = await disconnectMeta(b.statsId!);
  is("the last store says Meta's permission was given back", last && last.metaAccess, "removed");
  is("and the grant ends at Meta, once", [granted.get(USER_1), revokedFor], [false, [USER_1]]);
  is("the account it read is still answered", last && last.account?.id, "act_444");

  part("Connecting one store again with another login");
  revokedFor.length = 0;
  await connect(a, USER_1);
  await connect(b, USER_1);
  await connect(b, USER_2);
  is("the old login's grant is kept while another store still uses it", [granted.get(USER_1), revokedFor], [true, []]);
  is("that other store still reads Meta", await readMetaSpend(a.statsId!, a.currency), "read");
  await connect(a, USER_2);
  is("once no store uses the old login, its grant is given back", [granted.get(USER_1), revokedFor], [false, [USER_1]]);
  is("the new login still works for both stores", [granted.get(USER_2), await readMetaSpend(b.statsId!, b.currency)], [true, "read"]);

  part("An index that cannot be read keeps the grant");
  revokedFor.length = 0;
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SMEMBERS" && String(c[1]).startsWith("nl:metaads:user:"))) throw new Error("synthetic: connection reset");
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const unknown = await disconnectMeta(a.statsId!);
  redis.pipeline = pipeline as typeof redis.pipeline;
  is("forgotten here, but Meta's grant is kept rather than risk the other store", [unknown && unknown.metaAccess, granted.get(USER_2), revokedFor], ["kept", true, []]);
  is("the other store still reads Meta", await readMetaSpend(b.statsId!, b.currency) !== "broken", true);

  part("A flow that goes stale while Meta is read keeps the grant another store uses (main's late expiry, merged)");
  revokedFor.length = 0;
  staleOnAccounts = true;
  loginAs = USER_2;
  const stale = await finishMeta({ statsId: a.statsId!, sid: a.sid, code: "good-code", redirect, by: a.email, owner: { email: a.email, handle: a.handle }, currency: a.currency, startedAt: Date.now() });
  staleOnAccounts = false;
  is("nothing is kept: the flow expired", stale.ok ? "kept" : stale.error, "expired");
  is("and the login another store still uses keeps its grant at Meta", [granted.get(USER_2), revokedFor], [true, []]);
  skewMs = 0;

  // Codex X4 on #4159 @ec3229d254 (MEDIUM, privacy): before anything is written, the store's own connection on the
  // same login is still a user of the grant. A reconnect that goes stale must not give it back and break that
  // connection, which the studio would still show as connected.
  part("A stale reconnect with the same login keeps the grant the store's own connection still uses");
  await connect(a, USER_1);
  revokedFor.length = 0;
  staleOnAccounts = true;
  loginAs = USER_1;
  const sameStale = await finishMeta({ statsId: a.statsId!, sid: a.sid, code: "good-code", redirect, by: a.email, owner: { email: a.email, handle: a.handle }, currency: a.currency, startedAt: Date.now() });
  staleOnAccounts = false;
  skewMs = 0;
  is("nothing new is kept: the reconnect expired", sameStale.ok ? "kept" : sameStale.error, "expired");
  is("the login's grant is not given back while the store's own connection uses it", [granted.get(USER_1), revokedFor], [true, []]);
  is("and the store's existing connection still reads Meta", await readMetaSpend(a.statsId!, a.currency), "read");
  const after = await disconnectMeta(a.statsId!);
  is("disconnecting it afterward still gives the grant back, once", [after && after.metaAccess, granted.get(USER_1), revokedFor], ["removed", false, [USER_1]]);

  part("What the creator is told");
  const keptLine = accountChangeWords({ kind: "metaads-disconnected", kept: true }).line;
  is("the email never says the permission was given back when it was kept", [/given back/i.test(keptLine), /Another store still uses this Meta login/.test(keptLine), /Disconnect that store too/.test(keptLine)], [false, true, true]);
  is("the usual email still says it was given back", /given back/i.test(accountChangeWords({ kind: "metaads-disconnected" }).line), true);
  const routes = readFileSync("lib/meta-routes.ts", "utf8");
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  is("the route sends a kept disconnect to its own studio notice", routes.includes('kept ? "disconnected-kept" : "disconnected"'), true);
  const at = studio.indexOf('"disconnected-kept": {');
  const notice = at < 0 ? "" : studio.slice(at, at + 400);
  is("and that notice says the permission was kept, not given back", [notice.includes("we kept its permission at Meta"), /given back/i.test(notice)], [true, false]);

  part("What the creator is promised before pressing Disconnect, and what the privacy policy says");
  // Review of #4159 (Claude 1 cloud, MEDIUM): both promised an unconditional give-back, which disconnectMeta now
  // makes only when no other store is confirmed to use the same Meta login.
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const editor = flat(readFileSync("components/ad-spend-editor.tsx", "utf8"));
  const privacy = flat(readFileSync("app/privacy/page.tsx", "utf8"));
  is("the hint beside the button never promises an unconditional give-back", editor.includes("Gives the permission back to Meta and deletes what was read."), false);
  is("it says when the permission goes back", editor.includes("Gives the permission back to Meta only when we can confirm no other store uses this Meta login."), true);
  is("the privacy policy never promises an unconditional give-back", /disconnects from the studio, we give the permission back to Meta and delete/.test(privacy), false);
  is("it says the permission is kept while another store may use the same login", /unless another store still uses the same Meta login, or we cannot confirm that none does/.test(privacy), true);

  done();
}

const report = console.error;
main().catch((error) => {
  report(error);
  process.exit(1);
});
