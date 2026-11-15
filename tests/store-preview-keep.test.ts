/**
 * 488 [IT5] unit 4: keeping a store preview 24 hours and carrying it into the studio (lib/store-preview-keep.ts,
 * app/api/store-preview/kept/route.ts, components/store-setup-ai.tsx), with a stand-in model only. Checked: only the
 * draft is kept, never the visitor's words or address, under a random token in an HttpOnly cookie, for 24 hours at the
 * most; the answers round keeps it under the same token; carrying it needs a signed-in person with that cookie, takes
 * it once (a second carry finds nothing) and clears the cookie; an id that is not one, or another visitor's, finds
 * nothing and sends nothing; the visitor deletes it at once, signed in or not; off, every path answers 404; one whole
 * preview, kept, carried and deleted, sends no more than PREVIEW_DB_COMMANDS.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { answerStorePreview } from "@/lib/store-preview-door";
import { PREVIEW_KEEP_SECONDS, PREVIEW_TOKEN_COOKIE, answerCarryPreview, answerForgetPreview } from "@/lib/store-preview-keep";
import { PREVIEW_DB_COMMANDS, STORE_PREVIEW_ON } from "@/lib/store-preview-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let round = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  round += 1;
  const text = JSON.stringify({ bios: [`Watercolor lessons, draft ${round}.`], products: [], faq: [], questions: round === 1 ? [{ q: "Who is it for?", options: ["Beginners", "Teachers"] }] : [] });
  return new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 3_000, output_tokens: 600 } }));
}) as typeof fetch;

let commands = 0;
const SCRIPT_INNER: Record<string, number> = { reserve: 8, settle: 6, release: 4 };
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (list: (string | number)[][]) => {
  for (const command of list) commands += command[0] === "EVAL" ? (SCRIPT_INNER[String(command[4])] ?? Number.POSITIVE_INFINITY) : 1;
  return pipeline(list);
}) as typeof redis.pipeline;

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const on = { on: true, isAutomated: async () => false, now: () => NOW, places: { kind: "own" as const, base: 300, perPaying: 0 }, paying: 0 };
const WORDS = { storeName: "Wren's Watercolors", currency: "usd", language: "en", about: "I teach watercolor to beginners. Write to wren@example.com.", selling: "A course." };
const HEAD = { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", "x-forwarded-for": "203.0.113.7" };
const door = (body: unknown, cookie = "") => new Request("https://marktmorgen.com/api/store-preview", { method: "POST", headers: { ...HEAD, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const kept = (method: "POST" | "DELETE", cookie: string) => new Request("https://marktmorgen.com/api/store-preview/kept", { method, headers: { host: HEAD.host, origin: HEAD.origin, ...(cookie ? { cookie } : {}) } });
const tokenIn = (response: Response) => /mm_pv=([A-Za-z0-9_-]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? "";
const keys = (prefix: string) => redis.keys().filter((key) => key.startsWith(prefix));

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  delete process.env.AI_MODEL;
  const signedIn = `${SESSION_COOKIE}=${await openSession("wren@example.com")}`;

  part("Off");
  is("the switch is off", STORE_PREVIEW_ON, false);
  is("off: carrying and deleting answer as paths that do not exist", [(await answerCarryPreview(kept("POST", signedIn))).status, (await answerForgetPreview(kept("DELETE", ""))).status], [404, 404]);
  const route = readFileSync(join(process.cwd(), "app/api/store-preview/kept/route.ts"), "utf8");
  is("the route hands each request over with no option", /answerCarryPreview\(request\)/.test(route) && /answerForgetPreview\(request\)/.test(route) && !/on\s*:/.test(route), true);

  part("Kept, only the draft, in a cookie only this browser sends");
  commands = 0;
  const first = await answerStorePreview(door(WORDS), on);
  const cookie = first.headers.get("set-cookie") ?? "";
  const token = tokenIn(first);
  is("a random token of 32 bytes", /^[A-Za-z0-9_-]{43}$/.test(token), true);
  is("an HttpOnly, Secure, same-site cookie for 24 hours", [/HttpOnly/.test(cookie), /Secure/.test(cookie), /SameSite=Lax/.test(cookie), new RegExp(`Max-Age=${PREVIEW_KEEP_SECONDS}`).test(cookie), /Path=\//.test(cookie)], [true, true, true, true, true]);
  is("kept 24 hours at the most", PREVIEW_KEEP_SECONDS, 86_400);
  const stored = keys("nl:storepv:kept:");
  is("one draft kept", stored.length, 1);
  const value = String(await redis.pipeline([["GET", stored[0]]]).then((r) => r[0]));
  is("only the draft: no words typed, no address", [Object.keys(JSON.parse(value)).sort(), value.includes("wren@example.com"), value.includes("203.0.113.7")], [["bios", "faq", "products", "questions"], false, false]);
  const previewId = String(((await first.json()) as { previewId: string }).previewId);
  const second = await answerStorePreview(door({ ...WORDS, previewId, answers: [{ q: "Who is it for?", a: "Beginners" }] }, `${PREVIEW_TOKEN_COOKIE}=${token}`), on);
  is("the answers round keeps it under the same token, the newer draft in place", [tokenIn(second), keys("nl:storepv:kept:").length, JSON.parse(String((await redis.pipeline([["GET", stored[0]]]))[0])).bios], [token, 1, ["Watercolor lessons, draft 2."]]);

  part("Carried into the studio once, by the same visitor");
  is("signed out: not carried", (await answerCarryPreview(kept("POST", `${PREVIEW_TOKEN_COOKIE}=${token}`), { on: true })).status, 401);
  const carried = await answerCarryPreview(kept("POST", `${signedIn}; ${PREVIEW_TOKEN_COOKIE}=${token}`), { on: true });
  const carriedBody = (await carried.json()) as { ok: boolean; draft: { bios: string[] } | null };
  is("the draft carried, with no model asked", [carried.status, carriedBody.draft?.bios, round], [200, ["Watercolor lessons, draft 2."], 2]);
  is("and the cookie cleared", /mm_pv=;.*Max-Age=0/.test(carried.headers.get("set-cookie") ?? ""), true);
  is("taken once: a second carry finds nothing", ((await (await answerCarryPreview(kept("POST", `${signedIn}; ${PREVIEW_TOKEN_COOKIE}=${token}`), { on: true })).json()) as { draft: unknown }).draft, null);
  const before = commands;
  is("an id that is not one finds nothing, and sends nothing for it", [((await (await answerCarryPreview(kept("POST", `${signedIn}; ${PREVIEW_TOKEN_COOKIE}=x`), { on: true })).json()) as { draft: unknown }).draft, commands - before <= 1], [null, true]);
  is("another visitor's token finds nothing", ((await (await answerCarryPreview(kept("POST", `${signedIn}; ${PREVIEW_TOKEN_COOKIE}=${"A".repeat(43)}`), { on: true })).json()) as { draft: unknown }).draft, null);

  part("Deleted by the visitor, at once");
  redis.clear();
  const again = await answerStorePreview(door(WORDS), on);
  const mine = tokenIn(again);
  const forgot = await answerForgetPreview(kept("DELETE", `${PREVIEW_TOKEN_COOKIE}=${mine}`), { on: true });
  is("signed out, deleted at once, and the cookie cleared", [forgot.status, keys("nl:storepv:kept:").length, /mm_pv=;.*Max-Age=0/.test(forgot.headers.get("set-cookie") ?? "")], [200, 0, true]);
  is("from another site, not", (await answerForgetPreview(new Request("https://marktmorgen.com/api/store-preview/kept", { method: "DELETE", headers: { host: HEAD.host, origin: "https://elsewhere.example", cookie: `${PREVIEW_TOKEN_COOKIE}=${mine}` } }), { on: true })).status, 403);

  part("Every command counted");
  redis.clear();
  commands = 0;
  const a = await answerStorePreview(door(WORDS), on);
  const t = tokenIn(a);
  const id = String(((await a.json()) as { previewId: string }).previewId);
  await answerStorePreview(door({ ...WORDS, previewId: id, answers: [] }, `${PREVIEW_TOKEN_COOKIE}=${t}`), on);
  await answerForgetPreview(kept("DELETE", `${PREVIEW_TOKEN_COOKIE}=${t}`), { on: true });
  await answerCarryPreview(kept("POST", `${signedIn}; ${PREVIEW_TOKEN_COOKIE}=${t}`), { on: true });
  console.log(`a preview kept, deleted and carried: ${commands} commands`);
  is(`no more than ${PREVIEW_DB_COMMANDS}`, commands <= PREVIEW_DB_COMMANDS, true);

  part("The studio's draft takes it, behind the switch");
  const setup = readFileSync(join(process.cwd(), "components/store-setup-ai.tsx"), "utf8");
  is("it asks for a carried draft only while the switch is on, and keeps it in this tab", [/STORE_PREVIEW_ON/.test(setup), /fetch\("\/api\/store-preview\/kept", \{ method: "POST"/.test(setup), /sessionStorage/.test(setup)], [true, true, true]);
  done();
}
void main();
