/**
 * What one workflow step, one wait and one run's start really cost the
 * database, measured on the real path (lib/flows.ts, sendDueSteps and
 * enroll) against the in-memory Redis, and held under the ceilings the
 * margin review prices (lib/flow-limits.ts). Added 4 November 2026.
 *
 * Counted as Upstash bills them (https://upstash.com/docs/redis/overall/billing,
 * read 31 October 2026): every command of every pipeline, and for an EVAL one
 * command more for every redis.call the script runs (INNER below, each
 * script's worst for the one person a batch of one holds). The two scripts the
 * stand-in does not run (lib/contacts.ts CAS_HSET, the lock scripts of
 * lib/redis-lock.ts) fall back to the same commands sent one by one, so what
 * they send is what Upstash bills. A script on the path with no entry in INNER
 * fails this test: nothing runs uncounted.
 *
 * Each step is a batch of one person (a batch shares its reads, so one is the
 * dearest), in a job run that serves nothing else, its empty scans included,
 * and every step here carries the dearest condition (a course's progress:
 * the course and its students read), which holds, so the action runs too.
 * Steps that act are measured at their worst: a label that starts every other
 * workflow of the store and is refused for each (the day's runs used up, or
 * no room for the run), a deal moved over the exact record, a note on a page
 * already full of notes, five webhook endpoints listening, a stop that finds
 * the run held for the creator's choice. A run a step starts that is admitted
 * is a run of its own, counted in the day's runs and priced by its own
 * RUN_START_COMMANDS; what the step spends beyond those starts is held here.
 *
 * Bytes are counted too, sent and answered, for the margin review's per-run
 * bytes (lib/flow-limits.ts, the workflows line of tests/plan-cost-registry.ts).
 */
import {
  ACTION_COMMANDS_PER_STEP,
  DEALS_READ_BYTES,
  HISTORY_COMMANDS_PER_STEP,
  MAX_FLOWS,
  MAX_RETRIES_BY_YOU,
  MAX_STEPS,
  MAX_WAITS_PER_RUN,
  QUEUE_COMMANDS_PER_STEP,
  RUN_START_BYTES,
  RUN_START_COMMANDS,
  RUN_START_FIXED_BYTES,
  STEP_BYTES,
  STEP_COMMANDS,
  STEP_FIXED_BYTES,
  STORE_READ_BYTES,
  WAIT_BYTES,
  WAIT_COMMANDS_PER_TRY,
  WAIT_FIXED_BYTES,
  WORKFLOWS_READ_BYTES,
  WORST_BYTES_PER_RUN,
  WORST_COMMANDS_PER_RUN,
} from "@/lib/flow-limits";
import { MAX_MAIL_BODY, MAX_SUBJECT } from "@/lib/mail";
import { MAX_DEALS } from "@/lib/crm-rules";
import { MAX_DELAY_HOURS, enroll, saveFlow, sendDueSteps } from "@/lib/flows";
import { MAX_TAG_LENGTH } from "@/lib/contact-rules";
import { personOf, readRun } from "@/lib/flow-runs";
import { changeLabels, upsertContact } from "@/lib/contacts";
import { readStages, writeDeal, writeFields } from "@/lib/crm";
import { putMember } from "@/lib/team";
import { addPersonNote, MAX_PERSON_NOTES } from "@/lib/buyer-profile";
import { personKey } from "@/lib/person-key";
import { addEndpoint } from "@/lib/webhooks";
import { MAX_ENDPOINTS } from "@/lib/webhook-limits";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { dataKey } from "@/lib/store-data";
import { contentRoomFor } from "@/lib/store-data-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail, storeForHandle, MAX_STORE_BYTES, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

let resendDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    if (resendDown) throw new Error("lost");
    const body = JSON.parse(String(init?.body)) as unknown;
    return json(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: "email" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** What each script the path runs bills beyond its EVAL, at its worst for one person. */
const INNER: Record<string, (command: (string | number)[], expired: number) => number> = {
  // ZSCORE, then ZADD while leased.
  "-- marktmorgen:flow-queue-if-leased:v1": () => 2,
  // HGET, HSET.
  "-- marktmorgen:crm-deal-move:v2": () => 2,
  // HEXISTS, HLEN, HSET.
  "-- marktmorgen:crm-deal-save:v2": () => 3,
  // HGET, HDEL.
  "-- marktmorgen:crm-value-take:v1": () => 2,
  // TAKE_DATA (lib/store-data.ts): HGET of the total and of the month list, HGET and HSET of each slot, the list and the
  // total written back, and HGET and HDEL of each month gone by. A month slot a run's start takes is removed once, two
  // commands later, by whichever take finds it gone: charged here to the start that made it.
  "-- marktmorgen:store-data:v1": (command, expired) => {
    const triples = command.slice(7);
    const slots = new Set<string>();
    let months = 0;
    for (let i = 0; i < triples.length; i += 3) {
      slots.add(String(triples[i + 1]));
      if (String(triples[i + 1]).startsWith("~")) months += 1;
    }
    return 4 + 2 * slots.size + 2 * expired + 2 * months;
  },
  // A webhook delivery's claim (lib/webhooks.ts) begins its try, which the webhooks line prices whole, per try, with its
  // own commands (tests/plan-cost-registry.ts, UNIT_COST.webhook): not this step's.
  'local due = redis.call("ZSCORE", KEYS[1], ARGV[1])': () => -1,
  // Counted by the stand-in itself (redis.scriptCalls).
  "-- marktmorgen:capped-count:v2": () => 0,
};
/** Scripts the stand-in does not run: their fallback sends the same commands Upstash would bill inside them. */
const FALLBACK = new Set(["local out = {}", 'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[2], ARGV[2]) return 1 else return 0 end', 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], ARGV[2]) else return 0 end', 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end']);

let billed = 0;
let bytes = 0;
/** What the records priced at their most apart (lib/flow-limits.ts) answered: the workflows, the deals board, the store. */
let priced = 0;
/** How often each of them was read: the ceiling counts each once. */
let reads = { workflows: 0, deals: 0, store: 0 };
const pricedApart = (command: (string | number)[]): keyof typeof reads | null =>
  command[0] === "GET" && /^nl:mail:flows:/.test(String(command[1])) ? "workflows" : command[0] === "HVALS" && /^nl:crm:deals:/.test(String(command[1])) ? "deals" : command[0] === "GET" && /^nl:store:owner:/.test(String(command[1])) ? "store" : null;
const unpriced = new Set<string>();
let measuring = false;
let failOn: ((command: (string | number)[]) => boolean) | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (list: (string | number)[][]) => {
  billed += list.length;
  if (measuring && process.env.STEP_COST_LOG) for (const command of list) console.log("    >", String(command[0]), String(command[1]).split("\n")[0].slice(0, 50));
  for (const command of list) {
    for (const arg of command) bytes += Buffer.byteLength(String(arg));
    if (command[0] !== "EVAL") continue;
    const head = String(command[1]).split("\n")[0];
    if (FALLBACK.has(head)) continue;
    const inner = INNER[head];
    if (!inner) {
      if (measuring) unpriced.add(head);
      continue;
    }
    let expired = 0;
    if (head === "-- marktmorgen:store-data:v1") {
      const [listed] = await pipeline([["HGET", String(command[3]), "~"]]);
      const month = String(command[6]);
      expired = typeof listed === "string" ? listed.split(",").filter((m) => m && m < month).length : 0;
    }
    billed += inner(command, expired);
  }
  if (failOn && list.some(failOn)) throw new Error("injected: unavailable");
  const before = redis.scriptCalls;
  const reply = await pipeline(list);
  billed += redis.scriptCalls - before;
  list.forEach((command, i) => {
    const answered = Buffer.byteLength(JSON.stringify(reply[i]) ?? "null");
    bytes += answered;
    const apart = pricedApart(command);
    if (apart) {
      priced += answered;
      reads[apart] += 1;
    }
  });
  return reply;
}) as typeof redis.pipeline;

type Cost = { commands: number; bytes: number; rest: number; reads: typeof reads };
/** What `work` cost: commands as billed, bytes in all, and the bytes beside the records priced at their most apart. */
const measure = async (work: () => Promise<unknown>): Promise<Cost> => {
  billed = 0;
  bytes = 0;
  priced = 0;
  reads = { workflows: 0, deals: 0, store: 0 };
  measuring = true;
  try {
    await work();
  } finally {
    measuring = false;
  }
  return { commands: billed, bytes, rest: bytes - priced, reads: { ...reads } };
};
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
const raw = (commands: (string | number)[][]) => pipeline(commands);

const PERSON = "kai@example.com";
const OPEN = "__open__";
const COURSE = "__course__";
const TARGET = "__target__";
/** The workflow a start or a stop step names, saved by the measurement's own preparation. */
let target = "";
let n = 0;

type World = { store: Store; course: string; open: string; other: string };

/** A Scale store with a two-person team, a course, a deal for the person, and the person on its list. */
async function world(): Promise<World> {
  redis.clear();
  n += 1;
  const OWNER = `owner${n}@example.com`;
  await claimHandle(OWNER, `stepcost${n}`, "Step Cost", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, `acct_1TestStepCost${String(n).padStart(2, "0")}`, true);
  await setSubscription(OWNER, { customerId: `cus_StepCost${n}`, subscriptionId: `sub_StepCost${n}`, active: true, tier: "scale", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Step Cost", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(OWNER, "A Course", "Lessons.", "49", null);
  if (!made.ok) throw new Error("no product");
  let course = emptyCourse();
  for (const title of ["One", "Two"]) {
    const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title });
    if (!added.ok) throw new Error("no lesson");
    course = added.course;
  }
  await saveCourse(course, ROOM);
  const set = await setProductCourse(OWNER, made.product.id, { id: course.id, lessons: 2 });
  if (!set.ok) throw new Error("not a course");
  let store = (await storeForEmail(OWNER))!;
  await putMember(store, "maya@example.com", "support");
  await putMember(store, "pat@example.com", "support");
  store = (await storeForEmail(OWNER))!;
  const stages = (await readStages(store.statsId!)).filter((s) => s.kind === "open");
  await writeDeal(store.statsId!, { id: "dealperson", title: "Deal", email: PERSON, cents: 0, stage: stages[0].id, note: "", createdAt: 2, updatedAt: 2 }, ROOM);
  await upsertContact(store.listId!, PERSON, { agreed: true, explicit: true, source: "free" }, ROOM);
  return { store, course: made.product.id, open: stages[0].id, other: stages[1].id };
}

/** Swaps the placeholders for the world's own ids, gives every step the course condition, and saves the workflow. */
async function workflow(w: World, steps: Record<string, unknown>[], extra: Record<string, unknown> = {}): Promise<string> {
  const fill = (value: unknown): unknown =>
    value === OPEN ? w.other : value === COURSE ? w.course : value === TARGET ? target : Array.isArray(value) ? value.map(fill) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)])) : value;
  const saved = await saveFlow(w.store, { name: "Measured", trigger: "joined", active: true, ...extra, steps: steps.map((s) => fill({ ...s, when: { if: "unstarted", productId: COURSE }, otherwise: "skip" })) }, { activate: true });
  if (!saved.ok) throw new Error(`not saved: ${JSON.stringify(saved)}`);
  return saved.flows.find((f) => f.name === (extra.name ?? "Measured"))!.id;
}

/** The step after the measured one: due a day later, so the job run measured does the one step only. */
const NEXT = { delayHours: 24, subject: "Next", body: "And then." };

type Measured = Cost & { name: string };
const steps: Measured[] = [];
const waitsMeasured: Measured[] = [];
const starts: Measured[] = [];

/** One try of a step that waits: `prep` makes it wait, `fail` makes a read fail on its way. */
async function wait(name: string, first: Record<string, unknown>, prep: (w: World) => Promise<void>, fail: ((command: (string | number)[]) => boolean) | null = null, others: (w: World) => Promise<void> = async () => {}): Promise<void> {
  const w = await world();
  await others(w);
  const id = await workflow(w, [first, NEXT]);
  w.store = (await storeForEmail(w.store.email))!;
  await enroll(w.store, PERSON, { joined: true });
  await prep(w);
  failOn = fail;
  const m = await measure(run).finally(() => {
    failOn = null;
  });
  const found = await readRun(id, personOf(PERSON));
  if (found?.run.status !== "waiting" || found.run.waits !== 1) throw new Error(`${name}: it did not wait (${JSON.stringify(found?.run)})`);
  waitsMeasured.push({ name, ...m });
}

/** One step of `first`, for one person, followed by an email step so the next step is queued. */
async function step(name: string, first: Record<string, unknown>, prep?: (w: World) => Promise<void>, others: (w: World) => Promise<void> = async () => {}, minus = 0): Promise<void> {
  const w = await world();
  await others(w);
  await workflow(w, [first, NEXT]);
  w.store = (await storeForEmail(w.store.email))!;
  await enroll(w.store, PERSON, { joined: true });
  if (prep) await prep(w);
  const m = await measure(run);
  steps.push({ ...m, name, commands: m.commands - minus * RUN_START_COMMANDS, rest: m.rest - minus * RUN_START_FIXED_BYTES });
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_step_cost_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_step_cost_only_a_stand_in";

  part("A run's start");
  {
    const w = await world();
    await workflow(w, [NEXT]);
    w.store = (await storeForEmail(w.store.email))!;
    const m = await measure(() => enroll(w.store, PERSON, { joined: true }));
    starts.push({ name: "a run's start", ...m });
  }

  part("One step of each kind, at its worst");
  await step("email", { delayHours: 0, subject: "Hello", body: "Words." });
  await step("wait", { delayHours: 0, action: { do: "wait" } });
  await step("untag", { delayHours: 0, action: { do: "untag", tag: "x" } }, async (w) => {
    await changeLabels(w.store.listId!, [PERSON], (tags) => [...tags, "x"], w.store);
  });
  await step("notify", { delayHours: 0, action: { do: "notify" } });
  await step("note, the page full", { delayHours: 0, action: { do: "note", text: "A note." } }, async (w) => {
    for (let i = 0; i < MAX_PERSON_NOTES; i += 1) await addPersonNote(w.store.statsId!, personKey(w.store.statsId!, PERSON), "owner@example.com", `Note ${i}`, ROOM);
  });
  await step("field", { delayHours: 0, action: { do: "field", field: "src001", value: "Ads" } }, undefined, async (w) => {
    await writeFields(w.store.statsId!, [{ id: "src001", name: "Came from", type: "text", options: [] }]);
  });
  await step(`webhook, ${MAX_ENDPOINTS} endpoints`, { delayHours: 0, action: { do: "webhook" } }, undefined, async (w) => {
    for (let i = 0; i < MAX_ENDPOINTS; i += 1) {
      const added = await addEndpoint(w.store, `https://hooks${i}.example.com/in`, ["sequence.step"]);
      if (!added.ok) throw new Error(`no endpoint: ${JSON.stringify(added)}`);
    }
    w.store = (await storeForEmail(w.store.email))!;
  });
  await step("deal moved", { delayHours: 0, action: { do: "deal", stage: OPEN, title: "Moved" } });
  await step("deal made", { delayHours: 0, action: { do: "deal", stage: OPEN, title: "Made" } }, async (w) => {
    await raw([["HDEL", `nl:crm:deals:${w.store.statsId}`, "dealperson"]]);
  });
  await step("assign", { delayHours: 0, action: { do: "assign", assignee: "maya@example.com" } });
  await step("next action", { delayHours: 0, action: { do: "next", text: "Call", days: 3 } });
  await step("rotate", { delayHours: 0, action: { do: "rotate" } });
  // The other workflows: as many as the plan lets start, each starting with the label (or started by the step).
  const tagged = (count: number) => async (w: World) => {
    for (let i = 0; i < count; i += 1) await workflow(w, [NEXT], { name: `Tagged ${i}`, trigger: "tagged", tag: "x" });
  };
  const OTHERS = 19;
  const dayUsed = async (w: World) => {
    await raw([["HSET", `nl:wf:day:${w.store.listId}:${new Date().toISOString().slice(0, 10)}`, "started", 1_000]]);
  };
  const roomFull = async (w: World) => {
    const key = dataKey(w.store)!;
    await raw([["HSET", key, "#", contentRoomFor(w.store) - 4_000]]);
  };
  await step(`label, ${OTHERS} others refused for the day`, { delayHours: 0, action: { do: "tag", tag: "x" } }, dayUsed, tagged(OTHERS));
  await step(`label, ${OTHERS} others refused for room`, { delayHours: 0, action: { do: "tag", tag: "x" } }, roomFull, tagged(OTHERS));
  await step(`label, ${OTHERS} others admitted, beyond their starts, each priced as a run`, { delayHours: 0, action: { do: "tag", tag: "x" } }, undefined, tagged(OTHERS), OTHERS);
  const one = (trigger: string) => async (w: World) => {
    target = await workflow(w, [{ delayHours: 48, subject: "Later", body: "Later." }, NEXT], { name: "Target", trigger, tag: "never" });
  };
  await step("start, refused for the day", { delayHours: 0, action: { do: "start", flowId: TARGET } }, dayUsed, one("tagged"));
  await step("start, refused for room", { delayHours: 0, action: { do: "start", flowId: TARGET } }, roomFull, one("tagged"));
  // The target starts for the person too (it starts on joining), so its next step waits in the queue: the stop takes it out.
  await step("stop, out of the queue", { delayHours: 0, action: { do: "stop", flowId: TARGET } }, undefined, one("joined"));
  // The target's first email is lost on its way (uncertain), so its run is held for the creator's choice: the stop ends it.
  const held = async (w: World) => {
    target = await workflow(w, [{ delayHours: 0, subject: "Now", body: "Now." }, NEXT], { name: "Target", trigger: "tagged", tag: "held" });
    w.store = (await storeForEmail(w.store.email))!;
    await enroll(w.store, PERSON, { joined: false, tag: "held" });
    resendDown = true;
    await run();
    resendDown = false;
  };
  await step("stop, the run held", { delayHours: 0, action: { do: "stop", flowId: TARGET } }, undefined, held);

  part("One try of a step that waits, at its worst");
  await wait("email, the month's emails used up", { delayHours: 0, subject: "Hello", body: "Words." }, async (w) => {
    const window = allowanceWindow(w.store)!;
    await raw([["SET", `nl:mail:used:${w.store.listId}:${window.id}`, 1_000_000_000]]);
  });
  await wait("rotate, the deal unreadable just before it is written", { delayHours: 0, action: { do: "rotate" } }, async () => {}, (c) => c[0] === "HGET" && String(c[1]).startsWith("nl:crm:deals:"));
  await wait("rotate, the lock taken", { delayHours: 0, action: { do: "rotate" } }, async (w) => {
    await raw([["SET", `nl:flow-rotate:${w.store.statsId}`, "someone", "EX", 120]]);
  });
  await wait("assign, the team unreadable", { delayHours: 0, action: { do: "assign", assignee: "maya@example.com" } }, async () => {}, (c) => String(c[1]).startsWith("nl:team:"));
  await wait("stop, unconfirmed", { delayHours: 0, action: { do: "stop", flowId: TARGET } }, async () => {}, (c) => c[0] === "ZREM" && c.length > 3, one("joined"));

  part("Held under the ceilings the margin review prices (lib/flow-limits.ts)");
  is("every script on the path is priced", [...unpriced], []);
  const within = (what: string, list: Measured[], commands: number, rest: number) => {
    for (const m of list) {
      is(`${what}, ${m.name}: ${m.commands} commands at most ${commands}, ${m.rest} bytes besides the records priced apart at most ${rest}`, [m.commands <= commands, m.rest <= rest], [true, true]);
      is(`${what}, ${m.name}: the workflows, the deals and the store read once at the most (${JSON.stringify(m.reads)})`, Math.max(m.reads.workflows, m.reads.deals, m.reads.store) <= 1, true);
    }
  };
  within("start", starts, RUN_START_COMMANDS, RUN_START_FIXED_BYTES);
  within("step", steps, STEP_COMMANDS, STEP_FIXED_BYTES);
  within("wait", waitsMeasured, WAIT_COMMANDS_PER_TRY, WAIT_FIXED_BYTES);
  const dearest = Math.max(...steps.map((m) => m.commands));
  is(`the dearest step (${dearest}) is within ten commands of the ceiling, so the ceiling is the measurement`, STEP_COMMANDS - dearest >= 0 && STEP_COMMANDS - dearest <= 10, true);
  is("the step's three parts add up to it", STEP_COMMANDS, HISTORY_COMMANDS_PER_STEP + QUEUE_COMMANDS_PER_STEP + ACTION_COMMANDS_PER_STEP);
  is("the run's worst counts its start, every step and retry, and every wait", WORST_COMMANDS_PER_RUN, RUN_START_COMMANDS + (MAX_STEPS + MAX_RETRIES_BY_YOU) * STEP_COMMANDS + MAX_WAITS_PER_RUN * WAIT_COMMANDS_PER_TRY);
  is("and its bytes the same way", WORST_BYTES_PER_RUN, RUN_START_BYTES + (MAX_STEPS + MAX_RETRIES_BY_YOU) * STEP_BYTES + MAX_WAITS_PER_RUN * WAIT_BYTES);

  part("The records priced apart, at their most");
  const PER_CHAR = 7;
  is("the workflows: every workflow and step at its longest, each character at its dearest as answered", WORKFLOWS_READ_BYTES, MAX_FLOWS * (MAX_STEPS * (PER_CHAR * (MAX_SUBJECT + MAX_MAIL_BODY) + 2_000) + PER_CHAR * 80 + 4_000));
  {
    const w = await world();
    const dear = "\u0001";
    const id = (i: number) => (i + 1).toString(16).padStart(16, "a");
    const longest = Array.from({ length: MAX_STEPS }, (_, i) => ({ id: id(i), delayHours: MAX_DELAY_HOURS, subject: dear.repeat(MAX_SUBJECT), body: dear.repeat(MAX_MAIL_BODY), when: { if: "tag", tag: "t".repeat(MAX_TAG_LENGTH) }, otherwise: "skip" }));
    const saved = await saveFlow(w.store, { name: dear.repeat(80), trigger: "tagged", tag: dear.repeat(40), active: false, steps: longest });
    is("a workflow at its longest is saved", saved.ok || saved.reason, true);
    const m = await measure(() => redis.pipeline([["GET", `nl:mail:flows:${w.store.listId}`]]));
    is(`one workflow at its longest answers ${m.bytes} bytes, within its share`, m.bytes <= WORKFLOWS_READ_BYTES / MAX_FLOWS, true);
    const deal = { id: "dealonelong", title: dear.repeat(90), email: `${"a".repeat(240)}@example.com`, cents: 10_000_000_000, stage: w.open, note: dear.repeat(500), nextAction: dear.repeat(200), dueDate: "2026-12-31", assignee: `${"b".repeat(240)}@example.com`, formResponseRef: "f".repeat(64), createdAt: 9_999_999_999, updatedAt: 9_999_999_999 };
    await raw([["DEL", `nl:crm:deals:${w.store.statsId}`], ["HSET", `nl:crm:deals:${w.store.statsId}`, deal.id, JSON.stringify(deal)]]);
    const d = await measure(() => redis.pipeline([["HVALS", `nl:crm:deals:${w.store.statsId}`]]));
    is(`one deal at its longest answers ${d.bytes} bytes, within its share`, d.bytes <= DEALS_READ_BYTES / MAX_DEALS, true);
  }
  is("the deals board: every deal there may be", DEALS_READ_BYTES % MAX_DEALS, 0);
  is("the store's record: as kept at its most, every byte at most escaped once", STORE_READ_BYTES, 2 * MAX_STORE_BYTES);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
