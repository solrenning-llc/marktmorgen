/**
 * writePage reads the page as it was (GET page, LLEN versions, LINDEX oldest) before it writes the new one: that read
 * decides whether the old page is kept as a version (the creator's undo), which saved-section uses are taken off
 * (SREM) and whether an ended headline test is counted. An answer in an unknown shape (no reply, too few, a slot that
 * is not a text, null or a count) is not "no page before": it throws before anything is written or counted, so the
 * page, its versions and its section uses stay as they were (Claude 5's review of #2830, rule 30; CX-123 rule 24).
 * The two studio routes that save a page say so in words, never a page saved or a vague failure.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { readVersions, writePage } from "@/lib/sales-page-store";
import { emptyBlock, parsePage, type PageBlock } from "@/lib/sales-page";
import { sectionUsesKey } from "@/lib/saved-block-store";
import { siteKey } from "@/lib/site-page-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as savePage } from "@/app/api/store/page/route";
import { POST as siteRoute } from "@/app/api/store/site-page/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "c5-write-before@example.com";
const ORIGIN = "https://marktmorgen.com";
const SECTION = "sect000001";

const cta = (label: string, saved = ""): PageBlock => ({ ...(emptyBlock("cta") as Extract<PageBlock, { kind: "cta" }>), label, ...(saved ? { saved } : {}) });

/** Whether a pipeline is writePage's own read of the page as it was. */
const isBeforeRead = (commands: (string | number)[][]) =>
  commands.length === 3 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:product:page:") && commands[1][0] === "LLEN" && commands[2][0] === "LINDEX";

/** Runs `act` with writePage's read of the page as it was answered by `shape` (given the true replies). */
async function withBeforeRead<T>(shape: (replies: unknown[]) => unknown, act: () => Promise<T>): Promise<{ result: T | null; error: unknown; changed: number }> {
  const original = redis.pipeline;
  let changed = 0;
  redis.pipeline = async (commands) => {
    const replies = await original.call(redis, commands);
    if (!isBeforeRead(commands)) return replies;
    changed += 1;
    return shape(replies as unknown[]) as typeof replies;
  };
  try {
    return { result: await act(), error: null, changed };
  } catch (error) {
    return { result: null, error, changed };
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "c5before", "C5 before", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const shop = (await storeForEmail(OWNER))!;
  const statsId = shop.statsId!;
  const product = made.product.id;
  const raw = async (key: string) => (await redis.pipeline([["GET", key]]))[0];
  const uses = async () => ((await redis.pipeline([["SMEMBERS", sectionUsesKey(statsId, SECTION)]]))[0] as string[]).slice().sort();

  part("Control: a healthy save keeps the page as it was and moves the section's use");
  await writePage(statsId, product, parsePage({ blocks: [cta("First", SECTION)] }), shop);
  await writePage(statsId, product, parsePage({ blocks: [cta("Second", SECTION)] }), shop);
  is("the page carrying the section is written down as a use", await uses(), [product]);
  const healthy = (await readVersions(statsId, product)).length;
  await writePage(statsId, product, parsePage({ blocks: [cta("Third", SECTION)] }), shop);
  is("a healthy save pushes one version", (await readVersions(statsId, product)).length, healthy + 1);

  part("An unknown answer to the read of the page as it was writes nothing");
  const shapes: [string, (replies: unknown[]) => unknown][] = [
    ["no replies", () => []],
    ["one reply too few", (replies) => replies.slice(0, 2)],
    ["one reply too many", (replies) => [...replies, "OK"]],
    ["not a list", () => "OK"],
    ["the page is a number", (replies) => [5, replies[1], replies[2]]],
    ["the page is a list", (replies) => [[String(replies[0])], replies[1], replies[2]]],
    ["the count of versions is a word", (replies) => [replies[0], "OK", replies[2]]],
    ["the count of versions is below zero", (replies) => [replies[0], -1, replies[2]]],
    ["the count of versions is not whole", (replies) => [replies[0], 1.5, replies[2]]],
    ["the oldest version is a number", (replies) => [replies[0], replies[1], 7]],
  ];
  for (const [name, shape] of shapes) {
    const pageBefore = await raw(`nl:product:page:${statsId}:${product}`);
    const versionsBefore = (await readVersions(statsId, product)).length;
    const usesBefore = await uses();
    const tried = await withBeforeRead(shape, () => writePage(statsId, product, parsePage({ blocks: [cta(`After ${name}`)] }), shop));
    is(`${name}: the read of the page as it was was the one answered`, tried.changed, 1);
    is(`${name}: it throws an unknown reply`, tried.error instanceof UnknownReplyError, true);
    is(`${name}: the page stays as it was`, await raw(`nl:product:page:${statsId}:${product}`), pageBefore);
    is(`${name}: its versions stay as they were`, (await readVersions(statsId, product)).length, versionsBefore);
    is(`${name}: the section's use stays as it was`, await uses(), usesBefore);
  }

  part("Known answers still save");
  const fresh = await withBeforeRead((replies) => replies, () => writePage(statsId, "neverbefore", parsePage({ blocks: [cta("New")] }), shop));
  is("a page never saved (GET null, LLEN 0, LINDEX null) is written", [fresh.error, typeof (await raw(`nl:product:page:${statsId}:neverbefore`)) === "string"], [null, true]);
  const healthyAgain = (await readVersions(statsId, product)).length;
  await writePage(statsId, product, parsePage({ blocks: [cta("Fourth")] }), shop);
  is("the next healthy save keeps the page as it was again", (await readVersions(statsId, product)).length, Math.min(healthyAgain + 1, 5));
  is("and takes the section's use off the page that no longer carries it", await uses(), []);

  part("The studio routes say what happened");
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const unknown = () => [];
  const productSave = await withBeforeRead(unknown, async () => {
    const response = await savePage(new NextRequest(`${ORIGIN}/api/store/page`, { method: "POST", headers, body: JSON.stringify({ id: product, page: { blocks: [cta("From the studio")] } }) }));
    return [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? ""];
  });
  is("a product page: refused with page_not_written, not a vague server error", productSave.result, [503, "page_not_written"]);
  is("and the page was not written", String(await raw(`nl:product:page:${statsId}:${product}`)).includes("From the studio"), false);

  const site = async (body: Record<string, unknown>) => {
    const response = await siteRoute(new NextRequest(`${ORIGIN}/api/store/site-page`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; id?: string } };
  };
  const added = await site({ action: "add", title: "About" });
  if (!added.body.ok || !added.body.id) throw new Error(`site page not added: ${added.body.error}`);
  const first = await site({ action: "save", id: added.body.id, page: { blocks: [{ ...emptyBlock("hero"), headline: "Hello" }], style: "plain" } });
  is("a store page saves when the read is known", first.body.ok, true);
  const keyBefore = await raw(`nl:product:page:${statsId}:${siteKey(added.body.id)}`);
  const siteSave = await withBeforeRead(unknown, () => site({ action: "save", id: added.body.id, page: { blocks: [{ ...emptyBlock("hero"), headline: "Changed" }], style: "plain" } }));
  is("a store page: refused with page_not_written", [siteSave.result?.status, siteSave.result?.body.error], [503, "page_not_written"]);
  is("and the store page stays as it was", await raw(`nl:product:page:${statsId}:${siteKey(added.body.id)}`), keyBefore);

  part("The words the studio shows");
  const words = STUDIO_MESSAGES.page_not_written ?? "";
  is("they say the page could not be read and was not saved", /could not be read/.test(words) && /not saved/.test(words), true);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
