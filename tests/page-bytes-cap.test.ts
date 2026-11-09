/**
 * A product's page is held to its weight in UTF-8 bytes, and the studio's reads of it pay for what they move before
 * they move it (Claude 5's proof on main 0ade0faf, 12 of 12; Claude 6's release on the channel, 7 November 2026,
 * 06h01 Fortaleza).
 *
 * Before: oversized (lib/sales-page.ts) and MAX_STORED_PAGE_BYTES were held against a record's length in UTF-16
 * units, so a page the studio saves (its body held only to 420,000 bytes) was kept at about 406 kB in a three-byte
 * script; GET /api/store/page read it for the one studio request it came with (UNIT_COST.studio prices fifty
 * kilobytes through the database), and GET /api/store/page-versions read five such versions, and the page, for one
 * (1.83 MB, or 2.18 MB with n=0). Its siblings: a saved section put on pages grew them past any weight
 * (lib/saved-blocks.ts, withSection), the MCP's read_sales_page took a record by its UTF-16 length while it paid for
 * MAX_STORED_PAGE_BYTES bytes (lib/sales-page-store.ts, readPageExact), and the cost registry and the store copy
 * priced a page that moves at MAX_PAGE_BYTES, a count of UTF-16 units, as if it were bytes.
 *
 * Every request is a real one from the creator's own session, to the real routes, on the in-memory Redis; only
 * the counter of studio requests and, in two checks, Redis's answer to one command are set by hand.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { POST as savePage, GET as copyPage } from "@/app/api/store/page/route";
import { GET as versionsGet } from "@/app/api/store/page-versions/route";
import { MAX_PAGE_BYTES, MAX_STORED_PAGE_BYTES, emptyBlock, oversized, parsePage, type PageBlock, type SalesPage } from "@/lib/sales-page";
import { readPageExact } from "@/lib/sales-page-store";
import { withSection } from "@/lib/saved-blocks";
import { ledgerUnits } from "@/lib/segments";
import { sentUnits } from "@/lib/sent-bytes";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "pbc.maker@example.com";
const ORIGIN = "https://marktmorgen.com";
const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

/** A page of FAQ blocks in a three-byte script, as close under MAX_PAGE_BYTES (UTF-16 units) as it goes. */
function bigPage(char: string, tag: string): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [];
  const answer = char.repeat(1_500);
  const question = char.repeat(200);
  const page = () => ({ blocks });
  let n = 0;
  while (blocks.length < 30) {
    const items: { q: string; a: string }[] = [];
    blocks.push({ id: `${tag}${String(n++).padStart(4, "0")}`, kind: "faq", heading: char.repeat(100), items });
    for (let i = 0; i < 15; i += 1) {
      items.push({ q: question, a: answer });
      if (oversized(parsePage(page()))) {
        items.pop();
        return page();
      }
    }
  }
  return page();
}

/** The page the proof saved: a first version near MAX_PAGE_BYTES units, and a second one the body cap still lets in. */
function provenPage(): Record<string, unknown> {
  const first = bigPage("語", "aaaa");
  first.variant = { blocks: [{ id: "vvvv0001", kind: "faq", heading: "文".repeat(100), items: Array.from({ length: 10 }, () => ({ q: "文".repeat(200), a: "文".repeat(1_500) })) }] };
  return first;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pbcshop", "PBC Shop", "");
  const statsId = (await ensureStatsId(OWNER))?.statsId;
  const made = await addProduct(OWNER, "Guide", "", "29", null);
  const small = await addProduct(OWNER, "Notes", "", "9", null);
  if (!made.ok || !small.ok || !statsId) throw new Error("setup");
  const id = made.product.id;
  const session = await openSession(OWNER);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const save = async (product: string, page: unknown) => {
    const response = await savePage(new NextRequest(`${ORIGIN}/api/store/page`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ id: product, page }) }));
    return { status: response.status, error: ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "" };
  };
  const get = (path: string) => new NextRequest(`${ORIGIN}${path}`, { headers: { cookie } });
  const pageKey = (product: string) => `nl:product:page:${statsId}:${product}`;
  const versionsKey = `nl:product:pages:${statsId}:${id}`;
  const stored = async (product: string) => {
    const [raw] = (await redis.pipeline([["GET", pageKey(product)]])) as unknown[];
    return typeof raw === "string" ? raw : "";
  };
  const studioKey = () => redis.keys().find((k) => k.startsWith("nl:allow:studio:")) ?? "";
  const taken = async () => {
    const [v] = (await redis.pipeline([["GET", studioKey()]])) as unknown[];
    return Number(v ?? 0);
  };
  /** Runs a request, counting the studio requests it took, its answer's bytes, and the commands it sent. */
  const run = async (task: () => Promise<Response>, answer?: (command: (string | number)[]) => unknown[] | undefined) => {
    const before = await taken();
    const original = redis.pipeline;
    const sent: (string | number)[][] = [];
    redis.pipeline = async (commands) => {
      sent.push(...commands);
      const changed = commands.length === 1 && answer ? answer(commands[0]) : undefined;
      return changed ?? original.call(redis, commands);
    };
    let response: Response;
    try {
      response = await task();
    } finally {
      redis.pipeline = original;
    }
    const text = await response.text();
    const body = (JSON.parse(text || "{}") ?? {}) as { ok?: boolean; error?: string; message?: string; blocks?: unknown[]; versions?: unknown[]; page?: SalesPage };
    return { status: response.status, body, bytes: utf8(text), units: (await taken()) - before, sent };
  };
  const reads = (sent: (string | number)[][], name: string, key: string) => sent.some((c) => c[0] === name && c[1] === key);

  part("A page is held to MAX_STORED_PAGE_BYTES in UTF-8 bytes, and nothing the studio saves today is refused for it");
  const proven = parsePage(provenPage());
  console.log(`  the proof's page: ${JSON.stringify(proven).length} UTF-16 units, ${utf8(JSON.stringify(proven))} bytes; MAX_STORED_PAGE_BYTES ${MAX_STORED_PAGE_BYTES}`);
  is("the proof's page is not oversized: nothing that saves today is cut", oversized(proven), false);
  is("and its record fits MAX_STORED_PAGE_BYTES in bytes", utf8(JSON.stringify(proven)) <= MAX_STORED_PAGE_BYTES, true);
  const twoFull = parsePage({ ...bigPage("語", "cccc"), variant: { blocks: (bigPage("文", "dddd").blocks as unknown[]) } });
  const eachUnder = JSON.stringify({ ...twoFull, variant: null }).length <= MAX_PAGE_BYTES && JSON.stringify(twoFull.variant).length <= MAX_PAGE_BYTES;
  console.log(`  two full versions: ${utf8(JSON.stringify(twoFull))} bytes, each under MAX_PAGE_BYTES units: ${eachUnder}`);
  is("two versions, each under MAX_PAGE_BYTES units but past MAX_STORED_PAGE_BYTES bytes together, are oversized", [eachUnder, oversized(twoFull)], [true, true]);
  is("the studio saves the proof's page", await save(id, provenPage()), { status: 200, error: "" });
  const record = await stored(id);
  console.log(`  kept: ${utf8(record)} bytes`);
  is("and keeps it within MAX_STORED_PAGE_BYTES bytes", record !== "" && utf8(record) <= MAX_STORED_PAGE_BYTES, true);

  part("GET /api/store/page takes the studio requests for what it reads and sends, before it reads");
  is("a small page saves", await save(small.product.id, { blocks: [{ ...emptyBlock("text"), id: "ssss0001", body: "A short page." }] }), { status: 200, error: "" });
  const light = await run(() => copyPage(get(`/api/store/page?id=${small.product.id}`)));
  is("a small page is copied for its one request", [light.status, light.units], [200, 1]);
  const heavy = await run(() => copyPage(get(`/api/store/page?id=${id}`)));
  const heavyDue = 1 + ledgerUnits(utf8(record)) + sentUnits(heavy.bytes);
  console.log(`  copy of the kept page: status ${heavy.status}, ${heavy.bytes} bytes sent, ${utf8(record)} read, units ${heavy.units} (covering it: ${heavyDue})`);
  is("the kept page is copied", [heavy.status, (heavy.body.blocks ?? []).length > 0], [200, true]);
  is("for the requests that cover what it read and sent", heavy.units >= heavyDue, true);
  is("measured before it was read (STRLEN)", reads(heavy.sent, "STRLEN", pageKey(id)), true);

  const shop = await storeForEmail(OWNER);
  if (!shop) throw new Error("setup");
  const limit = allowanceFor(shop, "studio");
  const used = await taken();
  await redis.pipeline([["SET", studioKey(), String(limit - 1)]]);
  const refused = await run(() => copyPage(get(`/api/store/page?id=${id}`)));
  is("with only its own request left, the copy is refused as used up", [refused.status, refused.body.error], [429, "studio_used"]);
  is("and the page is never read", reads(refused.sent, "GET", pageKey(id)), false);
  await redis.pipeline([["SET", studioKey(), String(used)]]);
  const unknownSize = await run(
    () => copyPage(get(`/api/store/page?id=${id}`)),
    (command) => (command[0] === "STRLEN" && command[1] === pageKey(id) ? [] : undefined),
  );
  is("a size that does not come back is page_unread, and the page is never read", [unknownSize.status, unknownSize.body.error, reads(unknownSize.sent, "GET", pageKey(id))], [503, "page_unread", false]);

  part("GET /api/store/page-versions takes the studio requests for the versions it reads, before it reads them");
  for (let k = 0; k < 5; k += 1) {
    const next = bigPage(k % 2 ? "語" : "文", `b${k}aa`);
    is(`save ${k + 1} of 5 more`, (await save(id, next)).status, 200);
  }
  const [entries] = (await redis.pipeline([["LRANGE", versionsKey, 0, -1]])) as unknown[];
  const versionBytes = (entries as string[]).reduce((s, e) => s + utf8(e), 0);
  const current = utf8(await stored(id));
  const list = await run(() => versionsGet(get(`/api/store/page-versions?id=${id}`)));
  const listDue = 1 + ledgerUnits(versionBytes) + sentUnits(list.bytes);
  console.log(`  versions list: status ${list.status}, versions ${list.body.versions?.length}, read ${versionBytes} bytes, units ${list.units} (covering it: ${listDue})`);
  is("the list reads five versions", [list.status, list.body.versions?.length], [200, 5]);
  is("for the requests that cover what it read and sent", list.units >= listDue, true);
  const one = await run(() => versionsGet(get(`/api/store/page-versions?id=${id}&n=0`)));
  const oneDue = 1 + ledgerUnits(versionBytes + current) + sentUnits(one.bytes);
  console.log(`  one version: status ${one.status}, read ${versionBytes + current} bytes, ${one.bytes} sent, units ${one.units} (covering it: ${oneDue})`);
  is("one version is brought back", [one.status, (one.body.page?.blocks ?? []).length > 0], [200, true]);
  is("for the requests that cover the versions, the page and the version sent", one.units >= oneDue, true);
  const none = await run(() => versionsGet(get(`/api/store/page-versions?id=${small.product.id}`)));
  is("a page with no earlier versions lists them for its one request", [none.status, none.units], [200, 1]);

  const used2 = await taken();
  await redis.pipeline([["SET", studioKey(), String(limit - 1)]]);
  const refusedList = await run(() => versionsGet(get(`/api/store/page-versions?id=${id}&n=0`)));
  is("with only its own request left, the versions are refused as used up", [refusedList.status, refusedList.body.error], [429, "studio_used"]);
  is("and neither they nor the page are read", [reads(refusedList.sent, "LRANGE", versionsKey), reads(refusedList.sent, "GET", pageKey(id))], [false, false]);
  await redis.pipeline([["SET", studioKey(), String(used2)]]);
  // Altered 2026-11-09 (rule 23): the route measures each version in Redis (versionSizes, an EVAL) instead of counting
  // them (LLEN), so a version kept larger before is paid for before it is read (pre-review of claude5/page-bytes-cap).
  const unknownCount = await run(
    () => versionsGet(get(`/api/store/page-versions?id=${id}`)),
    (command) => (command[0] === "EVAL" && command[3] === versionsKey ? [] : undefined),
  );
  is("sizes that do not come back are page_unread, and the versions are never read", [unknownCount.status, unknownCount.body.error, reads(unknownCount.sent, "LRANGE", versionsKey)], [503, "page_unread", false]);

  part("A saved section put on pages never grows one past what a page may weigh (lib/saved-blocks.ts, withSection)");
  const sectionId = "sec0000000001";
  const separator = (n: number): PageBlock => ({ ...(emptyBlock("cta") as Extract<PageBlock, { kind: "cta" }>), id: `sepa${String(n).padStart(4, "0")}`, label: "Buy it" });
  const mark = (n: number): PageBlock => ({ ...(emptyBlock("text") as Extract<PageBlock, { kind: "text" }>), id: `mark${String(n).padStart(4, "0")}`, body: "Short.", saved: sectionId }) as PageBlock;
  const host: SalesPage = { ...parsePage({}), blocks: Array.from({ length: 15 }, (_, n) => [mark(n), separator(n)]).flat() };
  const grown = { id: sectionId, blocks: [{ ...(emptyBlock("text") as Extract<PageBlock, { kind: "text" }>), id: "grow0001", body: "語".repeat(13_000) } as PageBlock] };
  const put = withSection(host, grown, ["text", "cta"]);
  console.log(`  the section put on every run would weigh ${put ? utf8(JSON.stringify(put)) : 0} bytes`);
  is("a section that would make the page oversized is not put on it", put === null || !oversized(put), true);
  is("a section that fits is still put on it", withSection(host, { id: sectionId, blocks: [{ ...(emptyBlock("text") as Extract<PageBlock, { kind: "text" }>), id: "grow0002", body: "A little more." } as PageBlock] }, ["text", "cta"]) !== null, true);

  part("The MCP's read_sales_page takes a record only within the bytes it paid for (lib/sales-page-store.ts, readPageExact)");
  const legacy = JSON.stringify({ blocks: [{ id: "lega0001", kind: "text", heading: "", body: "語".repeat(200_000) }] });
  await redis.pipeline([["SET", pageKey(small.product.id), legacy]]);
  console.log(`  a record kept before this change: ${legacy.length} UTF-16 units, ${utf8(legacy)} bytes`);
  is("a record past MAX_STORED_PAGE_BYTES bytes is refused, not read past what was paid for", await readPageExact(statsId, small.product.id).then(() => "read", () => "refused"), "refused");
  is("the proof's page is read", await readPageExact(statsId, id).then((r) => (r.page ? "read" : "none"), () => "refused"), "read");

  part("MAX_PAGE_BYTES counts UTF-16 units: nothing prices a page that moves with it as bytes");
  for (const file of ["tests/plan-cost-registry.ts", "lib/store-copy.ts"]) {
    const code = readFileSync(join(process.cwd(), file), "utf8").replace(/^import[\s\S]*?;$/gm, "");
    is(`${file} prices a page at MAX_STORED_PAGE_BYTES bytes, not at MAX_PAGE_BYTES units`, /\bMAX_PAGE_BYTES\b/.test(code), false);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
