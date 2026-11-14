import { apiAgent, apiStore, holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import { proposeDescription } from "@/lib/agent-propose";
import { BookReadRefused } from "@/lib/agent-book";
import { PRODUCT_DESCRIPTION } from "@/lib/agent-kinds";
import { addWork, apiReadUnits, listingsWork, proposeWork } from "@/lib/api-read-rules";
import { listingsToRead } from "@/lib/catalog-read-count";
import { limited } from "@/lib/request-guard";
import { products, storeInfo } from "@/lib/api-read";
import { apiNumbers } from "@/lib/api-numbers";
import { summaryOf } from "@/lib/stats-report";
import type { StatsData } from "@/lib/stats";
import {
  affiliatesTool,
  bundleChoicesTool,
  buyersTool,
  channelsTool,
  emailsTool,
  funnelTool,
  importsTool,
  insightsTool,
  membershipsTool,
  productTextTool,
  productsTool,
  readCourseTool,
  readLessonTool,
  readPageReadingTool,
  readPageTestTool,
  readPageVersionsTool,
  readSalesPageTool,
  savedBlocksTool,
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
  if (method === "tools/call" && asked.name === "propose_product_description") {
    const agent = await apiAgent(request, "draft");
    if (agent instanceof Response) {
      const refusal = (await agent.json().catch(() => null)) as { message?: unknown } | null;
      return failure(id, -32001, typeof refusal?.message === "string" ? refusal.message : "This key cannot prepare changes for you to confirm.");
    }
    // Paid for before it reads (lib/api-read-rules.ts, proposeWork): first all but the book; then the book, measured
    // under its lock where it cannot grow, at what it weighs, before it is read. Refused, the refusal's own sentence.
    const named = typeof asked.arguments?.product === "string" ? asked.arguments.product.slice(0, 40) : "";
    const envelope = (book: number) => apiReadUnits(addWork(listingsWork(3 * listingsToRead(agent.store, named ? [named] : [])), proposeWork(book, PRODUCT_DESCRIPTION.maxBytes)));
    const refusedWords = async (refusal: Response) => {
      const words = (await refusal.json().catch(() => null)) as { message?: unknown } | null;
      return failure(id, -32001, typeof words?.message === "string" ? words.message : "That could not be prepared just now. Try again in a moment.");
    };
    const first = envelope(0);
    const opened = await takeMoreApi(agent.store, first);
    if (opened) return refusedWords(opened);
    let refusal: Response | null = null;
    const admit = async (bytes: number) => {
      refusal = await takeMoreApi(agent.store, envelope(bytes) - first, first);
      return refusal === null;
    };
    try {
      return result(id, await proposeDescription(agent.store, agent.keyId, asked.arguments ?? {}, admit));
    } catch (error) {
      if (error instanceof BookReadRefused && refusal) return refusedWords(refusal);
      if (error instanceof BookReadRefused) return failure(id, -32001, "That could not be prepared just now. Try again in a moment.");
      throw error;
    }
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
        ...(read.listed ? {} : { products_note: "The products' names were not read: your store's API requests left did not cover them, or they could not be read just now. An empty products list here is not a store without products." }),
      };
      const answer = said(value);
      // What the answer sends is settled before it is sent.
      const refused = await read.settle(Buffer.byteLength(answer.content[0].text));
      return refused ? refusedWith(refused) : result(id, answer);
    }
    if (params.name === "get_memberships") return answer(await membershipsTool(store, charge));
    if (params.name === "get_emails") return answer(await emailsTool(store, { charge, hold }));
    if (params.name === "get_affiliates") return answer(await affiliatesTool(store, charge));
    // The store's pages and courses (631 [AA1] (a)): each takes what it reads, at its most, before reading (lib/api-read-rules.ts).
    const unknownProduct = { error: "There is no product with that id in this store. Use list_products for the ids." };
    const productArg = typeof params.arguments?.product === "string" ? params.arguments.product.slice(0, 40) : "";
    if (params.name === "get_product_description" || params.name === "get_sales_page") {
      if (!productArg) return result(id, said(unknownProduct, true));
      const found = await (params.name === "get_sales_page" ? readSalesPageTool(store, productArg, charge) : productTextTool(store, productArg, charge));
      if (found instanceof Response) return refusedWith(found);
      return result(id, found ? said(found, "error" in found) : said(unknownProduct, true));
    }
    if (params.name === "get_course_outline" || params.name === "get_lesson") {
      const lesson = typeof params.arguments?.lesson === "string" ? params.arguments.lesson.slice(0, 40) : "";
      const missing = { error: params.name === "get_lesson" ? "There is no such lesson in this store's courses. Use get_course_outline for the ids." : "There is no course with that id in this store. Use list_products for the ids." };
      if (!productArg || (params.name === "get_lesson" && !lesson)) return result(id, said(missing, true));
      const found = params.name === "get_lesson" ? await readLessonTool(store, productArg, lesson, charge) : await readCourseTool(store, productArg, charge);
      if (found instanceof Response) return refusedWith(found);
      return result(id, found ? said(found) : said(missing, true));
    }
    if (params.name === "get_page_test") {
      if (!productArg) return result(id, said(unknownProduct, true));
      const tested = await readPageTestTool(store, productArg, charge);
      if (tested instanceof Response) return refusedWith(tested);
      return result(id, tested.found ? said(tested.value) : said({ error: tested.error }, true));
    }
    if (params.name === "get_page_reading") {
      if (!productArg) return result(id, said(unknownProduct, true));
      const reading = await readPageReadingTool(store, productArg, charge);
      if (reading instanceof Response) return refusedWith(reading);
      return result(id, reading ? said(reading, "error" in reading) : said(unknownProduct, true));
    }
    if (params.name === "get_page_versions") {
      const raw = params.arguments?.version;
      const version = raw === undefined || raw === null ? null : Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) < 100 ? (raw as number) : -1;
      if (version === -1) return result(id, said({ error: "version is a whole number from the list, 0 for the newest." }, true));
      if (!productArg) return result(id, said(unknownProduct, true));
      const found = await readPageVersionsTool(store, productArg, version, hold);
      if (found instanceof Response) return refusedWith(found);
      return result(id, found.found ? said(found.value) : said({ error: found.error }, true));
    }
    if (params.name === "list_saved_blocks") {
      const listed = await savedBlocksTool(store, hold);
      if (listed instanceof Response) return refusedWith(listed);
      return result(id, said(listed, listed.sections === null));
    }
    // What a bundle can be made of, and the store's imports (631 [AA1] (a)): each sets aside its most before reading
    // and is settled at what it read and sends before it is sent (lib/mcp-tools.ts).
    if (params.name === "list_bundle_choices" || params.name === "get_imports") {
      const read = params.name === "get_imports" ? await importsTool(store, hold) : await bundleChoicesTool(store, params.arguments ?? {}, hold);
      if (read instanceof Response) return refusedWith(read);
      return result(id, read.found ? said(read.value) : said({ error: read.error }, true));
    }
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
