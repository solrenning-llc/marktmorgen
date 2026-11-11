/**
 * app/api/store/page-versions lists a page's earlier versions for the studio's editor, from
 * lib/sales-page-store.ts readVersions. When Redis's answer to that LRANGE is not a list (no reply,
 * a reply in another shape), readVersions answered [] and the route said `{ ok: true, versions: [] }`:
 * "this page has no earlier versions", a definite answer drawn from a read that failed (CX-123
 * rule 24). The creator, about to bring back yesterday's page, is told there is none. It must be an
 * answer that is not ok, which the editor already says as "could not be read just now"
 * (components/page-editor.tsx loadVersions). A real list keeps answering as before.
 * Audit of the API routes, Claude 3 (cloud K), 11 November 2026.
 *
 * Synthetic store; no network.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductPage, storeForEmail } from "@/lib/store";
import { writePage } from "@/lib/sales-page-store";
import { emptyBlock, parsePage, type PageBlock } from "@/lib/sales-page";
import { GET as pageVersions } from "@/app/api/store/page-versions/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "k-versions@example.com";
const ORIGIN = "https://marktmorgen.com";

async function main(): Promise<void> {
  redis.clear();
  const quiet = console.error;
  console.error = () => {};
  await claimHandle(OWNER, "kversions", "K versions", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const product = made.product.id;
  const shop = (await storeForEmail(OWNER))!;
  const statsId = shop.statsId!;
  const cta = (label: string): PageBlock => ({ ...(emptyBlock("cta") as Extract<PageBlock, { kind: "cta" }>), label });
  if (!(await setProductPage(OWNER, product, true)).ok) throw new Error("setup");
  await writePage(statsId, product, parsePage({ blocks: [cta("First")] }), shop);
  await writePage(statsId, product, parsePage({ blocks: [cta("Second")] }), shop);
  const session = await openSession(OWNER);
  const ask = async () => {
    const response = await pageVersions(new NextRequest(`${ORIGIN}/api/store/page-versions?id=${product}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
    return { status: response.status, body: (await response.json().catch(() => ({}))) as { ok?: boolean; versions?: unknown[] } };
  };

  part("Control: the page's earlier version is listed");
  const listed = await ask();
  is("listed", [listed.status, listed.body.ok, listed.body.versions?.length], [200, true, 1]);

  const original = redis.pipeline;
  for (const [mode, bad] of [["no reply", []], ["a reply that is not a list", [{ 0: "x" }]], ["a nil reply", [null]]] as const) {
    part(`The versions' read answers ${mode}: never "no earlier versions"`);
    redis.pipeline = async (commands) => {
      const reply = await original.call(redis, commands);
      return commands.length === 1 && commands[0][0] === "LRANGE" && String(commands[0][1]).startsWith(`nl:product:pages:${statsId}:`) ? (bad as unknown[]) : reply;
    };
    const unread = await ask();
    redis.pipeline = original;
    is("not answered as ok", unread.body.ok === true, false);
    is("and never as an empty list", Array.isArray(unread.body.versions), false);
  }
  console.error = quiet;
  done();
}

void main();
