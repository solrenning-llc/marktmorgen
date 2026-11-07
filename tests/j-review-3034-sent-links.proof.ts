/**
 * Local J follow-up to static LOWs on #3034 exact 12b73d60.
 * Real changeLink, data-room script/MemoryRedis, route and React component.
 * Authorization/broadcast lookup are fixed fixtures; React hooks are controlled,
 * so this is neither a browser nor an authentication test. No external IO.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { SentLinksEditor, type SentEmailLinks } from "../components/sent-links-editor";
import { POST } from "../app/api/store/mail/links/route";
import { changeLink, readSentLinks, sentLinkKey } from "../lib/sent-links";
import { SENT_LINK_CHANGES_MAX } from "../lib/sent-link-rules";
import { store as redis } from "./redis-stub";
import { emailFixture, storeFixture } from "./j-review-3034-sent-links-world";
import type { NextRequest } from "next/server";
import { createConnection } from "node:net";

test("the review transport blocks both fetch and sockets before product graph use", async () => {
  await assert.rejects(globalThis.fetch("https://review-transport.invalid/"), /REVIEW_FETCH_BLOCKED/);
  assert.throws(() => createConnection({ host: "review-transport.invalid", port: 443 }), /REVIEW_SOCKET_BLOCKED/);
});

const original = "https://example.com/original";
const next = "https://example.com/changed";
const at = Math.floor(Date.now() / 1000);
async function seedHistory(length: number) {
  redis.clear();
  await redis.pipeline([["SET", sentLinkKey(emailFixture.id), JSON.stringify({ l: emailFixture.listId, exp: at + 86_400, changes: Array.from({ length }, (_, index) => ({ n: 0, to: `${next}-${index}`, at: at - length + index })) })]]);
}

test("healthy control: restoring the original before the cap is a confirmed twentieth change", async () => {
  await seedHistory(SENT_LINK_CHANGES_MAX - 1);
  const result = await changeLink(storeFixture, emailFixture, 0, original);
  assert.equal(result.ok, true);
  assert.equal((await readSentLinks(emailFixture.id))?.changes.length, SENT_LINK_CHANGES_MAX);
  assert.equal((await readSentLinks(emailFixture.id))?.changes.at(-1)?.to, original);
});

test("the original remains an available undo after the history cap", async () => {
  await seedHistory(SENT_LINK_CHANGES_MAX);
  const result = await changeLink(storeFixture, emailFixture, 0, original);
  assert.equal(result.ok, true, "the page promises always and keeps offering its undo button");
});

type Element = { type?: unknown; props?: Record<string, unknown> };
function allElements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(allElements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as Element;
  return [element, ...allElements(element.props?.children)];
}
function words(value: unknown): string {
  if (Array.isArray(value)) return value.map(words).join("");
  if (value && typeof value === "object" && "props" in value) return words((value as Element).props?.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
async function submitThroughComponent(loseAcknowledgment: boolean) {
  redis.clear();
  const pipeline = redis.pipeline;
  let writes = 0, commands = 0;
  redis.pipeline = async batch => {
    commands += batch.length;
    if (commands > 1_000) throw new Error("review command budget exceeded");
    const reply = await pipeline.call(redis, batch);
    if (batch.some(command => command[0] === "SET" && command[1] === sentLinkKey(emailFixture.id))) {
      writes += 1;
      if (loseAcknowledgment) return [null];
    }
    return reply;
  };
  const hookState: unknown[] = [];
  let cursor = 0;
  let signal!: () => void;
  const settled = new Promise<void>(resolve => { signal = resolve; });
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = internals.H;
  internals.H = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in hookState)) hookState[index] = typeof initial === "function" ? initial() : initial;
      return [hookState[index], (value: unknown) => {
        hookState[index] = typeof value === "function" ? value(hookState[index]) : value;
        if (index === 3 && value === null) signal(); // the component's finally cleared busy
      }];
    },
    useRef(initial: unknown) { return { current: initial }; },
    useEffect() {},
  };
  const emails: SentEmailLinks[] = [{ id: emailFixture.id, subject: "Synthetic review", sentOn: "November 6, 2026", links: [original], own: [false], changes: [] }];
  const render = () => { cursor = 0; return allElements(SentLinksEditor({ emails, home: "https://marktmorgen.com/@harbor" })); };
  const fetchBefore = globalThis.fetch;
  let status = 0, apiError = "", requests = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/store/mail/links");
    requests += 1;
    assert.equal(requests, 1);
    const response = await POST(new Request("https://marktmorgen.com/api/store/mail/links", init) as NextRequest);
    status = response.status;
    apiError = (await response.clone().json()).error ?? "";
    return response;
  };
  try {
    const input = render().find(element => element.type === "input")!;
    (input.props!.onChange as (event: unknown) => void)({ target: { value: next } });
    const form = render().find(element => element.type === "form")!;
    (form.props!.onSubmit as (event: unknown) => void)({ preventDefault() {} });
    await settled;
    const rendered = render();
    const live = words(rendered.find(element => element.props?.role === "status"));
    const visible = words(rendered.find(element => element.props?.id === `${emailFixture.id}-0-error`));
    const kept = await readSentLinks(emailFixture.id);
    return { status, apiError, live, visible, writes, requests, destination: kept?.changes.at(-1)?.to, commands };
  } finally {
    globalThis.fetch = fetchBefore;
    internals.H = dispatcher;
    redis.pipeline = pipeline;
  }
}

test("healthy control: a confirmed save announces the destination actually kept", async () => {
  const result = await submitThroughComponent(false);
  assert.equal(result.status, 200);
  assert.equal(result.destination, next);
  assert.equal(result.writes, 1);
  assert.equal(result.live, `Link 1 now goes to ${next}.`);
});

test("an applied write with a lost acknowledgment never announces definitely unchanged", async () => {
  const result = await submitThroughComponent(true);
  console.log("applied-write receipt", JSON.stringify(result));
  assert.equal(result.status, 503);
  assert.equal(result.apiError, "unconfirmed");
  assert.equal(result.destination, next);
  assert.equal(result.writes, 1);
  assert.match(result.visible, /could not confirm/);
  assert.doesNotMatch(result.live, /was not changed|nothing was changed/i);
});
