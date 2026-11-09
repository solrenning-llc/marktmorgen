import { MemoryRedis } from "@/lib/redis-memory";
import type { NextRequest } from "next/server";
import type { Store } from "@/lib/store";

const redis = new MemoryRedis();
const store = { sid: "c".repeat(32), handle: "test-preview" } as Store;
export const state = {
  override: false, reply: undefined as unknown, throws: false,
  storeFound: true, publicAllowed: true, authorized: true,
  commands: [] as (string | number)[][], lookups: 0, publicCalls: 0,
  listings: 0, copies: 0, serves: 0, settings: 0,
};
export function reset() {
  redis.clear();
  Object.assign(state, { override: false, reply: undefined, throws: false, storeFound: true, publicAllowed: true, authorized: true, commands: [], lookups: 0, publicCalls: 0, listings: 0, copies: 0, serves: 0, settings: 0 });
}
export const isRedisConfigured = () => true;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  state.commands.push(...commands);
  if (state.throws) throw new Error("Synthetic preview counter timeout");
  return state.override ? state.reply as unknown[] : redis.pipeline(commands);
}
/** Controlled data/provider boundaries; the route and its counter are real. */
export const normaliseHandle = (value: string) => value;
export async function storeForHandle() { state.lookups += 1; return state.storeFound ? store : null; }
export async function takePublicRequest() { state.publicCalls += 1; return state.publicAllowed; }
export async function holdPublicRequests() { return state.publicAllowed; }
export async function readListing() { state.listings += 1; return { id: "p1234", hidden: false, preview: 3, file: { pathname: "synthetic.pdf" } }; }
export const MAX_PREVIEW_PAGES = 10;
export async function previewCopy() { state.copies += 1; return { pathname: "synthetic-preview.pdf" }; }
export function plain(status: number, body: string) { return new Response(body, { status }); }
export async function serveFile(_file: unknown, options: { paid: boolean }) {
  if (options.paid !== false) throw new Error("Preview must keep its existing free-download path");
  state.serves += 1; return new Response("Synthetic preview bytes", { status: 200 });
}
export const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";
export async function guardStoreWrite(request: NextRequest) {
  if (!state.authorized) return { ok: false as const, response: Response.json({ ok: false, error: "role" }, { status: 403 }) };
  return { ok: true as const, store, ref: "synthetic-ref", body: await request.json() as Record<string, unknown> };
}
export async function setProductPreview(_ref: string, id: string, pages: number) { state.settings += 1; return { ok: true as const, product: { id, preview: pages } }; }
