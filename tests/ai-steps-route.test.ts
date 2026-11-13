/**
 * The writing help's route for a drafted page told step by step, and its
 * stop (758 [STN5] unit 1; app/api/store/ai/route.ts). The model is played
 * by a stand-in for `fetch`; the database is the in-memory one. What is
 * checked:
 *   - a stop leaves one short-lived mark under the store's own name, needs
 *     the products permission like the page itself, and is never held back
 *     by the per-minute limit on writing (stopping must always be possible);
 *   - a run id that is not one is refused, with nothing kept or asked;
 *   - a page asked for with steps comes back as lines: a padding line big
 *     enough for browsers that hold small replies, each step as it starts
 *     and ends, then the result with what is left;
 *   - the same page asked for without steps still comes back as one answer;
 *   - a stop whose mark is not confirmed kept says so (503 "unconfirmed");
 *   - a page drafted from its PDF, stopped before it began: the reading runs
 *     and says so, the writing step never starts, and the result line says
 *     the stop and the one job given back, end to end through the route;
 *   - a job that reads the PDF first, for a store whose month has fewer
 *     jobs left than it takes, or whose balance reply is not one known, is
 *     refused before the file is read (one read of the balance, nothing
 *     reserved).
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { PDFDocument } from "pdf-lib";
import { addProduct, claimHandle, ensureStatsId, setProductFile, setSubscription, storeForEmail } from "@/lib/store";
import { READ_PDF_JOBS } from "@/lib/ai-rules";
import { aiAllowance, aiLeft, aiMonthKey } from "@/lib/ai";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { POST } from "@/app/api/store/ai/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "steps.route@example.com";
const ORIGIN = "https://marktmorgen.com";
const DRAFT = {
  headline: "Forty weeknight dinners your kids will eat",
  sub: "One page per recipe.",
  story: null,
  benefits: ["One recipe per page", "A shopping list each week"],
  inside: [],
  faq: [{ q: "What format is it?", a: "A printable PDF." }],
  guarantee: "",
  cta: "Get the pack",
  seoTitle: "Weeknight Recipe Pack",
  seoDescription: "Forty weeknight dinners.",
};
const FACTS = { parts: [{ title: "Week 1: Pantry basics", detail: "Ten dinners" }], format: "A printable PDF", for: "Busy parents" };
let calls = 0;
/** Run once while the model is asked to read the PDF: the page's Stop, pressed while a run is live (cloud I on #3435). */
let duringRead: (() => Promise<unknown>) | null = null;
/** The product's PDF, as the synthetic file store hands it over. */
let book: Uint8Array = new Uint8Array();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const host = new URL(String(input)).hostname;
  if (host.endsWith(".r2.cloudflarestorage.com")) return new Response(new Blob([book.slice()]), { status: 200, headers: { "content-length": String(book.length) } });
  if (host !== "api.anthropic.com") return new Response("{}", { status: 404 });
  calls += 1;
  if (String(init?.body ?? "").includes('"type":"document"') && duringRead) {
    const press = duringRead;
    duringRead = null;
    await press();
  }
  // The reading is the call that carries the PDF; any other is the writing.
  const text = String(init?.body ?? "").includes('"type":"document"') ? JSON.stringify(FACTS) : JSON.stringify(DRAFT);
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }));
}) as typeof fetch;

/** One reply that a check may swap for an unknown shape. */
let unknownFor: ((command: (string | number)[]) => boolean) | null = null;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = async (commands: (string | number)[][]) => {
  const replies = await realPipeline(commands);
  return commands.map((command, i) => (unknownFor?.(command) ? { unexpected: true } : replies[i]));
};

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  await claimHandle(OWNER, "stepsroute", "Steps Route", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_StepsRt0001", subscriptionId: "sub_StepsRt0001", active: true, tier: "scale", trialEnds: 0, period: paidPeriod() });
  const made = await addProduct(OWNER, "Recipe Pack", "Forty weeknight dinners", "27", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const ask = (body: Record<string, unknown>) =>
    POST(
      new NextRequest(`${ORIGIN}/api/store/ai`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify(body),
      }),
    );
  const json = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { ok?: boolean; error?: string })];

  part("A stop for a live run leaves one short-lived mark under the store's own name; one for no run writes nothing");
  const run = "routerun00000001";
  const key = `nl:ai:stop:${store.statsId}:${run}`;
  // Cloud I on #3435, MEDIUM 1: a stop is written only over the run's own live mark, which the run writes as it starts.
  is("a stop for a run that is not running is not taken", await json(await ask({ kind: "stop", run })), [503, { ok: false, error: "unconfirmed" }]);
  is("and writes nothing", redis.run(["GET", key]), null);
  redis.run(["SET", key, "0", "EX", 300]);
  is("the stop for a live run is taken", await json(await ask({ kind: "stop", run })), [200, { ok: true }]);
  const ttl = Number(redis.run(["TTL", key]));
  is("the mark is there and lasts at most five minutes", [redis.run(["GET", key]), ttl > 0 && ttl <= 300], ["1", true]);
  is("a run id that is not one is refused and nothing is kept", await json(await ask({ kind: "stop", run: "no good" })), [400, { ok: false, error: "invalid" }]);
  is("no mark for it", redis.run(["GET", `nl:ai:stop:${store.statsId}:no good`]), null);
  const many = [];
  for (let i = 0; i < AI_PER_MINUTE + 2; i += 1) many.push((await ask({ kind: "stop", run: `routerunmany${String(i).padStart(4, "0")}` })).status);
  is("stops for made-up runs are never held back by the per-minute limit, and are not taken", many.every((status) => status === 503), true);
  is("and none of them writes a mark", Array.from({ length: AI_PER_MINUTE + 2 }, (_, i) => redis.run(["GET", `nl:ai:stop:${store.statsId}:routerunmany${String(i).padStart(4, "0")}`])).filter((v) => v !== null).length, 0);
  is("and it asks the model nothing", calls, 0);

  part("A page asked for with steps comes back step by step");
  calls = 0;
  const stepped = await ask({ kind: "page", product: made.product.id, steps: true, run: "routerunpage0001", notes: "" });
  is("a stream of lines", [stepped.status, stepped.headers.get("content-type"), stepped.headers.get("cache-control")], [200, "application/x-ndjson; charset=utf-8", "no-store"]);
  const lines = (await stepped.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const first = new TextEncoder().encode(JSON.stringify(lines[0])).length;
  is("the first line is padding, at least a kilobyte, and says nothing else", [Object.keys(lines[0] ?? {}), first >= 1024], [["pad"], true]);
  is("one step, said as it starts and ends", lines.slice(1, -1), [
    { step: "write", state: "started" },
    { step: "write", state: "done" },
  ]);
  const last = lines[lines.length - 1] as { done?: boolean; ok?: boolean; value?: { headline?: string }; left?: number };
  is("then the draft, with what is left", [last.done, last.ok, last.value?.headline, typeof last.left === "number"], [true, true, DRAFT.headline, true]);
  is("one model call", calls, 1);

  part("Steps with a run id that is not one");
  calls = 0;
  is("refused before anything is asked", await json(await ask({ kind: "page", product: made.product.id, steps: true, run: "nope", notes: "" })), [400, { ok: false, error: "invalid" }]);
  is("no model call", calls, 0);

  part("A stop whose mark is not confirmed kept");
  unknownFor = (c) => c[0] === "SET" && String(c[1]).startsWith("nl:ai:stop:");
  is("says it could not be confirmed, never that it is taken", await json(await ask({ kind: "stop", run: "routerununsure01" })), [503, { ok: false, error: "unconfirmed" }]);
  unknownFor = null;

  part("A page from its PDF, stopped before it began, end to end");
  // A synthetic file store: its address is answered by the stand-in above; nothing real is reached.
  process.env.R2_ACCOUNT_ID = "0".repeat(32);
  process.env.R2_ACCESS_KEY_ID = "synthetic-key-0000";
  process.env.R2_SECRET_ACCESS_KEY = "synthetic-secret-".padEnd(40, "0");
  process.env.R2_BUCKET = "synthetic-bucket";
  const pdfDoc = await PDFDocument.create();
  for (let i = 0; i < 3; i += 1) pdfDoc.addPage([300, 400]).drawText(`Page ${i + 1}`);
  book = await pdfDoc.save();
  const filed = await setProductFile(OWNER, made.product.id, { pathname: `vault/${"a".repeat(32)}/${made.product.id}/token0001/book.pdf`, name: "book.pdf", bytes: book.length, contentType: "application/pdf", addedAt: "2026-11-09" });
  if (!filed.ok) throw new Error("no file");
  const pdfRun = "routerunpdfstop1";
  // The page's Stop is pressed while the run is live, as the page offers it (after a step was said).
  let stopStatus = 0;
  duringRead = async () => {
    stopStatus = (await ask({ kind: "stop", run: pdfRun })).status;
  };
  calls = 0;
  const leftBefore = await aiLeft((await storeForEmail(OWNER))!);
  const pdfStepped = await ask({ kind: "page", product: made.product.id, steps: true, run: pdfRun, readFile: true, notes: "" });
  const pdfLines = (await pdfStepped.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  is("the reading runs and says so; the writing step never starts", pdfLines.slice(1, -1), [
    { step: "read", state: "started" },
    { step: "read", state: "done" },
  ]);
  is("the result says the stop, the one job given back and what is left", pdfLines[pdfLines.length - 1], { done: true, ok: false, error: "stopped", returned: 1, left: leftBefore - READ_PDF_JOBS });
  is("one model call: the reading", calls, 1);
  is("the stop pressed during the reading was taken", stopStatus, 200);

  part("A job that reads the PDF first is refused before the file is read when it could not be admitted");
  let fileReads = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).hostname.endsWith(".r2.cloudflarestorage.com")) fileReads += 1;
    return realFetch(input, init);
  }) as typeof fetch;
  const SMALL = "steps.route.small@example.com";
  await claimHandle(SMALL, "stepsroutesmall", "Small Route", "");
  await ensureStatsId(SMALL);
  await setSubscription(SMALL, { customerId: "cus_StepsRt0002", subscriptionId: "sub_StepsRt0002", active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  const smallMade = await addProduct(SMALL, "Small Pack", "A small pack", "9", null);
  if (!smallMade.ok) throw new Error("no small product");
  await setProductFile(SMALL, smallMade.product.id, { pathname: `vault/${"b".repeat(32)}/${smallMade.product.id}/token0002/book.pdf`, name: "book.pdf", bytes: book.length, contentType: "application/pdf", addedAt: "2026-11-09" });
  const smallSession = await openSession(SMALL);
  const askSmall = (body: Record<string, unknown>) =>
    POST(new NextRequest(`${ORIGIN}/api/store/ai`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${smallSession}` }, body: JSON.stringify(body) }));
  calls = 0;
  is("a plan without enough writing jobs: refused as used", await json(await askSmall({ kind: "page", product: smallMade.product.id, steps: true, run: "routerunsmall001", readFile: true, notes: "" })), [400, { ok: false, error: "used" }]);
  is("the same for a title and benefits from the PDF", await json(await askSmall({ kind: "product-pdf", product: smallMade.product.id, run: "routerunsmall002", notes: "" })), [400, { ok: false, error: "used" }]);
  is("the file is never read for them, and nothing is asked", [fileReads, calls], [0, 0]);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  is("no writing help on this deployment: refused as off", await json(await ask({ kind: "page", product: made.product.id, steps: true, run: "routerunoff00001", readFile: true, notes: "" })), [400, { ok: false, error: "off" }]);
  is("the same for a title and benefits from the PDF", await json(await ask({ kind: "product-pdf", product: made.product.id, run: "routerunoff00002", notes: "" })), [400, { ok: false, error: "off" }]);
  is("and the file is never read", fileReads, 0);
  process.env.ANTHROPIC_API_KEY = apiKey;

  // Focal review of #3447 (Claude 2, LEVE A): a plan with the writing help whose month is spent, or whose balance is not known.
  const SPENT = "steps.route.spent@example.com";
  await claimHandle(SPENT, "stepsroutespent", "Spent Route", "");
  await ensureStatsId(SPENT);
  await setSubscription(SPENT, { customerId: "cus_StepsRt0003", subscriptionId: "sub_StepsRt0003", active: true, tier: "scale", trialEnds: 0, period: paidPeriod() });
  const spentMade = await addProduct(SPENT, "Spent Pack", "A spent pack", "9", null);
  if (!spentMade.ok) throw new Error("no spent product");
  await setProductFile(SPENT, spentMade.product.id, { pathname: `vault/${"c".repeat(32)}/${spentMade.product.id}/token0003/book.pdf`, name: "book.pdf", bytes: book.length, contentType: "application/pdf", addedAt: "2026-11-09" });
  const spentStore = (await storeForEmail(SPENT))!;
  const spentMonth = aiMonthKey(spentStore, new Date())!;
  const spentSession = await openSession(SPENT);
  const askSpent = (body: Record<string, unknown>) =>
    POST(new NextRequest(`${ORIGIN}/api/store/ai`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${spentSession}` }, body: JSON.stringify(body) }));
  redis.run(["SET", spentMonth, String(aiAllowance(spentStore) - READ_PDF_JOBS)]);
  calls = 0;
  is("a month with fewer jobs left than reading and writing take: refused as used", await json(await askSpent({ kind: "page", product: spentMade.product.id, steps: true, run: "routerunspent001", readFile: true, notes: "" })), [400, { ok: false, error: "used" }]);
  is("the same for a title and benefits from the PDF", await json(await askSpent({ kind: "product-pdf", product: spentMade.product.id, run: "routerunspent002", notes: "" })), [400, { ok: false, error: "used" }]);
  is("the file is never read for it, and nothing is asked", [fileReads, calls], [0, 0]);
  is("nothing was taken from the month", redis.run(["GET", spentMonth]), String(aiAllowance(spentStore) - READ_PDF_JOBS));
  redis.run(["DEL", spentMonth]);
  unknownFor = (c) => c[0] === "GET" && c[1] === spentMonth;
  is("a balance reply that is not one known: refused, never taken as a full month", await json(await askSpent({ kind: "page", product: spentMade.product.id, steps: true, run: "routerunspent003", readFile: true, notes: "" })), [400, { ok: false, error: "off" }]);
  is("the same for a title and benefits from the PDF", await json(await askSpent({ kind: "product-pdf", product: spentMade.product.id, run: "routerunspent004", notes: "" })), [400, { ok: false, error: "off" }]);
  unknownFor = null;
  is("and the file is never read for it, nor anything asked", [fileReads, calls], [0, 0]);
  globalThis.fetch = realFetch;

  part("Without steps, one answer as before");
  calls = 0;
  const plain = await ask({ kind: "page", product: made.product.id, notes: "" });
  const body = (await plain.json()) as { ok?: boolean; value?: { headline?: string } };
  is("the draft as one JSON answer", [plain.status, plain.headers.get("content-type")?.startsWith("application/json"), body.ok, body.value?.headline], [200, true, true, DRAFT.headline]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
