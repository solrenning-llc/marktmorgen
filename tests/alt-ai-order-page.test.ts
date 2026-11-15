/**
 * The sales page drafted from the product's own PDF (app/api/store/ai/route.ts, `kind: "page"` with `readFile`;
 * lib/ai.ts, writePage) reads the file from the file store only after the month's jobs are taken (6 November 2026,
 * rule 30 sibling of tests/alt-ai-order.test.ts: the read came first, so a Creator store, whose AI_MONTHLY is 0,
 * spent a paid Blob read of up to MAX_STAMP_BYTES on every request and was then refused).
 *
 * Each check sends the real route a real request from the creator's own session, with a synthetic PDF in a file
 * store held in memory that counts every paid read (tests/alt-ai-order-world.ts) and the model played by a stand-in
 * for `fetch`:
 *
 *   - no allowance (Creator), a month already used, and too few jobs left for the reading: the same refusal as
 *     before, no Blob read, no model call;
 *   - a store with its allowance: one read, the reading and the writing (two model calls), 1 + READ_PDF_JOBS taken;
 *   - a file that cannot be read once the jobs are taken (missing, or the store not answering): the same refusal as
 *     before ("file"), no model call, and every job given back, since nothing billable started.
 */
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductFile, setSubscription, storeForEmail } from "@/lib/store";
import { aiLeft, aiMonthKey } from "@/lib/ai";
import { READ_PDF_JOBS } from "@/lib/ai-rules";
import { store as redis } from "./redis-stub";
import { failing, files, reads } from "./alt-ai-order-world";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { POST } from "@/app/api/store/ai/route";

const ORIGIN = "https://marktmorgen.com";
const FACTS = { parts: [{ title: "Week 1: Pantry basics", detail: "Ten dinners from the cupboard" }], format: "A printable PDF, one recipe per page", for: "Busy parents" };
const DRAFT = {
  headline: "Forty weeknight dinners your kids will eat",
  sub: "One page per recipe.",
  story: null,
  benefits: ["One recipe per page", "A shopping list each week", "Fast dinners"],
  inside: [],
  faq: [{ q: "What format is it?", a: "A printable PDF." }],
  guarantee: "",
  cta: "Get the pack",
  seoTitle: "Weeknight Recipe Pack",
  seoDescription: "Forty weeknight dinners.",
};

let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  modelCalls += 1;
  const system = String((JSON.parse(String(init?.body)) as { system?: unknown }).system ?? "");
  const text = JSON.stringify(/first pages of a product/i.test(system) ? FACTS : DRAFT);
  return new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 } }));
}) as typeof fetch;

const ask = async (session: string, body: unknown) => {
  const response = await POST(new NextRequest(`${ORIGIN}/api/store/ai`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const json = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; value?: { headline?: string }; left?: number };
  return { status: response.status, error: json.error ?? "ok", headline: json.value?.headline ?? null, left: json.left ?? null };
};

async function creator(email: string, handle: string, tier: "creator" | "pro", pdf: Uint8Array) {
  await claimHandle(email, handle, `Store ${handle}`, "");
  await ensureStatsId(email);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier, trialEnds: 0, period: paidPeriod() });
  const product = async (title: string, name: string, kept: boolean) => {
    const made = await addProduct(email, title, "", "19", null);
    if (!made.ok) throw new Error("setup");
    const pathname = `stores/${handle}/${made.product.id}/${name}`;
    const set = await setProductFile(email, made.product.id, { pathname, name, bytes: pdf.length, contentType: "application/pdf", addedAt: "" });
    if (!set.ok) throw new Error("setup file");
    if (kept) files.set(pathname, { bytes: pdf, contentType: "application/pdf" });
    return { id: made.product.id, pathname };
  };
  const kept = await product("Recipe Pack", "pack.pdf", true);
  const missing = await product("Lost Pack", "lost.pdf", false);
  return { session: await openSession(email), product: kept.id, pathname: kept.pathname, missing: missing.id };
}

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  const book = await PDFDocument.create();
  for (let i = 0; i < 3; i += 1) book.addPage([300, 400]).drawText(`Page ${i + 1}`);
  const pdf = await book.save();
  const jobs = 1 + READ_PDF_JOBS;

  part("No allowance: refused before the file store");
  const small = await creator("creator.page@example.com", "creatorpage", "creator", pdf);
  reads.length = 0;
  modelCalls = 0;
  const none = await ask(small.session, { kind: "page", product: small.product, readFile: true, notes: "" });
  is("a Creator store gets the same refusal as before", [none.status, none.error], [400, "used"]);
  is("and no Blob read and no model call were spent on it", [reads.length, modelCalls], [0, 0]);

  part("A month already used, or too few jobs left for the reading: refused before the file store");
  const studio = await creator("studio.page@example.com", "studiopage", "pro", pdf);
  const store = (await storeForEmail("studio.page@example.com"))!;
  const key = aiMonthKey(store, new Date())!;
  const full = await aiLeft(store);
  redis.run(["SET", key, String(full)]);
  reads.length = 0;
  modelCalls = 0;
  const spent = await ask(studio.session, { kind: "page", product: studio.product, readFile: true, notes: "" });
  is("the same refusal as before", [spent.status, spent.error], [400, "used"]);
  is("no Blob read and no model call", [reads.length, modelCalls], [0, 0]);
  redis.run(["SET", key, String(full - jobs + 1)]);
  const short = await ask(studio.session, { kind: "page", product: studio.product, readFile: true, notes: "" });
  is("one job short of the reading: the same refusal", [short.status, short.error], [400, "used"]);
  is("still no Blob read and no model call", [reads.length, modelCalls], [0, 0]);
  redis.run(["DEL", key]);

  part("With its allowance: one read, the reading and the writing");
  reads.length = 0;
  modelCalls = 0;
  const healthy = await ask(studio.session, { kind: "page", product: studio.product, readFile: true, notes: "" });
  is("drafted from the file, its jobs taken", [healthy.status, healthy.headline, healthy.left], [200, DRAFT.headline, full - jobs]);
  is("one read of the file and two model calls", [reads, modelCalls], [[`get ${studio.pathname}`], 2]);

  part("A file that cannot be read once the jobs are taken");
  reads.length = 0;
  modelCalls = 0;
  const gone = await ask(studio.session, { kind: "page", product: studio.missing, readFile: true, notes: "" });
  is("a missing file: the same refusal as before, no model call", [gone.status, gone.error, modelCalls], [400, "file", 0]);
  is("and every job given back", await aiLeft(store), full - jobs);
  failing.on = true;
  const down = await ask(studio.session, { kind: "page", product: studio.product, readFile: true, notes: "" });
  failing.on = false;
  is("a file store not answering: the same refusal, no model call", [down.status, down.error, modelCalls], [400, "file", 0]);
  is("and every job given back", await aiLeft(store), full - jobs);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
