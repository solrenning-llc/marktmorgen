/**
 * 232 [CA1] unit 4b4c: while a store's plan renewal is unpaid, or a payment
 * for its plan is disputed, reading the store through one of its API keys
 * (the REST API's reads and every MCP tool) is refused with its sentence
 * before any of the month's API requests is taken or anything outside is
 * reached; taking back access and removing a webhook endpoint through the
 * API stay open, and reads work again once paid (lib/api-guard.ts).
 */
import { GET as storeRead } from "@/app/api/v1/store/route";
import { DELETE as hookDelete } from "@/app/api/v1/hooks/route";
import { POST as mcp } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { addEndpoint, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, recordPlanDispute, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { API_READ_PAUSED_WORDS, integrationPauseWord } from "@/lib/integration-pause";
import { RENEWAL_PAUSED_WORDS } from "@/lib/renewal-unpaid-words";
import { DISPUTE_PAUSED_WORDS } from "@/lib/plan-dispute-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

setSendHooksForTests({ fetch: { resolve: async () => { throw new Error("a stand-in that answers nothing"); } } as never });

const OWNER = "api-reads-paused@example.com";

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => { outside += 1; throw new Error("No outside requests in this test"); }) as typeof fetch;
  try {
    await claimHandle(OWNER, "api-reads-paused-shop", "API Reads Paused Shop", "");
    await ensureStatsId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_ApiReadsPause", subscriptionId: "sub_ApiReadsPause", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    let store = (await storeForEmail(OWNER))!;
    const reader = await makeKey(store.sid, "Synthetic reader");
    const writer = await makeKey(store.sid, "Synthetic writer", Date.now(), true);
    if (!reader.ok || !writer.ok) throw new Error("No synthetic keys");
    const auth = (key: string) => ({ Authorization: `Bearer ${key}` });
    const rest = async (key: string | null) => {
      const res = await storeRead(new Request("https://marktmorgen.com/api/v1/store", { headers: key ? auth(key) : {} }));
      return { status: res.status, body: (await res.json()) as { data?: unknown; error?: string; message?: string } };
    };
    let rpc = 0;
    const call = async (method: string, params: unknown = {}) => {
      const res = await mcp(new Request("https://marktmorgen.com/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...auth(reader.key) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }) }));
      return (await res.json()) as { result?: { tools?: unknown[]; content?: { text: string }[] }; error?: { code: number; message: string } };
    };
    const used = async () => allowanceUsed((await storeForEmail(OWNER))!, "api");

    part("Paid: reads answer and are counted");
    const paid = await rest(reader.key);
    is("the REST read answers", paid.status, 200);
    is("an MCP tool answers", Array.isArray((await call("tools/call", { name: "get_store" })).result?.content), true);
    is("both were counted", await used(), 2);

    part("Renewal unpaid: reads refused with the sentence, nothing counted");
    await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
    store = (await storeForEmail(OWNER))!;
    is("paused", integrationPauseWord(store), "paused_unpaid");
    const refused = await rest(reader.key);
    is("the REST read is refused with its sentence", [refused.status, refused.body.error, refused.body.message], [409, "paused_unpaid", API_READ_PAUSED_WORDS.paused_unpaid]);
    is("no data is sent", refused.body.data, undefined);
    const listed = await call("tools/list");
    is("MCP tools/list is refused with the same sentence", [listed.error?.code, listed.error?.message, listed.result], [-32001, API_READ_PAUSED_WORDS.paused_unpaid, undefined]);
    const tool = await call("tools/call", { name: "get_numbers" });
    is("an MCP tool is refused with the same sentence", tool.error?.message, API_READ_PAUSED_WORDS.paused_unpaid);
    is("a write key reading is refused too", (await rest(writer.key)).body.error, "paused_unpaid");
    is("nothing was counted while paused", await used(), 2);
    is("initialize still answers without data", typeof (await call("initialize")).result, "object");
    is("a missing key is still 401, not the pause", (await rest(null)).status, 401);
    is("a wrong key is still 401", (await rest("nl_live_" + "x".repeat(40))).status, 401);

    part("Writes that take something away stay open");
    // Added through the library, as an endpoint made while paid would be.
    await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
    const added = await addEndpoint((await storeForEmail(OWNER))!, "https://hooks.example.com/api-paused", ["sale.completed"]);
    is("an endpoint is added while paid", added.ok, true);
    await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
    store = (await storeForEmail(OWNER))!;
    const id = (await webhooksView(store)).endpoints[0]!.id;
    const removed = await hookDelete(new Request("https://marktmorgen.com/api/v1/hooks", { method: "DELETE", headers: { ...auth(writer.key), "Content-Type": "application/json" }, body: JSON.stringify({ id }) }));
    is("removing an endpoint through the API works while paused", [removed.status, (await webhooksView(store)).endpoints.length], [200, 0]);

    part("The notices name it");
    is("the renewal and dispute notices say API reads wait", [RENEWAL_PAUSED_WORDS, DISPUTE_PAUSED_WORDS].every((w) => w.includes("Reading your store through your API keys, AI assistants included, waits too")), true);

    part("Disputed: the dispute's sentence");
    await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
    store = (await storeForEmail(OWNER))!;
    const now = Math.floor(Date.now() / 1000);
    is("the dispute is written down", Boolean(await recordPlanDispute(storeRef(store), { id: "du_ApiReadsPause1", status: "open", at: now, coversUntil: now + 30 * 86_400 })), true);
    const disputed = await rest(reader.key);
    is("refused for the dispute", [disputed.status, disputed.body.error, disputed.body.message], [409, "paused_disputed", API_READ_PAUSED_WORDS.paused_disputed]);
    is("MCP says the dispute's sentence", (await call("tools/list")).error?.message, API_READ_PAUSED_WORDS.paused_disputed);

    part("Settled: reads answer again");
    store = (await storeForEmail(OWNER))!;
    is("the dispute won", Boolean(await recordPlanDispute(storeRef(store), { id: "du_ApiReadsPause1", status: "won", at: now, coversUntil: now + 30 * 86_400 })), true);
    const counted = await used();
    is("the REST read answers again", (await rest(reader.key)).status, 200);
    is("and is counted", await used(), counted + 1);

    part("MCP tells the month's limit as it is, not as the minute's");
    store = (await storeForEmail(OWNER))!;
    const left = allowanceFor(store, "api") - (await used());
    is("the rest of the month is taken", (await takeAllowance(store, "api", left)).ok, true);
    const full = await call("tools/list");
    is("MCP says the month is used, not 'this minute'", [full.error?.code, /month/.test(full.error?.message ?? ""), /this minute/.test(full.error?.message ?? "")], [-32001, true, false]);

    part("A dispute decided for the store keeps reads paused for the period it covered");
    store = (await storeForEmail(OWNER))!;
    is("a second dispute is written down", Boolean(await recordPlanDispute(storeRef(store), { id: "du_ApiReadsPause2", status: "open", at: now, coversUntil: now + 30 * 86_400 })), true);
    store = (await storeForEmail(OWNER))!;
    is("and is lost", Boolean(await recordPlanDispute(storeRef(store), { id: "du_ApiReadsPause2", status: "lost", at: now, coversUntil: now + 30 * 86_400 })), true);
    const lost = await rest(reader.key);
    is("reads still answer 409 with the dispute's sentence", [lost.status, lost.body.error], [409, "paused_disputed"]);
    is("the sentence says it lasts for the period that payment covered", /until the period that payment covered ends/.test(lost.body.message ?? ""), true);
    is("nothing outside was reached", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
