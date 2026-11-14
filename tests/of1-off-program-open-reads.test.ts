/**
 * Claude 4 (cloud N) on #3573, LOW (cost, MR): `/open` asks `linkOpens` before `withinStore` whenever
 * `takesNewAffiliates(store)` is false, which includes a store whose program is simply switched off, not only a
 * suspended one. An off program refuses every link anyway (`openAffiliateLink` starts with `affiliatesOn`), so an
 * uncounted POST must not read the link or the affiliate records first: it is refused at once as `unavailable`,
 * with no `nl:aff:` read. A suspended store keeps reading `linkOpens`, so an affiliate it already has still signs in.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as openRoute } from "@/app/api/store/affiliates/open/route";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { openAffiliateLink } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setAffiliateSetting, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 })) as typeof fetch;

const HANDLE = "offkiln";
const PAGE = `https://marktmorgen.com/@${HANDLE}/affiliates`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;

const real = redis.pipeline.bind(redis);
let affiliateCommands: string[] = [];
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) if (String(command[1] ?? "").startsWith("nl:aff:")) affiliateCommands.push(`${command[0]} ${command[1]}`);
  return real(commands);
}) as typeof redis.pipeline;

const open = (token: string) =>
  openRoute(
    new NextRequest("https://marktmorgen.com/api/store/affiliates/open", {
      method: "POST",
      headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com", "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.10" },
      body: new URLSearchParams({ handle: HANDLE, token }).toString(),
    }),
  );

async function main(): Promise<void> {
  redis.clear();
  const owner = "of1-off@example.test";
  await claimHandle(owner, HANDLE, "Off Kiln", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  const on = { buyers: true, percent: 10, days: 60, rule: "last", payday: 0, hold: 0, rates: {} };
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, ...on }));
  const load = async () => (await storeForEmail(owner))!;
  const statsId = (await load()).statsId!;
  let tokens = 0;
  const emailed = async (email: string) => {
    const token = String(++tokens).padStart(64, "f");
    await real([["SET", linkKey(token), JSON.stringify({ s: statsId, e: email, n: "" }), "EX", 600]]);
    return token;
  };
  const made = await openAffiliateLink(await load(), await emailed("partner@example.test"));
  if (!made.ok) throw new Error("the affiliate fixture was not created");

  part("A program switched off: /open refuses before reading the link or the affiliate records");
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: false, ...on }));
  const token = await emailed("partner@example.test");
  affiliateCommands = [];
  const response = await open(token);
  is("refused as unavailable, nobody signed in", [response.status, response.headers.get("location"), (response.headers.get("set-cookie") ?? "").includes("=")], [303, `${PAGE}?status=unavailable`, false]);
  is("no command on any affiliate key (no GET of the link, no HGET of the people)", affiliateCommands, []);

  part("Control: a suspended store with the program on still lets an affiliate it has sign in");
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, ...on }));
  await noteTakedown(owner, null, true);
  if (!(await load()).suspended) throw new Error("the store was not switched off");
  const back = await open(await emailed("partner@example.test"));
  is("the plain link of an existing affiliate signs in", [back.headers.get("location"), (back.headers.get("set-cookie") ?? "").includes("Max-Age=")], [`${PAGE}?status=welcome`, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
