/**
 * Two suppliers whose answers the studio shows (CX-123 rule 24, Claude 5,
 * 05/11/2026), read only in their exact shape:
 *
 *   - Search Console: a store's searches. Google leaves `rows` out when there
 *     are none, which is no searches; anything else out of shape (not an
 *     object, `rows` not a list, a row whose clicks, times shown or place is
 *     not a number) is not known, never 0 clicks or no searches.
 *   - Discord: the roles a creator may link to a product. A role whose place
 *     in the server is not a whole number is not offered (it could sit above
 *     the bot, which then cannot give it); when the bot's own roles cannot be
 *     read, the server's roles are not known, never "none within reach".
 *
 * Synthetic only.
 */
import { readRows, storeSearches } from "@/lib/search-console";
import { store as redis } from "./redis-stub";
import { serverRoles } from "@/lib/discord";
import { done, is, part } from "./check";

const SERVER = "111111111111111111";
const BOT = "222222222222222222";
let roles: unknown = [];
let memberStatus = 200;

process.env.DISCORD_BOT_TOKEN = "test-bot-token";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret-for-tests";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.pathname.endsWith(`/guilds/${SERVER}/roles`)) return json(roles);
  if (url.pathname.endsWith("/users/@me")) return json({ id: BOT, username: "bot" });
  if (url.pathname.endsWith(`/guilds/${SERVER}/members/${BOT}`)) return memberStatus === 200 ? json({ roles: ["333333333333333333"] }) : json({ message: "down" }, memberStatus);
  return json({ message: "unexpected" }, 404);
}) as typeof fetch;

const throws = (f: () => unknown) => {
  try {
    f();
    return "read";
  } catch {
    return "not known";
  }
};

async function main(): Promise<void> {
  console.error = () => {};
  part("Search Console rows");
  is("no rows at all is no searches", readRows({ responseAggregationType: "byProperty" }), []);
  is("a real row", readRows({ rows: [{ keys: ["meal planner"], clicks: 3, impressions: 40, position: 7.84 }] }), [{ query: "meal planner", clicks: 3, impressions: 40, position: 7.8 }]);
  is("an answer that is not an object", throws(() => readRows("<html>")), "not known");
  is("rows that are not a list", throws(() => readRows({ rows: { keys: ["a"] } })), "not known");
  is("clicks that are not a number", throws(() => readRows({ rows: [{ keys: ["a"], clicks: "lots", impressions: 5, position: 1 }] })), "not known");
  is("times shown missing", throws(() => readRows({ rows: [{ keys: ["a"], clicks: 1, position: 1 }] })), "not known");
  is("a place that is not a number", throws(() => readRows({ rows: [{ keys: ["a"], clicks: 1, impressions: 5, position: null }] })), "not known");
  // Review of Codex J on #2684: a row without its search as text is not "no search".
  for (const keys of [undefined, null, [], [42]]) {
    is(`keys ${JSON.stringify(keys) ?? "missing"}`, throws(() => readRows({ rows: [{ ...(keys === undefined ? {} : { keys }), clicks: 1, impressions: 5, position: 1 }] })), "not known");
  }

  part("A store's searches kept a day, read back only in their shape (Codex T on #2684)");
  const shop = { statsId: "gscshape01", handle: "shapes", domain: null } as never;
  const kept = { from: "2026-10-01", to: "2026-10-28", rows: [{ query: "meal planner", clicks: 3, impressions: 40, position: 7.8 }] };
  await redis.pipeline([["SET", "nl:gsc:q:gscshape01", JSON.stringify(kept)]]);
  is("a kept answer is used as it is", await storeSearches(shop), kept);
  await redis.pipeline([["SET", "nl:gsc:q:gscshape01", "null"]]);
  is("a kept 'Google did not answer' is used as it is", await storeSearches(shop), null);
  for (const bad of ["{}", "[]", JSON.stringify({ ...kept, rows: "x" }), JSON.stringify({ ...kept, rows: [{ query: 1 }] }), JSON.stringify({ ...kept, from: 5 })]) {
    await redis.pipeline([["SET", "nl:gsc:q:gscshape01", bad]]);
    // Not connected here, so the read again ends at null: never the malformed value.
    is(`kept ${bad.slice(0, 30)}: never shown as searches`, await storeSearches(shop), null);
  }

  part("Discord roles");
  const role = (id: string, position: unknown) => ({ id, name: `Role ${id.slice(0, 3)}`, color: 0, position, managed: false });
  roles = [role("333333333333333333", 5), role("444444444444444444", 2), role("555555555555555555", "high")];
  const read = await serverRoles(SERVER);
  is("the bot's place is its own role's", read?.botTop, 5);
  is("a role whose place is not a whole number is not offered", read?.roles.map((r) => r.id).sort(), ["333333333333333333", "444444444444444444"]);
  // Review of Codex J on #2684: whether Discord manages a role (a bot's or an integration's, never given by hand)
  // is only Discord's own true or false.
  for (const managed of [undefined, null, "true"]) {
    roles = [role("333333333333333333", 5), { id: "666666666666666666", name: "Odd", color: 0, position: 2, ...(managed === undefined ? {} : { managed }) }];
    const odd = await serverRoles(SERVER);
    is(`managed ${JSON.stringify(managed) ?? "missing"}: not offered`, odd?.roles.some((r) => r.id === "666666666666666666"), false);
  }
  memberStatus = 500;
  is("the bot's own roles not read: the roles are not known", await serverRoles(SERVER), null);
  done();
}

void main();
