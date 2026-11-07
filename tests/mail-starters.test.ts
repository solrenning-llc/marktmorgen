/**
 * The two sequences written for a creator (lib/mail-starters.ts).
 *
 * They are sent under the creator's name to people who trusted them with an
 * address, so most of what is held here is what the words may not do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boughtSteps, missingStarters, starterFlows, welcomeSteps, type StarterFacts } from "@/lib/mail-starters";
import { MAX_STEPS, MAX_DELAY_HOURS, MAX_FLOW_NAME } from "@/lib/flows";
import { MAX_MAIL_BODY, MAX_SUBJECT } from "@/lib/mail";

const facts: StarterFacts = {
  fromName: "Harbor Kitchen",
  storeLink: "https://marktmorgen.com/@harbor",
  ordersLink: "https://marktmorgen.com/@harbor/orders",
  product: { title: "Weekly Meal Planner", link: "https://marktmorgen.com/@harbor/p/plan" },
  paidCount: 2,
};
const nothingToSell: StarterFacts = { ...facts, product: null, paidCount: 0 };

test("a store with no sequence gets both, switched off", () => {
  const made = starterFlows(facts, []);
  assert.deepEqual(made.map((f) => [f.starter, f.trigger]), [["welcome", "joined"], ["bought", "bought"]]);
  for (const flow of made) {
    assert.equal(flow.active, false, "nothing is sent until the creator has read it and switched it on");
    assert.equal(flow.productId, null);
    assert.ok(flow.name.length <= MAX_FLOW_NAME);
  }
});

test("a store that already has its own welcome is not given a second one to send beside it", () => {
  assert.deepEqual(starterFlows(facts, [{ trigger: "joined" }]).map((f) => f.starter), ["bought"]);
  assert.deepEqual(starterFlows(facts, [{ trigger: "bought" }]).map((f) => f.starter), ["welcome"]);
  assert.deepEqual(starterFlows(facts, [{ trigger: "joined" }, { trigger: "bought" }]), []);
  // A sequence for one product is a different moment, and takes neither place.
  assert.equal(starterFlows(facts, [{ trigger: "product" }]).length, 2);
});

test("a store that sells nothing gets a welcome that sends nobody to a product", () => {
  const made = starterFlows(nothingToSell, []);
  assert.deepEqual(made.map((f) => f.starter), ["welcome"], "nobody can buy for the first time yet");
  assert.equal(made[0].steps.length, 1);
  assert.ok(!/\/p\//.test(made[0].steps[0].body));
  assert.deepEqual(missingStarters([], false), ["welcome"]);
  assert.deepEqual(missingStarters([], true), ["welcome", "bought"]);
});

test("the rest of the store is offered only by a store that has a rest", () => {
  assert.equal(boughtSteps({ ...facts, paidCount: 1 }).length, 1);
  assert.equal(boughtSteps(facts).length, 2);
});

test("every email is one a sequence can hold, in order, from the creator's own store", () => {
  for (const steps of [welcomeSteps(facts), boughtSteps(facts)]) {
    assert.ok(steps.length >= 1 && steps.length <= MAX_STEPS);
    let last = -1;
    for (const step of steps) {
      assert.ok(step.subject.length > 0 && step.subject.length <= MAX_SUBJECT);
      assert.ok(step.body.length > 0 && step.body.length <= MAX_MAIL_BODY);
      assert.ok(Number.isInteger(step.delayHours) && step.delayHours >= 0 && step.delayHours <= MAX_DELAY_HOURS);
      assert.ok(step.delayHours > last, "each one later than the one before");
      last = step.delayHours;
      assert.ok(step.body.trimEnd().endsWith("Harbor Kitchen"), "signed with the name the emails are from");
      for (const link of step.body.match(/https:\/\/\S+/g) ?? []) {
        assert.ok(link.startsWith("https://marktmorgen.com/@harbor"), `only the creator's own store is linked: ${link}`);
      }
    }
  }
});

test("the words claim nothing that is not true of every store", () => {
  // Sent under somebody's name, to people who trusted them. No result, no
  // number of buyers, no discount, no deadline, no scarcity, no guarantee —
  // and no placeholder left for a reader to receive.
  const all = [...welcomeSteps(facts), ...boughtSteps(facts)].map((s) => `${s.subject}\n${s.body}`).join("\n");
  const never = [
    /guarantee/i, /\bproven\b/i, /\bresults?\b/i, /\bbest[- ]?sell/i, /most people/i, /thousands|hundreds/i, /\d+\s*%/,
    /discount|coupon|\boff\b|sale ends|deadline|last chance|only \d+ left|limited/i, /\bfree\b/i, /testimonial|review/i,
    /\[[^\]]*\]|\{[^}]*\}|<[^>]*>|TODO|lorem/i, /every day/i,
  ];
  for (const pattern of never) assert.ok(!pattern.test(all), `the starter emails must not say ${pattern}`);
  // A price would be wrong the day the creator changes it.
  assert.ok(!/[$€£]\s?\d/.test(all), "no price is written into an email that goes out for months");
});

test("no model writes them, so they cost nothing and cannot say something new", () => {
  const src = readFileSync(join(process.cwd(), "lib/mail-starters.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/@\/lib\/ai\b|fetch\(/.test(src));
  // Changed 7 November 2026 (review of #1927): the same one save, now also carrying the studio's meter, so what
  // reading and writing the workflows moves takes its studio requests first (lib/flows.ts, FlowMeter).
  assert.match(src, /const saved = await saveFlow\(store, raw, \{ meter \}\);/, "and they are saved by the one place that checks a sequence");
});

test("where a written sequence came from survives an edit, and only whoever sends may ask for one", () => {
  assert.match(readFileSync(join(process.cwd(), "lib/flows.ts"), "utf8"), /const starter = starterOf\(raw\.starter\) \?\? \(at >= 0 \? flows\[at\]\.starter : undefined\);/);
  assert.match(readFileSync(join(process.cwd(), "app/api/store/mail/route.ts"), "utf8"), /starters: "send",/);
});
