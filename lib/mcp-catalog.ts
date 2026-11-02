/**
 * What the Marktmorgen MCP server offers, written once (631 [AA1] (b), unit 5,
 * 2 November 2026): the protocol version, the server's name, its instructions
 * and every tool with its description and input. app/api/mcp/route.ts answers
 * `initialize` and `tools/list` from here, and /llms.txt (app/llms.txt/route.ts)
 * is generated from the same list, so the documentation an agent reads can
 * never name a tool the server does not serve, or miss one it does.
 *
 * Moved here unchanged from app/api/mcp/route.ts, where the tools themselves
 * are still dispatched.
 */
export type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; additionalProperties: boolean };
  annotations: { readOnlyHint: boolean };
};

export const MCP_SERVER = { name: "marktmorgen", version: "1.1.0" } as const;

export const MCP_INSTRUCTIONS =
  "Read a Marktmorgen store's numbers, products, memberships, emails and affiliate program, never anybody's name or address. Money fields are in the smallest unit of the store's currency. A channel named 'direct' is a visit or sale from nowhere the store could name. Tools that take `days` read the last 7, 30 or 90 days.";

export const MCP_PROTOCOL = "2025-06-18";

export const MCP_TOOLS: readonly McpTool[] = [
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
