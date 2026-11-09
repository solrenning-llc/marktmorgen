/**
 * A list's unsubscribe link read and pressed only in its exact shape
 * (CX-123 rule 24), as #3010 did for review stops and #2951 for checkout
 * reminders. lib/contacts.ts, readUnsubToken and unsubscribe:
 *
 *   - U1 reading the link (GET of nl:mail:unsub:<token>: text or nothing):
 *     another shape is unknown, never "no such link";
 *   - U2 reading the contact behind it (HGET of the list row: text or
 *     nothing): another shape is unknown, never "no such link";
 *   - U3 pressing unsubscribe (HSET of the row, 0 or 1, one reply per
 *     command): another shape, or a write that throws, is unknown, never
 *     "Unsubscribed.";
 *   - U4 at the door (app/api/mail/unsubscribe, `t` links, the one-click
 *     List-Unsubscribe POST of RFC 8058): an unknown read or write answers 503
 *     "try again", never "Unsubscribed." nor "Not found."; from the page it
 *     goes back with done=0, and the page says the last press was not saved
 *     and offers the button again. A link nobody made (an exact nil) still
 *     says "Not found." with 404, not "try again" (on main the door read
 *     unsubscribe's "no such link" as "not saved");
 *   - U5 the page never says "This link is not one we know" for a link whose
 *     read was unknown (it fails to draw instead, app/error.tsx), for `t` and
 *     for `l` links (lib/mail-clicks.ts reads the same token).
 *
 * The real functions over the in-memory Redis (tests/redis-stub.ts), with
 * only one pipeline's reply replaced. Controls: an exact nil (a link nobody
 * made, a row that is gone) still reads as "no such link", and healthy data
 * still reads, unsubscribes and says so. Synthetic records only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import UnsubscribePage from "@/app/unsubscribe/page";
import { POST as unsubscribePost } from "@/app/api/mail/unsubscribe/route";
import { leadsKey, readUnsubToken, tokenKey, tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { claimHandle, ensureListId, storeForEmail } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

globalThis.fetch = (async () => {
  throw new Error("No real provider call allowed");
}) as typeof fetch;

const OWNER = "unsub-exact-owner@example.test";
const HANDLE = "unsubexactkiln";

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
const isLinkRead = (c: Commands) => c.length === 1 && c[0]?.[0] === "GET" && String(c[0][1]).startsWith("nl:mail:unsub:");
const isRowRead = (c: Commands) => c.length === 1 && c[0]?.[0] === "HGET" && String(c[0][1]).startsWith("nl:store:leads:");
// Claude 5, consent audit of 9 November 2026 (rule 23): the press now writes the row only over the one it read, in
// one script (lib/contacts.ts unsubscribe, CAS_HSET), and counts the leaving after it; the pipeline found here is that
// write. Every answer injected below, and what each case proves, is as it was.
const isUnsubWrite = (c: Commands) =>
  c.length === 1 && c[0]?.[0] === "EVAL" && String(c[0][1]).startsWith("-- marktmorgen:contact-cas-hset:v1\n") && String(c[0][3]).startsWith("nl:store:leads:");

let listId = "";
let handle = "";
async function list(): Promise<string> {
  if (!listId) {
    await claimHandle(OWNER, HANDLE, "Unsub Exact Kiln", "");
    await ensureListId(OWNER);
    const store = await storeForEmail(OWNER);
    listId = store?.listId ?? "";
    handle = store?.handle ?? "";
    assert.ok(listId && handle);
  }
  return listId;
}
const unique = (() => {
  let n = 0;
  return (label: string) => `unsubx-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${(n += 1)}@example.test`;
})();
/** A reader on the list who agreed, with the link a sent email carries. */
async function reader(label: string): Promise<{ email: string; token: string }> {
  const id = await list();
  const email = unique(label);
  await upsertContact(id, email, { agreed: true, explicit: true, source: "import" }, ROOM);
  const token = (await tokensFor(id, [email], handle)).get(email);
  assert.ok(token, "a link is made");
  return { email, token };
}
const isUnsub = async (email: string): Promise<boolean> => {
  const [raw] = await redis.pipeline([["HGET", leadsKey(listId), email]]);
  return typeof raw === "string" && JSON.parse(raw).unsub === true;
};

/** Answers that are not a reply of their command's shape: a number, a list, nothing, two, no list at all. */
const offShapeReads: [Answer, string][] = [
  [async () => [42], "answered a number"],
  [async () => [["x"]], "answered a list"],
  [async () => [[]], "answered an empty list"],
  [async () => [], "with no reply"],
  [async () => [null, null], "with two replies"],
  [async () => ({}), "with no list"],
  [async () => [undefined], "answered undefined"],
  [async () => [true], "answered true"],
];

// ---- controls -------------------------------------------------------------------------------------------

test("control: a healthy link reads, unsubscribes once, and is safe to press twice", async () => {
  const { email, token } = await reader("control");
  const found = await readUnsubToken(token);
  assert.equal(found?.email, email);
  assert.equal(found?.listId, listId);
  assert.equal(found?.handle, handle);
  assert.ok(found && !found.contact.unsub, "not left yet");
  assert.deepEqual(await unsubscribe(token), { listId, email });
  assert.equal(await isUnsub(email), true);
  assert.equal((await readUnsubToken(token))?.contact.unsub, true);
  assert.deepEqual(await unsubscribe(token), { listId, email }, "safe to press twice");
});

test("control: an exact nil is still 'no such link' (a link nobody made, a row that is gone, a record that is not one)", async () => {
  assert.equal(await readUnsubToken("f".repeat(40)), null, "no record");
  assert.equal(await unsubscribe("f".repeat(40)), null);
  assert.equal(await readUnsubToken("not a token"), null, "not a token's shape");
  const { email, token } = await reader("row gone");
  await redis.pipeline([["HDEL", leadsKey(listId), email]]);
  assert.equal(await readUnsubToken(token), null, "the row is gone: HGET answered an exact nil");
  assert.equal(await unsubscribe(token), null);
  const broken = "e".repeat(40);
  await redis.pipeline([["SET", tokenKey(broken), "no-bars-here"]]);
  assert.equal(await readUnsubToken(broken), null, "a record that is not listId|address|handle");
  const { token: other } = await reader("other token");
  const { token: mine } = await reader("token moved");
  // A record whose row now holds another token: not this link's.
  const [rec] = await redis.pipeline([["GET", tokenKey(other)]]);
  await redis.pipeline([["SET", tokenKey(mine), String(rec)]]);
  assert.equal(await readUnsubToken(mine), null, "the row's own token is another");
});

async function press(key: "t" | "l", token: string, fromPage: boolean, when?: (c: Commands) => boolean, answer?: Answer): Promise<Response> {
  const body = new URLSearchParams(fromPage ? { from: "page" } : {});
  const send = () =>
    unsubscribePost(
      new NextRequest(`https://marktmorgen.test/api/mail/unsubscribe?${key}=${token}`, {
        method: "POST",
        headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
  return when && answer ? intercept(when, answer, send) : send();
}

test("control: at the door a healthy one-click says 'Unsubscribed.'", async () => {
  const { email, token } = await reader("door ok");
  const ok = await press("t", token, false);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "Unsubscribed.");
  assert.equal(await isUnsub(email), true);
  const { token: paged } = await reader("door page ok");
  const fromPage = await press("t", paged, true);
  assert.equal(fromPage.status, 303);
  assert.match(fromPage.headers.get("location") ?? "", /[?&]t=[0-9a-f]{40}&done=1$/);
});

test("U4: at the door a link nobody made says 'Not found.', never 'try again' (an exact nil is known)", async () => {
  const none = await press("t", "f".repeat(40), false);
  assert.equal(none.status, 404);
  assert.equal(await none.text(), "Not found.");
  const fromPage = await press("t", "f".repeat(40), true);
  assert.equal(fromPage.status, 303);
  assert.match(fromPage.headers.get("location") ?? "", /[?&]t=f{40}&done=0$/);
});

// ---- U1, U2: reading the link and its row ------------------------------------------------------------------

test("U1: the link's record in another shape is unknown, never 'no such link'", async (t) => {
  const { token } = await reader("u1");
  for (const [answer, label] of offShapeReads) {
    await t.test(`GET ${label}`, async () => {
      await assert.rejects(intercept(isLinkRead, answer, () => readUnsubToken(token)), UnknownReplyError);
      await assert.rejects(intercept(isLinkRead, answer, () => unsubscribe(token)), UnknownReplyError);
    });
  }
  assert.ok(await readUnsubToken(token), "still read once Redis answers in shape");
});

test("U2: the contact row behind the link in another shape is unknown, never 'no such link'", async (t) => {
  const { email, token } = await reader("u2");
  for (const [answer, label] of offShapeReads) {
    await t.test(`HGET ${label}`, async () => {
      await assert.rejects(intercept(isRowRead, answer, () => readUnsubToken(token)), UnknownReplyError);
      await assert.rejects(intercept(isRowRead, answer, () => unsubscribe(token)), UnknownReplyError);
      assert.equal(await isUnsub(email), false, "nothing written on an unknown read");
    });
  }
});

// ---- U3: pressing unsubscribe -----------------------------------------------------------------------------

test("U3: an unsubscribe whose HSET answers in another shape is unknown, never done", async (t) => {
  for (const [answer, label] of [
    [async () => [], "with no reply"],
    [async () => ({}), "with no list"],
    [async () => [null, 1], "HSET answered nothing"],
    [async () => ["OK", 1], "HSET answered text"],
    [async () => [-1, 1], "HSET answered a negative count"],
    [async () => [2, 1], "HSET answered more than one field"],
    [async () => [0.5, 1], "HSET answered a fraction"],
    [async () => [[0], 1], "HSET answered a list"],
    [async () => [0], "one reply short"],
    [async () => [0, 1, 1], "one reply too many"],
    [async () => { throw new Error("synthetic Redis timeout"); }, "the write threw"],
  ] as [Answer, string][]) {
    await t.test(label, async () => {
      const { email, token } = await reader(`u3 ${label}`);
      await assert.rejects(intercept(isUnsubWrite, answer, () => unsubscribe(token)));
      assert.equal(await isUnsub(email), false, "not left, so the page offers the button again");
      assert.deepEqual(await unsubscribe(token), { listId, email }, "the next press, in shape, unsubscribes");
    });
  }
  await t.test("a write that applied but whose reply was lost: unknown now, done on the next press", async () => {
    const { email, token } = await reader("u3 applied lost");
    await assert.rejects(intercept(isUnsubWrite, async (c, real) => (await real(c), [null]), () => unsubscribe(token)), UnknownReplyError);
    assert.equal(await isUnsub(email), true);
    assert.deepEqual(await unsubscribe(token), { listId, email });
  });
});

// ---- U4: at the door --------------------------------------------------------------------------------------

test("U4: at the door an unknown read or write never says 'Unsubscribed.' nor 'Not found.'", async (t) => {
  for (const [when, answer, label] of [
    [isLinkRead, async () => [42], "link read answered a number"],
    [isRowRead, async () => [["x"]], "row read answered a list"],
    [isUnsubWrite, async () => [null, 1], "HSET answered nothing"],
    [isUnsubWrite, async () => { throw new Error("synthetic Redis timeout"); }, "the write threw"],
  ] as [(c: Commands) => boolean, Answer, string][]) {
    await t.test(label, async () => {
      const { email, token } = await reader(`door one ${label}`);
      const oneClick = await press("t", token, false, when, answer);
      assert.equal(oneClick.status, 503, "a one-click whose read or write is unknown answers try again");
      const said = await oneClick.text();
      assert.ok(!/Unsubscribed|Not found/.test(said), `never a false answer: ${said}`);
      assert.match(said, /try again/i);
      assert.equal(oneClick.headers.get("retry-after"), "60");
      assert.equal(await isUnsub(email), false);
      const { token: paged } = await reader(`door page ${label}`);
      const fromPage = await press("t", paged, true, when, answer);
      assert.equal(fromPage.status, 303);
      assert.match(fromPage.headers.get("location") ?? "", /[?&]t=[0-9a-f]{40}&done=0$/);
    });
  }
});

// ---- U4, U5: the page --------------------------------------------------------------------------------------

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
const words = affiliatesWords("en");
const escaped = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

test("U4: the page says the last press was not saved when the route answered done=0, and offers the button again", async () => {
  const { token } = await reader("page not saved");
  const html = await page({ t: token, done: "0" });
  assert.ok(html.includes(escaped(words.reviewsNotSaved)), "the reader is told the last press was not saved");
  assert.match(html, /role="status"[^>]*>We could not save that just now/, "said in a status region");
  assert.match(html, /<form /, "the button is offered again");
});

test("control: the page says nothing of a failure without done=0, nor once the reader has left", async () => {
  const { token } = await reader("page saved");
  for (const query of [{ t: token }, { t: token, done: "1" }] as Record<string, string>[]) {
    const html = await page(query);
    assert.ok(!html.includes(escaped(words.reviewsNotSaved)), `no failure said for ${JSON.stringify(query)}`);
    assert.match(html, /<form /);
  }
  await unsubscribe(token);
  const html = await page({ t: token, done: "0" });
  assert.ok(!html.includes(escaped(words.reviewsNotSaved)), "a press already saved is not said to have failed");
  assert.doesNotMatch(html, /<form /);
  const unknown = await page({ t: "f".repeat(40) });
  assert.ok(unknown.includes(escaped(words.unknownLink)), "a link nobody made is still 'not one we know'");
});

test("U5: the page never calls a link whose read was unknown 'not one we know'", async (t) => {
  for (const key of ["t", "l"] as const) {
    for (const [when, answer, label] of [
      [isLinkRead, async () => [42], "link read answered a number"],
      [isLinkRead, async () => [], "link read with no reply"],
      [isRowRead, async () => [["x"]], "row read answered a list"],
    ] as [(c: Commands) => boolean, Answer, string][]) {
      await t.test(`${key}: ${label}`, async () => {
        const { token } = await reader(`page ${key} ${label}`);
        let html = "";
        try {
          html = await intercept(when, answer, () => page({ [key]: token }));
        } catch (error) {
          assert.ok(error instanceof UnknownReplyError, `fails to draw on the unknown read, not on something else: ${String(error)}`);
          return;
        }
        assert.ok(!html.includes(escaped(words.unknownLink)), "never 'This link is not one we know'");
        assert.fail("an unknown read must not draw a page as if the link were known or unknown");
      });
    }
  }
});
