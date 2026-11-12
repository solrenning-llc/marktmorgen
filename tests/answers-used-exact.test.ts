/**
 * Rule 24 on the studio's product-page answers (VR item 2): how many of the month's AI attempts were used. A count
 * Redis answered in another shape, or a missing reply, is unknown: answersUsed throws UnknownReplyError, the page
 * passes null and AnswersEditor says it could not read it, never "0 of N used". A key not there yet is a real 0, and a
 * stored count reads as itself (controls). The admission (takeAnswer) is not touched: it already fails closed.
 * Synthetic store and the in-memory Redis; the real component rendered to HTML.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { answersUsed } from "@/lib/answers";
import { AnswersEditor } from "@/components/answers-editor";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 11, 12);
const shop = { statsId: "answersused1", handle: "shop", tier: "pro", period: paidPeriod(NOW) } as unknown as Store;
const outcome = async () => answersUsed(shop, NOW).then((n) => n, (e: Error) => e.name);
const asked = (commands: (string | number)[][]) => commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:ask:answersused1:"));

async function main(): Promise<void> {
  part("The reader: exact, unknown is never 0");
  redis.clear();
  is("no key yet is a real 0", await outcome(), 0);
  const plain = redis.pipeline.bind(redis);
  let answer: unknown[] | null = null;
  redis.pipeline = (async (commands: (string | number)[][]) => (asked(commands) && answer ? answer : plain(commands))) as typeof redis.pipeline;
  answer = ["7"];
  is("a stored count reads as itself", await outcome(), 7);
  answer = ["not a number"];
  is("a count in another shape is unknown", await outcome(), "UnknownReplyError");
  answer = ["-3"];
  is("a negative count is unknown", await outcome(), "UnknownReplyError");
  answer = [];
  is("a missing reply is unknown", await outcome(), "UnknownReplyError");
  redis.pipeline = plain;

  part("The editor: an unread count is said in words, never as 0");
  const editor = (used: number | null) => renderToStaticMarkup(createElement(AnswersEditor, { setting: { on: true, facts: "" }, used: used as never, allowance: 700, missed: [] }));
  is("unread is said so", /could not read how many AI attempts were used this month/.test(editor(null)), true);
  is("never '0 of 700'", /\b(0|null) of 700/.test(editor(null)), false);
  is("control: a count is shown", /\b5 of 700 AI attempts used this month/.test(editor(5)), true);

  part("The studio page passes null for an unread count");
  is("caught as null, never 0", /answersUsed\(store\)\.catch\(\(\) => null\)/.test(readFileSync("app/studio/page.tsx", "utf8")), true);

  done();
}

main();
