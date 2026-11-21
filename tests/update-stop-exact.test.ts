/**
 * A buyer's "stop update emails" link, and the checkout reminders' stop page,
 * answered as the review requests' already are (tests/review-stop-exact.test.ts):
 *
 *   - U1 pressing stop on an update link whose stop mark's write fails or
 *     answers in another shape is unknown: it throws, never "stopped" and
 *     never "no such link";
 *   - U2 at the door (app/api/mail/unsubscribe): a one-click stop whose write
 *     is unknown answers 503 "try again", never "Not found." for a link that
 *     exists; from the page it goes back with done=0;
 *   - U3 the update and checkout-reminder stop pages say, in a status region,
 *     that the last press was not saved when the route answered done=0, and
 *     offer the button again; nothing is said without done=0 or once stopped.
 *
 * The real functions over the in-memory Redis (tests/redis-stub.ts), with
 * only one pipeline's reply replaced. Synthetic records only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readUpdateStop, stopUpdates } from "@/lib/product-updates";
import { readStopToken, stopReminders } from "@/lib/checkout-recovery";
import { claimHandle, ensureStatsId, setLanguage, storeForEmail } from "@/lib/store";
import { POST as unsubscribePost } from "@/app/api/mail/unsubscribe/route";
import UnsubscribePage from "@/app/unsubscribe/page";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";

globalThis.fetch = (async () => {
  throw new Error("No real provider call allowed");
}) as typeof fetch;

const HANDLE = "updstopkiln";
const OWNER = "updstop-owner@example.test";
const NAME = "Updstop Kiln";

type Commands = (string | number)[][];
type Pipe = (commands: Commands) => Promise<unknown[]>;
type Answer = (commands: Commands, real: Pipe) => Promise<unknown>;
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
/** The update stop mark's write: one order-write script whose keys hold the stop mark (lib/order-data.ts). */
const isStopWrite = (c: Commands) => c.length === 1 && c[0]?.[0] === "EVAL" && c[0].some((arg) => String(arg).startsWith("nl:upd:off:"));

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
let tokens = 0;
async function updateToken(email: string): Promise<string> {
  const s = await shop();
  tokens += 1;
  const token = tokens.toString(16).padStart(40, "c");
  await redis.pipeline([["SET", `nl:upd:stop:${token}`, JSON.stringify({ s, e: email, h: HANDLE, n: NAME })]]);
  return token;
}
/** A checkout reminder's stop link as lib/checkout-recovery.ts stopLink leaves it. */
async function reminderToken(email: string): Promise<string> {
  const s = await shop();
  tokens += 1;
  const token = tokens.toString(16).padStart(40, "d");
  await redis.pipeline([["SET", `nl:recover:link:${token}`, JSON.stringify({ k: s, e: email, n: NAME, h: HANDLE })]]);
  return token;
}
const unique = (() => {
  let n = 0;
  return (label: string) => `updstop-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${(n += 1)}@example.test`;
})();

async function press(token: string, fromPage: boolean, answer?: Answer): Promise<Response> {
  const body = new URLSearchParams(fromPage ? { from: "page" } : {});
  const send = () =>
    unsubscribePost(
      new NextRequest(`https://marktmorgen.test/api/mail/unsubscribe?u=${token}`, {
        method: "POST",
        headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
  return answer ? intercept(isStopWrite, answer, send) : send();
}

test("control: a healthy update stop, twice, and links that are not one", async () => {
  const email = unique("control");
  const token = await updateToken(email);
  assert.equal((await readUpdateStop(token))?.stopped, false);
  assert.equal(await stopUpdates(token), true);
  assert.equal((await readUpdateStop(token))?.stopped, true);
  assert.equal(await stopUpdates(token), true, "safe to press twice");
  assert.equal(await stopUpdates("f".repeat(40)), false);
  const broken = "e".repeat(40);
  await redis.pipeline([["SET", `nl:upd:stop:${broken}`, "not json"]]);
  assert.equal(await stopUpdates(broken), false);
  const ok = await press(await updateToken(unique("door ok")), false);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "Unsubscribed.");
  const none = await press("f".repeat(40), false);
  assert.equal(none.status, 404);
});

test("U1: an update stop whose write fails or answers oddly is unknown, never 'no such link'", async (t) => {
  for (const [answer, label] of [
    [async () => [[0, null]], "SET answered nothing"],
    [async () => [[0, 1]], "SET answered 1"],
    [async () => [null], "script answered nothing"],
    [async () => { throw new Error("connection reset"); }, "the write threw"],
  ] as [Answer, string][]) {
    const token = await updateToken(unique(`u1 ${label}`));
    await t.test(label, async () => {
      await assert.rejects(intercept(isStopWrite, answer, () => stopUpdates(token)), `stop: ${label}`);
      assert.equal((await readUpdateStop(token))?.stopped, false, "nothing was written");
    });
  }
});

test("U2 at the door: an unknown update stop answers 503 'try again', never 'Not found.'", async (t) => {
  for (const [answer, label] of [
    [async () => [[0, null]], "SET answered nothing"],
    [async () => { throw new Error("connection reset"); }, "the write threw"],
  ] as [Answer, string][]) {
    await t.test(label, async () => {
      const oneClick = await press(await updateToken(unique(`door one ${label}`)), false, answer);
      const said = await oneClick.text();
      assert.equal(oneClick.status, 503, `a one-click stop whose write is unknown answers try again, got ${oneClick.status} ${said}`);
      assert.ok(!/Unsubscribed|Not found/.test(said), `never a false answer: ${said}`);
      const token = await updateToken(unique(`door page ${label}`));
      const fromPage = await press(token, true, answer);
      assert.equal(fromPage.status, 303);
      assert.match(fromPage.headers.get("location") ?? "", /[?&]u=[0-9a-f]{40}&done=0$/);
      assert.equal((await readUpdateStop(token))?.stopped, false);
    });
  }
});

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
const quoted = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("U3: the update and reminder stop pages say the last press was not saved, in every language", async () => {
  await shop();
  for (const language of LANGUAGE_CODES) {
    await setLanguage(OWNER, language);
    // As React writes it into the page.
    const said = affiliatesWords(language).reviewsNotSaved.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
    for (const [key, token] of [["u", await updateToken(unique(`u3 ${language}`))], ["r", await reminderToken(unique(`r3 ${language}`))]] as const) {
      const html = await page({ [key]: token, done: "0" });
      assert.match(html, new RegExp(`role="status"[^>]*>${quoted(said)}`), `${key} in ${language}: the buyer is told the last press was not saved`);
      assert.match(html, /<form /, `${key} in ${language}: the button is offered again`);
      for (const query of [{ [key]: token }, { [key]: token, done: "1" }]) assert.ok(!(await page(query)).includes(said), `${key} in ${language}: nothing said for ${JSON.stringify(query)}`);
    }
  }
  await setLanguage(OWNER, "en");
});

test("U3 control: a stop already saved is never said to have failed", async () => {
  const said = affiliatesWords("en").reviewsNotSaved;
  const update = await updateToken(unique("u3 saved"));
  assert.equal(await stopUpdates(update), true);
  const reminder = await reminderToken(unique("r3 saved"));
  assert.equal(await stopReminders(reminder), true);
  assert.equal((await readStopToken(reminder))?.stopped, true);
  for (const [key, token] of [["u", update], ["r", reminder]] as const) {
    const html = await page({ [key]: token, done: "0" });
    assert.ok(!html.includes(said), `${key}: no failure said once stopped`);
    assert.doesNotMatch(html, /<form /, `${key}: and no button is offered`);
  }
});
