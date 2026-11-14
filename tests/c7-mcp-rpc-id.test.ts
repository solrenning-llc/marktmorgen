/**
 * The MCP server's JSON-RPC ids (C7 adversarial review, 12 November 2026).
 *
 * JSON-RPC 2.0 §4: an id, when present, is a String, a Number or Null; the
 * MCP specification (basic, "Requests") narrows it: a request MUST carry a
 * string or integer id, and it MUST NOT be null. A message with an id of any
 * other shape is an Invalid Request (-32600, answered with id null): no tool
 * runs, and none of the store's API requests is taken for it. A request with
 * `"id": null` is not a notification (a notification has no id member at
 * all), so it is answered with that same error, never with a silent 202.
 */
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("No external requests in this test"); }) as typeof fetch;
  try {
    const owner = "c7-mcp-rpc-id@example.com";
    await claimHandle(owner, "c7rpcidcheck", "Synthetic RPC id store", "");
    await ensureStatsId(owner);
    await setSubscription(owner, { customerId: "cus_C7RpcIdCheck001", subscriptionId: "sub_C7RpcIdCheck001", active: true, tier: "creator", period: paidPeriod() });
    const store = (await storeForEmail(owner))!;
    const made = await makeKey(store.sid, "Synthetic read-only key");
    if (!made.ok) throw new Error("No synthetic key");
    const send = async (body: Record<string, unknown>) =>
      POST(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${made.key}` },
        body: JSON.stringify(body),
      }));

    part("A request whose id is not a string or a number is an Invalid Request, and no tool runs");
    for (const [label, id] of [["an object", { a: 1 }], ["an array", [1]], ["true", true]] as const) {
      const response = await send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_store" } });
      const answer = (await response.json()) as { id?: unknown; result?: unknown; error?: { code?: unknown } };
      is(`id ${label}: refused as an invalid request`, answer.error?.code, -32600);
      is(`id ${label}: answered with id null`, answer.id, null);
      is(`id ${label}: no tool result`, answer.result, undefined);
    }

    part("A request with id null is not a notification: it is answered, never a silent 202");
    const nulled = await send({ jsonrpc: "2.0", id: null, method: "tools/call", params: { name: "get_store" } });
    is("id null: answered with a body, not 202", nulled.status === 202, false);
    const said = (await nulled.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    is("id null: refused as an invalid request", said?.error?.code, -32600);

    part("Valid ids still work, and a real notification is still a 202");
    const ok = (await (await send({ jsonrpc: "2.0", id: "abc", method: "tools/call", params: { name: "get_store" } })).json()) as { id?: unknown; result?: { isError?: unknown } };
    is("a string id is answered with the tool", [ok.id, ok.result?.isError], ["abc", false]);
    const ok2 = (await (await send({ jsonrpc: "2.0", id: 7, method: "ping" })).json()) as { id?: unknown; result?: unknown };
    is("an integer id is answered", [ok2.id, ok2.result], [7, {}]);
    const note = await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    is("a notification (no id member) is a 202", note.status, 202);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
