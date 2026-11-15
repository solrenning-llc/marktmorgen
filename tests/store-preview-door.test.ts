/**
 * 488 [IT5] unit 3a: the store preview's door (lib/store-preview-door.ts, app/api/store-preview/route.ts), with a
 * stand-in model only. Checked, every count before anything is spent: off it answers as a path that does not exist and
 * sends nothing to the database; another site, the hidden field and a robot are refused before any count; with no
 * places chosen by the owner (A or B) or no count of paying stores, previews are full and nothing is asked; an address
 * makes at most PREVIEWS_PER_ADDRESS_PER_DAY previews a day, counted before the site's day and month counts; the site's
 * day count is previewDayCeiling of the month's; a second job needs the preview the door opened, and a third is never
 * made; one preview sends no more than PREVIEW_DB_COMMANDS to the database; the route declares the duration priced.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW_DOOR_BODY_BYTES, answerStorePreview } from "@/lib/store-preview-door";
import {
  PREVIEWS_PER_ADDRESS_PER_DAY, PREVIEW_DB_COMMANDS, PREVIEW_ROUTE, STORE_PREVIEW_ON, previewDayCeiling, previewMonthCeiling, routePricedIn,
} from "@/lib/store-preview-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const asked: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  asked.push(JSON.parse(String(init?.body)));
  const text = JSON.stringify({ bios: ["Watercolor lessons for beginners."], products: [{ title: "Watercolor Basics", summary: "Six short lessons.", kind: "course", price: "29" }], faq: [], questions: [{ q: "Who is it for?", options: ["Beginners", "Teachers"] }] });
  return new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 3_000, output_tokens: 600 } }));
}) as typeof fetch;

// Every command the door sends, top level, with ASSISTANT_POOL's own inner commands counted at their most for each
// operation: reserve TYPE, HGET held, HGET spent, HGET cap, HINCRBY, HSET, TTL, EXPIRE; settle TYPE, two HGETs and
// three HINCRBYs; release TYPE, two HGETs and one HINCRBY.
let commands = 0;
const SCRIPT_INNER: Record<string, number> = { reserve: 8, settle: 6, release: 4 };
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (list: (string | number)[][]) => {
  for (const command of list) commands += command[0] === "EVAL" ? (SCRIPT_INNER[String(command[4])] ?? Number.POSITIVE_INFINITY) : 1;
  return pipeline(list);
}) as typeof redis.pipeline;

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const OWN = { kind: "own" as const, base: 300, perPaying: 0 };
const on = { on: true, isAutomated: async () => false, now: () => NOW, places: OWN, paying: 0 };
const WORDS = { storeName: "Wren's Watercolors", currency: "usd", language: "en", about: "I teach watercolor to beginners.", selling: "A course for $29." };

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://marktmorgen.com/api/store-preview", {
    method: "POST",
    headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const read = async (response: Response) => ({ status: response.status, body: response.status === 404 ? null : ((await response.json()) as Record<string, unknown>) });

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  delete process.env.AI_MODEL;

  part("Off");
  is("the switch is off", STORE_PREVIEW_ON, false);
  commands = 0;
  is("off: a path that does not exist, nothing read, counted or asked", [(await read(await answerStorePreview(post(WORDS)))).status, commands, asked.length], [404, 0, 0]);
  const route = readFileSync(join(process.cwd(), PREVIEW_ROUTE), "utf8");
  is("the route declares the duration the preview's worst is priced at", routePricedIn(route), true);
  is("the route only hands the request to the door, with no option that could turn it on", /answerStorePreview\(request\)/.test(route) && !/on\s*:/.test(route), true);

  part("Refused before any count");
  commands = 0;
  is("another site", (await read(await answerStorePreview(post(WORDS, { origin: "https://elsewhere.example" }), on))).status, 403);
  is("the hidden field filled", (await read(await answerStorePreview(post({ ...WORDS, website: "x" }), on))).body?.error, "automated");
  is("a robot", (await read(await answerStorePreview(post(WORDS), { ...on, isAutomated: async () => true }))).body?.error, "automated");
  is("a body too large", (await read(await answerStorePreview(post("x".repeat(PREVIEW_DOOR_BODY_BYTES + 1)), on))).status, 413);
  is("not JSON", (await read(await answerStorePreview(post("not json"), on))).status, 400);
  is("none of those counted anything", commands, 0);

  part("No places chosen, no previews");
  is("no places (the owner's choice of A or B): full, nothing asked", [(await read(await answerStorePreview(post(WORDS), { ...on, places: null }))).body?.error, asked.length], ["full", 0]);
  is("no count of paying stores: full, nothing asked", [(await read(await answerStorePreview(post(WORDS), { ...on, paying: null }))).body?.error, asked.length], ["full", 0]);
  is("a month with no previews: full", (await read(await answerStorePreview(post(WORDS), { ...on, places: { kind: "own", base: 0, perPaying: 0 } }))).body?.error, "full");

  part("A preview, and its one answers round");
  commands = 0;
  const first = await read(await answerStorePreview(post(WORDS), on));
  is("a draft, with the preview's id", [first.status, typeof first.body?.previewId, (first.body?.draft as { bios?: string[] })?.bios], [200, "string", ["Watercolor lessons for beginners."]]);
  const previewId = String(first.body?.previewId);
  const second = await read(await answerStorePreview(post({ ...WORDS, previewId, answers: [{ q: "Who is it for?", a: "Beginners" }] }), on));
  is("the answers round, on the same preview", [second.status, asked.length], [200, 2]);
  is(`one whole preview sends no more than ${PREVIEW_DB_COMMANDS} commands`, commands <= PREVIEW_DB_COMMANDS, true);
  console.log(`one preview, two jobs: ${commands} commands at the most`);
  is("never a third job", [(await read(await answerStorePreview(post({ ...WORDS, previewId, answers: [{ q: "Who is it for?", a: "Teachers" }] }), on))).body?.error, asked.length], ["used", 2]);
  is("a preview the door did not open is not one", [(await read(await answerStorePreview(post({ ...WORDS, previewId: "a".repeat(32) }), on))).body?.error, asked.length], ["expired", 2]);
  const later = await read(await answerStorePreview(post(WORDS), on));
  const laterId = String(later.body?.previewId);
  is("a preview's answers round is good the next day", (await read(await answerStorePreview(post({ ...WORDS, previewId: laterId, answers: [] }), { ...on, now: () => NOW + 86_400_000 }))).status, 200);
  is("and not the day after", (await read(await answerStorePreview(post({ ...WORDS, previewId: laterId, answers: [] }), { ...on, now: () => NOW + 2 * 86_400_000 }))).body?.error, "expired");
  is("an id that does not read", (await read(await answerStorePreview(post({ ...WORDS, previewId: "x" }), on))).status, 400);
  is("nothing to work from: asked to say more, nothing asked of the model", [(await read(await answerStorePreview(post({ ...WORDS, about: " " }), { ...on, now: () => NOW, isAutomated: async () => false }))).body?.error, asked.length], ["notes", 4]);
  commands = 0;
  await answerStorePreview(post({ ...WORDS, about: " " }), on);
  is("and counts nothing", commands, 0);

  part("Per address, then the site");
  redis.clear();
  const made = asked.length;
  for (let n = 0; n < PREVIEWS_PER_ADDRESS_PER_DAY; n++) is(`preview ${n + 1} from one address`, (await read(await answerStorePreview(post(WORDS), on))).status, 200);
  is("one more from that address is refused", (await read(await answerStorePreview(post(WORDS), on))).body?.error, "address");
  is("another address still gets one", (await read(await answerStorePreview(post(WORDS, { "x-forwarded-for": "198.51.100.9" }), on))).status, 200);
  is("the next day, the first address again", (await read(await answerStorePreview(post(WORDS), { ...on, now: () => NOW + 86_400_000 }))).status, 200);
  is("models asked only for those", asked.length - made, PREVIEWS_PER_ADDRESS_PER_DAY + 2);

  redis.clear();
  const small = { kind: "own" as const, base: 15, perPaying: 0 };
  const perDay = previewDayCeiling(previewMonthCeiling(small, 0));
  is("the day's share of a month of 15", perDay, 1);
  is("the site's day: the first preview", (await read(await answerStorePreview(post(WORDS, { "x-forwarded-for": "198.51.100.1" }), { ...on, places: small }))).status, 200);
  is("then full for everyone that day", (await read(await answerStorePreview(post(WORDS, { "x-forwarded-for": "198.51.100.2" }), { ...on, places: small }))).body?.error, "full");
  done();
}
void main();
