import { apiStore } from "@/lib/api-guard";
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
const PROTOCOL = "2025-06-18";

const TOOLS = [
  {
    name: "get_numbers",
    description:
      "The store's numbers for the last 7, 30 and 90 days: visitors, checkouts, sales and revenue; each channel (instagram, tiktok, newsletter…) from visit to sale; and page views by country and device, each window with the same stretch of days just before it under previous. Money is in the smallest unit of the store's currency (cents for USD), before Stripe's fee.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_products",
    description: "The store's products in the order the store shows them, drafts included, 50 at a time. Pass the returned `next` as `cursor` for more.",
    inputSchema: { type: "object", properties: { cursor: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  ...(
    [
      ["get_revenue_by_channel", "Revenue by channel for the last 7, 30 or 90 days: each channel's visits, checkouts, free sign-ups, sales and revenue; the same money credited three ways (last visit, first visit, what buyers said after paying); and money by ad and by post."],
      ["get_funnel", "From visit to sale for the last 7, 30 or 90 days, with the same stretch of days before, the rates between each step, and how far down the store page visitors read and what they clicked."],
      ["get_product_numbers", "Each product for the last 7, 30 or 90 days: page views, checkouts, sales, revenue and sales per view; and, from all sales, which product is bought first and what buyers buy next, how many and how many days later."],
      ["get_buyers", "Who bought in the last 7, 30 or 90 days, in numbers only: people, orders, revenue, how many had bought before and how many bought more than once. No names or addresses."],
      ["get_worth_knowing", "What changed in the last 7, 30 or 90 days that is worth acting on, by the studio's own fixed rules, with the arithmetic behind any money at stake."],
    ] as const
  ).map(([name, description]) => ({
    name,
    description,
    inputSchema: { type: "object", properties: { days: { type: "number", enum: [7, 30, 90], description: "The window; 30 when left out." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  })),
  {
    name: "get_memberships",
    description: "Memberships as the Membership numbers page shows them: MRR and ARR, paying and trialing members, churn, trials that converted, each membership, each channel's members and how long they stay, why members left (counted), MRR month by month by what moved it, ARPU, net revenue retention and a three-month forecast.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_emails",
    description: "The store's list (how many people, how many agreed to hear) and what each email and each sequence did: how many it went to, and the sales and revenue its links brought, in the store's currency, with sales_in_another_currency counted apart and never added to revenue.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_affiliates",
    description: "The affiliate program's terms and each affiliate by their link's code: clicks, sales, earned, paid, owed, payable now, and anything held for review and why. No addresses.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_store",
    description: "Which store this key reads: its handle, name and currency.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const result = (id: unknown, value: unknown) => json({ jsonrpc: "2.0", id, result: value });
const failure = (id: unknown, code: number, message: string) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
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
      serverInfo: { name: "marktmorgen", version: "1.1.0" },
      instructions:
        "Read a Marktmorgen store's numbers, products, memberships, emails and affiliate program, never anybody's name or address. Money fields are in the smallest unit of the store's currency. A channel named 'direct' is a visit or sale from nowhere the store could name. Tools that take `days` read the last 7, 30 or 90 days.",
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
