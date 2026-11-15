/**
 * A stamped copy carries its buyer's address on every page, so deleting the person deletes it (Claude 7 on main
 * 4865799f53, MÉDIO, privacy): each copy's record is noted under the address (lib/erasure-index.ts), the deletion
 * finds the file through it and deletes both (forgetStampedPerson, run before forgetNoted in lib/person-erasure.ts),
 * and a download after the deletion never makes or keeps a new copy with the address (stampedCopy reads the store's
 * deletion mark before and after the copy is made; whether the buyer keeps the download is not decided here).
 * Synthetic files and the Redis stub; the file store is a small S3 of the test's own.
 */
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import * as stamp from "@/lib/pdf-stamp";
import { stampedCopy } from "@/lib/pdf-stamp";
import { ERASERS } from "@/lib/person-erasure";
import { forgetNoted } from "@/lib/erasure-index";
import { suppressCommand } from "@/lib/suppression";
import { redisPipeline } from "@/lib/redis";
import type { ProductFile } from "@/lib/product-file";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "sold-files";
const ORIGIN = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const FOLDER = "0123456789abcdef0123456789abcdef";

const objects = new Map<string, { bytes: Uint8Array; type: string }>();
let puts = 0;
let reads = 0;
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const xml = (body: string, status = 200) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { "content-type": "application/xml" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.origin !== ORIGIN || !url.pathname.startsWith(`/${BUCKET}`)) return new Response(null, { status: 404 });
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const key = url.pathname.slice(BUCKET.length + 2);
  if (!key) {
    const prefix = url.searchParams.get("prefix") ?? "";
    const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    return xml(`<ListBucketResult><IsTruncated>false</IsTruncated>${all.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.bytes.byteLength}</Size></Contents>`).join("")}</ListBucketResult>`);
  }
  if (method === "PUT") {
    puts += 1;
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array(init?.body as ArrayBuffer);
    objects.set(key, { bytes: new Uint8Array(body), type: headers["content-type"] ?? headers["Content-Type"] ?? "" });
    return new Response(null, { status: 200, headers: { ETag: `"${md5(body)}"` } });
  }
  if (method === "DELETE") {
    objects.delete(key);
    return new Response(null, { status: 204 });
  }
  const found = objects.get(key);
  if (!found) return method === "HEAD" ? new Response(null, { status: 404 }) : xml("<Error><Code>NoSuchKey</Code></Error>", 404);
  const about = { "content-length": String(found.bytes.byteLength), "content-type": found.type };
  if (method === "HEAD") return new Response(null, { status: 200, headers: about });
  if (method === "POST" && url.searchParams.has("delete")) {
    const keys = [...new TextDecoder().decode(init?.body as Uint8Array).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    for (const k of keys) objects.delete(k);
    return xml(`<DeleteResult>${keys.map((k) => `<Deleted><Key>${k}</Key></Deleted>`).join("")}</DeleteResult>`);
  }
  reads += 1;
  return new Response(found.bytes as BodyInit, { status: 200, headers: about });
}) as typeof fetch;

for (const [name, value] of [
  ["R2_ACCOUNT_ID", ACCOUNT],
  ["R2_ACCESS_KEY_ID", "a-stand-in-access-key-id"],
  ["R2_SECRET_ACCESS_KEY", "a-stand-in-secret-access-key-for-tests-only"],
  ["R2_BUCKET", BUCKET],
]) process.env[name] = value;


async function pdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  return doc.save();
}

async function main(): Promise<void> {
  redis.clear();
  const bytes = await pdf();
  const pathname = `vault/${FOLDER}/0000000001/Guide.pdf`;
  objects.set(pathname, { bytes, type: "application/pdf" });
  const file: ProductFile = { pathname, name: "Guide.pdf", bytes: bytes.byteLength, contentType: "application/pdf", addedAt: "2026-11-15T12:00:00.000Z" };
  const store = { sid: "stamped-erasure", statsId: "stats0000stamped", listId: "list0000stamped", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "", language: "en" as const };
  const ana = { reference: "cs_test_a1B2c3D4e5F6", email: "ana@example.com", paidAt: 1_763_200_000 };
  const sam = { reference: "cs_test_z9Y8x7W6v5U4", email: "sam@example.com", paidAt: 1_763_200_000 };

  part("Deleting the person deletes their stamped copy and its record");
  const counted: string[] = [];
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) counted.push(String(c[0]));
    return original(commands);
  }) as typeof redis.pipeline;
  const copy = await stampedCopy(file, ana, store);
  redis.pipeline = original;
  const samCopy = await stampedCopy(file, sam, store);
  is("(control) each buyer gets a copy of their own", [Boolean(copy), Boolean(samCopy), copy?.pathname !== samCopy?.pathname], [true, true, true]);
  is("Ana's copy is in the file store", objects.has(copy?.pathname ?? ""), true);
  const eraser = ERASERS.find((e) => e.module === "lib/pdf-stamp.ts");
  const order = ERASERS.map((e) => e.module);
  is("the deletion has a step for stamped copies, before the noted records go", Boolean(eraser) && order.indexOf("lib/pdf-stamp.ts") < order.indexOf("lib/erasure-index.ts"), true);
  const forget = (stamp as unknown as { forgetStampedPerson?: (statsId: string, email: string) => Promise<number> }).forgetStampedPerson;
  await redisPipeline([suppressCommand(store.listId, ana.email)]);
  is("it finds Ana's one copy", forget ? await forget(store.statsId, ana.email) : "no step", 1);
  await forgetNoted(store.statsId, ana.email);
  is("her copy's file is deleted", objects.has(copy?.pathname ?? ""), false);
  const keys = [...(redis as unknown as { data: Map<string, unknown> }).data?.keys?.() ?? []].filter((k) => String(k).startsWith("nl:stamp:copy:"));
  is("and only Sam's record is left", keys.length, 1);
  is("Sam's copy is untouched", objects.has(samCopy?.pathname ?? ""), true);

  part("A download after the deletion makes no new copy with her address");
  const before = objects.size;
  is("the original is handed over (null)", await stampedCopy(file, ana, store), null);
  is("and nothing is written to the file store", objects.size, before);

  part("What a new copy adds for the deletion is counted");
  const STAMP_ERASURE_COMMANDS = (stamp as unknown as { STAMP_ERASURE_COMMANDS?: number }).STAMP_ERASURE_COMMANDS;
  const added = counted.filter((c) => c === "HEXISTS" || c === "ZADD" || c === "ZREMRANGEBYSCORE" || c === "EXPIRE").length;
  is("the deletion mark twice and the note's three commands", [added, STAMP_ERASURE_COMMANDS], [5, 5]);

  part("A copy made while the person is deleted is not kept");
  const ben = { reference: "cs_test_b2C3d4E5f6G7", email: "ben@example.com", paidAt: 1_763_200_000 };
  let marked = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The deletion lands between the first check and the record's write.
    if (!marked && commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:stamp:copy:"))) {
      marked = true;
      await original([suppressCommand(store.listId, ben.email)]);
    }
    return original(commands);
  }) as typeof redis.pipeline;
  const size = objects.size;
  const raced = await stampedCopy(file, ben, store);
  redis.pipeline = original;
  is("the original is handed over", raced, null);
  is("the copy written meanwhile is deleted again", objects.size, size);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
