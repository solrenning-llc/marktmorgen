/**
 * 646 [WG6] unit 2, Codex X5 on #3533 @ad1005e (MÉDIO): the reader of a kept request to look again
 * (lib/takedown-appeals.ts readAppeals) checked that `moves` was an array and that `state` was one of the four
 * names, but never that the two agree. A record whose state says "Reversed" with no move to it, a move by the
 * creator past "Received", a final answer with no reason, a move backwards or a move list that ends somewhere other
 * than its state were all read as a request, and the studio told the creator what such a record says. A kept record
 * is read exactly (rule 24): one whose state its moves do not lead to is unknown, never shown.
 *
 * A real request is filed with fileAppeal into the in-memory Redis; its kept record is then rewritten in place.
 * Synthetic stores and a stubbed email provider only.
 */
import { claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { decisionsOf, fileAppeal, readAppeals } from "@/lib/takedown-appeals";
import { moveAppeal } from "@/lib/takedown-appeal-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const PRODUCT = { at: "2026-11-09T12:00:00.000Z", what: 'The product "Synthetic Guide", now unpublished', report: "0123456789abcdef" };

async function keptKey(): Promise<string> {
  const [reply] = (await redis.pipeline([["SCAN", 0, "MATCH", "*:a:*", "COUNT", 1000]])) as [[string, string[]]];
  const keys = reply[1].filter((k) => !k.includes(":an:"));
  if (keys.length !== 1) throw new Error(`expected one kept request, found ${keys.length}`);
  return keys[0]!;
}

async function rewrite(key: string, change: (kept: { appeal: Record<string, unknown>; told: boolean; tries: number }) => void): Promise<void> {
  const [raw] = (await redis.pipeline([["GET", key]])) as [string];
  const kept = JSON.parse(raw) as { appeal: Record<string, unknown>; told: boolean; tries: number };
  change(kept);
  await redis.pipeline([["SET", key, JSON.stringify(kept)]]);
}

const outcome = async (store: Store) =>
  readAppeals(store).then(
    (found) => [...found.values()].map((kept) => kept.appeal.state).join(",") || "none",
    (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`),
  );

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_appeal_moves_only";
  redis.clear();
  const email = "appeal-moves@example.test";
  await claimHandle(email, "appealmoves", "Synthetic shop", "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  await setSubscription(email, { customerId: "cus_moves", subscriptionId: "sub_moves", active: true, tier: "creator", period: paidPeriod() });
  await noteTakedown(email, PRODUCT);
  const store = (await storeForEmail(email))!;
  const decision = decisionsOf(store)[0]!;
  const filed = await fileAppeal(store, decision.key, { explanation: "I wrote this guide myself." }, new Date("2026-11-10T09:00:00.000Z"), "https://marktmorgen.com");
  // Kept whether or not the inbox email went out (an unsent one is kept and marked so): only the record matters here.
  is("a request is kept (control)", filed.ok || filed.problem === "unsent", true);
  const key = await keptKey();
  const [original] = (await redis.pipeline([["GET", key]])) as [string];
  const restore = () => redis.pipeline([["SET", key, original]]);

  part("Controls: records whose moves lead to their state");
  is("the request as filed: received", await outcome(store), "received");
  const kept = JSON.parse(original) as { appeal: Parameters<typeof moveAppeal>[0] };
  const reviewing = moveAppeal(kept.appeal, "under_review", { role: "operator" }, new Date("2026-11-11T09:00:00.000Z"));
  const reversed = reviewing.ok ? moveAppeal(reviewing.appeal, "reversed", { role: "operator" }, new Date("2026-11-12T09:00:00.000Z"), "The notice named another book.") : reviewing;
  if (!reversed.ok) throw new Error("the synthetic moves were refused");
  await rewrite(key, (k) => { k.appeal = reversed.appeal as unknown as Record<string, unknown>; });
  is("received, under review, reversed with its reason: reversed", await outcome(store), "reversed");
  await restore();

  part("A state its moves do not lead to is unknown, never shown");
  await rewrite(key, (k) => { k.appeal.state = "reversed"; });
  is("Reversed with only the creator's Received", await outcome(store), "unknown");
  await restore();
  await rewrite(key, (k) => { k.appeal.moves = []; });
  is("no move at all", await outcome(store), "unknown");
  await restore();
  await rewrite(key, (k) => {
    k.appeal.state = "upheld";
    (k.appeal.moves as unknown[]).push({ state: "upheld", at: "2026-11-11T09:00:00.000Z", by: "creator", reason: "I decide." });
  });
  is("a final answer moved by the creator", await outcome(store), "unknown");
  await restore();
  await rewrite(key, (k) => {
    k.appeal.state = "upheld";
    (k.appeal.moves as unknown[]).push({ state: "upheld", at: "2026-11-11T09:00:00.000Z", by: "operator" });
  });
  is("a final answer with no reason", await outcome(store), "unknown");
  await restore();
  await rewrite(key, (k) => {
    (k.appeal.moves as unknown[]).push({ state: "upheld", at: "2026-11-11T09:00:00.000Z", by: "operator", reason: "Kept." }, { state: "received", at: "2026-11-12T09:00:00.000Z", by: "operator" });
    k.appeal.state = "received";
  });
  is("a move back after a final answer", await outcome(store), "unknown");
  await restore();
  await rewrite(key, (k) => {
    (k.appeal.moves as unknown[]).push({ state: "under_review", at: "2026-11-11T09:00:00.000Z", by: "operator" });
  });
  is("moves that end under review while the state says received", await outcome(store), "unknown");
  await restore();
  await rewrite(key, (k) => {
    (k.appeal.moves as unknown[])[0] = { state: "under_review", at: "2026-11-10T09:00:00.000Z", by: "creator" };
    k.appeal.state = "under_review";
  });
  is("a first move that is not the creator's Received", await outcome(store), "unknown");
  await restore();
  await rewrite(key, (k) => {
    (k.appeal.moves as unknown[]).push({ state: "under_review", at: 7, by: "operator" });
    k.appeal.state = "under_review";
  });
  is("a move whose time is not a time", await outcome(store), "unknown");
  await restore();
  is("the record put back reads again (control)", await outcome(store), "received");
  done();
}

void main();
