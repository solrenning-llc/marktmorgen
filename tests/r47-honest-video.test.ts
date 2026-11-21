/**
 * The public pages promise lesson-video captions (an uploaded .vtt/.srt file
 * per language, and AI captions as a paid add-on) and video made into several
 * sizes only while a new lesson video can be kept by the video service.
 *
 * Captions and sizes exist only for a video the video service keeps
 * (lib/store-caption.ts, lib/auto-captions.ts). The only door to such a video
 * is app/api/store/stream/route.ts, which asks reserveStoreUpload(store,
 * bytes, "stream"); when that door is closed the studio keeps a plain file,
 * which plays in the browser's own player at its own size and has no
 * captions. AGENTS.md, VR Part A item 2: what does not work today does not
 * appear. Synthetic only: the runner's in-memory Redis, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FEATURE_PAGES } from "@/lib/feature-pages";
import { PRICING_ADDONS } from "@/lib/pricing-page-data";
import { reserveStoreUpload, type UploadStore } from "@/lib/upload-budget";
import * as budgetPolicy from "@/lib/upload-budget-policy";
import * as redis from "@/lib/redis";
import { uploadTestPolicy } from "./upload-budget-approved-policy";

const STREAM_ONLY = [
  "Captions in up to 12 languages",
  "Captions written by AI",
  "Video that does not stop to load",
  "five sizes",
  "pick a size",
  "connection can carry",
  "first size is made",
  "Captions written by AI are machine transcription",
];

const store: UploadStore = { statsId: "a".repeat(32), tier: "creator", subscriptionActive: true, subscriptionId: null, trialEnds: 0 } as UploadStore;

/** The in-memory Redis the test runner puts behind "@/lib/redis" (tests/redis-stub.ts). */
const memory = (redis as unknown as { store?: { pipeline: (commands: (string | number)[][]) => Promise<unknown[]> } }).store;

/** What the upload door answers today, read through the real reserveStoreUpload with a Redis that grants every reservation it is asked for. */
async function doors(): Promise<{ r2: boolean; stream: boolean; streamCalls: number }> {
  assert.ok(memory, "the test runner's in-memory Redis is in place");
  const saved = memory.pipeline;
  let calls = 0;
  memory.pipeline = async (commands) => {
    calls += 1;
    return commands.map(() => 1);
  };
  try {
    const policy = uploadTestPolicy();
    const r2 = await reserveStoreUpload(store, 1, "r2", policy);
    const before = calls;
    const stream = (await Promise.all([1, 1_000_000, 100_000_000].map((bytes) => reserveStoreUpload(store, bytes, "stream", policy)))).some(Boolean);
    return { r2, stream, streamCalls: calls - before };
  } finally {
    memory.pipeline = saved;
  }
}

test("the in-memory Redis can open the file door, so a closed video door is the code's own answer", async () => {
  const door = await doors();
  assert.equal(door.r2, true);
  if (!door.stream) assert.equal(door.streamCalls, 0);
});

test("one exported predicate says which upload doors are open, and it matches what reserveStoreUpload answers", async () => {
  const door = await doors();
  const open = (budgetPolicy as unknown as Record<string, unknown>).uploadBackendOpen;
  assert.equal(typeof open, "function");
  const ask = open as (backend: "r2" | "blob" | "stream") => boolean;
  assert.equal(ask("r2"), door.r2);
  assert.equal(ask("stream"), door.stream);
  assert.equal(ask("blob"), false);
});

test("the courses page promises captions and sizes only while a lesson video can be kept by the video service", async () => {
  const door = await doors();
  const courses = FEATURE_PAGES.find((page) => page.slug === "courses");
  assert.ok(courses, "the courses page exists");
  const words = JSON.stringify(courses);
  for (const phrase of STREAM_ONLY) assert.equal(words.includes(phrase), door.stream, phrase);
  // What works for a plain file stays: the player, upright video, the signed address and free previews.
  for (const phrase of ["A player students control", "playback speed", "Video that stays upright", "A video address that expires", "Free preview lessons"]) assert.ok(words.includes(phrase), phrase);
  // The courses page still answers how long a new video takes, in either state.
  assert.ok(words.includes("How long until a video I upload can be watched?"));
});

test("the pricing page sells the AI captions add-on only while a lesson video can take captions", async () => {
  const door = await doors();
  assert.equal(PRICING_ADDONS.some((addon) => addon.key === "captions"), door.stream);
  assert.equal(JSON.stringify(PRICING_ADDONS).includes("AI captions for a lesson video"), door.stream);
  assert.ok(PRICING_ADDONS.some((addon) => addon.key === "assistant"), "the Store assistant add-on stays listed");
});
