/**
 * 631 [AA1] (c): the first tool that prepares a change, through the real MCP
 * route: propose_product_description. A key that only reads is refused; a
 * key allowed to prepare changes keeps a proposal in the store's book with
 * what the description is now and what it would become; nothing on the
 * store changes; the same text is "no change"; an unknown product is said.
 */
import { makeKey } from "@/lib/api-keys";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription } from "@/lib/store";
import { readAbout } from "@/lib/product-about";
import { readBook } from "@/lib/agent-book";
import { POST as mcp } from "@/app/api/mcp/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "propose@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "proposeshop", "Propose Shop", "");
  const statsId = (await ensureStatsId(OWNER))!.statsId!;
  await setSubscription(OWNER, { customerId: "cus_Prop00001", subscriptionId: "sub_Prop00001", active: true, period: paidPeriod() });
  const product = await addProduct(OWNER, "Knife Skills", "Learn to cut.", "29", null);
  if (!product.ok) throw new Error("no product");
  const sid = (await ensureStoreId(OWNER))!.sid;
  const reader = await makeKey(sid, "Reader");
  const drafter = await makeKey(sid, "Drafter", Date.now(), false, "draft");
  if (!reader.ok || !drafter.ok) throw new Error("no keys");
  const call = async (key: string, args: Record<string, unknown>) =>
    (await (
      await mcp(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "propose_product_description", arguments: args } }),
      }))
    ).json()) as { result?: { content: { text: string }[]; isError: boolean }; error?: { code: number; message: string } };

  part("Only a key allowed to prepare changes");
  const refused = await call(reader.key, { product: product.product.id, description: "New words." });
  is("a reading key is refused, with why", [refused.error?.code, /cannot prepare/i.test(refused.error?.message ?? "")], [-32001, true]);

  part("Kept as a proposal; nothing changes");
  const made = await call(drafter.key, { product: product.product.id, description: "What you get:\n- Ten lessons" });
  const data = JSON.parse(made.result?.content[0].text ?? "{}") as { proposal?: string; title?: string };
  is("a proposal is kept for the creator", [made.result?.isError, typeof data.proposal, data.title], [false, "string", "Knife Skills"]);
  const book = await readBook(statsId);
  is("with what is there now and what it would become, and who asked", book.waiting.map((p) => [p.kind, p.target, p.before, p.after, p.asked.by]), [["product.description", product.product.id, "", "What you get:\n- Ten lessons", "mcp"]]);
  is("the store's description is unchanged", await readAbout(statsId, product.product.id), "");
  const same = await call(drafter.key, { product: product.product.id, description: "" });
  is("the same text as now is no change", [same.result?.isError, /already/.test(same.result?.content[0].text ?? "")], [true, true]);
  const unknown = await call(drafter.key, { product: "nosuchproduct", description: "x" });
  is("an unknown product is said", [unknown.result?.isError, /no such product/.test(unknown.result?.content[0].text ?? "")], [true, true]);
  is("still one proposal waiting", (await readBook(statsId)).waiting.length, 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
