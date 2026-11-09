/**
 * A buyer's "stop review requests" read and written only in their exact
 * shape (CX-123 rule 24), as PR #2951 did for checkout reminders
 * (lib/checkout-recovery.ts, readStopToken and stopReminders).
 *
 *   - R1 the stop page's reading of a link (GET text or nothing, EXISTS 0 or
 *     1): another shape is unknown, never "no such link" or "not stopped";
 *   - R2 pressing stop (GET, then the stop mark's SET "OK" inside the order
 *     write script, lib/order-data.ts): another shape, or a write that throws,
 *     is unknown, never "stopped" and never "no such link";
 *   - R3 at the door (app/api/mail/unsubscribe): a one-click stop whose write
 *     is unknown answers 503 "try again", never "Unsubscribed." nor
 *     "Not found."; from the page it goes back with done=0 and the address is
 *     not stopped, so the button is offered again.
 *
 * The real functions over the in-memory Redis (tests/redis-stub.ts), with
 * only one pipeline's reply replaced. Controls show the healthy answers still
 * read, stop and say "not found" as before. Synthetic records only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { UnknownReplyError } from "@/lib/redis-reply";
import { readReviewStop, stopReviewRequests } from "@/lib/review-requests";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { POST as unsubscribePost } from "@/app/api/mail/unsubscribe/route";
import { store as redis } from "./redis-stub";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import UnsubscribePage from "@/app/unsubscribe/page";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { LANGUAGE_CODES } from "@/lib/store-language";

globalThis.fetch = (async () => {
  throw new Error("No real provider call allowed");
}) as typeof fetch;

const HANDLE = "revstopkiln";
const OWNER = "revstop-owner@example.test";
const NAME = "Revstop Kiln";

type Commands = (string | number)[][];
type Pipe = (commands: Commands) => Promise<unknown[]>;
type Answer = (commands: Commands, real: Pipe) => Promise<unknown>;
/** Answers the pipelines `when` picks with `answer`, every other one as Redis would. */
async function intercept<T>(when: (commands: Commands) => boolean, answer: Answer, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  const real: Pipe = (commands) => original.call(redis, commands);
  redis.pipeline = (async (commands: Commands) => (when(commands) ? answer(commands, real) : real(commands))) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}
const isLinkRead = (c: Commands) => c.length === 1 && c[0]?.[0] === "GET" && String(c[0][1]).startsWith("nl:rev:stop:");
const isStopRead = (c: Commands) => c.length === 1 && c[0]?.[0] === "EXISTS" && String(c[0][1]).startsWith("nl:rev:off:");
/** The stop mark's write: one order-write script whose keys hold the stop mark (lib/order-data.ts, scriptOf). */
const isStopWrite = (c: Commands) => c.length === 1 && c[0]?.[0] === "EVAL" && c[0].some((arg) => String(arg).startsWith("nl:rev:off:"));

let statsId = "";
async function shop(): Promise<string> {
  if (!statsId) {
    await claimHandle(OWNER, HANDLE, NAME, "");
    await ensureStatsId(OWNER);
    statsId = (await storeForEmail(OWNER))?.statsId ?? "";
    assert.ok(statsId);
  }
  return statsId;
}

/** A stop link as a sent review request leaves it, written straight into the stand-in. */
let tokens = 0;
async function stopToken(email: string): Promise<string> {
  const s = await shop();
  tokens += 1;
  const token = tokens.toString(16).padStart(40, "b");
  await redis.pipeline([["SET", `nl:rev:stop:${token}`, JSON.stringify({ s, e: email, h: HANDLE, n: NAME })]]);
  return token;
}
const unique = (() => {
  let n = 0;
  return (label: string) => `revstop-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${(n += 1)}@example.test`;
})();

test("control: the stop page and the stop button with healthy replies", async () => {
  const email = unique("control");
  const token = await stopToken(email);
  assert.deepEqual(await readReviewStop(token), { email, storeName: NAME, stopped: false, handle: HANDLE });
  assert.equal(await stopReviewRequests(token), true);
  assert.equal((await readReviewStop(token))?.stopped, true);
  assert.equal(await stopReviewRequests(token), true, "safe to press twice");
  // A link nobody made, or one whose text is not a grant, is not one: nothing else is said about it.
  assert.equal(await readReviewStop("f".repeat(40)), null);
  assert.equal(await stopReviewRequests("f".repeat(40)), false);
  const broken = "e".repeat(40);
  await redis.pipeline([["SET", `nl:rev:stop:${broken}`, "not json"]]);
  assert.equal(await readReviewStop(broken), null);
  assert.equal(await stopReviewRequests(broken), false);
});

test("control: a healthy stop at the door says 'Unsubscribed.', and an unknown link 'Not found.'", async () => {
  const token = await stopToken(unique("door-ok"));
  const ok = await press(token, false);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "Unsubscribed.");
  const none = await press("f".repeat(40), false);
  assert.equal(none.status, 404);
  assert.equal(await none.text(), "Not found.");
});

test("R1: the stop page's readings of another shape are unknown, never 'no such link' or 'not stopped'", async (t) => {
  const token = await stopToken(unique("page"));
  for (const [answer, label] of [
    [async () => [42], "GET answered a number"],
    [async () => [["x"]], "GET answered a list"],
    [async () => [], "GET with no reply"],
    [async () => [null, null], "GET with two replies"],
    [async () => ({}), "GET with no list"],
  ] as [Answer, string][]) {
    await t.test(label, () => assert.rejects(intercept(isLinkRead, answer, () => readReviewStop(token)), UnknownReplyError, `stop page: ${label}`));
  }
  for (const [answer, label] of [
    [async () => [null], "EXISTS answered nothing"],
    [async () => ["1"], "EXISTS answered text"],
    [async () => [2], "EXISTS answered 2"],
    [async () => [-1], "EXISTS answered -1"],
    [async () => [], "EXISTS with no reply"],
    [async () => ({}), "EXISTS with no list"],
  ] as [Answer, string][]) {
    await t.test(label, () => assert.rejects(intercept(isStopRead, answer, () => readReviewStop(token)), UnknownReplyError, `stop page: ${label}`));
  }
});

test("R2: pressing stop with a reply of another shape is unknown, never 'stopped' or 'no such link'", async (t) => {
  for (const [answer, label] of [
    [async () => [42], "GET answered a number"],
    [async () => [], "GET with no reply"],
    [async () => ({}), "GET with no list"],
  ] as [Answer, string][]) {
    const token = await stopToken(unique(`get ${label}`));
    await t.test(label, () => assert.rejects(intercept(isLinkRead, answer, () => stopReviewRequests(token)), UnknownReplyError, `stop: ${label}`));
  }
  // The script ran but the stop mark's own SET did not answer "OK": the write is not confirmed.
  for (const [answer, label] of [
    [async () => [[0, null]], "SET answered nothing"],
    [async () => [[0, "QUEUED"]], "SET answered QUEUED"],
    [async () => [[0, 1]], "SET answered 1"],
  ] as [Answer, string][]) {
    const email = unique(`set ${label}`);
    const token = await stopToken(email);
    await t.test(label, async () => {
      await assert.rejects(intercept(isStopWrite, answer, () => stopReviewRequests(token)), UnknownReplyError, `stop: ${label}`);
      assert.equal((await readReviewStop(token))?.stopped, false, "nothing was written");
    });
  }
  // The script itself answered in no known shape: lib/order-data.ts throws, and that is not "no such link".
  for (const [answer, label] of [
    [async () => [null], "script answered nothing"],
    [async () => [], "script with no reply"],
    [async () => ({}), "script with no list"],
    [async () => [[0]], "script with no reply for the SET"],
  ] as [Answer, string][]) {
    const token = await stopToken(unique(`script ${label}`));
    await t.test(label, () => assert.rejects(intercept(isStopWrite, answer, () => stopReviewRequests(token)), `stop: ${label}`));
  }
});

async function press(token: string, fromPage: boolean, answer?: Answer): Promise<Response> {
  const body = new URLSearchParams(fromPage ? { from: "page" } : {});
  const send = () =>
    unsubscribePost(
      new NextRequest(`https://marktmorgen.test/api/mail/unsubscribe?v=${token}`, {
        method: "POST",
        headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
  return answer ? intercept(isStopWrite, answer, send) : send();
}

test("R3 at the door: an unknown stop write never says 'Unsubscribed.' nor 'Not found.', and the page offers the button again", async (t) => {
  for (const [answer, label] of [
    [async () => [[0, null]], "SET answered nothing"],
    [async () => [null], "script answered nothing"],
  ] as [Answer, string][]) {
    await t.test(label, async () => {
      const oneClick = await press(await stopToken(unique(`door one ${label}`)), false, answer);
      assert.equal(oneClick.status, 503, "a one-click stop whose write is unknown answers try again");
      const said = await oneClick.text();
      assert.ok(!/Unsubscribed|Not found/.test(said), `never a false answer: ${said}`);
      assert.match(said, /try again/i);
      const token = await stopToken(unique(`door page ${label}`));
      const fromPage = await press(token, true, answer);
      assert.equal(fromPage.status, 303);
      assert.match(fromPage.headers.get("location") ?? "", /[?&]v=[0-9a-f]{40}&done=0$/);
      assert.equal((await readReviewStop(token))?.stopped, false, "not stopped, so the page shows the button again");
    });
  }
});

// ---- Claude 5's LOW on #3010: the page path says when the last press was not saved (AX274 3.3.1, 4.1.3) ----
async function settle(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(settle));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === "function") {
    return settle(await (element.type as (props: unknown) => ReactNode | Promise<ReactNode>)(element.props));
  }
  return "children" in element.props ? cloneElement(element, undefined, await settle(element.props.children)) : element;
}
const page = async (query: Record<string, string>) => renderToStaticMarkup(await settle(await UnsubscribePage({ searchParams: Promise.resolve(query) })));
const notSaved = (): string => {
  const said = (affiliatesWords("en") as unknown as Record<string, unknown>).reviewsNotSaved;
  return typeof said === "string" ? said : "<no reviewsNotSaved>";
};

test("the stop page says the last press was not saved when the route answered done=0, and offers the button again", async () => {
  const token = await stopToken(unique("page not saved"));
  const html = await page({ v: token, done: "0" });
  assert.ok(html.includes(notSaved()), "the buyer is told the last press was not saved");
  assert.match(html, new RegExp(`role="status"[^>]*>${notSaved().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "said in a status region");
  assert.match(html, /<form /, "the button is offered again");
});

test("control: no such sentence without done=0, nor once the stop is saved", async () => {
  const token = await stopToken(unique("page saved"));
  for (const query of [{ v: token }, { v: token, done: "1" }] as Record<string, string>[]) assert.ok(!(await page(query)).includes(notSaved()), `no failure said for ${JSON.stringify(query)}`);
  assert.equal(await stopReviewRequests(token), true);
  const html = await page({ v: token, done: "0" });
  assert.ok(!html.includes(notSaved()), "a stop already saved is not said to have failed");
  assert.doesNotMatch(html, /<form /, "and no button is offered");
});

test("the sentence exists in every buyer language and differs in each", () => {
  const all = LANGUAGE_CODES.map((code) => (affiliatesWords(code) as unknown as Record<string, unknown>).reviewsNotSaved);
  assert.ok(all.every((s) => typeof s === "string" && s.length > 15), "set in every language");
  assert.equal(new Set(all).size, LANGUAGE_CODES.length, "each its own");
});
