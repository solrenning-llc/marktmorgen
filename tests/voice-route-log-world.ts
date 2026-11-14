/** lib/customer-voice.ts as it is, except makeVoice, which fails with customers' words in its error (rule 30 proof). */
export * from "../lib/customer-voice";
export const LEAK = "Customer wrote: refund me at lee@example.org, +1 555 0100";
export async function makeVoice(): Promise<never> {
  throw new Error(LEAK);
}
