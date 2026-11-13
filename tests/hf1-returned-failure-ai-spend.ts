/**
 * Stand-in for lib/ai-spend in tests/hf1-returned-failure-words.test.ts: every dollar reservation is refused, as
 * the automatic ceiling does once a month's AI money is spent (MR). Everything else is the real module.
 */
export * from "../lib/ai-spend";
export async function reserveAiSpend(): Promise<boolean> {
  return false;
}
