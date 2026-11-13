/**
 * A store's own pages are changed on the list as it is when the change is written, never on the copy the request
 * read before it took the store's lock (app/api/store/site-page/route.ts, app/api/store/forms/route.ts).
 *
 * Before, every action built the whole new list from the store read at the start of the request and wrote it over
 * whatever was there: two tabs adding a page at once kept only one; a rename in one tab undid a page added in
 * another; saving a page (seconds of picture checks between the read and the write) brought back a page another tab
 * had removed, after its blocks and pictures were already deleted. Each check sends the real route real requests
 * from the creator's own session, at the same time, against the in-memory store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, setSitePages, storeForEmail } from "@/lib/store";
import { emptyBlock } from "@/lib/sales-page";
import type { SitePage } from "@/lib/site-page-rules";
import { POST as sitePage } from "@/app/api/store/site-page/route";
import { POST as forms } from "@/app/api/store/forms/route";
import { store as redis } from "./redis-stub";

const OWNER = "site-latest@example.com";
const ORIGIN = "https://marktmorgen.com";
const page = (n: number, extra: Partial<SitePage> = {}): SitePage => ({ id: String(n).padStart(10, "0"), slug: `page-${n}`, title: `Page ${n}`, nav: true, target: "", from: -1, ...extra });

async function start(pages: SitePage[], stats = true) {
  redis.clear();
  await claimHandle(OWNER, "sitelatest", "Site latest", "");
  if (stats) await ensureStatsId(OWNER);
  if (pages.length) assert.equal((await setSitePages(OWNER, pages)).ok, true);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  return (body: unknown) => sitePage(new NextRequest(`${ORIGIN}/api/store/site-page`, { method: "POST", headers, body: JSON.stringify(body) }));
}

const pages = async () => (await storeForEmail(OWNER))!.sitePages;
const ok = async (response: Response) => {
  const body = (await response.json()) as { ok: boolean; error?: string };
  assert.equal(body.ok, true, body.error);
};

test("two pages added at the same time are both kept", async () => {
  const post = await start([page(1)]);
  await Promise.all([post({ action: "add", title: "Pricing" }), post({ action: "add", title: "About" })]).then((all) => Promise.all(all.map(ok)));
  assert.deepEqual((await pages()).map((p) => p.title).sort(), ["About", "Page 1", "Pricing"]);
});

test("a rename sent with an addition keeps both", async () => {
  const post = await start([page(1)]);
  await Promise.all([
    post({ action: "meta", id: page(1).id, title: "Renamed", slug: page(1).slug, nav: true, target: "" }),
    post({ action: "add", title: "About" }),
  ]).then((all) => Promise.all(all.map(ok)));
  const now = await pages();
  assert.deepEqual(now.map((p) => p.title).sort(), ["About", "Renamed"]);
});

test("a removal sent with an addition keeps the addition and the removal", async () => {
  const post = await start([page(1), page(2)]);
  await Promise.all([post({ action: "remove", id: page(1).id }), post({ action: "add", title: "About" })]).then((all) => Promise.all(all.map(ok)));
  assert.deepEqual((await pages()).map((p) => p.title).sort(), ["About", "Page 2"]);
});

test("saving a page does not bring back a page removed meanwhile, nor undo another's rename", async () => {
  const post = await start([page(1), page(2), page(3)]);
  const shown = { blocks: [{ ...emptyBlock("hero"), headline: "Hello" }], style: "plain", hidden: false };
  await Promise.all([
    post({ action: "save", id: page(1).id, page: shown }),
    post({ action: "remove", id: page(2).id }),
    post({ action: "meta", id: page(3).id, title: "Renamed", slug: page(3).slug, nav: false, target: "" }),
  ]).then((all) => Promise.all(all.map(ok)));
  const now = await pages();
  assert.deepEqual(now.map((p) => p.id), [page(1).id, page(3).id]);
  assert.equal(now[0].from, 0, "the saved page is out");
  assert.deepEqual([now[1].title, now[1].nav], ["Renamed", false]);
});

test("the address check reads the latest pages: two adds asking for the same address do not both get it", async () => {
  const post = await start([]);
  const answers = await Promise.all([post({ action: "add", title: "One", slug: "same" }), post({ action: "add", title: "Two", slug: "same" })]);
  const bodies = (await Promise.all(answers.map((a) => a.json()))) as { ok: boolean }[];
  assert.equal(bodies.filter((b) => b.ok).length, 1);
  assert.deepEqual((await pages()).map((p) => p.slug), ["same"]);
});

test("an order built from an older list is refused, never written over a page added since", async () => {
  const post = await start([page(1), page(2)]);
  await Promise.all([post({ action: "add", title: "About" }), post({ action: "order", ids: [page(2).id, page(1).id] })]);
  const now = await pages();
  assert.equal(now.length, 3, "the page added is kept whichever came first");
});

test("a removal of a page already removed answers unknown and changes nothing else", async () => {
  const post = await start([page(1), page(2)]);
  const answers = await Promise.all([post({ action: "remove", id: page(1).id }), post({ action: "remove", id: page(1).id })]);
  const statuses = answers.map((a) => a.status).sort();
  assert.deepEqual(statuses, [200, 404]);
  assert.deepEqual((await pages()).map((p) => p.id), [page(2).id]);
});

test("a store given its id by the forms route keeps a page added at the same time", async () => {
  const post = await start([page(1)], false);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  await Promise.all([
    forms(new NextRequest(`${ORIGIN}/api/store/forms`, { method: "POST", headers, body: JSON.stringify({ action: "nothing" }) })),
    post({ action: "add", title: "About" }),
  ]);
  const store = (await storeForEmail(OWNER))!;
  assert.ok(store.statsId);
  assert.deepEqual(store.sitePages.map((p) => p.title).sort(), ["About", "Page 1"]);
});

/**
 * #4253 MEDIUM (Claude 2 nuvem F, confirmed by Claude 1 cloud): a save whose page is removed after the save read the
 * list but before it wrote wrote the page's blocks back under a key no list names (the room charged for good, nothing
 * can free it) and answered "saved". The removal now wins: what the save wrote is dropped, and it answers 404.
 */
test("a save of a page removed while it was saving keeps nothing and says it is gone", async () => {
  const post = await start([page(1), page(2)]);
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const real = redis.pipeline.bind(redis);
  let removing = false;
  // The save reads the page it will write (readPage, a GET of its key) after it read the list: the removal lands then.
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!removing && commands.some((c) => c[0] === "GET" && String(c[1]).endsWith(`site-${page(1).id}`))) {
      removing = true;
      redis.pipeline = real;
      const removed = await post({ action: "remove", id: page(1).id });
      assert.equal(removed.status, 200, "(control) the removal went through");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let answer: Response;
  try {
    answer = await post({ action: "save", id: page(1).id, page: { blocks: [{ ...emptyBlock("hero"), headline: "Hello" }], style: "plain", hidden: false } });
  } finally {
    redis.pipeline = real;
  }
  assert.equal(removing, true, "(control) the removal ran inside the save");
  assert.deepEqual((await pages()).map((p) => p.id), [page(2).id], "the page stays removed");
  assert.equal(redis.run(["EXISTS", `nl:product:page:${statsId}:site-${page(1).id}`]), 0, "nothing of the removed page is written back under its key");
  assert.equal(answer.status, 404, "the save says the page is gone, never saved");
});
