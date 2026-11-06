import { MemoryRedis } from "@/lib/redis-memory";
import type { Store, Listing } from "@/lib/store";

/** Only transport, store/catalog and model boundaries are synthetic.
 * The two handlers, body/origin checks and both counter decoders are real.
 * Model counts below are attempted helper calls, not real supplier debits. */
export const redis = new MemoryRedis();
const shop = { sid: "c".repeat(32), statsId: "d".repeat(32), handle: "visitor-fixture" } as Store;
const product = { id: "p_fixture", hidden: false, about: true, page: true, title: "Synthetic product" } as unknown as Listing;
export const state = { scope: "", reply: undefined as unknown, throws: false, commit: false, commands: [] as (string | number)[][], models: 0, reads: 0, readBytes: 0, found: true, enabled: true, sellable: true };
export function reset() {
  redis.clear();
  Object.assign(state, { scope: "", reply: undefined, throws: false, commit: false, commands: [], models: 0, reads: 0, readBytes: 0, found: true, enabled: true, sellable: true });
}
export const isRedisConfigured = () => true;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  state.commands.push(...commands);
  if (state.scope && String(commands[0][1]).startsWith(`nl:rl:${state.scope}:`)) {
    if (state.commit) await redis.pipeline(commands);
    if (state.throws) throw new Error("Synthetic counter timeout");
    return state.reply as unknown[];
  }
  return redis.pipeline(commands);
}
export const normaliseHandle = (value: string) => value;
export const storeForHandle = async () => state.found ? shop : null;
export const canSell = () => state.sellable;
export const answersOn = () => state.enabled;
function read<T>(value: T): T { state.reads++; state.readBytes += Buffer.byteLength(JSON.stringify(value)); return value; }
export const readListing = async () => read(product);
export const readAbout = async () => read("Synthetic description");
export const readPage = async () => read({ blocks: [] });
export const pageShown = () => true;
export const productIds = () => ["p_fixture", "p_second"];
export const readListings = async () => read([product, { ...product, id: "p_second" }]);
export const GUIDE_PRODUCTS = 60;
export const pricePill = () => "$1";
export const productPath = () => "/synthetic-product";
export async function answerQuestion() { state.models++; return { ok: true as const, answer: "Synthetic answer", known: true }; }
export async function guideVisitor() { state.models++; return { ok: true as const, picks: [{ id: product.id, why: "Synthetic choice" }] }; }
