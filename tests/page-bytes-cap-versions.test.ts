/**
 * The pre-review of claude5/page-bytes-cap (Claude 5, 9 November 2026), two findings:
 *
 * 1. pageReadUnits (lib/page-read-units.ts) made one IncludedBytes for what a studio read moves through the database
 *    and another for what it sends on, so a request's own fifty kilobytes were spent twice; C3-112 (2) spends them
 *    once a request, whatever its parts (lib/sent-bytes.ts, IncludedBytes; tests/plan-cost-registry.ts,
 *    PAGE_INCLUDED_BYTES; the same as lib/person-agenda-read.ts).
 * 2. writePage (lib/sales-page-store.ts) kept the page it saved over as a version while its length in UTF-16 units
 *    was within MAX_STORED_PAGE_BYTES, so a record kept before pages were held in bytes became a version of up to
 *    three times MAX_VERSION_BYTES; and GET /api/store/page-versions read such versions (LRANGE) before it took what
 *    they weigh past MAX_VERSION_BYTES, so what a version kept before 9 November 2026 weighs past it moved before it
 *    was paid for.
 *
 * Every request is a real one from the creator's own session, to the real routes, on the in-memory Redis; only the
 * counter of studio requests, and the versions and the record kept before pages were held in bytes, are set by hand.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { POST as savePage } from "@/app/api/store/page/route";
import { GET as versionsGet } from "@/app/api/store/page-versions/route";
import { emptyBlock } from "@/lib/sales-page";
import { MAX_VERSION_BYTES } from "@/lib/sales-page-store";
import { ledgerUnits } from "@/lib/segments";
import { pageReadUnits } from "@/lib/page-read-units";
import { IncludedBytes, sentUnits } from "@/lib/sent-bytes";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "pbcv.maker@example.com";
const ORIGIN = "https://marktmorgen.com";
const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pbcvshop", "PBCV Shop", "");
  const statsId = (await ensureStatsId(OWNER))?.statsId;
  const made = await addProduct(OWNER, "Guide", "", "29", null);
  const other = await addProduct(OWNER, "Notes", "", "9", null);
  if (!made.ok || !other.ok || !statsId) throw new Error("setup");
  const id = made.product.id;
  const session = await openSession(OWNER);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const save = async (product: string, page: unknown) => {
    const response = await savePage(new NextRequest(`${ORIGIN}/api/store/page`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ id: product, page }) }));
    return { status: response.status, error: ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "" };
  };
  const get = (path: string) => new NextRequest(`${ORIGIN}${path}`, { headers: { cookie } });
  const pageKey = (product: string) => `nl:product:page:${statsId}:${product}`;
  const versionsKey = (product: string) => `nl:product:pages:${statsId}:${product}`;
  const studioKey = () => redis.keys().find((k) => k.startsWith("nl:allow:studio:")) ?? "";
  const taken = async () => {
    const [v] = (await redis.pipeline([["GET", studioKey()]])) as unknown[];
    return Number(v ?? 0);
  };
  /** Runs a request, counting the studio requests it took, its answer's bytes, and the commands it sent. */
  const run = async (task: () => Promise<Response>) => {
    const before = await taken();
    const original = redis.pipeline;
    const sent: (string | number)[][] = [];
    redis.pipeline = async (commands) => {
      sent.push(...commands);
      return original.call(redis, commands);
    };
    let response: Response;
    try {
      response = await task();
    } finally {
      redis.pipeline = original;
    }
    const text = await response.text();
    const body = (JSON.parse(text || "{}") ?? {}) as { ok?: boolean; error?: string; versions?: unknown[] };
    return { status: response.status, body, bytes: utf8(text), units: (await taken()) - before, sent };
  };
  const reads = (sent: (string | number)[][], name: string, key: string) => sent.some((c) => c[0] === name && c[1] === key);

  part("A studio read spends its request's own fifty kilobytes once (C3-112 (2)), not once for the database and again for the browser");
  const shared = new IncludedBytes();
  const once = ledgerUnits(50_000, shared) + sentUnits(50_000, shared);
  console.log(`  pageReadUnits(50_000, 50_000) = ${pageReadUnits(50_000, 50_000)}; with one IncludedBytes = ${once}`);
  is("50 kB read and 50 kB sent take what one shared IncludedBytes takes", pageReadUnits(50_000, 50_000), once);
  is("and a part that fits alone still takes nothing", pageReadUnits(20_000, 20_000), 0);

  part("writePage never keeps a version past MAX_VERSION_BYTES, measured in bytes");
  // A record kept before pages were held in bytes: 239,000 UTF-16 units, 717 kB.
  const legacy = JSON.stringify({ blocks: [{ id: "lega0001", kind: "text", heading: "", body: "語".repeat(239_000) }] });
  console.log(`  the old record: ${legacy.length} UTF-16 units, ${utf8(legacy)} bytes`);
  await redis.pipeline([["SET", pageKey(id), legacy]]);
  is("a small save over an old 717 kB record", await save(id, { blocks: [{ ...emptyBlock("text"), id: "ssss0002", body: "Short." }] }), { status: 200, error: "" });
  await redis.pipeline([["SET", pageKey(id), legacy]]);
  is("a second small save over an old 717 kB record", await save(id, { blocks: [{ ...emptyBlock("text"), id: "ssss0003", body: "Shorter." }] }), { status: 200, error: "" });
  const [entries] = (await redis.pipeline([["LRANGE", versionsKey(id), 0, -1]])) as unknown[];
  const kept = entries as string[];
  console.log(`  versions kept: ${kept.length}, of ${kept.map(utf8).join(", ") || "none"} bytes; MAX_VERSION_BYTES ${MAX_VERSION_BYTES}`);
  is("no version kept past MAX_VERSION_BYTES", kept.every((entry) => utf8(entry) <= MAX_VERSION_BYTES), true);
  is("a page that fits is still kept as a version when it is saved over", await save(id, { blocks: [{ ...emptyBlock("text"), id: "ssss0004", body: "Shortest." }] }), { status: 200, error: "" });
  const [after] = (await redis.pipeline([["LRANGE", versionsKey(id), 0, -1]])) as unknown[];
  is("the small page before it is the newest version", (after as string[])[0]?.includes("Shorter."), true);

  part("GET /api/store/page-versions takes what a version kept before weighs past MAX_VERSION_BYTES before it reads it");
  // Two versions kept before 9 November 2026, when writePage measured them in UTF-16 units.
  const product = other.product.id;
  await redis.pipeline([["LPUSH", versionsKey(product), `${Date.now() - 2_000}\n${legacy}`, `${Date.now() - 1_000}\n${legacy}`]]);
  const legacyBytes = 2 * utf8(`${Date.now()}\n${legacy}`);
  const shop = await storeForEmail(OWNER);
  if (!shop) throw new Error("setup");
  const limit = allowanceFor(shop, "studio");
  const used = await taken();
  // Left: its own request and what two versions at MAX_VERSION_BYTES take, not what they weigh past it.
  await redis.pipeline([["SET", studioKey(), String(limit - 1 - ledgerUnits(2 * MAX_VERSION_BYTES))]]);
  const refused = await run(() => versionsGet(get(`/api/store/page-versions?id=${product}`)));
  console.log(`  ${legacyBytes} bytes kept; status ${refused.status} ${refused.body.error ?? ""}; LRANGE sent: ${reads(refused.sent, "LRANGE", versionsKey(product))}`);
  is("refused for what they weigh past it, without having read the versions", [refused.status, refused.body.error, reads(refused.sent, "LRANGE", versionsKey(product))], [429, "studio_used", false]);
  await redis.pipeline([["SET", studioKey(), String(used)]]);
  const listed = await run(() => versionsGet(get(`/api/store/page-versions?id=${product}`)));
  const due = 1 + pageReadUnits(legacyBytes, listed.bytes);
  console.log(`  with requests left: status ${listed.status}, versions ${listed.body.versions?.length}, units ${listed.units} (covering it: ${due})`);
  is("with requests left, both are listed for what they weigh", [listed.status, listed.body.versions?.length, listed.units >= due], [200, 2, true]);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
