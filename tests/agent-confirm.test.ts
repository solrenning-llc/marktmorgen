/**
 * 631 [AA1] (c): the creator's side of a proposal, through the real studio
 * route. An agent's key prepares a description (the MCP tool); nothing
 * changes until the creator, signed in to the studio, confirms it; a declined
 * one changes nothing; a confirmed one is in the history and can be put back;
 * an agent's own key never reaches this route; words a product on the store
 * may not hold are never carried out; the page is drawn.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { makeKey } from "@/lib/api-keys";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductHidden, setSubscription } from "@/lib/store";
import { readAbout } from "@/lib/product-about";
import { readBook } from "@/lib/agent-book";
import { AGENT_COVERAGE } from "@/lib/agent-coverage";
import { POST as mcp } from "@/app/api/mcp/route";
import { POST as agentRoute } from "@/app/api/store/agent/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "confirm@example.com";
const proposalsSource = () => readFileSync("components/agent-proposals.tsx", "utf8");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "confirmshop", "Confirm Shop", "");
  const statsId = (await ensureStatsId(OWNER))!.statsId!;
  await setSubscription(OWNER, { customerId: "cus_Conf00001", subscriptionId: "sub_Conf00001", active: true, period: paidPeriod() });
  const product = await addProduct(OWNER, "Bread Basics", "Bake at home.", "19", null);
  const other = await addProduct(OWNER, "Pasta Basics", "Roll at home.", "19", null);
  if (!product.ok || !other.ok) throw new Error("no product");
  const sid = (await ensureStoreId(OWNER))!.sid;
  const drafter = await makeKey(sid, "Drafter", Date.now(), false, "draft");
  if (!drafter.ok) throw new Error("no key");
  const propose = async (id: string, description: string) => {
    const answer = (await (
      await mcp(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${drafter.key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "propose_product_description", arguments: { product: id, description } } }),
      }))
    ).json()) as { result?: { content: { text: string }[] } };
    return (JSON.parse(answer.result?.content[0].text ?? "{}") as { proposal?: string }).proposal ?? "";
  };
  const session = await openSession(OWNER);
  const post = async (body: unknown, headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${session}` }) => {
    const response = await agentRoute(new NextRequest("https://marktmorgen.com/api/store/agent", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as { ok: boolean; error?: string; done?: string[]; refused?: { id: string; why: string }[] } };
  };

  part("Only the creator, signed in");
  const first = await propose(product.product.id, "What you get:\n- Six recipes");
  is("signed out: refused", (await post({ action: "confirm", ids: [first] }, {})).status, 401);
  is("an agent's key is not a session", (await post({ action: "confirm", ids: [first] }, { authorization: `Bearer ${drafter.key}` })).status, 401);
  is("the coverage table says no agent reaches it", AGENT_COVERAGE["POST store/agent"]?.reach.kind, "never");
  is("nothing changed yet", await readAbout(statsId, product.product.id), "");

  part("Confirm carries it out, into the history");
  const confirmed = await post({ action: "confirm", ids: [first] });
  is("carried out", [confirmed.status, confirmed.data.ok, confirmed.data.done], [200, true, [first]]);
  is("the store's description is the proposed one", await readAbout(statsId, product.product.id), "What you get:\n- Six recipes");
  const book = await readBook(statsId);
  is("off the waiting list, into the history with who confirmed it", [book.waiting.length, book.history.map((d) => [d.id, d.confirmed.who])], [0, [[first, OWNER]]]);

  part("Decline changes nothing");
  const second = await propose(other.product.id, "Something else");
  is("declined", (await post({ action: "decline", id: second })).data.ok, true);
  is("the other product is unchanged and nothing waits", [await readAbout(statsId, other.product.id), (await readBook(statsId)).waiting.length], ["", 0]);
  is("declining again: not waiting any more", (await post({ action: "decline", id: second })).status, 404);

  part("Undo puts it back");
  const undone = await post({ action: "undo", id: first });
  is("put back", [undone.status, undone.data.ok], [200, true]);
  is("the description is as it was", await readAbout(statsId, product.product.id), "");
  is("undoing twice is said", (await post({ action: "undo", id: first })).data.error, "already_undone");

  part("Words a product on the store may not hold are never carried out");
  // Proposed while the product was a draft, which may hold them; published since.
  is("hidden while it is a draft", (await setProductHidden(OWNER, other.product.id, true)).ok, true);
  const late = await propose(other.product.id, "Make easy money rolling pasta at home.");
  is("a draft may be proposed such words", typeof late === "string" && late.length > 0, true);
  is("published again", (await setProductHidden(OWNER, other.product.id, false)).ok, true);
  const blocked = await post({ action: "confirm", ids: [late] });
  is("confirming it is refused for its words, and it stays waiting to be declined", [blocked.data.done, blocked.data.refused, (await readBook(statsId)).waiting.map((p) => p.id)], [[], [{ id: late, why: "terms" }], [late]]);
  is("the product's description is unchanged", await readAbout(statsId, other.product.id), "");
  is("the studio says why", proposalsSource().includes("terms: \"its words are not allowed on a product that is on the store"), true);
  is("declined", (await post({ action: "decline", id: late })).data.ok, true);

  part("Bad requests");
  is("nothing chosen", (await post({ action: "confirm", ids: ["not-an-id"] })).data.error, "ids");
  is("unknown action", (await post({ action: "delete" })).data.error, "invalid");

  part("The page");
  const page = readFileSync("app/studio/agent/page.tsx", "utf8");
  const parts = readFileSync("components/agent-proposals.tsx", "utf8");
  is("a role that may change settings", page.includes('"settings")'), true);
  is("one heading, the before beside the after, confirm, decline, undo", ["What the AI proposes"].every((w) => page.includes(w)) && ["Now", "Would become", "Confirm", "Decline", "Undo", "What the AI did"].every((w) => parts.includes(w)), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
