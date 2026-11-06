/** Causal public-copy review: real HTTP admission and real course grants. */
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/import/route";
import { claimHandle, ensureListId, ensureStatsId, storeForEmail, addProduct, setProductCourse, addOption } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { importAllowanceFor } from "@/lib/import-limits";
import { addRows, finishUpload, runImport, startImport } from "@/lib/imports";
import { importedFor } from "@/lib/imported-purchases";
import { paidCourses } from "@/lib/learn";
import { emptyCourse, newItemId, saveCourse } from "@/lib/course";
import { MIGRATION_GUIDES } from "@/lib/migration-guides";
import { store as redis } from "./redis-stub";

const owner = "migration-proof@example.test";
async function seed() {
  redis.clear();
  await claimHandle(owner, "migrationproof", "Synthetic migration proof", "");
  await ensureStatsId(owner); await ensureListId(owner);
  const store = await storeForEmail(owner); assert.ok(store);
  assert.equal(store.subscriptionActive, false);
  return store;
}
async function main(): Promise<void> {
  const results: { name: string; ok: boolean; actual: unknown }[] = [];
  let store = await seed();
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  async function post(body: Record<string, unknown>) {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/import", { method: "POST", headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie }, body: JSON.stringify(body) }));
    const data = await response.json(); return { status: response.status, data };
  }
  const limit = importAllowanceFor(store).rows;
  const start = await post({ action: "start", kind: "contacts", expected: 50_000, file: "synthetic.csv", agreed: true });
  assert.equal(start.status, 200, `HTTP start control must be admitted: ${JSON.stringify(start)}`);
  assert.ok(start.data.import?.id);
  const rows = Array.from({ length: limit }, (_, i) => [String(i + 2), `person${i}@example.test`, "Synthetic", "", ""]);
  const within = await post({ action: "rows", id: start.data.import.id, rows });
  assert.equal(within.status, 200, `Known within-quota HTTP control must pass: ${JSON.stringify(within)}`);
  const over = await post({ action: "rows", id: start.data.import.id, rows: [[String(limit + 2), "next@example.test", "Synthetic", "", ""]] });
  const listClaim = MIGRATION_GUIDES[0].moves.find((m) => m.capability === "list")!;
  results.push({ name: "the advertised 50,000-row file can upload on the planless route", ok: over.status === 200, actual: { claim: listClaim.title, noPlanMonthRows: limit, startStatus: start.status, withinStatus: within.status, overStatus: over.status, overError: over.data.error, overLimit: over.data.limit } });

  store = await seed();
  const product = await addProduct(owner, "Synthetic course", "", "20", null); assert.ok(product.ok);
  const course = emptyCourse();
  course.modules[0].lessons.push({ id: newItemId(), title: "Synthetic lesson", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null });
  await saveCourse(course, store);
  assert.equal((await setProductCourse(owner, product.product.id, { id: course.id, lessons: 1 })).ok, true);
  assert.equal((await addOption(owner, product.product.id, "Standard", "20")).ok, true);
  assert.equal((await addOption(owner, product.product.id, "Extra", "30")).ok, true);
  store = (await storeForEmail(owner))!;
  const started = await startImport(store, owner, "purchases", { expected: 1, file: "course.csv", email: false }); assert.ok(started.ok);
  const received = await addRows(store, started.job.id, [["2", "student@example.test", "Synthetic course", "paid"]]); assert.ok(received.ok);
  assert.ok((await finishUpload(store, started.job.id)).ok);
  let finished = await runImport(started.job.id, Date.now() + 10_000);
  for (let i = 0; i < 5 && finished?.state !== "done"; i += 1) finished = await runImport(started.job.id, Date.now() + 10_000);
  const current = await storeForEmail(owner);
  assert.ok(current?.pastBuyers, "Use the persisted post-import store, including its enabled purchase index");
  const grants = await importedFor(current, "student@example.test");
  const entitled = (await paidCourses(current, "student@example.test")).has(product.product.id);
  const priceClaim = MIGRATION_GUIDES[1].notMoved.find((line) => line.includes("several prices"));
  assert.equal(finished?.state, "done", "The real import must complete before interpreting the copy");
  assert.equal(entitled, true, "The actual course entitlement reader must recognize the imported buyer");
  results.push({ name: "the categorical multi-price restriction matches real course import", ok: !grants.some((grant) => grant.productId === product.product.id), actual: { claim: priceClaim, state: finished?.state, added: finished?.counts.added, grantedCourse: grants.some((grant) => grant.productId === product.product.id), courseEntitlement: entitled, optionCount: store.catalog.items.find((item) => item.id === product.product.id)?.options.length } });

  console.log(JSON.stringify({ cases: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }, null, 2));
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
