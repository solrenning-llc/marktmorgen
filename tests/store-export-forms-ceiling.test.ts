/**
 * Claude 6's LEVE on #3397 (confirmed by Claude 2, 6759501365; still in main on 23/11): the store export's measuring
 * read the forms with readForms and no ceiling fallback. Since #2857 made readForms exact, one form record that does
 * not read made the measuring throw, so the route answered "could not be measured" (503) on every try and a store
 * with such a record could never download its whole file.
 *
 * Now the forms are priced at the most a store keeps (MAX_FORMS), as the course outlines and the posts' list already
 * are, and the file is made: the forms part says it could not be read, reading no answers, and the file's end never
 * says "Nothing else is in this file".
 *
 * Synthetic: the Redis stub only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyCatalog } from "@/lib/catalog";
import { MAX_FORMS, parseForm } from "@/lib/forms";
import { writeForm } from "@/lib/form-store";
import { EXPORT_COMMANDS, exportShape, storeExport } from "@/lib/store-export";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const statsId = "f".repeat(32);
const shop = {
  sid: "export-forms-ceiling",
  statsId,
  handle: "export-forms-ceiling",
  catalog: emptyCatalog("c".repeat(32)),
} as unknown as Store;

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

test("a form record that does not read is priced at MAX_FORMS, never a refusal of the whole file", async () => {
  console.error = () => {};
  redis.clear();
  const empty = await exportShape(shop);
  redis.run(["HSET", `nl:forms:${statsId}`, "brokenfm01", "{not a form"]);
  const shape = await exportShape(shop).then(
    (measured) => measured,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  assert.equal(typeof shape, "object", `the measuring refused the file: ${String(shape)}`);
  if (typeof shape !== "object") return;
  assert.equal(shape.commands, empty.commands + EXPORT_COMMANDS.form * MAX_FORMS, "priced at the most forms a store keeps");
  assert.equal(shape.bytes, empty.bytes);
});

test("the file is made, the forms are said not read, and no answer is read for them", async () => {
  console.error = () => {};
  redis.clear();
  redis.run(["HSET", `nl:forms:${statsId}`, "brokenfm01", "{not a form"]);
  const pipeline = redis.pipeline.bind(redis);
  let answerReads = 0;
  redis.pipeline = async (commands) => {
    // The answers' key is nl:form:r:<statsId>:<form id> (lib/form-store.ts); Claude 6's LEVE on #5479: the earlier
    // prefixes matched nothing, so this check could not fail.
    if (commands.some((c) => String(c[1] ?? "").startsWith(`nl:form:r:${statsId}:`))) answerReads += 1;
    return pipeline(commands);
  };
  try {
    const body = await text(storeExport(shop));
    const file = JSON.parse(body) as Record<string, unknown>;
    assert.equal("forms" in file, false, "never an empty forms list as if there were none");
    assert.equal(Object.keys(file).some((key) => /^unreadPart\d+$/.test(key)), true, "the part is said not read");
    assert.equal(String(file.notIncluded).startsWith("Not everything above is whole"), true, "the end never says nothing else is in it");
    assert.equal(answerReads, 0);
  } finally {
    redis.pipeline = pipeline;
  }
});

test("control: a readable form is counted as it is, never at the ceiling", async () => {
  redis.clear();
  const empty = await exportShape(shop);
  // One real form (Claude 6's LEVE on #5479: the control compared an empty store with itself).
  const form = parseForm({ id: "readable01", name: "Readable", fields: [{ id: "q1mail", type: "email", label: "Email", required: true }] });
  if (!form) throw new Error("no form (set-up)");
  assert.equal(await writeForm(statsId, form), true, "(set-up) the form is written");
  assert.equal((await exportShape(shop)).commands, empty.commands + EXPORT_COMMANDS.form);
});
