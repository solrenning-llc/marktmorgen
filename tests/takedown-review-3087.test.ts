/**
 * The review findings on #3087 (7 November 2026): a takedown's recovery record is read and written only in its exact
 * shape, the strike is written once per takedown, and the email still owed never takes content down again.
 *
 *   P1  (Codex P, review 5814594030): a steps GET that answers nothing ([] or [undefined]) is not "nothing owed".
 *   P2  (Codex P): a steps SET whose reply is not "OK" stops before the content is touched, so nothing is removed
 *       without its recovery record; a healthy retry then takes it down and tells the creator.
 *   C6-1 (Claude 6, comment 6712347123): unsentNotices throws on an unknown SMEMBERS or steps reply, never [].
 *   C6-2 (Claude 6): a strike is written once per takedown, even when the write after it fails and the press is retried.
 *   C6-3 (Claude 6): "Send the email to the creator" only finishes the kept steps and never takes anything down:
 *       content that is up again (a store switched back on, a product published again) stays up and gets no new
 *       strike. Its statement of reasons is still owed (EU DSA Art. 17(1): owed once the restriction was imposed, even
 *       if lifted since), so it stays listed, with a note that it is back up, and the press sends it once, in the kept
 *       words, under the takedown's own idempotency key (coordinator's legal correction, 7 Nov 2026).
 *   G   (Claude 6, focal 6713440905): the steps are written before the content is touched, so they say a takedown
 *       started, not that it is down. When the store write fails before it lands, the owed button sends no email and
 *       writes no strike, and the page does not list it as taken down; when the write landed without being confirmed,
 *       the content is down and the owed button finishes it (one strike, one email); old steps with no `applied`
 *       field are read the same way.
 *   LOW1 the owed list says what is known: "Taken down, but we could not confirm the creator was told".
 *   LOW2 the page keeps working when the owed list cannot be read, and says so.
 *   LOW3 the owed set's SADD/EXPIRE replies are checked: unknown stops before the content is touched.
 *
 * The P1/P2 cases are ported from Codex P's proof (tests/p-review-3087-stage-evidence.proof.ts at f28a752a, branch
 * codex/p-review-3087-stage-evidence), with credit; its setup was adapted from this PR's own fixture. The C6 cases are
 * written from Claude 6's review text (its proof file was local to that review).
 *
 * Synthetic store, in-memory Redis, the email provider stood in by fetch. No network.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/takedown/route";
import { addProduct, addStoreLink, claimHandle, ensureStatsId, setProductHidden, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReport } from "@/lib/takedown-rules";
import { fileReport, openReport, unsentNotices } from "@/lib/takedown";
import { KIND } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const ORIGIN = "https://marktmorgen.com";
type Sent = { to: string[] | string; subject: string; text: string; key: string };
const sent: Sent[] = [];
const tried: string[] = [];
let senderDown: false | "refused" = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    tried.push(key);
    if (senderDown) return new Response(JSON.stringify({ message: "unavailable" }), { status: 422 });
    sent.push({ ...(JSON.parse(String(init?.body)) as Omit<Sent, "key">), key });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

type Commands = (string | number)[][];
const realPipeline = redis.pipeline;
/** A stand-in answer for one pipeline, or undefined to let the in-memory Redis answer it. */
let fault: ((commands: Commands) => unknown[] | "throw" | undefined) | null = null;
redis.pipeline = async (commands: Commands) => {
  const hit = fault?.(commands);
  if (hit === "throw") throw new Error("Redis request timed out (test)");
  if (hit !== undefined) return hit;
  return realPipeline(commands);
};
const on = (op: string, key: string, also: (c: (string | number)[]) => boolean = () => true) =>
  (commands: Commands) => commands.some((c) => c[0] === op && c[1] === key && also(c));

const NOTICE = {
  kind: "copyright",
  url: `${ORIGIN}/@reviewshop`,
  work: "My song 'Harbor Lights', played on this page from a SoundCloud upload I did not make.",
  original: "https://example.com/harbor-lights",
  name: "Rita Owner",
  email: "rita@example.com",
  contact: "+1 555 0100",
  signature: "Rita Owner",
  goodFaith: true,
  accurate: true,
};

const settle = <T>(work: Promise<T>) => work.then((value) => ({ value }), () => "threw" as const);

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";

  const owner = "review@example.com";
  await claimHandle(owner, "reviewshop", "Review Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestReview001", true);
  await setSubscription(owner, { customerId: "cus_Review001", subscriptionId: "sub_Review001", active: true, period: paidPeriod() });
  const links: string[] = [];
  for (const title of ["First track", "Second track", "Third track", "Fourth track", "Fifth track", "Sixth track", "Seventh track", "Eighth track", "Ninth track"]) {
    const made = await addStoreLink(owner, title, `https://example.com/${title.toLowerCase().replace(" ", "-")}`);
    if (!made.ok) throw new Error(`setup: ${title}`);
    links.push(made.store.links.find((l) => l.title === title)!.id);
  }
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const made = await addProduct(owner, `Song Pack ${i + 1}`, "", "9", null);
    if (!made.ok) throw new Error(`setup: product ${i + 1}`);
    ids.push(made.product.id);
  }
  const store = () => storeForEmail(owner).then((s) => s!);
  const read = readReport(NOTICE);
  if (!read.ok) throw new Error("setup: notice");
  if ((await fileReport(read.report, "7.7.7.8", ORIGIN)) !== "sent") throw new Error("setup: filed");
  const token = sent[0].text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
  const opened = await openReport(token);
  if (!opened?.store) throw new Error("setup: opened");
  const report = opened.report;
  sent.length = 0;
  tried.length = 0;

  const answer = async (action: unknown, owed = false) => {
    const response = await POST(new NextRequest(`${ORIGIN}/api/takedown`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "marktmorgen.com" },
      body: JSON.stringify(owed ? { token, action, owed: true } : { token, action }),
    }));
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, error: body.error ?? null, done: body.done ?? null };
  };
  const stepsKey = (part: string) => `nl:report:${report.id}:n:${part}`;
  const owedKey = `nl:report:${report.id}:n`;
  const linkUp = async (id: string) => (await store()).links.some((l) => l.id === id);
  const strikes = async () => (await store()).strikes.filter((s) => s.report === report.id).length;
  const published = async (id: string) => ((await store()).catalog.items.find((p) => p.id === id)?.kind ?? KIND.hidden) & KIND.hidden ? "unpublished" : "published";
  const owedNow = async () => settle(unsentNotices(report, await store()));

  part("P1: a steps read that answers nothing is not \"nothing owed\" (Codex P)");
  {
    const id = links[0];
    const key = stepsKey(`link-${id}`);
    senderDown = "refused";
    const first = await answer({ type: "link", id });
    senderDown = false;
    is("control: a confirmed refusal leaves a durable unsent notice", [first.status, first.error, typeof (await realPipeline([["GET", key]]))[0], sent.length], [500, "notice_unsent", "string", 0]);
    for (const mode of ["empty", "undefined"] as const) {
      fault = (commands) => (on("GET", key)(commands) ? (mode === "empty" ? [] : [undefined]) : undefined);
      const retry = await answer({ type: "link", id });
      fault = null;
      is(`${mode}: an error to retry, never 409 "nothing"`, [retry.status, retry.error, sent.length], [500, "error", 0]);
    }
    const healthy = await answer({ type: "link", id });
    is("control: readable again, the notice goes out once", [healthy.status, sent.length], [200, 1]);
  }

  part("P2: a steps write that is not confirmed stops before the content is touched (Codex P)");
  {
    const id = links[1];
    const key = stepsKey(`link-${id}`);
    sent.length = 0;
    tried.length = 0;
    senderDown = "refused";
    fault = (commands) => (on("SET", key)(commands) ? [] : undefined);
    const uncertain = await answer({ type: "link", id });
    fault = null;
    senderDown = false;
    is("an unconfirmed steps write: a storage error, not notice_unsent", [uncertain.status, uncertain.error], [500, "error"]);
    is("the link is still up, and no email was tried", [await linkUp(id), tried.length], [true, 0]);
    for (const [name, reply] of [["[null]", [null]], ['["QUEUED"]', ["QUEUED"]], ["[1]", [1]]] as const) {
      fault = (commands) => (on("SET", key)(commands) ? [...reply] : undefined);
      const odd = await answer({ type: "link", id });
      fault = null;
      is(`a steps write answered ${name}: an error, the link still up`, [odd.status, odd.error, await linkUp(id)], [500, "error", true]);
    }
    const recovered = await answer({ type: "link", id });
    is("a healthy retry takes it down and tells the creator", [recovered.status, await linkUp(id), sent.length], [200, false, 1]);
  }

  part("LOW3: the owed set's SADD and EXPIRE are checked");
  {
    const id = links[2];
    sent.length = 0;
    for (const [name, reply] of [["[]", []], ["[1]", [1]], ["[1, 0]", [1, 0]], ["[undefined, 1]", [undefined, 1]], ['["1", 1]', ["1", 1]]] as const) {
      fault = (commands) => (on("SADD", owedKey)(commands) ? [...reply] : undefined);
      const odd = await answer({ type: "link", id });
      fault = null;
      is(`the owed set answered ${name}: an error, the link still up, nothing sent`, [odd.status, odd.error, await linkUp(id), sent.length], [500, "error", true, 0]);
    }
    const healthy = await answer({ type: "link", id });
    is("healthy: taken down and told", [healthy.status, await linkUp(id), sent.length], [200, false, 1]);
  }

  part("C6-1: the owed list never reads an unknown as nothing owed (Claude 6)");
  {
    const id = links[3];
    senderDown = "refused";
    const first = await answer({ type: "link", id });
    senderDown = false;
    is("setup: one notice owed", first.error, "notice_unsent");
    for (const [name, reply] of [["[]", []], ["[undefined]", [undefined]], ["[null]", [null]], ['["link-x"]', ["link-x"]], ["[{}]", [{}]]] as const) {
      fault = (commands) => (on("SMEMBERS", owedKey)(commands) ? [...reply] : undefined);
      const listed = await owedNow();
      fault = null;
      is(`SMEMBERS answered ${name}: it throws, never []`, listed, "threw");
    }
    for (const [name, reply] of [["[]", []], ["[undefined]", [undefined]]] as const) {
      fault = (commands) => (on("GET", stepsKey(`link-${id}`))(commands) ? [...reply] : undefined);
      const listed = await owedNow();
      fault = null;
      is(`the steps GET answered ${name}: it throws, never skipped`, listed, "threw");
    }
    const listed = await owedNow();
    is("healthy: the owed notice is listed", listed === "threw" ? "threw" : listed.value.map((o) => o.action), [{ type: "link", id }]);
  }

  part("C6-2: one strike per takedown, even when the write after it fails (Claude 6)");
  {
    const id = links[4];
    const key = stepsKey(`link-${id}`);
    sent.length = 0;
    const before = await strikes();
    fault = (commands) => (on("SET", key, (c) => String(c[2]).includes('"noted":true'))(commands) ? "throw" : undefined);
    const first = await answer({ type: "link", id });
    fault = null;
    const second = await answer({ type: "link", id });
    is("the first press fails after the strike, the retry finishes", [first.status, first.error, second.status], [500, "error", 200]);
    is("one strike, one email", [(await strikes()) - before, sent.length], [1, 1]);
  }

  part("C6-3, store: the owed email never switches a store off again, and is still sent (Claude 6; DSA Art. 17(1))");
  {
    sent.length = 0;
    tried.length = 0;
    senderDown = "refused";
    const off = await answer({ type: "store", on: true });
    senderDown = false;
    is("setup: switched off, the notice refused", [off.status, off.error, Boolean((await store()).suspended)], [500, "notice_unsent", true]);
    const before = await strikes();
    const back = await answer({ type: "store", on: false });
    is("the operator switches it back on", [back.status, Boolean((await store()).suspended)], [200, false]);
    const listed = await owedNow();
    is("a store back on stays listed as owed, marked as up again", listed === "threw" ? "threw" : listed.value.filter((o) => o.action.type === "store").map((o) => o.up ?? false), [true]);
    is("restoring keeps its owed entry", ((await realPipeline([["SMEMBERS", owedKey]]))[0] as string[]).includes("store-"), true);
    sent.length = 0;
    const press = await answer({ type: "store", on: true }, true);
    is("the owed press sends the statement and says Done", [press.status, press.done], [200, "Your store's pages and sales, now switched off"]);
    is("and the store stays on, with no new strike and one email to the creator", [Boolean((await store()).suspended), (await strikes()) - before, sent.length, [sent[0]?.to].flat()], [false, 0, 1, [owner]]);
    const storeKeys = [...new Set(tried.filter((k) => k.startsWith(`takedown-${report.id}-store--`)))];
    is("under the same idempotency key as the refused try", storeKeys.length, 1);
    const again = await answer({ type: "store", on: true }, true);
    is("pressed again: nothing to do, nothing sent, the store still on", [again.status, again.error, sent.length, Boolean((await store()).suspended)], [409, "nothing", 1, false]);
    const after = await owedNow();
    is("and it is no longer listed", after === "threw" ? "threw" : after.value.some((o) => o.action.type === "store"), false);
  }

  part("C6-3, product: the owed email never unpublishes a product published again, and is still sent (Claude 6; DSA Art. 17(1))");
  {
    const id = ids[0];
    sent.length = 0;
    senderDown = "refused";
    const first = await answer({ type: "product", id });
    senderDown = false;
    is("setup: unpublished, the notice refused", [first.status, first.error, await published(id)], [500, "notice_unsent", "unpublished"]);
    if (!(await setProductHidden(owner, id, false)).ok || (await published(id)) !== "published") throw new Error("setup: the product did not publish again");
    const before = await strikes();
    const listed = await owedNow();
    is("a product published again stays listed as owed, marked as up again", listed === "threw" ? "threw" : listed.value.filter((o) => o.action.type === "product" && o.action.id === id).map((o) => o.up ?? false), [true]);
    const press = await answer({ type: "product", id }, true);
    is("the owed press sends the statement and says Done", [press.status, press.done], [200, "The product \"Song Pack 1\", now unpublished"]);
    is("and the product stays published, with no new strike and one email", [await published(id), (await strikes()) - before, sent.length], ["published", 0, 1]);
    const again = await answer({ type: "product", id }, true);
    is("pressed again: nothing to do, still published", [again.status, again.error, sent.length, await published(id)], [409, "nothing", 1, "published"]);
  }

  part("The owed press, when the content is still down, only sends the kept notice");
  {
    const id = links[5];
    sent.length = 0;
    tried.length = 0;
    senderDown = "refused";
    const first = await answer({ type: "link", id });
    senderDown = false;
    is("setup: down, the notice refused", [first.error, await linkUp(id)], ["notice_unsent", false]);
    const before = await strikes();
    const press = await answer({ type: "link", id }, true);
    is("the owed press sends it and says Done", [press.status, sent.length, [...new Set(tried)].length], [200, 1, 1]);
    is("no new strike", (await strikes()) - before, 0);
    const again = await answer({ type: "link", id }, true);
    is("pressed again after it went out: nothing to do, nothing sent", [again.status, again.error, sent.length], [409, "nothing", 1]);
    const unknownItem = await answer({ type: "product", id: ids[2] }, true);
    is("an owed press for content never taken down takes nothing down", [unknownItem.status, unknownItem.error, await published(ids[2]), sent.length], [409, "nothing", "published", 1]);
  }

  part("C6-2, store: a skipped strike still switches the store off");
  {
    const key = stepsKey("store-");
    sent.length = 0;
    const before = await strikes();
    if ((await store()).suspended) throw new Error("setup: the store should be on");
    fault = (commands) => (on("SET", key, (c) => String(c[2]).includes('"noted":true'))(commands) ? "throw" : undefined);
    const first = await answer({ type: "store", on: true });
    fault = null;
    is("the first press fails after the strike, and the store is off", [first.status, first.error, Boolean((await store()).suspended)], [500, "error", true]);
    const second = await answer({ type: "store", on: true });
    is("the retry finishes: one strike, one email, the store still off", [second.status, (await strikes()) - before, sent.length, Boolean((await store()).suspended)], [200, 1, 1, true]);
  }

  // The next pipeline after the owed set is written fails: the store write times out before it lands.
  const failAfterOwed = () => {
    let armed = false;
    fault = (commands) => {
      if (armed) {
        fault = null;
        return "throw";
      }
      if (on("SADD", owedKey)(commands)) armed = true;
      return undefined;
    };
  };
  /** Whether the page lists that takedown as owed ("threw" when the list cannot be read). */
  const lists = async (part: string) => {
    const listed = await owedNow();
    return listed === "threw" ? "threw" : listed.value.some((o) => `${o.action.type}-${"id" in o.action ? o.action.id : ""}` === part);
  };

  part("G, link: the owed button never tells of a takedown that did not land (Claude 6, focal 6713440905)");
  {
    const id = links[6];
    sent.length = 0;
    const before = await strikes();
    failAfterOwed();
    const first = await answer({ type: "link", id });
    fault = null;
    is("the store write timed out: an error, and the link is still up", [first.status, first.error, await linkUp(id)], [500, "error", true]);
    is("the page does not list it as taken down", await lists(`link-${id}`), false);
    const press = await answer({ type: "link", id }, true);
    is("the owed press does not answer Done", press.status === 200, false);
    is("no email, no strike, the link still up", [sent.length, (await strikes()) - before, await linkUp(id)], [0, 0, true]);
    const real = await answer({ type: "link", id });
    is("the normal button still takes it down and tells the creator once", [real.status, await linkUp(id), sent.length, (await strikes()) - before], [200, false, 1, 1]);
  }

  part("G, product: the owed button never tells of an unpublish that did not land (Claude 6, focal 6713440905)");
  {
    const id = ids[1];
    sent.length = 0;
    const before = await strikes();
    failAfterOwed();
    const first = await answer({ type: "product", id });
    fault = null;
    is("the store write timed out: an error, and the product is still published", [first.status, first.error, await published(id)], [500, "error", "published"]);
    is("the page does not list it as taken down", await lists(`product-${id}`), false);
    const press = await answer({ type: "product", id }, true);
    is("the owed press does not answer Done", press.status === 200, false);
    is("no email, no strike, still published", [sent.length, (await strikes()) - before, await published(id)], [0, 0, "published"]);
  }

  part("G: a takedown that landed without being confirmed is finished by the owed button");
  {
    const id = links[7];
    const key = stepsKey(`link-${id}`);
    sent.length = 0;
    const before = await strikes();
    fault = (commands) => (on("SET", key, (c) => String(c[2]).includes('"applied":true'))(commands) ? "throw" : undefined);
    const first = await answer({ type: "link", id });
    fault = null;
    is("the link went, but its mark was not confirmed: an error, nothing sent", [first.status, first.error, await linkUp(id), sent.length], [500, "error", false, 0]);
    is("the page lists it as taken down, owed", await lists(`link-${id}`), true);
    const press = await answer({ type: "link", id }, true);
    is("the owed press finishes it: Done, one strike, one email", [press.status, (await strikes()) - before, sent.length], [200, 1, 1]);
  }

  part("G: steps kept before the `applied` field, content down, are finished");
  {
    const id = links[8];
    const key = stepsKey(`link-${id}`);
    sent.length = 0;
    const before = await strikes();
    const at = String(Date.now() - 60_000);
    await realPipeline([["SET", key, JSON.stringify({ what: 'The link "Ninth track" (https://example.com/ninth-track)', howLong: "How long: for good.", at, noted: false, counted: false, sent: false }), "EX", 3600]]);
    await realPipeline([["SADD", owedKey, `link-${id}`]]);
    const { removeStoreLink } = await import("@/lib/store");
    const gone = await removeStoreLink(owner, id);
    if (!gone.ok || (await linkUp(id))) throw new Error("setup: the link did not go");
    is("listed as owed", await lists(`link-${id}`), true);
    const press = await answer({ type: "link", id }, true);
    is("the owed press finishes it: Done, one strike, one email", [press.status, (await strikes()) - before, sent.length], [200, 1, 1]);
  }

  part("LOW1, LOW2: the page says only what is known");
  {
    const page = readFileSync("app/takedown/[token]/page.tsx", "utf8");
    is("the owed list's heading", page.includes("Taken down, but we could not confirm the creator was told"), true);
    is("the old heading is gone", page.includes("the creator was not told yet"), false);
    is("an owed list that cannot be read is said, and the page goes on", page.includes("We could not check whether an email to the creator is still owed."), true);
    is("the owed button presses the owed path", /label="Send the email to the creator"[^>]*owed|owed[^>]*label="Send the email to the creator"/.test(page), true);
    is("the owed button says honestly when no email was sent because the takedown was not confirmed", readFileSync("components/takedown-actions.tsx", "utf8").includes("we could not confirm it was taken down"), true);
    is("content up again is noted, still owed", page.includes("It is back up now; the email still explains why it was taken down."), true);
    is("no answer refuses the owed email for content up again", [readFileSync("components/takedown-actions.tsx", "utf8").includes("up_again"), readFileSync("app/api/takedown/route.ts", "utf8").includes("up_again")], [false, false]);
  }
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
