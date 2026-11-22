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

const REASONS: [Refusal, number, string][] = [
  ["signed_out", 401, "Log in first."],
  ["no_store", 404, "There is no store here yet."],
  ["forbidden", 403, "Your role on this store does not include its files."],
  ["gone", 403, "That store is not one you can open."],
  ["used", 429, "This store's studio requests for this month are used."],
  ["locked", 403, "You got in without your second step, so this waits until two-step login turns off. The date is at the top of your studio."],
  ["two_step", 403, "This store asks everyone on its team to turn on two-step login first."],
];

function request(): NextRequest {
  const url = new URL("https://marktmorgen.com/api/store/file/download?id=abc");
  return Object.assign(new Request(url), { nextUrl: url, cookies: { get: () => undefined } }) as unknown as NextRequest;
}

async function main() {
  part("Each refusal is answered, never thrown");
  for (const [reason, status, expectedText] of REASONS) {
    refusal.reason = reason;
    refusal.message = reason === "used" ? "This store's studio requests for this month are used." : undefined;
    let answer: { status: number; text: string } | string;
    try {
      const response = await GET(request());
      answer = { status: response.status, text: await response.text() };
    } catch (error) {
      answer = `threw: ${String(error)}`;
    }
    const got = typeof answer === "string" ? answer : [answer.status, answer.text];
    is(`${reason}: exact refusal`, got, [status, expectedText]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
