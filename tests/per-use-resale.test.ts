/**
 * Reselling per-use services (docs/per-use-resale-2026-10-18.md): an
 * ANALYSIS, no price, limit or gate in code changes. The document must be what
 * tests/per-use-resale-table.ts renders today (regenerate it with
 * `node scripts/per-use-resale.mjs`), every rate it gives must keep 60% with
 * the whole credit spent on that one service, and every figure must have its
 * page and its day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onDemandReport, onDemandText } from "./generated-on-demand";
import { join } from "node:path";
import { PLANS_ON_SALE } from "@/lib/opening";
import { MOST_TAX_READING, unitUnder } from "./historical-margin-model";
import { AMOUNTS, DOC_FILE, candidates, data, rateOf, renderPerUseResale } from "./per-use-resale-table";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("the document is what the numbers render today (run node scripts/per-use-resale.mjs)", () => {
  assert.equal(read(DOC_FILE), onDemandText(onDemandReport(DOC_FILE)), `${DOC_FILE} holds only its fixed text: the report is generated on demand`);
  assert.match(renderPerUseResale(), /\*\*An analysis for the owner, not a change\.\*\*/);
  assert.equal(PLANS_ON_SALE, false);
});

test("every rate keeps 60% with the whole credit spent on that one service, and fails the most-tax gate", () => {
  for (const c of candidates()) for (const a of AMOUNTS) {
    const r = rateOf(c, a);
    assert.ok(r.keeps && r.worst.netBps >= 6_000, `${c.id} at ${a}`);
    assert.ok(r.centsPerDisplay > 0);
    assert.equal(unitUnder(a, r.worst.usageCents, MOST_TAX_READING, true).meetsFloor, false);
  }
});

test("only bounded services are sold, and every sold one has an order", () => {
  for (const c of candidates()) {
    if (c.unbounded) assert.equal(c.verdict, "don't sell", c.id);
    assert.equal(c.order === null, c.verdict === "don't sell", c.id);
  }
});

test("every supplier and competitor figure has its page and its day", () => {
  const d = data();
  for (const s of d.sources) { assert.match(s.url, /^https:\/\//); assert.match(s.read, /2026/); }
  const ids = new Set(d.sources.map((s) => s.id));
  const sp = d.suppliers;
  for (const id of [...sp.smsSegment.map((r) => r.source), sp.tenDlc.source, sp.phoneNumberMonthly.source, sp.voiceMinute.source, sp.whatsappMarketing.source, sp.aiVoiceMinute.source, sp.captionMinuteLanguage.source, sp.videoAlternative.source, ...sp.emailAlternatives.map((e) => e.source)]) assert.ok(ids.has(id), id);
  for (const rows of Object.values(d.competitors)) for (const r of rows) assert.ok(ids.has(r.source), r.source);
  for (const c of candidates()) for (const id of c.supplierSources) assert.ok(ids.has(id), id);
});
