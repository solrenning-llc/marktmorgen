/**
 * Named steps while the writing help drafts a sales page from the product's
 * own PDF, and a stop that charges nothing for a step that never started
 * (758 [STN5] unit 1). The model is played by a stand-in for `fetch`; the
 * database is the in-memory one. What is checked:
 *   - each step says when it starts and ends, in order;
 *   - a stop asked for while the reading runs starts no further model call,
 *     reserves no further money, and gives back the jobs of the step that
 *     never started, read in their exact shape;
 *   - the step that was already sent stays counted (it may be billed);
 *   - a stop that comes once the last step has started changes nothing: the
 *     draft is paid for, so it comes back;
 *   - an unknown reply about the stop starts no further call either;
 *   - a give-back whose reply is unknown is never retried and never shown
 *     as a number;
 *   - every command and byte a stepped generation adds is priced in the ai
 *     line of tests/plan-cost-registry.ts.
 */
import { PDFDocument } from "pdf-lib";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import * as ai from "@/lib/ai";
import { AI_MONTHLY, READ_PDF_JOBS } from "@/lib/ai-rules";
import { PDF_READ_MICRO_USD, WRITING_JOB_MICRO_USD } from "@/lib/spend-cost-table";
import { AUTOMATIC_AI_STORE_MICRO_USD } from "@/lib/ai-spend-policy";
import { firstPages } from "@/lib/pdf-preview";
import { COST_LINES } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
// The same module lib/ai.ts reads as @/lib/ai-spend (tests/aliases/ai-steps.test.ts.json), so its count is the reservations made.
import { refuse, reservations as spent } from "./ai-steps-spend-stub";

type Step = { step: string; state: string };
type Steps = { run: string; onStep: (step: "read" | "write", state: "started" | "done") => void };
type Stopped = { ok: false; reason: "stopped"; returned: number | null; left: number | null };
const writePage = ai.writePage as unknown as (
  store: Parameters<typeof ai.writePage>[0],
  input: Parameters<typeof ai.writePage>[1],
  now?: number,
  steps?: Steps,
) => Promise<Awaited<ReturnType<typeof ai.writePage>> | Stopped>;

const FACTS = { parts: [{ title: "Week 1: Pantry basics", detail: "Ten dinners from what is in the cupboard" }], format: "A printable PDF", for: "Busy parents" };
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

/** What the stand-in model is asked, and what it does when each call arrives. */
let calls = 0;
let onCall: (n: number) => void = () => {};
/** What the reading answers: its facts, unless a check gives it another valid answer. */
let readingSays = JSON.stringify(FACTS);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  calls += 1;
  onCall(calls);
  // The reading is the call that carries the PDF; any other is the writing.
  const text = String(init?.body ?? "").includes('"type":"document"') ? readingSays : JSON.stringify(DRAFT);
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
const stopGets = () => sent.filter((c) => c[0] === "GET" && String(c[1]).startsWith("nl:ai:stop:")).length;
const giveBacks = (key: string) => sent.filter((c) => c[0] === "DECRBY" && c[1] === key);

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  await claimHandle("steps@example.com", "stepshop", "Step Kitchen", "");
  await ensureStatsId("steps@example.com");
  await setSubscription("steps@example.com", { customerId: "cus_Steps00001", subscriptionId: "sub_Steps00001", active: true, tier: "scale", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail("steps@example.com"))!;
  const book = await PDFDocument.create();
  for (let i = 0; i < 3; i += 1) book.addPage([300, 400]).drawText(`Page ${i + 1}`);
  const pdf = await firstPages(await book.save(), 3);
  const input = { title: "Recipe Pack", price: "$27", kind: "download" as const, summary: "", about: "", notes: "", pdf };
  const monthKey = ai.aiMonthKey(store, new Date())!;
  const stopKey = (run: string) => `nl:ai:stop:${store.statsId}:${run}`;
  let spentBefore = 0;
  const reservations = () => spent.count - spentBefore;
  const fresh = () => {
    spentBefore = spent.count;
    calls = 0;
    onCall = () => {};
    readingSays = JSON.stringify(FACTS);
    refuse.at = 0;
    // Each check starts from a month with nothing used, so a plan's allowance never runs out midway.
    redis.run(["DEL", monthKey]);
    sent.length = 0;
    unknownFor = null;
  };
  const stepsOf = (run: string, seen: Step[]): Steps => ({ run, onStep: (step, state) => seen.push({ step, state }) });

  part("The reading's jobs come from the code");
  is("the reading takes its reservation in priced jobs, rounded up", READ_PDF_JOBS, Math.ceil(PDF_READ_MICRO_USD / WRITING_JOB_MICRO_USD));

  part("Without a stop, both steps run and say so");
  fresh();
  let seen: Step[] = [];
  let before = await ai.aiLeft(store);
  const whole = await writePage(store, input, Date.now(), stepsOf("runwhole00000001", seen));
  is("the draft comes back", whole.ok ? whole.value.headline : whole.reason, DRAFT.headline);
  is("each step is said as it starts and ends, in order", seen, [
    { step: "read", state: "started" },
    { step: "read", state: "done" },
    { step: "write", state: "started" },
    { step: "write", state: "done" },
  ]);
  is("both steps' jobs are taken", before - (await ai.aiLeft(store)), 1 + READ_PDF_JOBS);
  is("two model calls, each with its own money reserved before it", [calls, reservations()], [2, 2]);
  is("the stop mark is read once, between the two steps", stopGets(), 1);

  part("A stop asked for while the reading runs");
  fresh();
  seen = [];
  before = await ai.aiLeft(store);
  onCall = (n) => {
    if (n === 1) redis.run(["SET", stopKey("runstopped000001"), "1", "EX", 300]);
  };
  const stopped = await writePage(store, input, Date.now(), stepsOf("runstopped000001", seen));
  is("no further model call starts", calls, 1);
  is("no further money is reserved", reservations(), 1);
  is("the reading, already sent, stays counted; the page's job is given back", before - (await ai.aiLeft(store)), READ_PDF_JOBS);
  is("the job given back once, read in its exact shape", giveBacks(monthKey).map((c) => c[2]), [1]);
  is("it says it stopped, what came back and what is left", stopped, { ok: false, reason: "stopped", returned: 1, left: before - READ_PDF_JOBS });
  is("the writing step never said it started", seen, [
    { step: "read", state: "started" },
    { step: "read", state: "done" },
  ]);

  part("A stop that comes once the last step has started");
  fresh();
  before = await ai.aiLeft(store);
  onCall = (n) => {
    if (n === 2) redis.run(["SET", stopKey("runlate000000001"), "1", "EX", 300]);
  };
  const late = await writePage(store, input, Date.now(), stepsOf("runlate000000001", []));
  is("the draft, already paid for, comes back", late.ok ? late.value.headline : late.reason, DRAFT.headline);
  is("nothing is given back", [before - (await ai.aiLeft(store)), giveBacks(monthKey).length], [1 + READ_PDF_JOBS, 0]);

  part("A stop of another run or of another store changes nothing");
  fresh();
  redis.run(["SET", stopKey("runelsewhere0001"), "1", "EX", 300]);
  redis.run(["SET", "nl:ai:stop:someoneelse:runmine000000001", "1", "EX", 300]);
  const mine = await writePage(store, input, Date.now(), stepsOf("runmine000000001", []));
  is("the run goes on to its draft", [mine.ok, calls], [true, 2]);

  part("An unknown reply about the stop starts no further call");
  fresh();
  before = await ai.aiLeft(store);
  unknownFor = (c) => c[0] === "GET" && String(c[1]).startsWith("nl:ai:stop:");
  const unsure = await writePage(store, input, Date.now(), stepsOf("rununknown000001", []));
  is("no second model call", calls, 1);
  is("it is not shown as a draft or as a stop the creator asked for", unsure.ok ? "drafted" : unsure.reason, "failed");
  is("the job of the step never started is given back", before - (await ai.aiLeft(store)), READ_PDF_JOBS);

  part("A give-back whose reply is unknown is never retried");
  fresh();
  before = await ai.aiLeft(store);
  onCall = (n) => {
    if (n === 1) redis.run(["SET", stopKey("runbackunknown01"), "1", "EX", 300]);
  };
  unknownFor = (c) => c[0] === "DECRBY" && c[1] === monthKey;
  const unconfirmed = await writePage(store, input, Date.now(), stepsOf("runbackunknown01", []));
  is("it is said as not confirmed, never as a number", unconfirmed, { ok: false, reason: "stopped", returned: null, left: null });
  is("one give-back sent, no retry", giveBacks(monthKey).length, 1);

  part("A reading with nothing in it, and nothing else said: the writing step never starts");
  fresh();
  seen = [];
  before = await ai.aiLeft(store);
  readingSays = JSON.stringify({ parts: [], format: "", for: "" });
  const empty = await writePage(store, input, Date.now(), stepsOf("runemptyfacts001", seen));
  is("only the reading is sent", calls, 1);
  is("the reading stays counted; the page's job is given back", before - (await ai.aiLeft(store)), READ_PDF_JOBS);
  is("given back once, read in its exact shape", giveBacks(monthKey).map((c) => c[2]), [1]);
  is("it says the writing step did not run, what came back and what is left", empty, { ok: false, reason: "failed", returned: 1, left: before - READ_PDF_JOBS });
  is("the writing step never said it started", seen, [
    { step: "read", state: "started" },
    { step: "read", state: "done" },
  ]);

  part("The same, asked for without steps");
  fresh();
  before = await ai.aiLeft(store);
  readingSays = JSON.stringify({ parts: [], format: "", for: "" });
  const plainEmpty = await writePage(store, input, Date.now());
  is("the page's job is given back there too", [calls, before - (await ai.aiLeft(store)), plainEmpty.ok], [1, READ_PDF_JOBS, false]);

  part("The same, with the give-back's reply unknown");
  fresh();
  readingSays = JSON.stringify({ parts: [], format: "", for: "" });
  unknownFor = (c) => c[0] === "DECRBY" && c[1] === monthKey;
  const emptyUnsure = await writePage(store, input, Date.now(), stepsOf("runemptyunsure01", []));
  is("said as not confirmed, never as a number", emptyUnsure, { ok: false, reason: "failed", returned: null, left: null });
  is("one give-back sent, no retry", giveBacks(monthKey).length, 1);

  part("The writing step's money refused: it never reaches the model");
  fresh();
  seen = [];
  before = await ai.aiLeft(store);
  refuse.at = spent.count + 2;
  const refused = await writePage(store, input, Date.now(), stepsOf("runwriterefused1", seen));
  is("only the reading is sent", calls, 1);
  is("the writing step's job is given back", [before - (await ai.aiLeft(store)), refused], [READ_PDF_JOBS, { ok: false, reason: "failed", returned: 1, left: before - READ_PDF_JOBS }]);
  is("the writing step never says it is done", seen.some((s) => s.step === "write" && s.state === "done"), false);

  part("The reading's money refused, with the creator's own words to write from");
  fresh();
  seen = [];
  before = await ai.aiLeft(store);
  refuse.at = spent.count + 1;
  const unread = await writePage(store, { ...input, notes: "Forty dinners for busy parents." }, Date.now(), stepsOf("runreadrefused01", seen));
  is("the page is still written, from the creator's words", [unread.ok ? unread.value.headline : unread.reason, calls], [DRAFT.headline, 1]);
  is("the reading, never sent, is not charged: its jobs are given back", [before - (await ai.aiLeft(store)), giveBacks(monthKey).map((c) => c[2])], [1, [READ_PDF_JOBS]]);
  is("what is left is said after the give-back", unread.ok ? unread.left : null, before - 1);
  is("the reading never says it is done", seen.some((s) => s.step === "read" && s.state === "done"), false);

  part("A run that is not one takes nothing");
  fresh();
  before = await ai.aiLeft(store);
  const bad = await writePage(store, input, Date.now(), stepsOf("not a run!", []));
  is("refused before anything is taken or asked", [bad.ok, calls, before - (await ai.aiLeft(store))], [false, 0, 0]);

  part("Every command and byte a stepped generation adds is priced");
  const line = COST_LINES.find((l) => l.id === "ai")!;
  is("the ai line reads the step figures from lib/ai-steps.ts", line.sources.some((s) => s.file === "lib/ai-steps.ts" && s.names.includes("AI_STOP_COMMANDS") && s.names.includes("AI_STEP_EXTRA_BYTES")), true);
  const extra = (tier: "pro" | "scale") => line.monthlyUsd(tier) - AUTOMATIC_AI_STORE_MICRO_USD[tier] / 1e6;
  is("each plan with writing jobs pays for them on top of its AI ceiling", [extra("pro") > 0, extra("scale") > 0], [true, true]);
  is("at the same figure a job on each plan", Math.abs(extra("pro") / AI_MONTHLY.pro - extra("scale") / AI_MONTHLY.scale) < 1e-15, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
