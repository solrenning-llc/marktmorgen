/**
 * VR 2, rule 24: how many come-back and yearly-offer emails were sent is shown only when counted
 * (lib/winback-send.ts winbacksSent, lib/yearly-ask.ts yearlyAsksThisMonth; components/winback-editor.tsx,
 * components/yearly-ask-editor.tsx; app/studio/page.tsx).
 *
 * Before: a GET answered cut short or of another shape was read as 0 (`Number(n) || 0`), and a read that threw became
 * 0 on the page (`.catch(() => 0)`), so the studio said "Sent so far: 0." / "Sent this month: 0" for a count it did
 * not have. Now the reads are exact and throw on anything else, the page hands null, and each editor says the count
 * could not be read. A known count still shows its number.
 *
 * Synthetic store; real components rendered on the server.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { winbacksSent } from "@/lib/winback-send";
import { yearlyAsksThisMonth } from "@/lib/yearly-ask";
import { WinBackEditor } from "@/components/winback-editor";
import { YearlyAskEditor } from "@/components/yearly-ask-editor";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const store = { statsId: "f".repeat(32) } as Store;
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
const html = (element: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never }, element));
const UNREAD = /could not be counted just now/;

for (const [name, read, prefix] of [
  ["winbacksSent", () => winbacksSent(store), "nl:wb:n:"],
  ["yearlyAsksThisMonth", () => yearlyAsksThisMonth(store), "nl:yearask:count:"],
] as [string, () => Promise<number>, string][]) {
  for (const [label, reply] of [["no reply", []], ["a word", ["many"]], ["two replies", ["3", "3"]]] as [string, unknown[]][]) {
    test(`${name}: a count read as ${label} is unknown, never 0`, async () => {
      redis.clear();
      redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "GET" && String(b[0][1]).startsWith(prefix) ? reply : pipeline(b))) as typeof redis.pipeline;
      try {
        await assert.rejects(read());
      } finally {
        redis.pipeline = pipeline;
      }
    });
  }
  test(`${name}: none counted is 0, a count is read as it is`, async () => {
    redis.clear();
    assert.equal(await read(), 0);
    redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "GET" && String(b[0][1]).startsWith(prefix) ? ["4"] : pipeline(b))) as typeof redis.pipeline;
    try {
      assert.equal(await read(), 4);
    } finally {
      redis.pipeline = pipeline;
    }
  });
}

const winback = (sent: number | null) =>
  html(createElement(WinBackEditor, { winback: { percent: 25, months: 1, days: 30, address: "a@example.com", coupon: "c1" } as never, connected: true, suggestedAddress: "", sent: sent as never }));
const yearly = (sent: number | null) => html(createElement(YearlyAskEditor, { ask: { on: true, address: "a@example.com" }, suggestedAddress: "", sent: sent as never, offersYearly: true }));

test("the editors say an unread count in words, never 0", () => {
  for (const out of [winback(null), yearly(null)]) {
    assert.match(out, UNREAD);
    assert.doesNotMatch(out, /Sent (so far|this month): (0|null)/);
  }
});

test("a known count still shows its number", () => {
  assert.match(winback(3), /Sent so far: 3\./);
  assert.match(yearly(2), /Sent this month: 2/);
});
