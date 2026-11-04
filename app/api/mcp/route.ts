import { apiStore, takeMoreApi } from "@/lib/api-guard";
import { API_NUMBERS_UNITS } from "@/lib/store-allowance-rules";
import { limited } from "@/lib/request-guard";
import { products, storeInfo } from "@/lib/api-read";
import { readNumbers, summaryOf } from "@/lib/stats-report";
import type { StatsData } from "@/lib/stats";
import {
  affiliatesTool,
  buyersTool,
  channelsTool,
  emailsTool,
  funnelTool,
  insightsTool,
  membershipsTool,
  productsTool,
  readFullNumbers,
  windowOf,
} from "@/lib/mcp-tools";

/**
 * The Marktmorgen MCP server (added 11 October 2026): a creator's AI
 * assistant — Claude, ChatGPT, Cursor, anything that speaks the Model Context
 * Protocol — can ask about their store in plain words: "which channel made me
 * money this month?", "what did my October reel bring?".
 *
 * Streamable HTTP, JSON only, one JSON-RPC message per request; a GET is
 * answered 405, because no stream is offered. The key is the same API key as
 * /api/v1, through the same door (lib/api-guard.ts) and the same limit per
 * minute; `initialize` alone is answered before the key is read, so a client
 * can learn what this is before it has been given anything, and that answer
 * carries no store's data.
 *
 * Read only: numbers, products, memberships, emails and affiliates, each as
 * the studio shows them (lib/mcp-tools.ts, added 12 October 2026, beside the
 * first three). Buyers', members', subscribers' and affiliates' addresses
 * and words stay out of it on purpose: an assistant's conversation is kept by
 * whoever runs the assistant, and the people on a creator's list never agreed
 * to be read there. The API is where a creator's own tools read those.
 */
import { MCP_INSTRUCTIONS, MCP_PROTOCOL as PROTOCOL, MCP_SERVER, MCP_TOOLS as TOOLS } from "@/lib/mcp-catalog";

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const result = (id: unknown, value: unknown) => json({ jsonrpc: "2.0", id, result: value });
const failure = (id: unknown, code: number, message: string) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
/** The tools that read the store's sales again (lib/mcp-tools.ts): counted as API_NUMBERS_UNITS. */
const SALES_TOOLS = new Set(["get_numbers", "get_revenue_by_channel", "get_funnel", "get_product_numbers", "get_buyers", "get_worth_knowing", "get_emails"]);
const said = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError });

export async function GET() {
  return new Response("This MCP server answers POST only.", { status: 405, headers: { Allow: "POST" } });
}

/** The most one JSON-RPC message may weigh: far past any call a tool takes. */
const MAX_RPC_BYTES = 16_000;

export async function POST(request: Request) {
  let message: Rpc;
  try {
    // Read only as far as MAX_RPC_BYTES, whether or not a length was declared (docs/security-audit-2026-10-18.md, MM-SA-10).
    message = (await (await limited(request, MAX_RPC_BYTES)).json()) as Rpc;
  } catch {
    return failure(null, -32700, "Parse error");
  }
  if (Array.isArray(message)) return failure(null, -32600, "One message per request.");
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return failure(message?.id, -32600, "Invalid request");
  const { id, method } = message;
  // A notification has no id and wants no answer.
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  if (method === "initialize") {
    return result(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER,
      instructions: MCP_INSTRUCTIONS,
    });
  }
  if (method === "ping") return result(id, {});

  const store = await apiStore(request);
  if (store instanceof Response) {
    // The refusal's own sentence (a pause, the month used, the minute), so an
    // assistant never asks for a key that was already accepted (232 [CA1] 4b4c).
    if (store.status === 401) return failure(id, -32001, "Send your Marktmorgen API key as: Authorization: Bearer nl_live_…");
    const said = (await store.json().catch(() => null)) as { message?: unknown } | null;
    return failure(id, -32001, typeof said?.message === "string" ? said.message : "That could not be read just now. Try again in a moment.");
  }

  if (method === "tools/list") return result(id, { tools: TOOLS });
  if (method !== "tools/call") return failure(id, -32601, "Method not found");

  const params = (message.params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> };
  // A tool that reads the store's sales again from Stripe (the numbers, and what each email sold) counts as
  // API_NUMBERS_UNITS of the store's API requests, taken before it reads; refused, the figure's own sentence.
  if (typeof params.name === "string" && SALES_TOOLS.has(params.name)) {
    const refused = await takeMoreApi(store, API_NUMBERS_UNITS - 1);
    if (refused) {
      const words = (await refused.json().catch(() => null)) as { message?: unknown } | null;
      return result(id, said({ error: typeof words?.message === "string" && words.message ? words.message : "That could not be counted just now. Try again in a moment." }, true));
    }
  }
  try {
    if (params.name === "get_store") return result(id, said(storeInfo(store)));
    if (params.name === "get_numbers") {
      const data = await readNumbers(store);
      return result(id, data ? said(summaryOf(data)) : said({ error: "Your numbers could not be read just now. Try again in a moment." }, true));
    }
    const days = windowOf(params.arguments?.days);
    const windowed: Record<string, (data: StatsData) => unknown | Promise<unknown>> = {
      get_revenue_by_channel: (data) => channelsTool(data, days),
      get_funnel: (data) => funnelTool(data, days),
      get_product_numbers: (data) => productsTool(store, data, days),
      get_buyers: (data) => buyersTool(data, days),
      get_worth_knowing: (data) => insightsTool(data, days),
    };
    const tool = typeof params.name === "string" && Object.hasOwn(windowed, params.name) ? windowed[params.name] : undefined;
    if (typeof tool === "function") {
      const data = await readFullNumbers(store);
      return result(id, data ? said(await tool(data)) : said({ error: "Your numbers could not be read just now. Try again in a moment." }, true));
    }
    if (params.name === "get_memberships") return result(id, said(await membershipsTool(store)));
    if (params.name === "get_emails") return result(id, said(await emailsTool(store)));
    if (params.name === "get_affiliates") return result(id, said(await affiliatesTool(store)));
    if (params.name === "list_products") {
      const cursor = typeof params.arguments?.cursor === "string" ? params.arguments.cursor.slice(0, 200) : null;
      return result(id, said(await products(store, cursor)));
    }
    return result(id, said({ error: `There is no tool called ${String(params.name).slice(0, 40)}.` }, true));
  } catch (error) {
    console.error("mcp: a tool failed", error);
    return result(id, said({ error: "That could not be read just now. Try again in a moment." }, true));
  }
}
