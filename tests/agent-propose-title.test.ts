/**
 * 631 [AA1] (c): propose_product_title, through the real MCP route and the
 * studio's route. A key that only reads is refused; a proposal keeps the
 * title now and the one it would become; nothing changes until the creator
 * confirms; confirming changes the title and nothing else (price, summary);
 * undo puts it back; an empty or too long title, and words the studio
 * refuses on a product on the store, are refused before anything is kept.
 */
import { NextRequest } from "next/server";
import { makeKey } from "@/lib/api-keys";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { MAX_TITLE_LENGTH, readListing } from "@/lib/catalog";
import { readBook } from "@/lib/agent-book";
import { POST as mcp } from "@/app/api/mcp/route";
import { POST as agentRoute } from "@/app/api/store/agent/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "proposetitle@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "titleshop", "Title Shop", "");
  const statsId = (await ensureStatsId(OWNER))!.statsId!;
  await setSubscription(OWNER, { customerId: "cus_Titl00001", subscriptionId: "sub_Titl00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Knife Skills", "Learn to cut.", "29", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const sid = (await ensureStoreId(OWNER))!.sid;
  const reader = await makeKey(sid, "Reader");
  const drafter = await makeKey(sid, "Drafter", Date.now(), false, "draft");
  if (!reader.ok || !drafter.ok) throw new Error("no keys");
  const call = async (key: string, args: Record<string, unknown>) =>
    (await (
      await mcp(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "propose_product_title", arguments: args } }),
      }))
    ).json()) as { result?: { content: { text: string }[]; isError: boolean }; error?: { code: number; message: string } };
  const session = await openSession(OWNER);
  const post = async (body: unknown) =>
    (await (
      await agentRoute(new NextRequest("https://marktmorgen.com/api/store/agent", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }))
    ).json()) as { ok: boolean; error?: string; done?: string[] };
  const listing = async () => (await readListing((await storeForEmail(OWNER))!, id))!;

  part("Only a key allowed to prepare changes");
  is("a reading key is refused", (await call(reader.key, { product: id, title: "Knife Skills for Home Cooks" })).error?.code, -32001);

  part("Refused before anything is kept");
  is("an empty title", /not empty/.test((await call(drafter.key, { product: id, title: "   " })).result?.content[0].text ?? ""), true);
  is("a title too long", /at most/.test((await call(drafter.key, { product: id, title: "x".repeat(MAX_TITLE_LENGTH + 1) })).result?.content[0].text ?? ""), true);
  const money = await call(drafter.key, { product: id, title: "Make easy money with knives" });
  is("a promise of fast or easy money on a product on the store", [money.result?.isError, /Nothing was proposed\./.test(money.result?.content[0].text ?? "")], [true, true]);
  is("the same title is no change", /already the product's title/.test((await call(drafter.key, { product: id, title: "Knife Skills" })).result?.content[0].text ?? ""), true);
  is("nothing kept", (await readBook(statsId)).waiting.length, 0);

  part("Kept, then confirmed, then undone");
  const kept = await call(drafter.key, { product: id, title: "  Knife Skills   for Home Cooks " });
  const proposal = (JSON.parse(kept.result?.content[0].text ?? "{}") as { proposal?: string }).proposal ?? "";
  const book = await readBook(statsId);
  is("before and after, spaces tidied", book.waiting.map((p) => [p.kind, p.before, p.after]), [["product.title", "Knife Skills", "Knife Skills for Home Cooks"]]);
  is("nothing changed yet", (await listing()).title, "Knife Skills");
  const before = await listing();
  is("confirmed", (await post({ action: "confirm", ids: [proposal] })).done, [proposal]);
  const after = await listing();
  is("the title changed, and nothing else", [after.title, after.priceCents, after.summary, after.hidden], ["Knife Skills for Home Cooks", before.priceCents, before.summary, before.hidden]);
  is("undone", (await post({ action: "undo", id: proposal })).ok, true);
  is("the title is as it was", (await listing()).title, "Knife Skills");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
