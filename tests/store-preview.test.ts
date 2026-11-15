/**
 * 488 [IT5] unit 2: the anonymous store preview's writing job (lib/store-preview.ts), with a stand-in model only.
 * Checked: it is off (STORE_PREVIEW_ON false) and its switch-free core is reached from nowhere but its own gate; it
 * asks exactly what the studio's draft asks (storeSetupRequest) and reads it the same way (parseStoreSetup); every job
 * is counted per preview and never beyond PREVIEW_JOBS; the model's worst is reserved from the preview's own month
 * pool before the call, exactly as ASSISTANT_POOL does for the Store assistant, settled at the billed tokens, released
 * only when the provider answered with an error status, and kept whole when it may have billed; a pool whose cap is
 * unknown or spent asks nothing.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { previewDraft, runPreviewJob } from "@/lib/store-preview";
import {
  PREVIEW_JOBS, PREVIEW_OUTPUT_TOKENS, STORE_PREVIEW_ON, previewMonthCeiling, previewPoolCapMicroUsd, previewSettledMicroUsd,
} from "@/lib/store-preview-rules";
import { storeSetupRequest } from "@/lib/ai";
import { boundedAiRequest } from "@/lib/ai-request-rules";
import { AI_CALL_INFRA_MICRO_USD, PROVIDER_CHARGES_BPS, WRITING_JOB_MICRO_USD, aiRequestHoldMicroUsd } from "@/lib/spend-cost-table";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { model: string; max_tokens: number; system: string; messages: { content: string }[] };
const asked: Sent[] = [];
let answer: () => Promise<Response> = async () => new Response("{}", { status: 500 });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  asked.push(JSON.parse(String(init?.body)) as Sent);
  return answer();
}) as typeof fetch;

const DRAFT = JSON.stringify({
  bios: ["Watercolor lessons for beginners.", "Paint your first landscape this week."],
  products: [{ title: "Watercolor Basics", summary: "Six short lessons.", kind: "course", price: "29" }],
  faq: [{ q: "Do I need paints?", a: "A basic set is enough." }],
});
const USAGE = { input_tokens: 3_000, output_tokens: 800 };
const said = (text: string, usage: unknown = USAGE) => async () => new Response(JSON.stringify({ content: [{ type: "text", text }], usage }));

const MONTH = "2026-11";
const id = (n: number) => `preview${String(n).padStart(25, "0")}`;
const job = (n: number, cap: number | null) => ({
  previewId: id(n), month: MONTH, poolCapMicroUsd: cap, storeName: "Wren's Watercolors", currency: "usd", language: "en",
  about: "I teach watercolor to beginners.", selling: "A course for $29.",
});

async function poolOf(): Promise<{ held: number; spent: number; n: number; cap: number }> {
  const [raw] = await redis.pipeline([["HGETALL", `nl:storepv:pool:${MONTH}`]]);
  const pairs = Array.isArray(raw) ? (raw as string[]) : Object.entries((raw ?? {}) as Record<string, string>).flat();
  const read: Record<string, number> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) read[pairs[i]] = Number(pairs[i + 1]);
  return { held: read.held ?? 0, spent: read.spent ?? 0, n: read.n ?? 0, cap: read.cap ?? 0 };
}

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === "node_modules" ? [] : sourcesUnder(path)) : /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  delete process.env.AI_MODEL;

  const request = storeSetupRequest({ name: "Wren's Watercolors", currency: "usd", language: "English" }, { about: "I teach watercolor to beginners.", selling: "A course for $29.", answers: [], page: null });
  const bounded = boundedAiRequest(request.system, request.prompt, PREVIEW_OUTPUT_TOKENS, "claude-sonnet-5-5");
  if (!bounded.ok) throw new Error("unbounded");
  const hold = aiRequestHoldMicroUsd("claude-sonnet-5-5", bounded.shape)!;
  const billed = Math.ceil((Math.ceil((3_000 * 2_000_000) / 1e6) + Math.ceil((800 * 10_000_000) / 1e6)) * (10_000 + PROVIDER_CHARGES_BPS) / 10_000) + AI_CALL_INFRA_MICRO_USD;

  part("The rules");
  is("the pool's cap is unknown while the route is not priced, never zero or a guess", previewPoolCapMicroUsd({ kind: "own", base: 10, perPaying: 1 }, 5, false), null);
  is("the pool's cap is the month's previews at every job's priced worst", previewPoolCapMicroUsd({ kind: "own", base: 10, perPaying: 1 }, 5, true), previewMonthCeiling({ kind: "own", base: 10, perPaying: 1 }, 5) * PREVIEW_JOBS * WRITING_JOB_MICRO_USD);
  is("no previews in the month, no pool", previewPoolCapMicroUsd({ kind: "own", base: 0, perPaying: 0 }, 5, true), 0);
  is("one request's hold fits in the priced writing job", hold > 0 && hold <= WRITING_JOB_MICRO_USD, true);
  is("settled at the billed tokens, with the provider's charges and the call's infrastructure", previewSettledMicroUsd("claude-sonnet-5-5", USAGE, hold, PREVIEW_OUTPUT_TOKENS), billed);
  is("an unreadable bill, more output than asked or an unknown model settle the whole hold", [
    previewSettledMicroUsd("claude-sonnet-5-5", null, hold, PREVIEW_OUTPUT_TOKENS),
    previewSettledMicroUsd("claude-sonnet-5-5", { input_tokens: "3000", output_tokens: 800 }, hold, PREVIEW_OUTPUT_TOKENS),
    previewSettledMicroUsd("claude-sonnet-5-5", { input_tokens: 3_000, output_tokens: PREVIEW_OUTPUT_TOKENS + 1 }, hold, PREVIEW_OUTPUT_TOKENS),
    previewSettledMicroUsd("claude-nobody-1", USAGE, hold, PREVIEW_OUTPUT_TOKENS),
  ], [hold, hold, hold, hold]);
  is("never more than the hold", previewSettledMicroUsd("claude-sonnet-5-5", { input_tokens: 900_000, output_tokens: 2_000 }, hold, PREVIEW_OUTPUT_TOKENS), hold);

  part("Off");
  is("the switch is off", STORE_PREVIEW_ON, false);
  answer = said(DRAFT);
  is("the gate answers off and asks nothing", [await previewDraft(job(1, 10 * WRITING_JOB_MICRO_USD)), asked.length, await poolOf()], [{ ok: false, reason: "off" }, 0, { held: 0, spent: 0, n: 0, cap: 0 }]);
  const callers = ["app", "components", "lib"].flatMap((dir) => sourcesUnder(join(process.cwd(), dir))).filter((path) => /\brunPreviewJob\b/.test(readFileSync(path, "utf8")));
  is("the switch-free core is called only behind its own gate", callers.map((path) => path.slice(process.cwd().length + 1)), ["lib/store-preview.ts"]);

  part("A draft, reserved before and settled after");
  const first = await runPreviewJob(job(2, 10 * WRITING_JOB_MICRO_USD));
  is("the draft, read as the studio reads it", first.ok ? [first.draft.bios, first.draft.products.map((p) => [p.title, p.price])] : first, [["Watercolor lessons for beginners.", "Paint your first landscape this week."], [["Watercolor Basics", "29"]]]);
  is("asked exactly what the studio's draft asks, of the writing model", [asked[0].system, asked[0].messages[0].content, asked[0].model, asked[0].max_tokens], [request.system, request.prompt, "claude-sonnet-5-5", PREVIEW_OUTPUT_TOKENS]);
  is("settled at the billed tokens, nothing left held", await poolOf(), { held: 0, spent: billed, n: 1, cap: 10 * WRITING_JOB_MICRO_USD });

  part("Failures");
  answer = async () => new Response('{"error":"overloaded"}', { status: 529 });
  is("an error status: failed, and the whole hold released", [await runPreviewJob(job(3, 10 * WRITING_JOB_MICRO_USD)), await poolOf()], [{ ok: false, reason: "failed" }, { held: 0, spent: billed, n: 1, cap: 10 * WRITING_JOB_MICRO_USD }]);
  answer = async () => { throw new Error("connection reset"); };
  is("no answer at all: it may have billed, so the whole hold is kept", [await runPreviewJob(job(4, 10 * WRITING_JOB_MICRO_USD)), await poolOf()], [{ ok: false, reason: "failed" }, { held: 0, spent: billed + hold, n: 2, cap: 10 * WRITING_JOB_MICRO_USD }]);
  answer = said("no json here");
  is("an answer with no draft: failed, the billed tokens still settled", [await runPreviewJob(job(5, 10 * WRITING_JOB_MICRO_USD)), (await poolOf()).spent], [{ ok: false, reason: "failed" }, 2 * billed + hold]);

  part("Caps before spending");
  answer = said(DRAFT);
  const before = asked.length;
  redis.clear();
  is("a pool smaller than one hold: spent, nothing asked", [await runPreviewJob(job(6, hold - 1)), asked.length - before], [{ ok: false, reason: "spent" }, 0]);
  is("a cap not known: spent, nothing asked", [await runPreviewJob(job(7, null)), await runPreviewJob(job(7, -1)), await runPreviewJob(job(7, 1.5)), asked.length - before], [{ ok: false, reason: "spent" }, { ok: false, reason: "spent" }, { ok: false, reason: "spent" }, 0]);
  redis.clear();
  for (let n = 0; n < PREVIEW_JOBS; n++) await runPreviewJob(job(8, 10 * WRITING_JOB_MICRO_USD));
  const made = asked.length;
  is(`no more than ${PREVIEW_JOBS} jobs for one preview`, [await runPreviewJob(job(8, 10 * WRITING_JOB_MICRO_USD)), asked.length - made, (await poolOf()).n], [{ ok: false, reason: "used" }, 0, PREVIEW_JOBS]);
  is("the month's cap is kept: a later, larger cap does not raise it", [(await runPreviewJob(job(9, 1_000 * WRITING_JOB_MICRO_USD))).ok, (await poolOf()).cap], [true, 10 * WRITING_JOB_MICRO_USD]);
  is("nothing to work from, nothing asked", [await runPreviewJob({ ...job(10, 10 * WRITING_JOB_MICRO_USD), about: "  " }), asked.length - made - 1], [{ ok: false, reason: "notes" }, 0]);
  is("a preview id or a month that does not read: failed, nothing asked", [await runPreviewJob({ ...job(11, 10 * WRITING_JOB_MICRO_USD), previewId: "x" }), await runPreviewJob({ ...job(11, 10 * WRITING_JOB_MICRO_USD), month: "2026-13" }), await runPreviewJob({ ...job(11, 10 * WRITING_JOB_MICRO_USD), currency: "US$" }), asked.length - made - 1], [{ ok: false, reason: "failed" }, { ok: false, reason: "failed" }, { ok: false, reason: "failed" }, 0]);
  delete process.env.ANTHROPIC_API_KEY;
  is("no key on this deployment: off, nothing reserved", [await runPreviewJob(job(12, 10 * WRITING_JOB_MICRO_USD)), asked.length - made - 1], [{ ok: false, reason: "off" }, 0]);
  done();
}

void main();
