/**
 * An email to the people with one label (99 [E2-TAG-BROADCAST]; added 2
 * November 2026). The labels an import or a sequence puts on a contact were
 * already on the record every email reads, so choosing by one adds no read.
 * Checked: the audience keeps only the people chosen above who carry the
 * label, capital letters and spaces at the ends aside, and still only people
 * who may be written to; an email keeps its label, cleaned as a contact's
 * labels are, and an older email without one reads as before; a draft and a
 * copy of a sent email keep it, and a malformed one is refused, never read as
 * no label (which would be a broader group); "keep sending" turns the label
 * into the sequence's own "has the label" condition, and refuses an email
 * narrowed two ways; the composer sends it to the count, the draft and the
 * send, and shows it in the audience summary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { audience, changeLabels, leadsKey, upsertContact } from "@/lib/contacts";
import { readDraftAudience, sameDraftAudience } from "@/lib/mail-draft-audience";
import { confirmedMailCopy } from "@/lib/mail-response";
import { planKeep } from "@/lib/mail-reuse";
import type { Broadcast } from "@/lib/broadcasts";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const LIST = "list_labels";

test("the audience: only the people chosen above who carry the label", async () => {
  redis.run(["DEL", leadsKey(LIST)]);
  for (const email of ["vip@example.com", "also-vip@example.com", "plain@example.com", "bought@example.com"]) {
    await upsertContact(LIST, email, { agreed: true, explicit: true, source: "free", ...(email === "bought@example.com" ? { productId: "prod_course", title: "Course" } : {}) }, ROOM);
  }
  await changeLabels(LIST, ["vip@example.com", "bought@example.com"], (tags) => [...tags, "VIP"], ROOM);
  await changeLabels(LIST, ["also-vip@example.com"], (tags) => [...tags, " vip "], ROOM);
  assert.deepEqual((await audience(LIST)).sort(), ["also-vip@example.com", "bought@example.com", "plain@example.com", "vip@example.com"], "no label is everyone, as before");
  assert.deepEqual((await audience(LIST, undefined, undefined, undefined, undefined, "vip")).sort(), ["also-vip@example.com", "bought@example.com", "vip@example.com"], "capital letters and spaces at the ends do not matter");
  assert.deepEqual(await audience(LIST, "prod_course", undefined, undefined, undefined, "vip"), ["bought@example.com"], "and with the other choices together");
  assert.deepEqual(await audience(LIST, undefined, undefined, undefined, undefined, "nobody has this"), [], "a label nobody carries is nobody");
});

test("a draft keeps its label; a malformed one is refused, never read as none", () => {
  const base = { who: "all", notProductId: null, narrow: null };
  assert.deepEqual(readDraftAudience({ ...base, label: "VIP" }), { ...base, label: "VIP" });
  assert.deepEqual(readDraftAudience(base), base, "a draft saved before labels reads as before");
  assert.deepEqual(readDraftAudience({ ...base, label: null }), base);
  assert.equal(readDraftAudience({ ...base, label: 7 }), null);
  assert.equal(readDraftAudience({ ...base, label: "  padded " }), null, "only a label as an email keeps one");
  assert.equal(readDraftAudience({ ...base, label: "x".repeat(41) }), null);
  assert.equal(sameDraftAudience({ ...base, label: "VIP" }, base), false, "a different label cannot confirm a save");
});

test("a copy of a sent email keeps its label", () => {
  const copy = { subject: "S", body: "B", productId: null, who: "all", notProductId: null, narrow: null };
  assert.deepEqual(confirmedMailCopy({ ok: true, copy: { ...copy, label: "VIP" } }), { ...copy, label: "VIP" });
  assert.deepEqual(confirmedMailCopy({ ok: true, copy }), copy);
  assert.equal(confirmedMailCopy({ ok: true, copy: { ...copy, label: ["VIP"] } }), null);
});

function sent(over: Partial<Broadcast> = {}): Broadcast {
  return { id: "a".repeat(24), listId: LIST, handle: "harbor", subject: "News", body: "Hello.", productId: null, notProductId: null, who: "all", narrow: null, status: "sent", createdAt: 1, sendAt: 1, finishedAt: 2, total: 3, sent: 3, note: "", failures: 0, listed: true, tagged: false, test: null, ...over };
}

test("keep sending: the label becomes the sequence's own condition", () => {
  const plan = planKeep(sent({ label: "VIP" }), LIST, [], null);
  assert.ok(plan.ok);
  const steps = plan.raw.steps as { when?: unknown; otherwise?: unknown }[];
  assert.deepEqual(steps.at(-1)?.when, { if: "tag", tag: "VIP" });
  assert.equal(steps.at(-1)?.otherwise, "skip");
  const two = planKeep(sent({ label: "VIP", notProductId: "prod_course" }), LIST, [], null);
  assert.equal(two.ok ? "kept" : two.reason, "excludes", "narrowed two ways at once is refused, as before");
});

test("the composer sends the label everywhere the audience goes, and shows it", () => {
  const studio = readFileSync("components/email-studio.tsx", "utf8").replace(/\s+/g, " ");
  assert.ok(studio.includes("const cleanLabel = readTags([label])[0] ?? \"\";"), "cleaned once, as the server keeps it");
  assert.ok(studio.includes('call({ action: "count", productId, notProductId, who, narrow: { minSpent, channel, quietDays }, label: countedLabel,'), "the count, once the typing stops");
  assert.ok(studio.includes("setTimeout(() => setCountedLabel(cleanLabel), 400)"), "and not at every key");
  assert.ok(studio.includes("...(cleanLabel ? { label: cleanLabel } : {}) };"), "the draft");
  assert.ok(studio.includes("label: cleanLabel, sendAt,"), "the send");
  assert.ok(studio.includes('void group({ action: "segment-save", name: groupName, who, productId, notProductId, narrow, label: cleanLabel }'), "a saved group");
  assert.ok(studio.includes("setLabel(segment.label ?? \"\");"), "and a group applied");
  assert.ok(studio.includes("if (b.label) return `${start} and has the label"), "keep sending says it");
  assert.ok(studio.includes('aria-describedby="mail-label-hint"'), "the hint describes the field");
  assert.ok(studio.includes("Only people with the label \u201c${audience.label}\u201d."), "the summary");
  assert.ok(studio.includes('<span className="field-label">Only people with the label (optional)</span>'));
  const route = readFileSync("app/api/store/mail/route.ts", "utf8").replace(/\s+/g, " ");
  assert.ok(route.includes("label: text(body.label, 80),"), "the send reads it");
  assert.ok(route.includes("const label = readTags([text(body.label, 80)])[0] || undefined;"), "the count reads it");
});
