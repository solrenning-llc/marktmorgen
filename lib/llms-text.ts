import { MCP_TOOLS } from "@/lib/mcp-catalog";
import { API_RATE } from "@/lib/api-guard";
import { MAX_KEYS } from "@/lib/api-key-rules";
import { SITE_URL } from "@/lib/site-url";

/**
 * /llms.txt: what an AI agent needs to use Marktmorgen for a creator, in
 * plain Markdown (631 [AA1] (b), 614 [WP13], unit 5, 2 November 2026).
 *
 * Generated from the code, never written ahead of it (rule VR): the MCP
 * server's tools, with their descriptions and inputs, come from
 * lib/mcp-catalog.ts, the same list the server answers `tools/list` from; the
 * key and rate figures from lib/api-key-rules.ts and lib/api-guard.ts. A tool
 * added to the server appears here in the same change, and one that is not
 * served cannot appear. The REST endpoints are described, field for field,
 * on /developers, which this file points to rather than repeats.
 *
 * Served on this site only. A creator's own domain is the creator's store,
 * not Marktmorgen, so it answers 404 here.
 */
export function llmsText(): string {
  const tools = MCP_TOOLS.map((tool) => {
    const inputs = Object.entries(tool.inputSchema.properties).map(([name, schema]) => {
      const s = schema as { type?: string; enum?: unknown[]; description?: string };
      const allowed = Array.isArray(s.enum) ? ` (one of ${s.enum.join(", ")})` : "";
      return `  - \`${name}\`: ${s.type ?? "value"}${allowed}${s.description ? `. ${s.description}` : ""}`;
    });
    const reads = tool.annotations.readOnlyHint ? " Reads only." : "";
    return [`- \`${tool.name}\`: ${tool.description}${reads}`, ...inputs].join("\n");
  }).join("\n");
  const allRead = MCP_TOOLS.every((tool) => tool.annotations.readOnlyHint);

  return `# Marktmorgen

> Marktmorgen is where creators sell digital products, courses, memberships, calls and physical goods from their own store. A creator's AI assistant can read that store's numbers and catalog through Marktmorgen's MCP server, with an API key the creator makes in their studio.

## Connect

- MCP server (Streamable HTTP, JSON, one JSON-RPC message per POST): ${SITE_URL}/api/mcp
- Send the creator's key as the header \`Authorization: Bearer nl_live_…\`. The creator makes it in their studio, under API keys; a store has at most ${MAX_KEYS}, each revocable at once.
- At most ${API_RATE} requests a minute per key. Each request counts in the store's monthly API requests.
- \`initialize\` is answered before a key is read and carries no store's data.
- Money fields are in the smallest unit of the store's currency (cents for USD).

## MCP tools

${allRead ? "Every tool reads only: nothing a tool does changes the store.\n\n" : ""}${tools}

## Privacy

No tool returns a buyer's, member's, subscriber's or affiliate's name, address or words: an assistant's conversation is kept by whoever runs the assistant, and the people on a creator's list never agreed to be read there. Affiliates appear by their link's code.

## More

- [Developers](${SITE_URL}/developers): every REST endpoint under /api/v1, with keys, limits and example responses.
- [Help](${SITE_URL}/help): how creators use the studio.
`;
}
