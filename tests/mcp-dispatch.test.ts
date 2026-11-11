import { POST } from "@/app/api/mcp/route";
import { makeKey, revokeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = (async () => { externalCalls += 1; throw new Error("No external requests in MCP dispatch regression"); }) as typeof fetch;
  try {
    const owner = "mcp-dispatch@example.com";
    await claimHandle(owner, "dispatchcheck", "Synthetic dispatch store", "");
    await ensureStatsId(owner);
    await setSubscription(owner, { customerId: "cus_DispatchCheck001", subscriptionId: "sub_DispatchCheck001", active: true, tier: "creator", period: paidPeriod() });
    const store = (await storeForEmail(owner))!;
    const made = await makeKey(store.sid, "Synthetic read-only key");
    if (!made.ok) throw new Error("No synthetic key");
    let id = 0;
    const call = async (method: string, params: unknown, authenticated = true) => {
      const response = await POST(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${made.key}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }));
      return response.json();
    };

    part("Only advertised MCP tools can be dispatched");
    const listed = await call("tools/list", {});
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    is("the twenty-two advertised tools remain", names.length, 22);
    is("advertised names stay unique", new Set(names).size, 22);
    is("prototype properties are not advertised", names.includes("constructor") || names.includes("toString"), false);
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "not_a_tool"]) {
      const answer = await call("tools/call", { name, arguments: { days: 7 } });
      is("unknown tool is an explicit error: " + name, answer.result.isError, true);
      const payload = JSON.parse(answer.result.content[0].text);
      is("unknown tool takes the same refusal path: " + name, payload, { error: `There is no tool called ${name}.` });
      is("no raw statistics returned: " + name, Object.keys(payload), ["error"]);
    }

    part("Real API authentication and advertised dispatch remain");
    const current = await call("tools/call", { name: "get_store" });
    is("known tool succeeds", current.result.isError, false);
    is("known tool stays in its own store", JSON.parse(current.result.content[0].text), { handle: store.handle, name: store.name, currency: store.currency });
    const unauthorized = await call("tools/call", { name: "constructor" }, false);
    is("authentication still precedes dispatch", unauthorized.error.code, -32001);
    await revokeKey(store.sid, made.made.id);
    const revoked = await call("tools/list", {});
    is("revoked key cannot list tools", revoked.error.code, -32001);
    is("no external request was attempted", externalCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
