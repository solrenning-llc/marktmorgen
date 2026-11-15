/**
 * The stamping path's cost, measured (Claude 7, unit B after the stamped-copy erasure): what one new copy sends to
 * Redis at its worst (STAMP_COPY_COMMANDS, with DROP_QUEUE holding as many folders as one call retries), the most a
 * kept copy may weigh (STAMP_COPY_MAX_BYTES, held in code: a heavier one is not kept and the original is handed
 * over), and the line of tests/plan-cost-registry.ts that prices every copy a plan's orders can make in a month.
 * The copies' storage over the months is not in that line: an open gap until the owner chooses how copies are kept,
 * never zero, and the line's basis says so. Synthetic files and the Redis stub.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import * as stamp from "@/lib/pdf-stamp";
import { DROP_QUEUE, stampedCopy } from "@/lib/pdf-stamp";
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



async function main(): Promise<void> {
  redis.clear();
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i += 1) doc.addPage([300, 300]);
  const bytes = await doc.save();
  const pathname = `vault/${FOLDER}/0000000001/Guide.pdf`;
  objects.set(pathname, { bytes, type: "application/pdf" });
  const file: ProductFile = { pathname, name: "Guide.pdf", bytes: bytes.byteLength, contentType: "application/pdf", addedAt: "2026-11-15T12:00:00.000Z" };
  const store = { sid: "stamp-cost", statsId: "stats0000stampcost", listId: "list0000stampcost", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "", language: "en" as const };
  const STAMP_COPY_COMMANDS = (stamp as unknown as { STAMP_COPY_COMMANDS?: number }).STAMP_COPY_COMMANDS;
  const STAMP_COPY_MAX_BYTES = (stamp as unknown as { STAMP_COPY_MAX_BYTES?: number }).STAMP_COPY_MAX_BYTES;

  part("What one new copy sends to Redis, at its worst");
  // As many folders waiting as one call tries again, each a sale's folder the retry deletes and takes off the list.
  for (const n of [1, 2]) await redisPipeline([["SADD", DROP_QUEUE, `vault/${FOLDER}/stamped/${"a".repeat(24)}/${String(n).repeat(24)}/`]]);
  let sent = 0;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sent += commands.length;
    return original(commands);
  }) as typeof redis.pipeline;
  const copy = await stampedCopy(file, { reference: "cs_test_c0St1ng00001", email: "ana@example.com", paidAt: 1_763_200_000 }, store);
  redis.pipeline = original;
  is("(control) a copy is made", Boolean(copy), true);
  is(`STAMP_COPY_COMMANDS counts every command sent (${sent})`, STAMP_COPY_COMMANDS, sent);

  part("A kept copy's weight is held in code");
  is("STAMP_COPY_MAX_BYTES is twice the largest file stamped", STAMP_COPY_MAX_BYTES, 2 * 50 * 1024 * 1024);
  const source = readFileSync("lib/pdf-stamp.ts", "utf8");
  is("a heavier copy is not written: the original is handed over", /if \(stamped\.byteLength > STAMP_COPY_MAX_BYTES\)[^}]*return null;/s.test(source), true);

  part("Every copy a plan's orders can make in a month is priced");
  const { COST_LINES } = await import("./plan-cost-registry");
  const line = COST_LINES.find((l) => l.id === "stamped-copies");
  is("tests/plan-cost-registry.ts has the line", Boolean(line), true);
  is("its figure is above zero on every plan", (["creator", "pro", "scale"] as const).every((t) => (line?.monthlyUsd(t) ?? 0) > 0), true);
  is("and its basis says the copies' storage is an open gap, never zero", Boolean(line && /storage/.test(line.basis) && /open gap/.test(line.basis) && /never zero/.test(line.basis)), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
