/**
 * Rule 24 in course certificates (lib/certificate.ts):
 *
 *   - issueCertificate: the student's slot (HSETNX) answered in another shape is read back: a slot that names this
 *     press's own certificate is this press's, never "taken by another" (which deleted the record just written and
 *     handed the student a certificate whose record was gone);
 *   - withdrawCertificate: the withdrawal (SET … XX) is done only on "OK"; another shape is not done, so the studio is
 *     never told a certificate was withdrawn while it still stands.
 *
 * Synthetic course and students only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { issueCertificate, readCertificate, withdrawCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const lesson = (id: string) => ({ id, title: id, preview: false, video: null, files: [], link: null, hasBody: false, quiz: null }) as unknown as Course["modules"][number]["lessons"][number];
const course: Course = { id: "d".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [lesson("lesson000001")] }] } as unknown as Course;
const input = (who: string) => ({ store: "storekey02", productId: "prod02", course, title: "Bookkeeping", creator: "Night School", email: `${who}@example.com`, who, name: "Ana Lopes", room: ROOM });
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

for (const [label, reply] of [["no reply", []], ["a number other than 1", [7]], ["an object", [{}]]] as [string, unknown[]][]) {
  test(`issueCertificate: the slot answered ${label}, landed: the student gets a certificate whose record stands`, async () => {
    redis.clear();
    redis.pipeline = (async (b: Batch) => {
      const real = await pipeline(b);
      return b.length === 1 && b[0][0] === "HSETNX" ? reply : real;
    }) as typeof redis.pipeline;
    let issued: Awaited<ReturnType<typeof issueCertificate>> | "threw";
    try {
      issued = await issueCertificate(input(`ana${label.length}`));
    } catch {
      issued = "threw";
    } finally {
      redis.pipeline = pipeline;
    }
    if (issued !== "threw" && issued.ok) assert.ok(await readCertificate(issued.certificate.id), "the certificate handed over has its record");
  });
}

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["an object", [{}]]] as [string, unknown[]][]) {
  test(`withdrawCertificate: the withdrawal answered ${label} is not done`, async () => {
    redis.clear();
    const issued = await issueCertificate(input("ben"));
    assert.ok(issued.ok);
    const id = issued.ok ? issued.certificate.id : "";
    redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "SET" && b[0].includes("XX") ? reply : pipeline(b))) as typeof redis.pipeline;
    let done: boolean | "threw";
    try {
      done = await withdrawCertificate(course.id, id);
    } catch {
      done = "threw";
    } finally {
      redis.pipeline = pipeline;
    }
    assert.notEqual(done, true, "never told it was withdrawn");
    assert.equal((await readCertificate(id))?.withdrawnAt ?? 0, 0, "(it still stands)");
  });
}
