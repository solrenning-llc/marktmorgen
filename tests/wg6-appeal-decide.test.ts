/**
 * 646 [WG6] unit 3: a person at Marktmorgen answers a creator's request to look again, through the real route
 * (app/api/takedown/appeal), the real notice token (lib/takedown.ts) and the in-memory Redis, with a stubbed email
 * provider. Synthetic stores only. Each part fails on the wrong behavior it names: a request moved without the notice's
 * token or about another notice or store, a final answer without its reason, a move backwards or after a final answer,
 * the creator not emailed (or emailed twice) at a change, an email that failed and was taken for sent, a creator's send
 * that undoes a decision made at the same moment, and an unknown record taken for "no request".
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/takedown/appeal/route";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReport } from "@/lib/takedown-rules";
import { fileReport, openReport, takeDown } from "@/lib/takedown";
import { DECIDE_PROBLEMS, MAX_TELL_TRIES, appealsOfNotice, decisionsOf, fileAppeal, readAppeals, sendAgain } from "@/lib/takedown-appeals";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string[] | string; subject: string; text: string };
const sent: { body: Sent; key: string | null }[] = [];
let mailDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    if (mailDown) return new Response(JSON.stringify({ message: "down" }), { status: 500 });
    sent.push({ body: JSON.parse(String(init?.body)) as Sent, key: new Headers(init?.headers).get("Idempotency-Key") });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const url = `${ORIGIN}/api/takedown/appeal`;

/** A store with one product taken down for a notice, and that notice's token. */
async function takenDown(handle: string) {
  const owner = `${handle}@example.test`;
  await claimHandle(owner, handle, "Synthetic shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Test${handle.slice(0, 8)}0001`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Synthetic Guide", "", "9", null);
  if (!made.ok) throw new Error("setup");
  const read = readReport({
    kind: "copyright", url: `${ORIGIN}/@${handle}`, work: "A synthetic work named in a synthetic notice.", original: "https://example.test/work",
    name: "Synthetic Notifier", email: "notifier@example.test", contact: "+1 555 0100", signature: "Synthetic Notifier", goodFaith: true, accurate: true,
  });
  if (!read.ok) throw new Error("notice");
  sent.length = 0;
  if ((await fileReport(read.report, `9.9.${handle.length}.${handle.charCodeAt(handle.length - 1)}`, ORIGIN)) !== "sent") throw new Error("filed");
  const token = sent[0].body.text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
  const opened = await openReport(token);
  if (!opened?.store) throw new Error("opened");
  await takeDown(opened.report, opened.store, { type: "product", id: made.product.id }, ORIGIN);
  const store = (await storeForEmail(owner))!;
  const decision = decisionsOf(store).find((d) => d.report === opened.report.id)!;
  return { owner, token, report: opened.report, store, decision };
}

async function answer(body: Record<string, unknown>) {
  const response = await POST(new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

const toCreator = (owner: string) => sent.filter((m) => [m.body.to].flat().includes(owner));

async function main() {
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";
  redis.clear();
  const a = await takenDown("decideshopa");
  const filed = await fileAppeal(a.store, a.decision.key, { explanation: "I made this guide myself." }, new Date(), ORIGIN);
  if (!filed.ok) throw new Error("appeal");
  const number = filed.kept.appeal.number;

  part("Only the notice's token, and only this notice's decisions of this store");
  is("no token, a made-up token: nothing moves", [(await answer({ decision: a.decision.key, to: "under_review" })).status, (await answer({ token: "f".repeat(48), decision: a.decision.key, to: "under_review" })).status], [404, 404]);
  const b = await takenDown("decideshopb");
  is("another notice's token cannot reach this store's request", (await answer({ token: b.token, decision: a.decision.key, to: "under_review" })).status, 404);
  is("a decision with no request says so", [(await answer({ token: b.token, decision: b.decision.key, to: "under_review" })).data.message], [DECIDE_PROBLEMS.none]);
  is("still Received", (await readAppeals(a.store)).get(a.decision.key)?.appeal.state, "received");

  part("Each change is emailed to the creator once, with the new state and, at the end, the reason");
  sent.length = 0;
  const review = await answer({ token: a.token, decision: a.decision.key, to: "under_review" });
  is("Under review", [review.status, review.data.state, review.data.emailed], [200, "under_review", true]);
  const first = toCreator(a.owner);
  is("one email to the creator, naming the request and its state, linking to the studio", [first.length, first[0]?.body.subject, first[0]?.body.text.includes("A person at Marktmorgen is looking at your request."), first[0]?.body.text.includes("/studio/appeals")],
    [1, `Your request ${number}: Under review`, true, true]);
  is("under a key of its own for that state", first[0]?.key, `appeal-${number}-under_review-1`);
  const noReason = await answer({ token: a.token, decision: a.decision.key, to: "upheld", reason: "   " });
  is("a final answer without its reason is refused, and nothing is sent", [noReason.status, noReason.data.message, toCreator(a.owner).length], [400, DECIDE_PROBLEMS.reason, 1]);
  const upheld = await answer({ token: a.token, decision: a.decision.key, to: "upheld", reason: "The notice names this exact guide." });
  const second = toCreator(a.owner)[1];
  is("Upheld, with the reason in the email", [upheld.data.state, second?.body.subject, second?.body.text.includes("Why: The notice names this exact guide.")], ["upheld", `Your request ${number}: Upheld`, true]);
  is("a final answer never changes, and nothing goes back", [(await answer({ token: a.token, decision: a.decision.key, to: "reversed", reason: "Changed my mind." })).data.message, (await answer({ token: a.token, decision: a.decision.key, to: "received" })).status],
    [DECIDE_PROBLEMS.final, 400]);
  is("two emails in all", toCreator(a.owner).length, 2);
  const kept = (await readAppeals(a.store)).get(a.decision.key)!;
  is("the record keeps each move, by whom and why", kept.appeal.moves.map((m) => `${m.state}:${m.by}:${m.reason ?? ""}`), ["received:creator:", "under_review:operator:", "upheld:operator:The notice names this exact guide."]);
  is("and the page a person opens lists this request for the notice", (await appealsOfNotice(a.report, a.store)).map((x) => x.kept.appeal.number), [number]);

  part("An email that could not go is never taken for sent, and is sent again a bounded number of times");
  const c = await takenDown("decideshopc");
  const cFiled = await fileAppeal(c.store, c.decision.key, { explanation: "Please look again." }, new Date(), ORIGIN);
  if (!cFiled.ok) throw new Error("appeal c");
  mailDown = true;
  const unsent = await answer({ token: c.token, decision: c.decision.key, to: "reversed", reason: "The guide is the creator's own." });
  is("the state moves, and the answer says the email did not go", [unsent.status, unsent.data.state, unsent.data.emailed], [200, "reversed", false]);
  is("the record says so", (await readAppeals(c.store)).get(c.decision.key)?.creator, { state: "reversed", tries: 1, told: false });
  const tries = [await answer({ token: c.token, decision: c.decision.key, action: "again" }), await answer({ token: c.token, decision: c.decision.key, action: "again" }), await answer({ token: c.token, decision: c.decision.key, action: "again" })];
  is(`at most ${MAX_TELL_TRIES} tries, then it stops trying`, [tries.map((t) => t.data.emailed), (await readAppeals(c.store)).get(c.decision.key)?.creator?.tries], [[false, false, false], MAX_TELL_TRIES]);
  mailDown = false;
  sent.length = 0;
  const d = await takenDown("decideshopd");
  const dFiled = await fileAppeal(d.store, d.decision.key, { explanation: "Please look again." }, new Date(), ORIGIN);
  if (!dFiled.ok) throw new Error("appeal d");
  mailDown = true;
  await answer({ token: d.token, decision: d.decision.key, to: "under_review" });
  mailDown = false;
  sent.length = 0;
  const again = await answer({ token: d.token, decision: d.decision.key, action: "again" });
  is("sent again once the service is back: one email, the second try's key", [again.data.emailed, toCreator(d.owner).length, toCreator(d.owner)[0]?.key], [true, 1, `appeal-${dFiled.kept.appeal.number}-under_review-2`]);
  is("pressed again after it went: no other email", [(await answer({ token: d.token, decision: d.decision.key, action: "again" })).data.emailed, toCreator(d.owner).length], [true, 1]);

  part("A creator's send at the same moment never undoes a decision");
  const e = await takenDown("decideshope");
  mailDown = true;
  const eFiled = await fileAppeal(e.store, e.decision.key, { explanation: "Please look again." }, new Date(), ORIGIN);
  mailDown = false;
  is("the inbox email failed, so the creator may send it again", eFiled.ok, false);
  const holdKey = () => redis.keys().filter((k) => k.startsWith(`nl:report:${e.report.id}:al:`));
  // The creator's send holds the request while it writes; a decision pressed in that moment waits for it.
  const realPipeline = redis.pipeline.bind(redis);
  let decidedMidSend: Awaited<ReturnType<typeof answer>> | null = null;
  let holdName = "";
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (String(commands[0]?.[1]).includes(":al:")) holdName = String(commands[0][1]);
    if (!decidedMidSend && commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith(`nl:report:${e.report.id}:a:`) && commands[0][3] === "XX") {
      redis.pipeline = realPipeline;
      decidedMidSend = await answer({ token: e.token, decision: e.decision.key, to: "under_review" });
    }
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const creatorSend = await sendAgain(e.store, e.decision.key, ORIGIN);
  redis.pipeline = realPipeline;
  const mid = decidedMidSend as Awaited<ReturnType<typeof answer>> | null;
  is("a decision pressed while the creator's send writes is refused as busy, and says to try again", [mid?.status, mid?.data.message], [409, DECIDE_PROBLEMS.busy]);
  is("the creator's send went through, and the hold is gone", [creatorSend?.ok, holdKey().length], [true, 0]);
  const decidedAfter = await answer({ token: e.token, decision: e.decision.key, to: "under_review" });
  const afterSend = (await readAppeals(e.store)).get(e.decision.key)!;
  is("pressed again, the decision lands, and the creator's send is kept with it", [decidedAfter.status, afterSend.appeal.state, afterSend.told], [200, "under_review", true]);
  // And the other way round: a creator's send while a decision is written never writes the old state back.
  await redis.pipeline([["SET", holdName, "1", "EX", 30]]);
  is("while held, a decision is refused and a creator's send is left for later: nothing is written over", [(await answer({ token: e.token, decision: e.decision.key, to: "upheld", reason: "Held." })).status, (await sendAgain(e.store, e.decision.key, ORIGIN))?.ok, (await readAppeals(e.store)).get(e.decision.key)?.appeal.state], [409, true, "under_review"]);
  await redis.pipeline([["DEL", holdName]]);

  part("An unknown record is never 'no request'");
  const f = await takenDown("decideshopf");
  const fFiled = await fileAppeal(f.store, f.decision.key, { explanation: "Please look again." }, new Date(), ORIGIN);
  if (!fFiled.ok) throw new Error("appeal f");
  const recordKeys = redis.keys().filter((k) => k.startsWith(`nl:report:${f.report.id}:a:`));
  await redis.pipeline(recordKeys.map((k) => ["SET", k, "not json"]));
  sent.length = 0;
  const unknown = await answer({ token: f.token, decision: f.decision.key, to: "under_review" });
  is("refused as unknown, nothing emailed", [unknown.status, sent.length], [503, 0]);
  is("and no hold is left behind", redis.keys().filter((k) => k.includes(":al:")).length, 0);

  done();
}

main();
