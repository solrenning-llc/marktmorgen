export * from "./preview-counter-admission-world";

import {
  redisPipeline as baseRedisPipeline,
  reset as baseReset,
  state,
} from "./preview-counter-admission-world";

export const reviewState = {
  configured: true,
  afterCommit: "reply" as "reply" | "empty" | "throw",
};

export function resetReview() {
  baseReset();
  reviewState.configured = true;
  reviewState.afterCommit = "reply";
}

export const isRedisConfigured = () => reviewState.configured;

export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  const reply = await baseRedisPipeline(commands);
  if (reviewState.afterCommit === "empty") return [];
  if (reviewState.afterCommit === "throw") throw new Error("Synthetic lost preview counter reply");
  return reply;
}

export function replyWith(value: unknown) {
  state.override = true;
  state.reply = value;
}
