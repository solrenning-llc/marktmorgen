/**
 * Removing a store's own domain, through the real route (review L1 on #2859, Claude 4 team, comments 6696444077 and
 * 6697986104). When Vercel has already dropped the domain but letting its key go here cannot be confirmed, the
 * domain no longer serves the store: the route must not answer "unavailable" (the editor then says "Nothing was
 * changed"), and the store must not keep saying the domain is live (links in emails, the sitemap and affiliate links
 * read `liveAt`). It answers its own "unfinished", clears `liveAt`, keeps the domain on the store so the next press
 * finishes it (Vercel then answers 404 and the key is let go), and the editor says what happened.
 *
 * Synthetic only: Vercel is a stand-in fetch, Redis the in-memory stand-in.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { claimHandle, ensureStoreId, setDomain, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { domainKey } from "@/lib/domains";
import { POST as domainRoute } from "@/app/api/store/domain/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { answer, clearAnswers, type Command } from "./l10b-replies";
import { paidPeriod } from "./billing-period-fixture";

process.env.VERCEL_API_TOKEN = "test-token";
process.env.VERCEL_PROJECT_ID = "prj_remove";
const NAME = "shop.example.com";
const KEY = domainKey(NAME);
const LIVE_AT = "2026-11-01T12:00:00.000Z";

const vercelCalls: string[] = [];
let deleteStatus = 200;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  vercelCalls.push(`${method} ${url.pathname}`);
  return new Response("{}", { status: method === "DELETE" ? deleteStatus : 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
const vercelDelete = `DELETE /v9/projects/prj_remove/domains/${NAME}`;
/** The pipeline that lets the domain's key go: a DEL or a script naming the key. */
const letGo = (c: Command) => (c[0] === "DEL" || c[0] === "EVAL") && c.some((x) => String(x) === KEY);

async function main(): Promise<void> {
  const owner = "removedomain@example.com";
  const setUp = async () => {
    redis.clear();
    clearAnswers();
    vercelCalls.length = 0;
    deleteStatus = 200;
    await claimHandle(owner, "mystore", "My Store", "");
    await ensureStoreId(owner);
    await setSubscription(owner, { customerId: "cus_rm", subscriptionId: "sub_rm", active: true, tier: "scale", period: paidPeriod() });
    await setDomain(owner, { name: NAME, addedAt: "2026-10-30T12:00:00.000Z", liveAt: LIVE_AT });
    redis.run(["SET", KEY, "mystore"]);
    return openSession(owner);
  };
  const remove = async (session: string) => {
    const response = await domainRoute(new NextRequest("https://marktmorgen.com/api/store/domain", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "remove" }) }));
    return { status: response.status, error: ((await response.json()) as { error?: string }).error };
  };
  const domainNow = async () => (await storeForEmail(owner))?.domain ?? null;

  part("Vercel dropped the domain, the let-go's reply lost");
  let session = await setUp();
  answer(letGo, () => [], { run: false });
  const lost = await remove(session);
  is("its own answer, not unavailable; Vercel was asked to drop it", [lost.error, lost.status, vercelCalls], ["unfinished", 502, [vercelDelete]]);
  is("the domain kept on the store for the next press, no longer said to be live", [(await domainNow())?.name, (await domainNow())?.liveAt], [NAME, ""]);
  is("the key kept for the next press", redis.run(["GET", KEY]), "mystore");

  part("Vercel refusing the drop: nothing changed");
  session = await setUp();
  deleteStatus = 500;
  const refused = await remove(session);
  is("unavailable, the domain and its live date kept", [refused.error, refused.status, (await domainNow())?.liveAt, redis.run(["GET", KEY])], ["unavailable", 502, LIVE_AT, "mystore"]);

  part("The editor's words");
  const editor = readFileSync("components/domain-editor.tsx", "utf8");
  const said = (code: string) => editor.match(new RegExp(`\\n  ${code}: "([^"]*)"`))?.[1] ?? "";
  is("unfinished has its own message, which never says nothing was changed", [said("unfinished") !== "", /nothing was changed/i.test(said("unfinished"))], [true, false]);
  is("unavailable still says nothing was changed", /Nothing was changed/.test(said("unavailable")), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
