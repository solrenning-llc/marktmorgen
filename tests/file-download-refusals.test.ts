/**
 * SG1-B-03 (queue item 506 [SG1]): the creator's file download
 * (app/api/store/file/download) answers every studio refusal with words and a
 * status of its own. Before the fix `used`, `locked` and `two_step` had no
 * entry, so reading one threw and the creator got a server error.
 *
 * The studio's check is a stand-in (tests/file-download-refusals-world.ts)
 * that refuses with each reason in turn; the route is the real one.
 */
import type { NextRequest } from "next/server";
import { GET } from "@/app/api/store/file/download/route";
import { type Refusal, refusal } from "./file-download-refusals-world";
import { done, is, part } from "./check";

const REASONS: [Refusal, number][] = [
  ["signed_out", 401],
  ["no_store", 404],
  ["forbidden", 403],
  ["gone", 403],
  ["used", 429],
  ["locked", 403],
  ["two_step", 403],
];

function request(): NextRequest {
  const url = new URL("https://marktmorgen.com/api/store/file/download?id=abc");
  return Object.assign(new Request(url), { nextUrl: url, cookies: { get: () => undefined } }) as unknown as NextRequest;
}

async function main() {
  part("Each refusal is answered, never thrown");
  for (const [reason, status] of REASONS) {
    refusal.reason = reason;
    refusal.message = reason === "used" ? "This store's studio requests for this month are used." : undefined;
    let answer: { status: number; text: string } | string;
    try {
      const response = await GET(request());
      answer = { status: response.status, text: await response.text() };
    } catch (error) {
      answer = `threw: ${String(error)}`;
    }
    const got = typeof answer === "string" ? answer : [answer.status, answer.text.length > 0];
    is(`${reason}: ${status} with words`, got, [status, true]);
    if (reason === "used" && typeof answer !== "string") is("used: says what the studio's count said", answer.text, refusal.message);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
