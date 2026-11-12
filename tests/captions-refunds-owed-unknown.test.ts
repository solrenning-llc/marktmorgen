/**
 * Rule 24 on the studio's course page (VR item 2): refunds for AI captions that Stripe has not confirmed yet. When
 * they cannot be read, the page does not hide the section as if nothing were owed: lib/auto-captions.ts throws
 * UnknownReplyError on a record it cannot read, the page hands null to the section, and the section says the
 * refunds could not be checked. A known empty list shows nothing and a known list shows its refunds (controls).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { autoRefundsOwed } from "@/lib/auto-captions";
import { UnknownReplyError } from "@/lib/redis-reply";
import { streamPath } from "@/lib/stream-rules";
import { CaptionsRefundsOwed } from "@/components/captions-refunds-owed";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "c".repeat(32);
const GOOD = "2b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const BAD = "3b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const owedRecord = (id: string, cents: number) =>
  JSON.stringify({ langs: ["en"], got: [], at: 1_000, cents, pi: "pi_Captions000009", path: streamPath(FOLDER, "lesson000009", id), owed: { cents: null, key: `k-${id}`, since: 1, looks: 0 } });
const thrown = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "answered";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "other";
  }
};

async function main(): Promise<void> {
  part("the store's owed refunds, read exactly");
  redis.run(["SADD", `nl:stream:autoowed:${FOLDER}`, GOOD]);
  redis.run(["SET", `nl:stream:auto:${GOOD}`, owedRecord(GOOD, 3500), "EX", 3600]);
  is("control: a readable owed refund is listed", await autoRefundsOwed(FOLDER), [{ id: GOOD, cents: 3500, stuck: false }]);
  redis.run(["SADD", `nl:stream:autoowed:${FOLDER}`, BAD]);
  redis.run(["SET", `nl:stream:auto:${BAD}`, "{not json", "EX", 3600]);
  is("a record in the owed set that cannot be read is unknown, never dropped", await thrown(() => autoRefundsOwed(FOLDER)), "unknown");
  redis.run(["SET", `nl:stream:auto:${BAD}`, "garbage", "EX", 3600]);
  is("nor a record of another shape", await thrown(() => autoRefundsOwed(FOLDER)), "unknown");
  redis.run(["DEL", `nl:stream:auto:${BAD}`]);
  is("control: a member whose record is gone is not owed", await autoRefundsOwed(FOLDER), [{ id: GOOD, cents: 3500, stuck: false }]);

  part("the section on the page");
  const render = (rows: { id: string; cents: number; stuck: boolean }[] | null) => renderToStaticMarkup(createElement(CaptionsRefundsOwed, { rows }));
  const UNREAD = /We could not check refunds for AI captions just now\. Reload the page in a minute to try again\./;
  const unread = render(null);
  is("unknown refunds are said in words, under the section's heading", UNREAD.test(unread) && /Refunds for AI captions not confirmed yet/.test(unread), true);
  is("control: none owed shows nothing", render([]), "");
  const known = render([{ id: GOOD, cents: 3500, stuck: true }]);
  is("control: a stuck refund still says to write to support", /A refund of \$35\.00 for AI captions was not confirmed by Stripe/.test(known) && !UNREAD.test(known), true);

  const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  is("the page never reads unknown refunds as none", /autoRefundsOwed\(folder\)\.catch\(\(\) => null\)/.test(page) && !/autoRefundsOwed\(folder\)\.catch\(\(\) => \[\]\)/.test(page), true);
  is("the page draws the section from the component", /<CaptionsRefundsOwed rows=\{owedRows\} \/>/.test(page), true);

  done();
}

void main();
