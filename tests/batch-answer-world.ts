/**
 * lib/email.ts as it is, but with the batch answer set by the test: every caller that imports "@/lib/email" (aliased
 * here in tests/aliases/<test>.json) gets the real module, except sendBatchOutcome, which answers from `batchAnswers`
 * and sends nothing. Used by the batch-count regressions of #4073 (tests/*-batch-count-kept.test.ts), which drive the
 * real callers and read the real counters and marks (lib/batch-count.ts). Synthetic data only.
 */
import type { BatchMessage } from "../lib/email";

export * from "../lib/email";

export type BatchAnswer = "sent" | "retry" | "uncertain" | "unconfirmed" | "refused";

/** The answers to give, in order (`queue`), then `fallback`; and every batch handed over, with its key. */
export const batchAnswers = {
  queue: [] as BatchAnswer[],
  fallback: "sent" as BatchAnswer,
  handed: [] as { key: string; to: string[] }[],
};

export function answerBatches(...answers: BatchAnswer[]): void {
  batchAnswers.queue = [...answers];
  batchAnswers.handed.length = 0;
}

export async function sendBatchOutcome(messages: BatchMessage[], batchKey: string): Promise<BatchAnswer> {
  batchAnswers.handed.push({ key: batchKey, to: messages.map((m) => m.to) });
  return batchAnswers.queue.shift() ?? batchAnswers.fallback;
}
