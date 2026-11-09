/**
 * 767 [STN14], unit 3: saved sales filters per store (lib/sales-filters.ts,
 * app/api/store/sales-filters/route.ts), through the real route, session and
 * store, on the in-memory Redis.
 *
 *   - A filter is saved under a name as the page's own address (filterQuery), listed by name, renamed and
 *     deleted. A name already used, a filter that keeps nothing out and a buyer's address are refused, in words
 *     that say what to do; nothing is written by a refusal.
 *   - A store keeps at most MAX_SAVED_FILTERS: a storage bound the same on every plan, refused past it.
 *   - Only the store's team members who may read the orders (owner, admin, support) reach it; an editor does not.
 *   - Rule 24: a list Redis answers in another shape, or a kept filter that is not one, is "could not be read"
 *     (503), never "no saved filters"; a write or a deletion whose answer is not the exact one is an error, never
 *     "saved" or "gone".
 */
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/sales-filters/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { UnknownReplyError } from "@/lib/redis-reply";
import { EMPTY_FILTER, MAX_SAVED_FILTERS, MAX_SAVED_FILTER_NAME, SAVED_FILTER_REFUSALS, filterFromQuery, parseSavedFilter, savedFilterName } from "@/lib/sales-filter-rules";
import { readSavedFilters, removeSalesFilter, renameSalesFilter, saveSalesFilter } from "@/lib/sales-filters";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Saved = { id: string; name: string; query: string };
type Reply = { ok?: boolean; error?: string; message?: string; filters?: Saved[]; most?: number; filter?: Saved };

async function threw(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "no error";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown reply" : "other error";
  }
}

/** Runs `run` while Redis answers every pipeline with `reply`. */
async function answering<T>(reply: unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async () => reply) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("The rules: a name, a filter read from the page's address, a kept filter read exactly");
  is("a name: spaces collapsed, control characters out, cut at the most", savedFilterName(`  Big\n\t ${"x".repeat(80)}  `), `Big ${"x".repeat(MAX_SAVED_FILTER_NAME - 4)}`);
  is("not a name", [savedFilterName(42), savedFilterName("   ")], ["", ""]);
  is("a filter from the address", filterFromQuery("product=Course&from=2026-01-01&kind=products"), { ...EMPTY_FILTER, product: "Course", from: "2026-01-01", kind: "products" });
  is("a field given twice is not guessed", filterFromQuery("product=a&product=b").product, "");
  const good = { id: "0123456789ab", name: "Courses", query: "product=Course&kind=products" };
  is("a kept filter read as kept", parseSavedFilter(JSON.stringify(good)), good);
  for (const [what, raw] of [
    ["not text", 42],
    ["not JSON", "{"],
    ["a list", "[]"],
    ["an id of another shape", JSON.stringify({ ...good, id: "x" })],
    ["no name", JSON.stringify({ ...good, name: "" })],
    ["a name not as saved", JSON.stringify({ ...good, name: " Courses " })],
    ["an address not as saved", JSON.stringify({ ...good, query: "kind=products&product=Course" })],
    ["a filter that keeps nothing out", JSON.stringify({ ...good, query: "" })],
    ["a buyer's address", JSON.stringify({ ...good, query: "email=jane%40example.com" })],
    ["a field more", JSON.stringify({ ...good, extra: 1 })],
  ] as const) {
    is(`never a filter: ${what}`, parseSavedFilter(raw), null);
  }

  redis.clear();
  const owner = "filters@example.com";
  await claimHandle(owner, "filtershop", "Filter Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_filters", subscriptionId: "sub_filters", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  const key = `nl:sales:filters:${statsId}`;

  part("Saved, listed by name, renamed, deleted (lib/sales-filters.ts)");
  is("none yet: an empty list, confirmed", await readSavedFilters(statsId), []);
  const courses = await saveSalesFilter(statsId, "Courses", filterFromQuery("product=Course&kind=products"));
  is("saved", courses.ok && [courses.filter.name, courses.filter.query], ["Courses", "product=Course&kind=products"]);
  const april = await saveSalesFilter(statsId, "april", filterFromQuery("from=2026-04-01&to=2026-04-30"));
  is("listed by name, any case", (await readSavedFilters(statsId)).map((f) => f.name), ["april", "Courses"]);
  is("a name already used refused, any case", await saveSalesFilter(statsId, "COURSES", filterFromQuery("kind=tips")), { ok: false, reason: "taken" });
  is("a filter that keeps nothing out refused", await saveSalesFilter(statsId, "All", EMPTY_FILTER), { ok: false, reason: "empty" });
  is("a buyer's address never kept", await saveSalesFilter(statsId, "Jane", filterFromQuery("email=jane@example.com")), { ok: false, reason: "email" });
  is("no name refused", await saveSalesFilter(statsId, "  ", filterFromQuery("kind=tips")), { ok: false, reason: "name" });
  is("nothing written by a refusal", (await readSavedFilters(statsId)).length, 2);
  const id = courses.ok ? courses.filter.id : "";
  const renamed = await renameSalesFilter(statsId, id, "My courses");
  is("renamed, its filter kept", renamed.ok && renamed.filter, { id, name: "My courses", query: "product=Course&kind=products" });
  is("renamed to a name another one has: refused", await renameSalesFilter(statsId, id, "APRIL"), { ok: false, reason: "taken" });
  is("renamed to its own name in another case: kept", (await renameSalesFilter(statsId, id, "my Courses")).ok, true);
  is("a filter that is gone is not renamed", await renameSalesFilter(statsId, "ffffffffffff", "Other"), { ok: false, reason: "gone" });
  is("deleted", await removeSalesFilter(statsId, id), true);
  is("deleted again: already gone", await removeSalesFilter(statsId, id), false);
  is("an id of another shape removes nothing", await removeSalesFilter(statsId, "../x"), false);
  is("the other one stays", (await readSavedFilters(statsId)).map((f) => f.name), ["april"]);

  part("A store keeps at most MAX_SAVED_FILTERS, the same on every plan");
  for (let n = 1; n < MAX_SAVED_FILTERS; n += 1) await saveSalesFilter(statsId, `Filter ${n}`, filterFromQuery(`kind=tips&product=p${n}`));
  is("up to the most", (await readSavedFilters(statsId)).length, MAX_SAVED_FILTERS);
  is("one more refused", await saveSalesFilter(statsId, "One more", filterFromQuery("kind=calls")), { ok: false, reason: "full" });
  is("and not kept", (await readSavedFilters(statsId)).length, MAX_SAVED_FILTERS);
  is("the words do not call it a plan limit", /plan|upgrade/i.test(SAVED_FILTER_REFUSALS.full), false);

  part("Rule 24: an answer of another shape is never no filters, never saved, never gone");
  is("a list that is not a list", await threw(() => answering([7], () => readSavedFilters(statsId))), "unknown reply");
  is("no answer at all", await threw(() => answering([], () => readSavedFilters(statsId))), "unknown reply");
  is("a kept value that is not text", await threw(() => answering([[42]], () => readSavedFilters(statsId))), "unknown reply");
  is("a kept value that is not a filter", await threw(() => answering([["{"]], () => readSavedFilters(statsId))), "unknown reply");
  is("a deletion answered in another shape", await threw(() => answering(["1"], () => removeSalesFilter(statsId, "0123456789ab"))), "unknown reply");
  is("a write answered in another shape", await threw(() => answering(["1"], () => saveSalesFilter(statsId, "Calls", filterFromQuery("kind=calls")))), "unknown reply");
  await redis.pipeline([["DEL", key]]);
  is("a write answered with the list then not the script's number", await threw(async () => {
    const original = redis.pipeline;
    let calls = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => (calls++ === 0 ? original.call(redis, commands) : ["OK"])) as typeof redis.pipeline;
    try {
      return await saveSalesFilter(statsId, "Calls", filterFromQuery("kind=calls"));
    } finally {
      redis.pipeline = original;
    }
  }), "unknown reply");
  await redis.pipeline([["SET", key, "not a hash"]]);
  is("a key of another kind is never an empty list", await threw(() => readSavedFilters(statsId)), "unknown reply");
  await redis.pipeline([["DEL", key]]);

  part("The studio's route (app/api/store/sales-filters)");
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const url = "https://marktmorgen.com/api/store/sales-filters";
  const post = async (body: Record<string, unknown>, as = cookie, extra: Record<string, string> = {}) => {
    const response = await POST(new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie: as, ...extra }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const list = async (as = cookie) => {
    const response = await GET(new NextRequest(url, { headers: { "x-nimbus-store": store.sid, cookie: as } }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  is("none yet, with the most a store keeps", [(await list()).status, (await list()).body.filters, (await list()).body.most], [200, [], MAX_SAVED_FILTERS]);
  const saved = await post({ action: "save", name: "Tips", query: "kind=tips" });
  is("saved from the page's address", [saved.status, saved.body.filters?.map((f) => [f.name, f.query])], [200, [["Tips", "kind=tips"]]]);
  const refused = await post({ action: "save", name: "Jane", query: "email=jane%40example.com" });
  is("an address refused, saying what to do", [refused.status, refused.body.error, refused.body.message], [400, "email", SAVED_FILTER_REFUSALS.email]);
  const tipsId = saved.body.filters?.[0]?.id ?? "";
  is("renamed", (await post({ action: "rename", id: tipsId, name: "Tips only" })).body.filters?.map((f) => f.name), ["Tips only"]);
  const gone = await post({ action: "rename", id: "ffffffffffff", name: "Other" });
  is("a filter that is gone: 404, saying so", [gone.status, gone.body.error, gone.body.message], [404, "gone", SAVED_FILTER_REFUSALS.gone]);
  is("deleted", (await post({ action: "remove", id: tipsId })).body.filters, []);
  is("an action that is not one", (await post({ action: "learn" })).body.error, "unknown");
  is("from another site: refused", (await post({ action: "save", name: "X", query: "kind=tips" }, cookie, { origin: "https://evil.example" })).status, 403);
  is("no session: refused", (await post({ action: "save", name: "X", query: "kind=tips" }, "")).status, 401);

  part("Team roles: the people who may read the orders, and no one else");
  const helper = "support@example.com";
  const writer = "editor@example.com";
  await putMember(store, helper, "support");
  await putMember(store, writer, "editor");
  const helperCookie = `${SESSION_COOKIE}=${await openSession(helper)}`;
  const writerCookie = `${SESSION_COOKIE}=${await openSession(writer)}`;
  is("support reads and saves", [(await list(helperCookie)).status, (await post({ action: "save", name: "Calls", query: "kind=calls" }, helperCookie)).status], [200, 200]);
  is("an editor does not see the orders, nor their filters", [(await list(writerCookie)).status, (await post({ action: "save", name: "Trials", query: "kind=trials" }, writerCookie)).status], [403, 403]);
  is("and nothing an editor sent was kept", (await readSavedFilters(statsId)).map((f) => f.name), ["Calls"]);

  part("Could not be read: said so, never none, never written over");
  await redis.pipeline([["DEL", key], ["SET", key, "not a hash"]]);
  const unread = await list();
  is("503 with plain words, no list", [unread.status, unread.body.error, unread.body.filters, unread.body.message], [503, "unavailable", undefined, SAVED_FILTER_REFUSALS.unavailable]);
  const blind = await post({ action: "save", name: "Products", query: "kind=products" });
  is("a save then refused, 503", [blind.status, blind.body.error], [503, "unavailable"]);
  is("and the key left as it was", (await redis.pipeline([["GET", key]]))[0], "not a hash");

  done();
}

void main();
