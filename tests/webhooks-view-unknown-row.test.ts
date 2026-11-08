/**
 * One webhook endpoint whose API key's state cannot be read is shown as "State unknown", on its own row; the rest of
 * the studio's Webhooks section still shows, failed deliveries keep their "Send again" button, and the routes answer
 * with the list, that endpoint marked (lib/webhooks.ts webhooksView; components/webhook-editor.tsx; rule 24).
 * LOW 3 of #3096 (Claude 2, comment 6713512225).
 *
 * Before: one key record or the team record that did not read made webhooksView throw. The studio
 * (app/studio/page.tsx, `webhooksView(current).catch(() => null)`) then left out the whole Webhooks section, its
 * failed rows and their resend buttons with it; the studio route answered 500 after it had saved the change, and
 * DELETE /api/v1/hooks 502 before removing anything.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts); no email or webhook leaves.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as studioRoute } from "@/app/api/store/webhooks/route";
import { DELETE as deleteHook } from "@/app/api/v1/hooks/route";
import { makeKey } from "@/lib/api-keys";
import { makerFor } from "@/lib/api-key-pause";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { type WebhooksView, addEndpoint, emitEvent, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { WebhookEditor } from "@/components/webhook-editor";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 })) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
/** While set, the reply to each command it matches is replaced by what it returns. */
let bend: ((command: (string | number)[], reply: unknown) => unknown) | null = null;
redis.pipeline = (async (commands: Commands) => {
  const replies = await real(commands);
  if (bend) commands.forEach((c, i) => { replies[i] = bend!(c, replies[i]); });
  return replies;
}) as typeof redis.pipeline;

/** How a promise ended: its value, "unknown" for UnknownReplyError, or the other error's message. */
async function outcome<T>(work: Promise<T>): Promise<T | string> {
  try {
    return await work;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw: ${(error as Error).message}`;
  }
}

const HOST = "marktmorgen.com";
const ORIGIN = `https://${HOST}`;
const OWNER = "owner-view-unknown@example.com";

/** What the studio draws: the section from the view, or nothing when the read threw (the page's `.catch(() => null)`). */
function drawn(view: WebhooksView | string): string {
  return typeof view === "string" ? "" : renderToStaticMarkup(createElement(WebhookEditor, { view }));
}
const rows = (view: WebhooksView | string) =>
  typeof view === "string" ? view : view.endpoints.map((e) => [e.where.replace(/^hooks\.example\.com\/?/, ""), e.held ?? "-", e.keyState ?? "-"]);
const count = (text: string, word: string) => text.split(word).length - 1;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "view-unknown-shop", "View Unknown Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ViewUnknown001", subscriptionId: "sub_ViewUnknown001", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const sid = store.sid;
  const maker = makerFor(sid, "owner", OWNER, true);
  const live = await makeKey(sid, "Live sync", Date.now(), false, "none", maker);
  const unread = await makeKey(sid, "Unread sync", Date.now(), false, "none", maker);
  const paused = await makeKey(sid, "Paused sync", Date.now(), false, "none", maker);
  const writer = await makeKey(sid, "Writer", Date.now(), true, "none", maker);
  if (!live.ok || !unread.ok || !paused.ok || !writer.ok) throw new Error("setup: keys not made");
  await real([["HSET", `nl:api:hold:${sid}`, paused.made.id, "paused"]]);
  for (const [url, by] of [["https://hooks.example.com/studio", ""], ["https://hooks.example.com/live", live.made.id], ["https://hooks.example.com/unread", unread.made.id], ["https://hooks.example.com/paused", paused.made.id]]) {
    const added = await addEndpoint(store, url, ["sale.completed"], Date.now(), by);
    if (!added.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added)}`);
  }
  // A sale reaches three endpoints (not the paused key's); no network here, so each waits for its next try. One of
  // them is then written as failed for good, as a delivery is after its last try.
  is("setup: a sale is written for three endpoints", await emitEvent(store, "sale.completed", "cs_test_ViewUnknown01", { amount_cents: 6900 }), 3);
  const healthy = await webhooksView(store);
  is("setup: every key reads, the paused one is paused", rows(healthy), [["studio", "-", "-"], ["live", "-", "-"], ["unread", "-", "-"], ["paused", "paused", "-"]]);
  const studioDelivery = healthy.log.find((d) => d.endpoint.endsWith("/studio"))!;
  const [rawDelivery] = await real([["GET", `nl:hooks:d:${studioDelivery.id}`]]);
  await real([["SET", `nl:hooks:d:${studioDelivery.id}`, JSON.stringify({ ...JSON.parse(String(rawDelivery)), state: "failed", attempts: 7, next: null })]]);

  const list = `nl:api:keys:${sid}`;
  // Only a read that asks for the unread key's record comes back in another shape.
  const oneUnread = (c: (string | number)[], reply: unknown) => (c[0] === "HMGET" && c[1] === list && c.includes(unread.made.id) ? "off-shape" : reply);

  part("One key that cannot be read: its endpoint says state unknown, the rest of the section is unchanged");
  bend = oneUnread;
  const view = await outcome(webhooksView(store));
  bend = null;
  is("webhooksView answers with every endpoint, the unread key's marked unknown, never paused or revoked", rows(view),
    [["studio", "-", "-"], ["live", "-", "-"], ["unread", "-", "unknown"], ["paused", "paused", "-"]]);
  is("the deliveries are all there, the failed one as failed", typeof view === "string" ? view : [view.log.length, view.log.filter((d) => d.state === "failed").length], [3, 1]);
  const page = drawn(view);
  is("the studio draws the Webhooks section with its heading", page.includes('<h2 id="webhooks-title"'), true);
  is("the unread key's endpoint says so in words, once", count(page, "State unknown."), 1);
  is("the paused key's endpoint still says paused, once", count(page, "Paused."), 1);
  is("the failed delivery keeps its Send again button", count(page, ">Send again</button>"), 1);
  is("and the deliveries' heading is still under the section's", /<h2 id="webhooks-title"[\s\S]*<h3[^>]*>Last 3 deliveries<\/h3>/.test(page), true);

  part("A team record that does not read: every API key's endpoint is state unknown, the studio's own is not");
  const team = `nl:team:${sid}`;
  const [teamBefore] = await real([["GET", team]]);
  await real([["SET", team, "{not json"]]);
  const noTeam = await outcome(webhooksView(store));
  is("webhooksView answers, no key's endpoint read as live, paused or revoked", rows(noTeam),
    [["studio", "-", "-"], ["live", "-", "unknown"], ["unread", "-", "unknown"], ["paused", "-", "unknown"]]);
  const noTeamPage = drawn(noTeam);
  is("the studio draws the section, three endpoints say state unknown, the failed delivery keeps its button",
    [noTeamPage.includes('<h2 id="webhooks-title"'), count(noTeamPage, "State unknown."), count(noTeamPage, "Paused."), count(noTeamPage, ">Send again</button>")], [true, 3, 0, 1]);
  await real([typeof teamBefore === "string" ? ["SET", team, teamBefore] : ["DEL", team]]);

  part("The routes answer with the list, the unknown endpoint marked, never an error after the change is made");
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const studioId = healthy.endpoints.find((e) => e.where.endsWith("/studio"))!.id;
  bend = oneUnread;
  const res = await studioRoute(new NextRequest(`${ORIGIN}/api/store/webhooks?store=${sid}`, {
    method: "POST",
    headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "events", id: studioId, events: ["sale.completed", "refund.issued"] }),
  }));
  bend = null;
  const answer = (await res.json()) as { ok?: boolean; error?: string; view?: WebhooksView };
  is("the studio route saves the events and answers 200 with the list, the unread key's endpoint marked",
    [res.status, answer.ok, answer.view ? rows(answer.view) : answer.error],
    [200, true, [["studio", "-", "-"], ["live", "-", "-"], ["unread", "-", "unknown"], ["paused", "paused", "-"]]]);
  const unreadId = healthy.endpoints.find((e) => e.where.endsWith("/unread"))!.id;
  bend = oneUnread;
  const removed = await deleteHook(new Request(`${ORIGIN}/api/v1/hooks`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${writer.key}`, "content-type": "application/json" },
    body: JSON.stringify({ id: unreadId }),
  }));
  bend = null;
  const removedBody = (await removed.json()) as { data?: { id: string; status: string }; error?: string };
  is("DELETE /api/v1/hooks removes the endpoint whose key cannot be read", [removed.status, removedBody.data?.status ?? removedBody.error], [200, "removed"]);
  is("and it is gone from the list", rows(await webhooksView(store)), [["studio", "-", "-"], ["live", "-", "-"], ["paused", "paused", "-"]]);

  part("The studio still draws the section from the view, and the words are plain");
  const studioPage = readFileSync("app/studio/page.tsx", "utf8");
  is("the page reads the view and draws the editor whenever it answered", [/webhooksView\(current\)\.catch\(\(\) => null\)/.test(studioPage), /\{hooks \? <WebhookEditor view=\{hooks\} \/> : null\}/.test(studioPage)], [true, true]);
  const editor = readFileSync("components/webhook-editor.tsx", "utf8");
  is("the unknown line is words, not a color alone", /endpoint\.keyState === "unknown"[\s\S]{0,200}<span className="font-semibold text-ink">State unknown\.<\/span>/.test(editor), true);
  is("the resend button does not depend on the endpoint's key", /d\.state === "failed" && d\.type !== "test" && !d\.givenUp && !d\.resentFrom/.test(editor) && !/keyState[^\n]*Send again|Send again[^\n]*keyState/.test(editor), true);

  done();
}
void main();
