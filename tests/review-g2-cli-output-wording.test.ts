import { run } from "../cli/marktmorgen.mjs";
import { done, is } from "./check";
async function main() {
  let out = "", calls = 0;
  const code = await run(["get_store"], {
    env: { MARKTMORGEN_API_KEY: "nl_live_" + "a".repeat(40) },
    fetchImpl: (async (_url: unknown, init: RequestInit) => {
      calls++;
      const { id } = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Plain result" }] } }), { status: 200 });
    }) as typeof fetch,
    write: (text: string) => { out += text; }, warn: () => {},
  });
  is("control: one confirmed success, no retry", [code, calls], [0, 1]);
  is("control: text is preserved", out, "Plain result\n");
  let json = true; try { JSON.parse(out); } catch { json = false; }
  is("README line 33 and HELP line 42 promise JSON for any tool", json, true);
  done();
}
void main();
