/**
 * 488 [IT5] unit 2: the anonymous store preview's writing job (docs/it5-store-preview.md). A visitor's few sentences
 * become the same draft the studio writes (storeSetupRequest and parseStoreSetup in lib/ai.ts), with no account and
 * no store's month to count it against, so it pays from a pool of its own.
 *
 * Off: previewDraft answers "off" while STORE_PREVIEW_ON is false, and no route, page or job calls it yet. The
 * switch-free core, runPreviewJob, is exported for its tests only; tests/store-preview.test.ts fails if anything but
 * this file calls it.
 *
 * Money, exactly as the Store assistant's pool (ASSISTANT_POOL in lib/store-assistant.ts, the same script on a key of
 * the preview's own): the request's worst (aiRequestHoldMicroUsd), never more than one priced writing job, is reserved
 * from the month's pool before the model is asked; settled at the billed tokens (previewSettledMicroUsd); released
 * only when the provider answered with an error status, which it does not bill; kept whole when it may have billed.
 * The pool's cap comes from the caller (previewPoolCapMicroUsd in lib/store-preview-rules.ts, from the places the
 * owner chooses); an unknown cap asks nothing. Every job is counted per preview before anything is spent, never more
 * than PREVIEW_JOBS. The address's and the site's day counts belong to the route (unit 3).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { modelKeySet, parseStoreSetup, postToModel, type StoreSetup, storeSetupRequest, storeSetupWords, writingModel } from "@/lib/ai";
import { boundedAiRequest } from "@/lib/ai-request-rules";
import { AI_CALL_WAIT_SECONDS, WRITING_JOB_MICRO_USD, aiRequestHoldMicroUsd } from "@/lib/spend-cost-table";
import { ASSISTANT_POOL } from "@/lib/store-assistant";
import { LANGUAGES } from "@/lib/store-language";
import { windowCount, windowCountOf } from "@/lib/window-count";
import { PREVIEW_JOBS, PREVIEW_OUTPUT_TOKENS, STORE_PREVIEW_ON, previewSettledMicroUsd } from "@/lib/store-preview-rules";

/** A preview's id: random, made by the route when the visitor starts one. */
export const PREVIEW_ID = /^[A-Za-z0-9_-]{32}$/;
/** The calendar month (UTC) whose pool pays, as YYYY-MM. */
export const PREVIEW_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const POOL_KEEP_SECONDS = 40 * 86_400;
const JOBS_KEEP_SECONDS = 86_400;
const poolKey = (month: string) => `nl:storepv:pool:${month}`;
const jobsKey = (previewId: string) => `nl:storepv:jobs:${previewId}`;

export type PreviewJob = {
  previewId: string;
  month: string;
  /** The month pool's cap in micro-dollars (previewPoolCapMicroUsd), null while it is not known. */
  poolCapMicroUsd: number | null;
  storeName: string;
  /** The store's currency, three lowercase letters, and its language's code (lib/store-language.ts). */
  currency: string;
  language: string;
  about: unknown;
  selling: unknown;
  answers?: unknown;
};

export type PreviewJobResult = { ok: true; draft: StoreSetup } | { ok: false; reason: "off" | "notes" | "used" | "spent" | "failed" };

/** One writing job of a store preview, only while STORE_PREVIEW_ON is true. */
export async function previewDraft(job: PreviewJob): Promise<PreviewJobResult> {
  if (!STORE_PREVIEW_ON) return { ok: false, reason: "off" };
  return runPreviewJob(job);
}

/** The month pool's one operation, with ASSISTANT_POOL's own answers: 1 done, 0 over the cap, -1 anything else. */
async function previewPool(op: "reserve" | "settle" | "release", month: string, hold: number, value = 0): Promise<number> {
  const args: (string | number)[] = op === "reserve" ? [op, hold, value, POOL_KEEP_SECONDS] : op === "settle" ? [op, hold, value] : [op, hold];
  try {
    const [result] = await redisPipeline([["EVAL", ASSISTANT_POOL, 1, poolKey(month), ...args]]);
    return typeof result === "number" ? result : Number(result);
  } catch (error) {
    console.error("the store preview's pool could not be reached", error);
    return -1;
  }
}

/** The job itself, with no switch: for previewDraft and its tests only. */
export async function runPreviewJob(job: PreviewJob): Promise<PreviewJobResult> {
  if (!modelKeySet() || !isRedisConfigured()) return { ok: false, reason: "off" };
  const language = Object.hasOwn(LANGUAGES, job.language) ? LANGUAGES[job.language as keyof typeof LANGUAGES]?.english : undefined;
  if (!PREVIEW_ID.test(job.previewId) || !PREVIEW_MONTH.test(job.month) || !/^[a-z]{3}$/.test(job.currency) || !language) return { ok: false, reason: "failed" };
  const words = storeSetupWords(job);
  if (!words.about) return { ok: false, reason: "notes" };
  const cap = job.poolCapMicroUsd;
  if (cap === null || !Number.isSafeInteger(cap) || cap <= 0) return { ok: false, reason: "spent" };

  const named = writingModel();
  const request = storeSetupRequest({ name: job.storeName, currency: job.currency, language }, { ...words, page: null });
  const bounded = boundedAiRequest(request.system, request.prompt, PREVIEW_OUTPUT_TOKENS, named);
  if (!bounded.ok) return { ok: false, reason: "failed" };
  // The request's own worst, never more than the writing job the preview's worst was priced at.
  const hold = aiRequestHoldMicroUsd(named, bounded.shape);
  if (hold === null || hold <= 0 || hold > WRITING_JOB_MICRO_USD) return { ok: false, reason: "failed" };

  // Counted before anything is spent, and kept counted: a started job may have billed.
  const jobs = windowCountOf(await redisPipeline(windowCount(jobsKey(job.previewId), JOBS_KEEP_SECONDS)).catch(() => null));
  if (jobs === null) return { ok: false, reason: "failed" };
  if (jobs > PREVIEW_JOBS) return { ok: false, reason: "used" };

  const reserved = await previewPool("reserve", job.month, hold, cap);
  if (reserved === 0) return { ok: false, reason: "spent" };
  if (reserved !== 1) return { ok: false, reason: "failed" };

  const answered = await postToModel(bounded.body, AI_CALL_WAIT_SECONDS * 1_000);
  if (!answered.ok) {
    // Refused with an error status: nothing was billed, so it all goes back. Otherwise it may have been: kept.
    if (answered.billed) await previewPool("settle", job.month, hold, hold);
    else await previewPool("release", job.month, hold);
    return { ok: false, reason: "failed" };
  }
  await previewPool("settle", job.month, hold, previewSettledMicroUsd(named, answered.data.usage, hold, PREVIEW_OUTPUT_TOKENS));

  const content = Array.isArray(answered.data.content) ? (answered.data.content as { type?: unknown; text?: unknown }[]) : [];
  const said = content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("").trim();
  const draft = said ? parseStoreSetup(said, `${words.about}\n${words.selling}\n`, job.currency, false) : null;
  return draft ? { ok: true, draft } : { ok: false, reason: "failed" };
}
