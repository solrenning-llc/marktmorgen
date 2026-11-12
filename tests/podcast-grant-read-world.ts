import assert from "node:assert/strict";

export let reply: unknown[] = [];
export const calls: unknown[][] = [];

export function reset(next: unknown[]) {
  reply = next;
  calls.length = 0;
}

export const isRedisConfigured = () => true;

export async function redisPipeline(commands: unknown[][]) {
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], "GET");
  assert.match(String(commands[0][1]), /^nl:pod:t:[0-9a-f]{64}$/);
  calls.push(commands[0]);
  return reply;
}

const unexpected = () => {
  throw new Error("Unexpected provider or write boundary");
};

export const orderWrite = unexpected;
export const withinStore = unexpected;
export const withinLimit = unexpected;
export const withinEssentialLimit = unexpected;
export const essentialLimitState = unexpected;
export const holdsProducts = unexpected;
export const sendEmail = unexpected;
export const coursesWords = unexpected;
export const EMAIL_PATTERN = /^[^@]+@[^@]+$/;
export const MAX_EMAIL_LENGTH = 254;
export const normaliseEmail = (value: string) => value.trim().toLowerCase();
