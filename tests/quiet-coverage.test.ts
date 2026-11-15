import { checkQuiet, isQuiet, saleTimes } from "@/lib/quiet-sales";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_quiet_coverage";
process.env.RESEND_API_KEY = "re_test_quiet_coverage";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const now = Date.UTC(2026, 9, 20, 12);
const day = 86_400_000;
const store = { handle: "harbor", previousHandles: [], name: "Harbor", email: "owner@example.com", stripeAccountId: "acct_test", subscriptionActive: true } as unknown as Store;
let pages: unknown[] = [];
let calls = 0;
let emails = 0;
let fail = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") { emails++; return new Response('{"id":"test"}'); }
  if (fail) return new Response('{}', { status: 500 });
  return new Response(JSON.stringify(pages[Math.min(calls++, pages.length - 1)]));
}) as typeof fetch;
const paid = (id: string, at: number) => ({ id, created: at / 1000, status: "complete", payment_status: "paid", metadata: { store: "harbor" } });
async function read(list: unknown[]) { pages = list; calls = 0; return saleTimes(store, now); }
async function main() {
  is("confirmed empty history stays empty", await read([{ data: [], has_more: false }]), []);
  is("missing history stays unavailable", await read([{ has_more: false }]), null);
  is("missing pagination state stays unavailable", await read([{ data: [] }]), null);
  is("empty page with more results stays unavailable", await read([{ data: [], has_more: true }]), null);
  is("missing cursor stays unavailable", await read([{ data: [paid("", now - 20 * day)], has_more: true }]), null);
  is("paid checkout without its date stays unavailable", await read([{ data: [{ ...paid("cs_1", now), created: null }], has_more: false }]), null);
  // Three distinct pages that each promise more (a repeated page would now stop at its repeated id, before the cap).
  is("capped history stays unavailable", await read([1, 2, 3].map((i) => ({
    data: [paid(`cs_${i}`, now - (19 + i) * day)], has_more: true,
  }))), null);
  is("history cap remains three calls", calls, 3);
  is("complete third page is available", await read([
    { data: [paid("cs_1", now - 20 * day)], has_more: true },
    { data: [paid("cs_2", now - 30 * day)], has_more: true },
    { data: [paid("cs_3", now - 40 * day)], has_more: false },
  ]), [now - 20 * day, now - 30 * day, now - 40 * day]);
  is("other stores and unpaid sessions excluded", await read([{ data: [paid("cs_1", now - day), { ...paid("cs_2", now - day), payment_status: "unpaid" }, { ...paid("cs_3", now - day), metadata: { store: "elsewhere" } }], has_more: false }]), [now - day]);
  is("a checkout with unknown payment state leaves the history unknown", await read([{
    data: [{ ...paid("cs_recent", now - day), payment_status: null }], has_more: false,
  }]), null);
  is("a checkout with unknown status leaves the history unknown", await read([{
    data: [{ ...paid("cs_recent", now - day), status: "processing" }], has_more: false,
  }]), null);
  is("a paid checkout without readable metadata leaves the history unknown", await read([{
    data: [{ ...paid("cs_recent", now - day), metadata: "harbor" }], has_more: false,
  }]), null);
  is("a paid checkout with an unreadable store mark leaves the history unknown", await read([{
    data: [{ ...paid("cs_recent", now - day), metadata: { store: 7 } }], has_more: false,
  }]), null);
  is("a paid checkout dated in the future leaves the history unknown", await read([{
    data: [paid("cs_future", now + day)], has_more: false,
  }]), null);
  is("a repeated checkout cannot inflate the baseline", await read([{
    data: [paid("cs_repeated", now - 42 * day), paid("cs_repeated", now - 42 * day)], has_more: false,
  }]), null);
  is("a repeated checkout across pages leaves the history unknown", await read([
    { data: [paid("cs_repeated", now - 42 * day)], has_more: true },
    { data: [paid("cs_repeated", now - 42 * day)], has_more: false },
  ]), null);
  is("open, expired and unpaid checkouts are not sales", await read([{ data: [
    paid("cs_1", now - day),
    { ...paid("cs_2", now - day), status: "open", payment_status: "unpaid" },
    { ...paid("cs_3", now - day), status: "expired", payment_status: "unpaid" },
    { ...paid("cs_4", now - day), payment_status: "no_payment_required" },
  ], has_more: false }]), [now - day]);
  const times = Array.from({ length: 30 }, (_, i) => now - (20 + i) * day);
  is("complete quiet history still qualifies", isQuiet(times, now).quiet, true);
  redis.clear(); pages = [{ data: times.map((at, i) => paid(`cs_${i}`, at)), has_more: true }]; calls = 0;
  is("partial reading skips notification", await checkQuiet(store, now), "skipped");
  is("no email from partial history", emails, 0);
  redis.clear(); fail = true;
  is("provider failure skips notification", await checkQuiet(store, now), "skipped");
  is("no email from provider failure", emails, 0);
  fail = false;
  redis.clear(); pages = [{ data: [...times.map((at, i) => paid(`cs_${i}`, at)),
    { ...paid("cs_recent", now - day), payment_status: null }], has_more: false }]; calls = 0;
  is("an unreadable recent checkout cannot send a quiet-sales alert", await checkQuiet(store, now), "skipped");
  is("an unreadable recent checkout did not send an email", emails, 0);
  emails = 0;
  redis.clear(); pages = [{ data: Array.from({ length: 8 }, () => paid("cs_same", now - 42 * day)), has_more: false }]; calls = 0;
  is("eight copies of one sale do not qualify for an alert", await checkQuiet(store, now), "skipped");
  is("the repeated checkout did not send an email", emails, 0);
  emails = 0;
  redis.clear(); pages = [{ data: times.map((at, i) => paid(`cs_${i}`, at)), has_more: false }]; calls = 0;
  is("complete quiet reading sends notification", await checkQuiet(store, now), "sent");
  is("exactly one mocked email", emails, 1);
  is("daily deduplication retained", await checkQuiet(store, now), "seen");
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
