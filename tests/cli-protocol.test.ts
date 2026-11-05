/** Real CLI, synthetic HTTP responses. JSON-RPC 2.0 section 5: response identity and result/error are mandatory. */
import { run } from "../cli/marktmorgen.mjs";
import { done, is, part } from "./check";

type Data = Record<string, unknown>;
async function invoke(body: (id: number) => unknown, status = 200, command = "get_store") {
  let out = "", err = "", calls = 0;
  const code = await run([command], {
    env: { MARKTMORGEN_API_KEY: "nl_live_" + "a".repeat(40) },
    fetchImpl: (async (_url: unknown, init: RequestInit) => {
      calls++;
      const id = (JSON.parse(String(init.body)) as { id: number }).id;
      return new Response(JSON.stringify(body(id)), { status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
    write: (text: string) => { out += text; }, warn: (text: string) => { err += text; },
  });
  return { code, out, err, calls };
}
const success = (id: number): Data => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: '{"handle":"example-shop"}' }] } });

async function main() {
  part("A confirmed tool result and a confirmed server error");
  const good = await invoke(success);
  is("a matching successful response keeps the output", [good.code, good.out, good.err, good.calls], [0, '{"handle":"example-shop"}\n', "", 1]);
  const badTool = await invoke((id) => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Tool declined." }] } }));
  is("a valid tool error stays exit 1", [badTool.code, badTool.out, badTool.err], [1, "", "Tool declined.\n"]);
  const error = await invoke((id) => ({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool." } }));
  is("a valid RPC error stays exit 2", [error.code, error.out, error.err], [2, "", "Unknown tool.\n"]);

  part("Missing, ambiguous or unrelated confirmations never become success");
  const cases: [string, (id: number) => unknown][] = [
    ["null", () => null], ["array", () => []], ["primitive", () => 5],
    ["missing version", (id) => ({ id, result: success(id).result })],
    ["wrong version", (id) => ({ ...success(id), jsonrpc: "1.0" })],
    ["missing id", (id) => ({ jsonrpc: "2.0", result: success(id).result })],
    ["other id", (id) => ({ ...success(id), id: id + 1 })],
    ["string id", (id) => ({ ...success(id), id: String(id) })],
    ["null id", (id) => ({ ...success(id), id: null })],
    ["missing result", (id) => ({ jsonrpc: "2.0", id })],
    ["result and error", (id) => ({ ...success(id), error: { code: -1, message: "No." } })],
    ["null error", (id) => ({ jsonrpc: "2.0", id, error: null })],
    ["noninteger error code", (id) => ({ jsonrpc: "2.0", id, error: { code: 1.5, message: "No." } })],
    ["missing error message", (id) => ({ jsonrpc: "2.0", id, error: { code: -1 } })],
    ["null result", (id) => ({ ...success(id), result: null })],
    ["missing content", (id) => ({ ...success(id), result: {} })],
    ["bad content", (id) => ({ ...success(id), result: { content: {} } })],
    ["nonstring text", (id) => ({ ...success(id), result: { content: [{ type: "text", text: 5 }] } })],
    ["nonboolean error status", (id) => ({ ...success(id), result: { content: [], isError: "false" } })],
    ["misspelled content type (Codex G)", (id) => ({ ...success(id), result: { content: [{ type: "txet", text: "unconfirmed" }] } })],
    ["incomplete image content (Codex G)", (id) => ({ ...success(id), result: { content: [{ type: "image" }] } })],
    ["partial text before an unknown content type (Codex G)", (id) => ({ ...success(id), result: { content: [{ type: "text", text: "partial" }, { type: "not_a_content_type" }] } })],
    ["valid nontext content is explicitly unsupported by this text CLI", (id) => ({ ...success(id), result: { content: [{ type: "image", data: "eA==", mimeType: "image/png" }] } })],
  ];
  for (const [label, body] of cases) {
    const r = await invoke(body);
    is(label, [r.code, r.out, r.err.length > 0, r.calls], [2, "", true, 1]);
  }
  for (const status of [301, 401, 429, 500, 503]) {
    const r = await invoke(success, status);
    is(`HTTP ${status} with success-shaped JSON`, [r.code, r.out, r.err.length > 0, r.calls], [2, "", true, 1]);
  }
  part("The list is checked before any partial output");
  const tool = { name: "get_store", description: "Read the store.", inputSchema: { type: "object", properties: {} } };
  const listed = await invoke((id) => ({ jsonrpc: "2.0", id, result: { tools: [tool] } }), 200, "tools");
  is("a valid list still prints the tool", [listed.code, listed.out], [0, "get_store\n  Read the store.\n"]);
  const empty = await invoke((id) => ({ jsonrpc: "2.0", id, result: { tools: [] } }), 200, "tools");
  is("an explicitly empty list is valid", [empty.code, empty.out], [0, ""]);
  const optional = await invoke((id) => ({ jsonrpc: "2.0", id, result: { tools: [{ name: "get_store", inputSchema: { type: "object" } }] } }), 200, "tools");
  is("an optional description and empty schema stay valid without undefined output", [optional.code, optional.out], [0, "get_store\n  \n"]);
  for (const result of [{}, { tools: null }, { tools: {} }, { tools: [tool, null] }, { tools: [tool, { name: 5 }] }]) {
    const r = await invoke((id) => ({ jsonrpc: "2.0", id, result }), 200, "tools");
    is("malformed list is not reported as empty or partly successful", [r.code, r.out, r.err.length > 0, r.calls], [2, "", true, 1]);
  }
  const malformedText = await invoke((id) => ({ ...success(id), result: { content: [{ type: "text", text: "A partial result" }, null] } }));
  is("the entire tool result is checked before output", [malformedText.code, malformedText.out], [2, ""]);
  done();
}
void main();
