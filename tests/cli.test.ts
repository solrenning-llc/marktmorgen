/**
 * 631 [AA1] (b), unit 6: the command line (cli/marktmorgen.mjs) runs the MCP
 * server's tools with the key from the environment only. Run against the real
 * route (app/api/mcp/route.ts) with a synthetic store and key; nothing leaves
 * this process.
 */
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { HELP, parseArguments, run, serverUrl } from "../cli/marktmorgen.mjs";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "cli-check@example.com";

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => {
    outside += 1;
    throw new Error("No outside requests in this test");
  }) as typeof fetch;
  try {
    await claimHandle(OWNER, "cli-check-shop", "CLI Check Shop", "");
    await ensureStatsId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_CliCheck0001", subscriptionId: "sub_CliCheck0001", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    const store = (await storeForEmail(OWNER))!;
    const made = await makeKey(store.sid, "Synthetic command line key");
    if (!made.ok) throw new Error("No synthetic key");

    /** Every request goes to the real MCP route, and only to its address. */
    const sent: { url: string; auth: string | null; agent: string | null }[] = [];
    const routeFetch = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      sent.push({ url, auth: headers.get("authorization"), agent: headers.get("user-agent") });
      return POST(new Request(url, init));
    }) as unknown as typeof fetch;
    const cli = async (argv: string[], env: Record<string, string> = { MARKTMORGEN_API_KEY: made.key }) => {
      let out = "";
      let err = "";
      const code = await run(argv, { env, fetchImpl: routeFetch, write: (t: string) => { out += t; }, warn: (t: string) => { err += t; } });
      return { code, out, err };
    };

    part("Help");
    is("help prints the commands", (await cli(["help"])).out, HELP);
    is("no command: help, and a usage exit", (await cli([])).code, 2);

    part("The key comes from the environment only");
    const noKey = await cli(["tools"], {});
    is("without it: refused before anything is sent", [noKey.code, sent.length, noKey.err.includes("MARKTMORGEN_API_KEY")], [2, 0, true]);
    is("a key on the command line is refused", (await cli(["get_store", "--key", made.key])).err.includes("Never put the key in the command"), true);
    is("a bare key on the command line is refused", (await cli(["get_store", made.key])).err.includes("Never put the key in the command"), true);
    is("still nothing sent", sent.length, 0);

    part("Only to Marktmorgen, over https");
    is("the default address", serverUrl({}), "https://marktmorgen.com/api/mcp");
    is("http elsewhere is refused", serverUrl({ MARKTMORGEN_URL: "http://example.com" }), null);
    is("a local server for a test", serverUrl({ MARKTMORGEN_URL: "http://localhost:3000/" }), "http://localhost:3000/api/mcp");
    is("an address with a password in it is refused", serverUrl({ MARKTMORGEN_URL: "https://user:pass@marktmorgen.com" }), null);
    is("the command says so", (await cli(["tools"], { MARKTMORGEN_API_KEY: made.key, MARKTMORGEN_URL: "http://example.com" })).code, 2);

    part("tools: what the server lists for this key");
    const listed = (await (await POST(new Request("https://marktmorgen.com/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${made.key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }))).json()) as { result: { tools: { name: string }[] } };
    const served = listed.result.tools.map((t) => t.name);
    const tools = await cli(["tools"]);
    is("exit 0", tools.code, 0);
    is("the server serves tools", served.length > 0, true);
    is("every served tool is listed", served.filter((name) => !tools.out.split("\n").some((line) => line === name || line.startsWith(`${name} `))), []);
    is("with its options", tools.out.includes("get_funnel [--days]") && tools.out.includes("list_products [--cursor]"), true);
    is("sent to the MCP route with the key and the command line's name", [sent.at(-1)?.url, sent.at(-1)?.auth, sent.at(-1)?.agent], ["https://marktmorgen.com/api/mcp", `Bearer ${made.key}`, "marktmorgen-cli/0.1.0"]);

    part("A tool: its answer as JSON");
    const who = await cli(["get_store"]);
    const read = JSON.parse(who.out) as { handle?: string };
    is("get_store answers with this store", [who.code, read.handle], [0, "cli-check-shop"]);
    const week = await cli(["get_funnel", "--days", "7"]);
    is("a windowed tool answers for the window asked", [week.code, (JSON.parse(week.out) as { window?: string }).window], [0, "last_7_days"]);
    is("an unknown tool: the tool error, exit 1", [(await cli(["get_nothing"])).code], [1]);
    is("bad options are refused before sending", [parseArguments(["--days", "12"]).error, parseArguments(["--colour", "x"]).error], ["--days takes 7, 30 or 90.", "Unknown option: --colour"]);
    is("a command that is not a tool name is refused", (await cli(["../etc"])).code, 2);

    part("A revoked or wrong key");
    const wrong = await cli(["tools"], { MARKTMORGEN_API_KEY: `nl_live_${"0".repeat(40)}` });
    is("refused with the server's sentence, exit 2", [wrong.code, wrong.err.includes("Authorization: Bearer")], [2, true]);

    is("nothing reached outside", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

void main();
