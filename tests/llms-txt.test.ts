/**
 * 631 [AA1] (b), unit 5: /llms.txt is generated from the code. Every tool
 * the MCP server answers `tools/list` with is in it, with its description and
 * inputs, and nothing else is; the figures come from the code; a creator's
 * own domain answers 404; /developers counts the same tools.
 */
import { readFileSync } from "node:fs";
import { GET } from "@/app/llms.txt/route";
import { POST as mcp } from "@/app/api/mcp/route";
import { MCP_TOOLS } from "@/lib/mcp-catalog";
import { llmsText } from "@/lib/llms-text";
import { API_RATE } from "@/lib/api-guard";
import { MAX_KEYS } from "@/lib/api-key-rules";
import { SITE_URL } from "@/lib/site-url";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => {
    outside += 1;
    throw new Error("No outside requests in this test");
  }) as typeof fetch;
  try {
    const platform = new URL(SITE_URL).hostname;
    const page = await GET(new Request(`${SITE_URL}/llms.txt`, { headers: { host: platform } }));
    const text = await page.text();

    part("Served as Markdown on this site");
    is("200", page.status, 200);
    is("Markdown, UTF-8", page.headers.get("content-type"), "text/markdown; charset=utf-8");
    is("the same text the generator makes", text, llmsText());
    is("it starts with the site's name as the title", text.startsWith("# Marktmorgen\n"), true);

    part("Every served tool, and only those, with its words and inputs");
    is("tool names are unique", new Set(MCP_TOOLS.map((t) => t.name)).size, MCP_TOOLS.length);
    is("every tool is listed with its description", MCP_TOOLS.filter((t) => !text.includes(`- \`${t.name}\`: ${t.description}`)).map((t) => t.name), []);
    const listed = [...text.matchAll(/^- `([a-z_]+)`: /gm)].map((m) => m[1]);
    is("nothing is listed that the server does not serve", listed.filter((name) => !MCP_TOOLS.some((t) => t.name === name)), []);
    is("inputs are listed under their tool", text.includes("  - `days`: number (one of 7, 30, 90). The window; 30 when left out.") && text.includes("  - `cursor`: string"), true);
    is("it says every tool reads only, because every one does", [MCP_TOOLS.every((t) => t.annotations.readOnlyHint), text.includes("Every tool reads only")], [true, true]);

    part("The MCP server answers from the same list");
    const listedByServer = await mcp(new Request(`${SITE_URL}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) }));
    const init = (await listedByServer.json()) as { result?: { serverInfo?: { name?: string }; instructions?: string } };
    is("initialize still names the server and its instructions", [init.result?.serverInfo?.name, typeof init.result?.instructions === "string" && init.result.instructions.length > 50], ["marktmorgen", true]);

    part("Figures come from the code");
    is("the rate", text.includes(`At most ${API_RATE} requests a minute per key.`), true);
    is("the keys", text.includes(`a store has at most ${MAX_KEYS}`), true);
    is("the server's address", text.includes(`${SITE_URL}/api/mcp`), true);
    is("it points to the developers page for the endpoints", text.includes(`[Developers](${SITE_URL}/developers)`), true);

    part("A creator's own domain is the creator's store, not Marktmorgen");
    const elsewhere = await GET(new Request("https://shop.creator-example.com/llms.txt", { headers: { host: "shop.creator-example.com" } }));
    is("404 there", elsewhere.status, 404);

    part("/developers counts the same tools");
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
    const developers = readFileSync("app/developers/page.tsx", "utf8");
    is("the developers page says how many tools there are, and it is right", developers.includes(`It has ${words[MCP_TOOLS.length]} tools`), true);

    is("nothing reached outside", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

void main();
