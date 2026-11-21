import { test } from "node:test";
import assert from "node:assert/strict";
import { companyOwnerReport } from "../lib/company-owner-report";

const NOW = Date.UTC(2026, 10, 5, 8);
const MONTH = "2026-10";
function fixture() {
  return {
    closedData: { observedAtMs: NOW, parked: 1, stopped: 2, left: 3, stuck: 1, unread: 4, unreadKept: 2, owedKept: 5, scansStuck: 6 },
    storeForget: { observedAtMs: NOW, month: MONTH, queued: 7, done: 3, gaveUp: 2, waitingNow: 1, keptNow: 4 },
    keptStar: { observedAtMs: NOW, month: MONTH, times: 8 },
    settlementEvidence: { observedAtMs: NOW, scope: "run", complete: false, unknownDisputes: 2, unknownDisputeFees: ["fee_SYNTH1"], unknownAmounts: 3, unknownAmountFees: ["fee_SYNTH2"], listUnknown: 4 },
    sesPause: { status: "paused", observedAtMs: NOW, holdUntilMs: NOW + 60_000 },
    manualLook: { observedAtMs: NOW, minimumWeeks: 12, stopped: 2, stuck: 1 },
  };
}
const render = (input: unknown) => companyOwnerReport(typeof input === "string" ? input : JSON.stringify(input), MONTH, NOW);

for (const key of ["closedData", "storeForget", "keptStar", "settlementEvidence", "sesPause", "manualLook"] as const) {
  test(`the owner sees the separate ${key} observation`, () => {
    const report = render(fixture());
    const section = report.sections.find(row => row.id === key);
    assert.ok(section);
    assert.equal(section.status, "observed");
    assert.equal(section.observedAtMs, NOW);
    assert.ok(section.lines.length > 0);
  });
}

test("the six absent sources stay visible and unknown even without reconciled money", () => {
  const result = companyOwnerReport(null, MONTH, NOW);
  assert.equal(result.month, MONTH);
  assert.equal(result.sections.length, 6);
  for (const section of result.sections) {
    assert.equal(section.status, "unknown");
    assert.equal(section.observedAtMs, null);
    assert.deepEqual(section.counts, {});
    assert.match(section.lines.join(" "), /desconhecido/);
  }
});

test("each count remains separate and a run cannot claim a complete monthly settlement", () => {
  const sections = render(fixture()).sections;
  assert.deepEqual(sections[0].counts, { parked: 1, stopped: 2, left: 3, stuck: 1, unread: 4, unreadKept: 2, owedKept: 5, scansStuck: 6 });
  assert.deepEqual(sections[3].counts, { unknownDisputes: 2, unknownAmounts: 3, listUnknown: 4 });
  assert.deepEqual(sections[3].feeIds, { unknownDisputeFees: ["fee_SYNTH1"], unknownAmountFees: ["fee_SYNTH2"] });
  assert.match(sections[3].lines.join(" "), /execução/);
  assert.match(sections[3].lines.join(" "), /total mensal.*desconhecido/);
  assert.match(sections[5].lines.join(" "), /12.*semanas/);
  assert.equal("total" in sections[0].counts, false);
});

test("missing, fractional, negative and inconsistent evidence invalidates only its source", () => {
  for (const value of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "2"]) {
    const input = fixture();
    Object.assign(input.closedData, { stopped: value });
    const report = render(input);
    assert.equal(report.sections[0].status, "unknown");
    assert.equal(report.sections[1].status, "observed");
  }
  const input = fixture();
  input.closedData.stuck = 4;
  assert.equal(render(input).sections[0].status, "unknown");
  input.closedData.stuck = 1;
  Reflect.deleteProperty(input.closedData, "owedKept");
  assert.equal(render(input).sections[0].status, "unknown");
});

test("wrong months, future or stale observations and unmeasured ages never look current", () => {
  for (const at of [NOW + 1, NOW - 3_600_001, -1, 0.5]) {
    const input = fixture();
    input.sesPause.observedAtMs = at;
    assert.equal(render(input).sections[4].status, "unknown");
  }
  const input = fixture();
  input.storeForget.month = "2026-09";
  input.keptStar.month = "2026-11";
  input.manualLook.minimumWeeks = 11;
  for (const index of [1, 2, 5]) assert.equal(render(input).sections[index].status, "unknown");
});

test("only serialized bounded data is inspected; getters, proxies and coercions never execute", () => {
  let calls = 0;
  const hostile = new Proxy({}, { get() { calls += 1; throw Error("get"); }, ownKeys() { calls += 1; throw Error("keys"); } });
  const result = companyOwnerReport(hostile as never, MONTH, NOW);
  assert.equal(result.sections.every(section => section.status === "unknown"), true);
  assert.equal(calls, 0);
  for (const raw of ["{", "[]", '"private"', " ".repeat(65_537)]) {
    assert.equal(companyOwnerReport(raw, MONTH, NOW).sections.every(section => section.status === "unknown"), true);
  }
});

test("private extras and malformed fee references are never copied to the owner output", () => {
  const input = fixture();
  Object.assign(input.closedData, { address: "synthetic@example.com" });
  input.settlementEvidence.unknownDisputeFees = ["synthetic@example.com"];
  const report = render(input);
  assert.equal(report.sections[0].status, "unknown");
  assert.equal(report.sections[3].status, "unknown");
  assert.doesNotMatch(JSON.stringify(report), /synthetic@example\.com/);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.sections[1].counts), true);
  assert.equal(Object.isFrozen(report.sections[1].lines), true);
});

test("invalid clock and month fail closed; exact zero stays distinct from absent evidence", () => {
  for (const now of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal(companyOwnerReport(JSON.stringify(fixture()), MONTH, now).sections.every(row => row.status === "unknown"), true);
  }
  const input = fixture();
  input.keptStar.times = 0;
  assert.deepEqual(render(input).sections[2].counts, { times: 0 });
  assert.equal(companyOwnerReport(JSON.stringify(input), "2026-1", NOW).month, null);
});

test("an ambient inherited source cannot execute or fabricate an absent observation", () => {
  let calls = 0;
  Object.defineProperty(Object.prototype, "sesPause", { configurable: true, get() {
    calls += 1;
    return { status: "ready", observedAtMs: NOW, holdUntilMs: null };
  } });
  try {
    const report = companyOwnerReport("{}", MONTH, NOW);
    assert.equal(report.sections[4].status, "unknown");
    assert.equal(calls, 0);
  } finally {
    Reflect.deleteProperty(Object.prototype, "sesPause");
  }
});

test("an inherited timestamp cannot execute while refusing an incomplete source", () => {
  let calls = 0;
  Object.defineProperty(Object.prototype, "observedAtMs", { configurable: true, get() {
    calls += 1;
    return NOW;
  } });
  try {
    const report = companyOwnerReport('{"sesPause":{"status":"ready","holdUntilMs":null}}', MONTH, NOW);
    assert.equal(report.sections[4].status, "unknown");
    assert.equal(calls, 0);
  } finally {
    Reflect.deleteProperty(Object.prototype, "observedAtMs");
  }
});

test("conflicting duplicate JSON members remain unknown before last-value normalization", () => {
  const duplicateSource = `{"keptStar":{"observedAtMs":${NOW},"month":"${MONTH}","times":999},"keptStar":{"observedAtMs":${NOW},"month":"${MONTH}","times":8}}`;
  const duplicateCount = `{"keptStar":{"observedAtMs":${NOW},"month":"${MONTH}","times":999,"times":8}}`;
  const escapedDuplicateCount = `{"keptStar":{"observedAtMs":${NOW},"month":"${MONTH}","times":999,"ti\\u006des":8}}`;

  for (const serialized of [duplicateSource, duplicateCount, escapedDuplicateCount]) {
    const kept = companyOwnerReport(serialized, MONTH, NOW).sections.find(row => row.id === "keptStar");
    assert.equal(kept?.status, "unknown");
    assert.equal(kept?.observedAtMs, null);
  }
});
