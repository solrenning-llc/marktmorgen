/**
 * 766 [STN13], unit 1: the studio's search route (app/api/store/studio-search)
 * with two stores, a team and the Redis stand-in. A store's search answers
 * only from that store, only what the person's role may open; it is counted
 * before it reads, refused past its minute and its day without reading, reads
 * the product names in one exact command and never fills them in from the
 * products' own records; an unread answer is said, never shown as "nothing";
 * nothing is written to the team's log or printed.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSitePages, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { putMember, readLog } from "@/lib/team";
import { allowanceUsedExact, takeAllowance } from "@/lib/store-allowance";
import { STUDIO_SEARCH_UNITS } from "@/lib/studio-allowance-rules";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { SEARCHES_PER_DAY, SEARCHES_PER_MINUTE } from "@/lib/studio-search-rules";
import { POST as searchRoute } from "@/app/api/store/studio-search/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Group = { id: string; title: string; state: string; missing: number; results: { id: string; title: string; detail: string; href: string }[] };
type Answer = { ok?: boolean; error?: string; message?: string; groups?: Group[] };

const seen: (string | number)[][] = [];
let twist: ((command: (string | number)[]) => unknown) | null = null;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  seen.push(...commands);
  const replies = await realPipeline(commands);
  if (!twist) return replies;
  return replies.map((reply: unknown, i: number) => {
    const changed = twist!(commands[i]);
    return changed === undefined ? reply : changed;
  });
}) as typeof redis.pipeline;

const limiterKey = (scope: string, who: string) => `nl:rl:${scope}:${createHash("sha256").update(`nimbus-${scope}:${who}`).digest("hex").slice(0, 32)}`;

async function main(): Promise<void> {
  redis.clear();
  const ownerA = "search-a@example.com";
  const ownerB = "search-b@example.com";
  await claimHandle(ownerA, "searcha", "Search A", "");
  await claimHandle(ownerB, "searchb", "Search B", "");
  for (const owner of [ownerA, ownerB]) {
    await ensureStatsId(owner);
    await ensureStoreId(owner);
    await setSubscription(owner, { customerId: `cus_${owner.slice(7, 8)}`, subscriptionId: `sub_${owner.slice(7, 8)}`, active: true, tier: "creator", period: paidPeriod() });
  }
  // Store A: 26 products, so the last two are past the first page the store record holds and are read by name.
  for (let i = 1; i <= 24; i += 1) await addProduct(ownerA, `Recipe card ${i}`, "", "5", null);
  await addProduct(ownerA, "Alpha Notion Planner", "", "19", null);
  await addProduct(ownerA, "Alpha Sourdough Course", "", "49", null);
  await addProduct(ownerB, "Alpha Secret of B", "", "9", null);
  await setSitePages(ownerA, [{ id: "abcdefghij", slug: "about", title: "About Alpha", nav: true, target: "", from: 0 }]);
  const a = (await storeForEmail(ownerA))!;
  const b = (await storeForEmail(ownerB))!;
  const catalogA = a.catalog.id!;
  const catalogB = b.catalog.id!;

  const sessions: Record<string, string> = {};
  const sessionOf = async (email: string) => (sessions[email] ??= await openSession(email));
  const ask = async (email: string, q: unknown, options: { store?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${await sessionOf(email)}`, ...(options.headers ?? {}) };
    if (options.store !== undefined) headers["x-nimbus-store"] = options.store;
    const response = await searchRoute(new NextRequest("https://marktmorgen.com/api/store/studio-search", { method: "POST", headers, body: JSON.stringify({ q }) }));
    return { status: response.status, cache: response.headers.get("cache-control"), body: (await response.json().catch(() => ({}))) as Answer };
  };
  const group = (answer: Answer, id: string) => answer.groups?.find((g) => g.id === id);
  const ids = (answer: Answer, id: string) => group(answer, id)?.results.map((r) => r.id) ?? [];
  const resetLimits = async () => {
    for (const store of [a, b]) for (const scope of ["studio-search", "studio-search-day"]) await realPipeline([["DEL", limiterKey(scope, store.sid)]]);
  };

  part("Only the store's own data");
  const alphaId = a.catalog.items[24].id;
  const sourId = a.catalog.items[25].id;
  seen.length = 0;
  const own = await ask(ownerA, "alpha", { store: a.sid });
  is("answered", [own.status, own.body.ok, own.cache], [200, true, "no-store"]);
  is("A's two products past the first page, found by name", ids(own.body, "products"), [alphaId, sourId]);
  is("A's own page", ids(own.body, "pages"), ["abcdefghij"]);
  is("every link stays on store A", (own.body.groups ?? []).every((g) => g.results.every((r) => r.href.includes(`store=${a.sid}`))), true);
  is("a product opens its sales page", group(own.body, "products")?.results[0]?.href, `/studio/pages?store=${a.sid}&product=${alphaId}`);
  is("a page opens its editor", group(own.body, "pages")?.results[0]?.href, `/studio/site?store=${a.sid}&page=abcdefghij`);
  is("B's product is never in A's answer", JSON.stringify(own.body).includes("Secret of B"), false);
  is("no command touched B's products", seen.some((c) => c.some((part) => typeof part === "string" && part.includes(catalogB))), false);
  const other = await ask(ownerA, "alpha", { store: b.sid });
  is("asking for a store you cannot open is refused, never answered from another", [other.status, other.body.error], [409, "store_gone"]);

  part("What each role may see");
  await putMember(a, "editor@example.com", "editor");
  await putMember(a, "support@example.com", "support");
  await putMember(a, "admin@example.com", "admin");
  await resetLimits();
  seen.length = 0;
  const support = await ask("support@example.com", "alpha", { store: a.sid });
  is("support: no products, no pages", [support.status, group(support.body, "products"), group(support.body, "pages")], [200, undefined, undefined]);
  is("support: no product names read at all", seen.some((c) => c[0] === "HMGET"), false);
  const supportTools = await ask("support@example.com", "inbox", { store: a.sid });
  is("support finds the Inbox tool, and no tool outside its role", [ids(supportTools.body, "tools").includes("inbox"), (await ask("support@example.com", "sales pages", { store: a.sid })).body.groups?.flatMap((g) => g.results.map((r) => r.id)).includes("pages")], [true, false]);
  const editor = await ask("editor@example.com", "alpha", { store: a.sid });
  is("editor: products and pages", [ids(editor.body, "products").length, ids(editor.body, "pages").length], [2, 1]);
  const editorTools = await ask("editor@example.com", "buyers", { store: a.sid });
  is("editor: the Buyers tool is not offered", ids(editorTools.body, "tools").includes("people"), false);
  const admin = await ask("admin@example.com", "buyers", { store: a.sid });
  is("admin: the Buyers tool is offered", ids(admin.body, "tools").includes("people"), true);
  is("a tool opens its own screen on the store", group(admin.body, "tools")?.results.find((r) => r.id === "people")?.href, `/studio/people?store=${a.sid}`);
  is("searching wrote nothing to the team's log", (await readLog(a.sid)).length, 0);

  part("Counted before it reads");
  await resetLimits();
  const before = await allowanceUsedExact(a, "studio");
  await ask(ownerA, "planner", { store: a.sid });
  is(`a search is ${STUDIO_SEARCH_UNITS} of the store's studio requests`, (await allowanceUsedExact(a, "studio"))! - before!, STUDIO_SEARCH_UNITS);

  part("The minute's and the day's ceilings");
  await resetLimits();
  await realPipeline([["SET", limiterKey("studio-search", a.sid), String(SEARCHES_PER_MINUTE), "EX", 60]]);
  seen.length = 0;
  const slow = await ask(ownerA, "planner", { store: a.sid });
  is("past the minute's searches: refused, nothing read", [slow.status, slow.body.error, seen.some((c) => c[0] === "HMGET")], [429, "slow", false]);
  await resetLimits();
  await realPipeline([["SET", limiterKey("studio-search-day", a.sid), String(SEARCHES_PER_DAY), "EX", 86_400]]);
  seen.length = 0;
  const day = await ask(ownerA, "planner", { store: a.sid });
  is("past the day's searches: refused, nothing read", [day.status, day.body.error, seen.some((c) => c[0] === "HMGET")], [429, "day", false]);
  await resetLimits();
  twist = (command) => (command[0] === "INCR" && String(command[1]).startsWith("nl:rl:studio-search:") ? "many" : undefined);
  seen.length = 0;
  const unknownCount = await ask(ownerA, "planner", { store: a.sid });
  twist = null;
  is("a counter that cannot be read: refused, nothing read", [unknownCount.status, unknownCount.body.error, seen.some((c) => c[0] === "HMGET")], [503, "unknown", false]);

  part("A refused search takes none of the store's studio requests");
  await resetLimits();
  const usedFirst = (await allowanceUsedExact(a, "studio"))!;
  const statuses: number[] = [];
  for (let i = 0; i < SEARCHES_PER_MINUTE + 10; i += 1) statuses.push((await ask(ownerA, "planner", { store: a.sid })).status);
  is(`${SEARCHES_PER_MINUTE} answered, 10 refused for the minute`, [statuses.filter((s) => s === 200).length, statuses.filter((s) => s === 429).length], [SEARCHES_PER_MINUTE, 10]);
  is(`${SEARCHES_PER_MINUTE + 10} searches use exactly ${SEARCHES_PER_MINUTE} × ${STUDIO_SEARCH_UNITS}`, (await allowanceUsedExact(a, "studio"))! - usedFirst, SEARCHES_PER_MINUTE * STUDIO_SEARCH_UNITS);
  await resetLimits();
  await realPipeline([["SET", limiterKey("studio-search-day", a.sid), String(SEARCHES_PER_DAY), "EX", 86_400]]);
  const usedDay = (await allowanceUsedExact(a, "studio"))!;
  const pastDay = await ask(ownerA, "planner", { store: a.sid });
  is("past the day's searches: refused, nothing taken", [pastDay.status, pastDay.body.error, (await allowanceUsedExact(a, "studio"))! - usedDay], [429, "day", 0]);
  await resetLimits();
  const usedUnknown = (await allowanceUsedExact(a, "studio"))!;
  twist = (command) => (command[0] === "INCR" && String(command[1]).startsWith("nl:rl:studio-search") ? "many" : undefined);
  const unreadCounter = await ask(ownerA, "planner", { store: a.sid });
  twist = null;
  is("a counter that cannot be read: refused, nothing taken", [unreadCounter.status, unreadCounter.body.error, (await allowanceUsedExact(a, "studio"))! - usedUnknown], [503, "unknown", 0]);

  part("The studio's own refusal, with its reason");
  await resetLimits();
  twist = (command) => (command[0] === "INCRBY" ? "many" : undefined);
  seen.length = 0;
  const uncounted = await ask(ownerA, "planner", { store: a.sid });
  twist = null;
  is("studio requests that cannot be counted: 503 'unknown', never 'used', nothing read", [uncounted.status, uncounted.body.error, seen.some((c) => c[0] === "HMGET")], [503, "unknown", false]);

  part("A store whose studio requests are used");
  await resetLimits();
  const ownerC = "search-c@example.com";
  await claimHandle(ownerC, "searchc", "Search C", "");
  await ensureStatsId(ownerC);
  await ensureStoreId(ownerC);
  const c = (await storeForEmail(ownerC))!;
  const used = (await allowanceUsedExact(c, "studio"))!;
  await takeAllowance(c, "studio", allowanceFor(c, "studio") - used - 1);
  seen.length = 0;
  const spent = await ask(ownerC, "planner", { store: c.sid });
  is("refused with the studio's own words, nothing read", [spent.status, spent.body.error, typeof spent.body.message === "string" && spent.body.message.length > 0, seen.some((cmd) => cmd[0] === "HMGET")], [429, "studio_used", true, false]);

  part("Product names read exactly, never filled in");
  await resetLimits();
  twist = (command) => (command[0] === "HMGET" ? "garbled" : undefined);
  const unread = await ask(ownerA, "alpha", { store: a.sid });
  twist = null;
  is("an unread answer is 'unknown', never 'nothing'", [unread.status, group(unread.body, "products")?.state, group(unread.body, "products")?.results.length], [200, "unknown", 0]);
  is("the store's pages are still answered", ids(unread.body, "pages"), ["abcdefghij"]);
  await realPipeline([["HSET", `nl:catalog:${catalogA}:t`, sourId, "old shape"]]);
  await realPipeline([["HDEL", `nl:catalog:${catalogA}:t`, alphaId]]);
  seen.length = 0;
  const partial = await ask(ownerA, "alpha", { store: a.sid });
  is("cards missing: 'partial' with how many, none shown", [group(partial.body, "products")?.state, group(partial.body, "products")?.missing, ids(partial.body, "products")], ["partial", 2, []]);
  is("one HMGET, no product record read, nothing written back", [
    seen.filter((c) => c[0] === "HMGET").length,
    seen.some((c) => c[0] === "GET" && String(c[1]).startsWith(`nl:catalog:${catalogA}:l:`)),
    seen.some((c) => c[0] === "HSET" && String(c[1]) === `nl:catalog:${catalogA}:t`),
  ], [1, false, false]);

  part("What is refused before anything is read");
  await resetLimits();
  for (const bad of ["a", "", 7, "ana@example.com", "x".repeat(81)]) {
    seen.length = 0;
    const refused = await ask(ownerA, bad, { store: a.sid });
    is(`${JSON.stringify(bad).slice(0, 20)}: 400 with no command`, [refused.status, refused.body.error, seen.length], [400, "query", 0]);
  }
  seen.length = 0;
  const crossSite = await ask(ownerA, "alpha", { store: a.sid, headers: { "sec-fetch-site": "cross-site" } });
  is("from another site: 403 with no command", [crossSite.status, seen.length], [403, 0]);
  const signedOut = await searchRoute(new NextRequest("https://marktmorgen.com/api/store/studio-search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "alpha" }) }));
  is("signed out: 401", signedOut.status, 401);

  part("Nothing printed");
  const printed: string[] = [];
  const keep = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const name of ["log", "error", "warn", "info"] as const) console[name] = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  twist = (command) => (command[0] === "HMGET" ? "garbled" : undefined);
  await ask(ownerA, "zebra quiet words", { store: a.sid });
  twist = null;
  Object.assign(console, keep);
  is("the words searched for are never printed", printed.some((line) => line.includes("zebra quiet words")), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
