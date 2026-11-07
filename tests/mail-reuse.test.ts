/**
 * A sent email, used again (lib/mail-reuse.ts).
 *
 * The planning is a pure function on purpose, so what matters can be held
 * without a list, a plan or a queue: which sequence a sent email joins, how
 * long after the one before it, and the three things it refuses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEEP_FIRST_HOURS, KEEP_GAP_HOURS, keepName, planKeep } from "@/lib/mail-reuse";
import { MAX_FLOW_NAME, MAX_STEPS, type Flow } from "@/lib/flows";
import type { Broadcast } from "@/lib/broadcasts";

const LIST = "list-one";

function sent(over: Partial<Broadcast> = {}): Broadcast {
  return {
    id: "a".repeat(24),
    listId: LIST,
    handle: "harbor",
    subject: "The five-week plan is here",
    body: "Hello.\n\nIt is ready.",
    productId: null,
    notProductId: null,
    who: "all",
    narrow: null,
    status: "sent",
    createdAt: 1,
    sendAt: 1,
    finishedAt: 2,
    total: 10,
    sent: 10,
    note: "",
    failures: 0,
    listed: true,
    tagged: false,
    test: null,
    ...over,
  };
}

function flow(over: Partial<Flow> = {}): Flow {
  return { id: "f".repeat(16), name: "Welcome", trigger: "joined", productId: null, steps: [], active: true, createdAt: 1, ...over };
}

test("the first kept email starts a sequence for everybody who joins, a day after", () => {
  const plan = planKeep(sent(), LIST, [], null);
  assert.ok(plan.ok);
  assert.equal(plan.waitHours, KEEP_FIRST_HOURS);
  assert.equal(plan.position, 1);
  assert.equal(plan.raw.trigger, "joined");
  assert.equal(plan.raw.productId, null);
  assert.equal(plan.raw.active, true, "the creator asked for it to be sent");
  assert.equal(plan.raw.kept, true, "so the next one finds this sequence");
  assert.equal(plan.raw.id, undefined, "a new sequence, not somebody else's");
  assert.deepEqual(plan.raw.steps, [{ delayHours: KEEP_FIRST_HOURS, subject: "The five-week plan is here", body: "Hello.\n\nIt is ready." }]);
});

test("an email written to the people who got a product follows that product", () => {
  const plan = planKeep(sent({ productId: "prod1" }), LIST, [], "Weekly Meal Planner");
  assert.ok(plan.ok);
  assert.equal(plan.raw.trigger, "product");
  assert.equal(plan.raw.productId, "prod1");
  assert.equal(plan.name, "Kept sending to everyone who gets Weekly Meal Planner");
});

test("the second one joins the same sequence, two days after the first", () => {
  const home = flow({ kept: true, name: keepName(null), steps: [{ id: "1".repeat(16), delayHours: 24, subject: "First", body: "One" }] });
  const plan = planKeep(sent(), LIST, [flow(), home], null);
  assert.ok(plan.ok);
  assert.equal(plan.raw.id, home.id, "one sequence of several, not several sequences that all arrive on day one");
  assert.equal(plan.waitHours, 24 + KEEP_GAP_HOURS);
  assert.equal(plan.position, 2);
  assert.equal((plan.raw.steps as unknown[]).length, 2);
});

test("a sequence the creator built by hand is never added to", () => {
  // Same trigger, same people — but theirs, with their own timing. Only a
  // sequence this made before is one it may extend.
  const theirs = flow({ steps: [{ id: "1".repeat(16), delayHours: 0, subject: "Welcome", body: "Hi" }] });
  const plan = planKeep(sent(), LIST, [theirs], null);
  assert.ok(plan.ok);
  assert.equal(plan.raw.id, undefined);
});

test("a kept sequence for one product is not the home of an email for everybody", () => {
  const other = flow({ kept: true, trigger: "product", productId: "prod1", steps: [{ id: "1".repeat(16), delayHours: 24, subject: "A", body: "B" }] });
  const plan = planKeep(sent(), LIST, [other], null);
  assert.ok(plan.ok);
  assert.equal(plan.raw.id, undefined);
});

test("the same email is not kept twice", () => {
  const home = flow({ kept: true, steps: [{ id: "1".repeat(16), delayHours: 24, subject: "The five-week plan is here", body: "Hello.\n\nIt is ready." }] });
  assert.deepEqual(planKeep(sent(), LIST, [home], null), { ok: false, reason: "already" });
  // Recognised as the same email however its line endings and spaces arrived.
  assert.deepEqual(planKeep(sent({ subject: "The  five-week plan is here ", body: "Hello.\r\n\r\nIt is ready.\n" }), LIST, [home], null), { ok: false, reason: "already" });
});

test("an email that left out a product's owners keeps leaving them out, as its condition", () => {
  // "You have not bought this yet" must never arrive for somebody who has.
  const plan = planKeep(sent({ notProductId: "prod2" }), LIST, [], null);
  assert.ok(plan.ok);
  const steps = plan.raw.steps as { when?: unknown; otherwise?: unknown }[];
  assert.deepEqual([steps.at(-1)?.when, steps.at(-1)?.otherwise], [{ if: "lacks", productId: "prod2" }, "skip"]);
});

test("only an email that finished going out can be kept", () => {
  for (const status of ["scheduled", "sending", "waiting", "cancelled", "failed"] as const) {
    assert.deepEqual(planKeep(sent({ status }), LIST, [], null), { ok: false, reason: "unsent" }, status);
  }
});

test("another store's email is not there at all", () => {
  assert.deepEqual(planKeep(sent({ listId: "somebody-else" }), LIST, [], null), { ok: false, reason: "unknown" });
  assert.deepEqual(planKeep(null, LIST, [], null), { ok: false, reason: "unknown" });
  assert.deepEqual(planKeep(sent(), null, [], null), { ok: false, reason: "unknown" });
});

test("a full sequence says so instead of dropping an email off the end", () => {
  const steps = Array.from({ length: MAX_STEPS }, (_, i) => ({ id: String(i).padStart(16, "0"), delayHours: 24 + i * 48, subject: `S${i}`, body: `B${i}` }));
  assert.deepEqual(planKeep(sent(), LIST, [flow({ kept: true, steps })], null), { ok: false, reason: "full" });
});

test("a long product name still makes a name a sequence can have", () => {
  assert.ok(keepName("x".repeat(300)).length <= MAX_FLOW_NAME);
});

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("writing it again is drafting, and keeping it sending is sending", () => {
  // An Editor may put a sent email back in the composer; only somebody who
  // may reach the list can make it go out by itself.
  const src = read("app/api/store/mail/route.ts");
  assert.match(src, /copy: "draft",/);
  assert.match(src, /keep: "send",/);
});

test("the sequence is saved by the one place that checks a sequence", () => {
  // The plan, the setup, the product still existing and ten sequences at
  // most are saveFlow's rules. Writing the list of sequences here as well
  // would be a second door with none of them on it.
  const src = read("lib/mail-reuse.ts");
  // "Keep sending it" is the creator's explicit switch on (lib/flows.ts saves new workflows paused otherwise).
  // Changed 7 November 2026 (review of #1927): the same one save, now also carrying the studio's meter, so what
  // reading and writing the workflows moves takes its studio requests first (lib/flows.ts, FlowMeter).
  assert.match(src, /const saved = await saveFlow\(store, plan\.raw, \{ activate: true, meter \}\);/);
  assert.ok(!/writeFlows|redisPipeline/.test(src), "nothing is written to the list's records from here");
});

test("the mark that says a sequence was kept survives an edit in the studio", () => {
  const src = read("lib/flows.ts");
  assert.match(src, /raw\.kept === true \|\| \(at >= 0 && flows\[at\]\.kept === true\)/);
});

test("an email to buyers is kept for everybody who buys, in a sequence of its own", () => {
  const plan = planKeep(sent({ who: "buyers" }), LIST, [flow({ kept: true })], null);
  assert.ok(plan.ok);
  assert.equal(plan.raw.trigger, "bought");
  assert.equal(plan.raw.id, undefined, "not the sequence for everybody who joins");
  assert.equal(plan.name, "Kept sending to everyone who buys");
});

test("an email to people who have not bought is not kept sending to people who join by buying", () => {
  const leads = planKeep(sent({ who: "leads" }), LIST, [], null);
  assert.ok(leads.ok);
  assert.equal(leads.raw.trigger, "joined");
  assert.deepEqual((leads.raw.steps as { when?: unknown }[]).at(-1)?.when, { if: "lead" });
  const buyersOfOne = planKeep(sent({ who: "buyers", productId: "prod1" }), LIST, [], "Plan");
  assert.ok(buyersOfOne.ok);
  assert.deepEqual([buyersOfOne.raw.trigger, buyersOfOne.raw.productId, (buyersOfOne.raw.steps as { when?: unknown }[]).at(-1)?.when], ["product", "prod1", { if: "buyer" }]);
  // Narrowed two ways at once is more than one email's condition.
  assert.deepEqual(planKeep(sent({ who: "leads", notProductId: "prod2" }), LIST, [], null), { ok: false, reason: "excludes" });
});
