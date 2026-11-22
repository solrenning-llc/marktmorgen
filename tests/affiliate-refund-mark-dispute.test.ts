// A kept refund mark never keeps a dispute that can still be reversed (Codex X4 review of #4430, 13/11/2026).
//
// The affiliate book keeps, on each Stripe sale, what was given back when it was last read on the account the
// sale was paid into (lib/affiliates.ts AFFILIATE_REFUND_MARK), so it still counts once the creator moved to
// another account. A refund only ever grows, and a lost dispute never comes back; but a dispute still open
// (needs_response, under_review, an inquiry) can end won, and its money goes back to the creator. Kept as if it
// were a refund, a dispute later won took the commission off for good after the move, and a dispute still open
// at the last reading was settled as taken, though nobody can read how it ended.
//
// Synthetic store and affiliate, Stripe mocked by account; MemoryRedis (tests/redis-stub.ts).
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { noteCharge, readBook } from "@/lib/affiliates";
import { owedLines } from "@/lib/affiliate-payouts";
import { claimHandle, clearStripeAccount, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_refund_mark_dispute_only";
process.env.RESEND_API_KEY = "re_test_affiliate_refund_mark_dispute_only";

const OLD = "acct_1MarkDisputeOld";
const NEW = "acct_1MarkDisputeNew";
const ANA = "aaaaaaaaaaaa";
const NOW = Math.floor(Date.now() / 1000);

/** Disputes by account: each sale's dispute, in the status the test sets. */
const disputesOn: Record<string, Record<string, unknown>[]> = { [OLD]: [], [NEW]: [] };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const account = new Headers(init?.headers).get("stripe-account") ?? "";
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.pathname === "/v1/disputes") return answer({ object: "list", data: disputesOn[account] ?? [], has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const dispute = (pi: string, status: string) => ({ id: `dp_${pi}`, object: "dispute", status, payment_intent: pi, amount: 10_000, currency: "usd" });
const setDispute = (pi: string, status: string) => {
  disputesOn[OLD] = [...disputesOn[OLD].filter((d) => d.payment_intent !== pi), dispute(pi, status)];
};

/** A store on the old account with Ana's sale `pi`, paid there 200 days ago (past OTHER_ACCOUNT_DAYS). */
async function storeWithSale(owner: string, handle: string, pi: string): Promise<void> {
  await claimHandle(owner, handle, "Mark Dispute", "");
  await ensureStatsId(owner);
  is("old account connected", (await setStripeAccount(owner, OLD, true)).ok, true);
  await setAffiliateSetting(owner, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const statsId = (await storeForEmail(owner))!.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 800 * 86_400) * 1000, decidedAt: 1, note: "" })],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
  ]);
  await noteCharge((await storeForEmail(owner))!, {
    id: pi, status: "succeeded", amount: 10_000, currency: "usd", created: NOW - 200 * 86_400,
    receipt_email: `${pi}@example.com`, metadata: { via: ANA, via_rate: "30", product: "prod01", title: "Bread course" },
  });
}

async function moveToNew(owner: string): Promise<void> {
  await clearStripeAccount(owner);
  is("new account connected", (await setStripeAccount(owner, NEW, true)).ok, true);
}

async function main(): Promise<void> {
  redis.clear();

  part("a dispute under review, then won, read both times on the sale's own account, then a move past the window");
  await storeWithSale("mark-won@example.com", "markwon", "pi_1MarkWon");
  setDispute("pi_1MarkWon", "under_review");
  let book = await readBook((await storeForEmail("mark-won@example.com"))!);
  is("control: while the bank holds the money, the sale earns nothing", book.lines.find((l) => l.pi === "pi_1MarkWon")?.commission, 0);
  setDispute("pi_1MarkWon", "won");
  book = await readBook((await storeForEmail("mark-won@example.com"))!);
  is("control: won, read on its own account, it earns again", book.lines.find((l) => l.pi === "pi_1MarkWon")?.commission, 3_000);
  await moveToNew("mark-won@example.com");
  book = await readBook((await storeForEmail("mark-won@example.com"))!);
  is("after the move, the won dispute takes nothing: the full commission is due", book.lines.find((l) => l.pi === "pi_1MarkWon")?.commission, 3_000);
  is("its line is checked", book.lines.find((l) => l.pi === "pi_1MarkWon")?.unchecked, undefined);
  is("and the payout pays it", owedLines(book).map((l) => l.cents), [3_000]);

  part("a dispute still under review at the last reading on the old account, then a move past the window");
  await storeWithSale("mark-open@example.com", "markopen", "pi_1MarkOpen");
  book = await readBook((await storeForEmail("mark-open@example.com"))!);
  is("control: no dispute yet, it earns", book.lines.find((l) => l.pi === "pi_1MarkOpen")?.commission, 3_000);
  setDispute("pi_1MarkOpen", "under_review");
  book = await readBook((await storeForEmail("mark-open@example.com"))!);
  is("control: under review, it earns nothing for now", book.lines.find((l) => l.pi === "pi_1MarkOpen")?.commission, 0);
  await moveToNew("mark-open@example.com");
  book = await readBook((await storeForEmail("mark-open@example.com"))!);
  is("how the dispute ended cannot be read: the line is held, never settled as taken", book.lines.find((l) => l.pi === "pi_1MarkOpen")?.unchecked, true);
  is("nor paid on the mark kept before the dispute opened", owedLines(book).map((l) => l.cents), []);

  part("an inquiry still open at the last reading can still become a dispute: held after the move too");
  await storeWithSale("mark-inquiry@example.com", "markinquiry", "pi_1MarkInquiry");
  setDispute("pi_1MarkInquiry", "warning_needs_response");
  book = await readBook((await storeForEmail("mark-inquiry@example.com"))!);
  is("control: an inquiry takes nothing yet", book.lines.find((l) => l.pi === "pi_1MarkInquiry")?.commission, 3_000);
  await moveToNew("mark-inquiry@example.com");
  book = await readBook((await storeForEmail("mark-inquiry@example.com"))!);
  is("after the move, the open inquiry's line is held", book.lines.find((l) => l.pi === "pi_1MarkInquiry")?.unchecked, true);
  is("and not paid", owedLines(book).map((l) => l.cents), []);

  part("a dispute lost at the last reading is final: it still takes the commission after the move");
  await storeWithSale("mark-lost@example.com", "marklost", "pi_1MarkLost");
  setDispute("pi_1MarkLost", "lost");
  book = await readBook((await storeForEmail("mark-lost@example.com"))!);
  is("control: lost, it earns nothing", book.lines.find((l) => l.pi === "pi_1MarkLost")?.commission, 0);
  await moveToNew("mark-lost@example.com");
  book = await readBook((await storeForEmail("mark-lost@example.com"))!);
  is("after the move, the lost dispute still takes it", book.lines.find((l) => l.pi === "pi_1MarkLost")?.commission, 0);
  is("its line is checked", book.lines.find((l) => l.pi === "pi_1MarkLost")?.unchecked, undefined);
  is("and nothing is paid", owedLines(book).map((l) => l.cents), []);
  done();
}

void main();
