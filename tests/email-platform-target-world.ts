/** Synthetic transport only: no DNS, socket, provider account or real key. */
import type { SafeFetchOptions, SafeResponse } from "../lib/safe-fetch";
export { SafeFetchError } from "../lib/safe-fetch";

export const requests: { url: string; options: SafeFetchOptions }[] = [];
let replies: { body: string; status: number }[] = [];

export function answerWith(...answers: { body: string; status?: number }[]): void {
  requests.length = 0;
  replies = answers.map(({ body, status = 200 }) => ({ body, status }));
}

export async function safeFetch(url: string, options: SafeFetchOptions): Promise<SafeResponse> {
  requests.push({ url, options });
  const answer = replies.shift();
  if (!answer) throw new Error("Unexpected synthetic platform request");
  return { status: answer.status, headers: {}, body: Buffer.from(answer.body), url };
}
