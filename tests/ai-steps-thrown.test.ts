/**
 * A job told in two steps whose call throws instead of answering (review of
 * #3447, M1; 758 [STN5]). The model is played by a stand-in for `fetch`; the
 * database is the in-memory one; the money ledger is tests/ai-steps-spend-stub.ts.
 * Both writers that read a product's PDF first are checked: "Suggest a title
 * and benefits from your PDF" (lib/product-pdf-assist.ts, writeFromPdf, through
 * lib/ai.ts readPdfThenWrite) and the sales page (lib/ai.ts, writePage).
 * What is checked:
 *   - a reading whose fetch is rejected, or whose 200 answer is not JSON,
 *     stays counted (it was sent, so it may be billed), and the writing step,
 *     never started, is given back once, read in its exact shape;
 *   - a writing step whose money reservation throws never reached the model,
 *     so its job is given back too; one whose fetch is rejected after it was
 *     sent stays counted;
 *   - a give-back whose reply is unknown is never retried and never shown as
 *     a number;
 *   - the existing controls keep their counts: success, an HTTP 500 reading,
 *     an empty reading, a stop after the reading, the first or the second
 *     reservation refused, and a reading reservation that throws.
 */
import { PDFDocument } from "pdf-lib";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import * as ai from "@/lib/ai";
import { READ_PDF_JOBS } from "@/lib/ai-rules";
import { firstPages } from "@/lib/pdf-preview";
import { writeFromPdf } from "@/lib/product-pdf-assist";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
// The same module lib/ai.ts reads as @/lib/ai-spend (tests/aliases/ai-steps-thrown.test.ts.json), so its count is the reservations made.
import { fail, refuse, reservations as spent } from "./ai-steps-spend-stub";

type Step = { step: string; state: string };
type Steps = { run: string; onStep: (step: "read" | "write", state: "started" | "done") => void };
type Outcome = { ok: boolean; reason?: string; returned?: number | null; left?: number | null };

const FACTS = { parts: [{ title: "Week 1: Pantry basics", detail: "Ten dinners from what is in the cupboard" }, { title: "Week 2: One-pan meals", detail: "Dinners cooked in a single pan" }], format: "A printable PDF of 40 recipes, one on each page", for: "Busy parents" };
const PROPOSAL = {
  title: "The Weeknight Recipe Pack",
  summary: "Weeknight dinners for busy parents, one recipe on each page.",
  benefits: ["One recipe on each page", "Dinners from what is already in your cupboard", "One-pan meals for busy nights"],
};
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

/** How the stand-in answers a call: as the model, rejected, a 200 that is not JSON, or a 500. */
type Answer = "model" | "reject" | "not-json" | "500";
let calls = 0;
let answers: Answer[] = [];
let readingSays = JSON.stringify(FACTS);
let writingSays = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  calls += 1;
  const answer = answers.shift() ?? "model";
  if (answer === "reject") throw new TypeError("fetch failed");
  if (answer === "not-json") return new Response("<html>gateway</html>", { status: 200 });
  if (answer === "500") return new Response("overloaded", { status: 500 });
  // The reading is the call that carries the PDF; any other is the writing.
  const text = String(init?.body ?? "").includes('"type":"document"') ? readingSays : writingSays;
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }));
}) as typeof fetch;

/** Commands the code sends, watched, and one reply that may be swapped for an unknown shape. */
const sent: (string | number)[][] = [];
let unknownFor: ((command: (string | number)[]) => boolean) | null = null;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = async (commands: (string | number)[][]) => {
  sent.push(...commands);
  const replies = await realPipeline(commands);
  return commands.map((command, i) => (unknownFor?.(command) ? { unexpected: true } : replies[i]));
};

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  await claimHandle("thrown@example.com", "thrownshop", "Thrown Kitchen", "");
  await ensureStatsId("thrown@example.com");
  await setSubscription("thrown@example.com", { customerId: "cus_Thrown0001", subscriptionId: "sub_Thrown0001", active: true, tier: "scale", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail("thrown@example.com"))!;
  const book = await PDFDocument.create();
  for (let i = 0; i < 3; i += 1) book.addPage([300, 400]).drawText(`Page ${i + 1}`);
  const pdf = await firstPages(await book.save(), 3);
  const monthKey = ai.aiMonthKey(store, new Date())!;
  const stopKey = (run: string) => `nl:ai:stop:${store.statsId}:${run}`;
  const giveBacks = () => sent.filter((c) => c[0] === "DECRBY" && c[1] === monthKey).map((c) => c[2]);
  let spentBefore = 0;
  const reservations = () => spent.count - spentBefore;
  const fresh = () => {
    spentBefore = spent.count;
    calls = 0;
    answers = [];
    readingSays = JSON.stringify(FACTS);
    refuse.at = 0;
    fail.at = 0;
    redis.run(["DEL", monthKey]);
    sent.length = 0;
    unknownFor = null;
  };
  const told = (run: string, seen: Step[]): Steps => ({ run, onStep: (step, state) => seen.push({ step, state }) });

  const writers = [
    {
      name: "Title and benefits from a PDF (writeFromPdf)",
      tag: "pdfassist",
      drafted: (r: Outcome & { value?: unknown }) => (r.ok ? (r.value as { title?: string }).title : r.reason),
      expected: PROPOSAL.title,
      says: JSON.stringify(PROPOSAL),
      run: (steps?: Steps) => writeFromPdf(store, { title: "Recipe Pack", summary: "Weeknight dinners.", about: "Forty dinners my family loves.", notes: "", pdf }, Date.now(), steps) as Promise<Outcome & { value?: unknown }>,
    },
    {
      name: "Sales page from a PDF (writePage)",
      tag: "pagewrite",
      drafted: (r: Outcome & { value?: unknown }) => (r.ok ? (r.value as { headline?: string }).headline : r.reason),
      expected: DRAFT.headline,
      says: JSON.stringify(DRAFT),
      run: (steps?: Steps) =>
        (ai.writePage as unknown as (s: typeof store, i: unknown, n?: number, st?: Steps) => Promise<Outcome & { value?: unknown }>)(
          store,
          { title: "Recipe Pack", price: "$27", kind: "download", summary: "", about: "", notes: "", pdf },
          Date.now(),
          steps,
        ),
    },
  ];

  for (const writer of writers) {
    const run = (suffix: string, seen: Step[] = []) => writer.run(told(`${writer.tag}${suffix}`.padEnd(16, "0").slice(0, 16), seen));

    part(`${writer.name}: the reading's fetch is rejected`);
    fresh();
    writingSays = writer.says;
    let seen: Step[] = [];
    let before = await ai.aiLeft(store);
    answers = ["reject"];
    const rejected = await run("rj", seen);
    is("one call, one reservation", [calls, reservations()], [1, 1]);
    is("the reading, sent, stays counted; the writing step, never started, is given back", before - (await ai.aiLeft(store)), READ_PDF_JOBS);
    is("given back once, read in its exact shape", giveBacks(), [1]);
    is("it says it failed, what came back and what is left", rejected, { ok: false, reason: "failed", returned: 1, left: before - READ_PDF_JOBS });
    is("the writing step never said it started", seen.some((s) => s.step === "write"), false);

    part(`${writer.name}: the reading answers 200 with a body that is not JSON`);
    fresh();
    before = await ai.aiLeft(store);
    answers = ["not-json"];
    const garbled = await run("nj");
    is("one call, one reservation", [calls, reservations()], [1, 1]);
    is("the reading stays counted; the writing step is given back", before - (await ai.aiLeft(store)), READ_PDF_JOBS);
    is("given back once, read in its exact shape", giveBacks(), [1]);
    is("it says it failed, what came back and what is left", garbled, { ok: false, reason: "failed", returned: 1, left: before - READ_PDF_JOBS });

    part(`${writer.name}: the same, with the give-back's reply unknown`);
    fresh();
    answers = ["reject"];
    unknownFor = (c) => c[0] === "DECRBY" && c[1] === monthKey;
    const unsure = await run("uk");
    is("said as not confirmed, never as a number", unsure, { ok: false, reason: "failed", returned: null, left: null });
    is("one give-back sent, no retry", giveBacks().length, 1);

    part(`${writer.name}: the writing step's reservation throws`);
    fresh();
    seen = [];
    before = await ai.aiLeft(store);
    fail.at = spent.count + 2;
    const unreached = await run("wt", seen);
    is("only the reading is sent", calls, 1);
    is("the writing step never reached the model: its job is given back", [before - (await ai.aiLeft(store)), giveBacks()], [READ_PDF_JOBS, [1]]);
    is("it says it failed, what came back and what is left", unreached, { ok: false, reason: "failed", returned: 1, left: before - READ_PDF_JOBS });
    is("the writing step never says it is done", seen.some((s) => s.step === "write" && s.state === "done"), false);

    part(`${writer.name}: the writing step's fetch is rejected once sent`);
    fresh();
    before = await ai.aiLeft(store);
    answers = ["model", "reject"];
    const lost = await run("wr");
    is("both calls were sent", [calls, reservations()], [2, 2]);
    is("both steps stay counted: the writing may be billed", [before - (await ai.aiLeft(store)), giveBacks()], [1 + READ_PDF_JOBS, []]);
    is("it says it failed", lost, { ok: false, reason: "failed" });

    part(`${writer.name}: controls`);
    fresh();
    before = await ai.aiLeft(store);
    const whole = await run("ok");
    is("success: the draft comes back, both steps counted", [writer.drafted(whole), calls, before - (await ai.aiLeft(store))], [writer.expected, 2, 1 + READ_PDF_JOBS]);

    fresh();
    before = await ai.aiLeft(store);
    answers = ["500"];
    const refusedByProvider = await run("h5");
    is("an HTTP 500 reading: one call, the reading counted, the writing step given back", [calls, before - (await ai.aiLeft(store)), giveBacks(), refusedByProvider.ok, refusedByProvider.returned], [1, READ_PDF_JOBS, [1], false, 1]);

    fresh();
    before = await ai.aiLeft(store);
    readingSays = JSON.stringify({ parts: [], format: "", for: "" });
    const empty = await run("em");
    is("an empty reading: the writing step given back, said as empty", [calls, before - (await ai.aiLeft(store)), empty], [1, READ_PDF_JOBS, { ok: false, reason: "empty", returned: 1, left: before - READ_PDF_JOBS }]);

    fresh();
    before = await ai.aiLeft(store);
    const stopRun = `${writer.tag}st`.padEnd(16, "0").slice(0, 16);
    redis.run(["SET", stopKey(stopRun), "1", "EX", 300]);
    const stopped = await writer.run(told(stopRun, []));
    is("a stop after the reading: the writing step given back, said as stopped", [calls, before - (await ai.aiLeft(store)), stopped], [1, READ_PDF_JOBS, { ok: false, reason: "stopped", returned: 1, left: before - READ_PDF_JOBS }]);

    fresh();
    before = await ai.aiLeft(store);
    refuse.at = spent.count + 1;
    const firstRefused = await run("r1");
    is("the first reservation refused: nothing sent, every job given back", [calls, reservations(), before - (await ai.aiLeft(store)), firstRefused.ok], [0, 0, 0, false]);

    fresh();
    before = await ai.aiLeft(store);
    refuse.at = spent.count + 2;
    const secondRefused = await run("r2");
    is("the second reservation refused: the reading counted, the writing step given back", [calls, before - (await ai.aiLeft(store)), secondRefused], [1, READ_PDF_JOBS, { ok: false, reason: "failed", returned: 1, left: before - READ_PDF_JOBS }]);

    fresh();
    before = await ai.aiLeft(store);
    fail.at = spent.count + 1;
    const readThrown = await run("rt");
    is("the reading's reservation throws: nothing sent, every job given back once", [calls, before - (await ai.aiLeft(store)), giveBacks(), readThrown.ok], [0, 0, [1 + READ_PDF_JOBS], false]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
