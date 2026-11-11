/**
 * A stand-in for botid/server in tests/visit-proof.test.ts (wired through
 * tests/aliases/visit-proof.test.ts.json): checkBotId answers whatever the
 * test sets, so the host's check can be a person, a program, a failure, a
 * reply in another shape or no answer at all. Nothing real is reached.
 */
export type Verdict = "human" | "bot" | "throw" | "odd" | "hang";

export const botid = { verdict: "human" as Verdict, asked: 0 };

export async function checkBotId(): Promise<unknown> {
  botid.asked += 1;
  switch (botid.verdict) {
    case "human":
      return { isBot: false, isHuman: true, isVerifiedBot: false, bypassed: false };
    case "bot":
      return { isBot: true, isHuman: false, isVerifiedBot: false, bypassed: false };
    case "throw":
      throw new Error("the host's check failed");
    case "odd":
      return { isBot: "no" };
    case "hang":
      return new Promise(() => {});
  }
}
