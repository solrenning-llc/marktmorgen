import { apiAgent, apiStore, holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import { proposeDescription, proposeSummary, proposeTitle } from "@/lib/agent-propose";
import { limited } from "@/lib/request-guard";
import { products, storeInfo } from "@/lib/api-read";
import { BUNDLE_CHOICES_MOST, IMPORTS_MOST, type ReadMeter, type ReadWork, apiReadUnits, settledUnits } from "@/lib/api-read-rules";
import { apiNumbers } from "@/lib/api-numbers";
import { summaryOf } from "@/lib/stats-report";
import type { StatsData } from "@/lib/stats";
import { readTitles } from "@/lib/catalog";
import { rangeProblem, readLive, readRange, readToday } from "@/lib/stats";
import {
  affiliatesTool,
  buyersTool,
  channelsTool,
  emailsTool,
  funnelTool,
  insightsTool,
  liveTool,
  membershipsTool,
  productTextTool,
  productsTool,
  rangeTool,
  readCourseTool,
  readLessonTool,
  readPageReadingTool,
  readPageTestTool,
  readPageVersionsTool,
  savedBlocksTool,
  bundleChoicesTool,
  importsTool,
  readSalesPageTool,
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

  // A tool that prepares a change needs a key that may (631 [AA1] (c)); checked instead of the plain read, so the call is counted once.
  const asked = (message.params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> };
  const prepares = { propose_product_description: proposeDescription, propose_product_title: proposeTitle, propose_product_summary: proposeSummary } as const;
  if (method === "tools/call" && typeof asked.name === "string" && Object.hasOwn(prepares, asked.name)) {
    const agent = await apiAgent(request, "draft");
    if (agent instanceof Response) {
      const refusal = (await agent.json().catch(() => null)) as { message?: unknown } | null;
      return failure(id, -32001, typeof refusal?.message === "string" ? refusal.message : "This key cannot prepare changes for you to confirm.");
    }
    return result(id, await prepares[asked.name as keyof typeof prepares](agent.store, agent.keyId, asked.arguments ?? {}));
  }

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
    // Every other tool takes what it reads past the door before reading it (lib/api-read-rules.ts);
    // refused, the refusal's own sentence, as the door's.
    const charge = (more: number, taken?: number) => takeMoreApi(store, more, taken);
    const hold = (most: number) => holdMoreApi(store, most);
    const refusedWith = async (refusal: Response) => {
      const words = (await refusal.json().catch(() => null)) as { message?: unknown } | null;
      return failure(id, -32001, typeof words?.message === "string" ? words.message : "That could not be read just now. Try again in a moment.");
    };
    const answer = async (read: unknown) => (read instanceof Response ? refusedWith(read) : result(id, said(read)));
    // A tool of the creator's own records (631 [AA1]): set aside at its most before it reads anything, metered as it
    // reads, and settled at what it read and sends before it is sent (Codex G2 on #1933). Not read, nothing is shown.
    const paid = async (most: ReadWork, read: (meter: ReadMeter) => Promise<unknown>, unavailable: string) => {
      const held = apiReadUnits(most);
      const settle = await hold(held);
      if (settle instanceof Response) return refusedWith(settle);
      const meter: ReadMeter = { bytes: 0, commands: 0 };
      const value = await read(meter);
      const out = value === null || value === undefined ? said({ error: unavailable }, true) : said(value);
      const work = { commands: meter.commands, bytes: meter.bytes, sent: Buffer.byteLength(out.content[0].text), roundTrips: Math.min(most.roundTrips, meter.commands) };
      const refused = await settle(settledUnits(work, held));
      return refused ? refusedWith(refused) : result(id, out);
    };
    const days = windowOf(params.arguments?.days);
    const windowed: Record<string, (data: StatsData) => unknown | Promise<unknown>> = {
      get_numbers: (data) => summaryOf(data),
      get_revenue_by_channel: (data) => channelsTool(data, days),
      get_funnel: (data) => funnelTool(data, days),
      get_product_numbers: (data) => productsTool(store, data, days, { hold, charge }),
      get_buyers: (data) => buyersTool(data, days),
      get_worth_knowing: (data) => insightsTool(data, days),
    };
    const tool = typeof params.name === "string" && Object.hasOwn(windowed, params.name) ? windowed[params.name] : undefined;
    if (typeof tool === "function") {
      // The numbers, from the copy kept an hour or read anew, paid for first (lib/api-numbers.ts); get_numbers without the products' listings, as /api/v1/stats.
      const read = await apiNumbers(store, params.name === "get_numbers" ? "plain" : "full", charge, hold);
      if (read instanceof Response) return refusedWith(read);
      if (!read) return result(id, said({ error: "Your numbers could not be read just now. Try again in a moment." }, true));
      const value = {
        ...((await tool(read.data)) as Record<string, unknown>),
        asOf: read.asOf,
        ...(read.listed ? {} : { products_note: "The products' names were not read: your store's API requests left did not cover them." }),
      };
      const answer = said(value);
      // What the answer sends is settled before it is sent.
      const refused = await read.settle(Buffer.byteLength(answer.content[0].text));
      return refused ? refusedWith(refused) : result(id, answer);
    }
    if (params.name === "get_live") {
      const [live, today] = await Promise.all([readLive(store), readToday(store).catch(() => null)]);
      return result(id, said(liveTool(live, today)));
    }
    if (params.name === "get_numbers_for_days") {
      const from = typeof params.arguments?.from === "string" ? params.arguments.from.slice(0, 10) : "";
      const to = typeof params.arguments?.to === "string" ? params.arguments.to.slice(0, 10) : "";
      const problem = rangeProblem(from, to);
      if (problem) {
        const words = { dates: "Send from and to as YYYY-MM-DD.", order: "from must not be after to.", future: "to must not be after today (UTC).", kept: "Days are kept for 400 days; start later." } as const;
        return result(id, said({ error: words[problem] }, true));
      }
      const [range, titles] = await Promise.all([readRange(store, from, to), readTitles(store).catch(() => new Map<string, string>())]);
      return result(id, range ? said(rangeTool(range, titles)) : said({ error: "Your numbers could not be read just now. Try again in a moment." }, true));
    }
    if (params.name === "get_product_description" || params.name === "get_sales_page") {
      const product = typeof params.arguments?.product === "string" ? params.arguments.product.slice(0, 40) : "";
      const found = product ? await (params.name === "get_sales_page" ? readSalesPageTool(store, product) : productTextTool(store, product)) : null;
      return result(id, found ? said(found) : said({ error: "There is no product with that id in this store. Use list_products for the ids." }, true));
    }
    if (params.name === "get_course_outline" || params.name === "get_lesson") {
      const product = typeof params.arguments?.product === "string" ? params.arguments.product.slice(0, 40) : "";
      const lesson = typeof params.arguments?.lesson === "string" ? params.arguments.lesson.slice(0, 40) : "";
      const found = !product ? null : params.name === "get_lesson" ? (lesson ? await readLessonTool(store, product, lesson) : null) : await readCourseTool(store, product);
      return result(id, found ? said(found) : said({ error: params.name === "get_lesson" ? "There is no such lesson in this store's courses. Use get_course_outline for the ids." : "There is no course with that id in this store. Use list_products for the ids." }, true));
    }
    if (params.name === "get_page_test" || params.name === "get_page_reading") {
      const product = typeof params.arguments?.product === "string" ? params.arguments.product.slice(0, 40) : "";
      const unknown = { error: "There is no product with that id in this store. Use list_products for the ids." };
      if (params.name === "get_page_reading") {
        const reading = product ? await readPageReadingTool(store, product) : null;
        return result(id, reading ? said(reading) : said(unknown, true));
      }
      const tested = product ? await readPageTestTool(store, product) : { found: false as const, error: unknown.error };
      return result(id, tested.found ? said(tested.value) : said({ error: tested.error }, true));
    }
    if (params.name === "get_page_versions") {
      const product = typeof params.arguments?.product === "string" ? params.arguments.product.slice(0, 40) : "";
      const raw = params.arguments?.version;
      const version = raw === undefined || raw === null ? null : Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) < 100 ? (raw as number) : -1;
      if (version === -1) return result(id, said({ error: "version is a whole number from the list, 0 for the newest." }, true));
      const found = product ? await readPageVersionsTool(store, product, version) : { found: false as const, error: "There is no product with that id in this store. Use list_products for the ids." };
      return result(id, found.found ? said(found.value) : said({ error: found.error }, true));
    }
    if (params.name === "list_saved_blocks") return result(id, said(await savedBlocksTool(store)));
    if (params.name === "list_bundle_choices") return paid(BUNDLE_CHOICES_MOST, (meter) => bundleChoicesTool(store, params.arguments ?? {}, meter), "This page of products could not be read just now. Nothing was left out on purpose; try the same cursor again in a moment.");
    if (params.name === "get_imports") return paid(IMPORTS_MOST, (meter) => importsTool(store, meter), "Your imports could not be read just now. This is not an empty history; try again in a moment.");
    if (params.name === "get_memberships") return answer(await membershipsTool(store, charge));
    if (params.name === "get_emails") return answer(await emailsTool(store, charge));
    if (params.name === "get_affiliates") return answer(await affiliatesTool(store, charge));
    if (params.name === "list_products") {
      const cursor = typeof params.arguments?.cursor === "string" ? params.arguments.cursor.slice(0, 200) : null;
      return answer(await products(store, cursor, charge));
    }
    return result(id, said({ error: `There is no tool called ${String(params.name).slice(0, 40)}.` }, true));
  } catch (error) {
    console.error("mcp: a tool failed", error);
    return result(id, said({ error: "That could not be read just now. Try again in a moment." }, true));
  }
}
