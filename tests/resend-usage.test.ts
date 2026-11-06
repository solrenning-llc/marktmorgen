import { done, is, part } from "./check";
import { withCutoff } from "@/lib/fetch-timeout";

process.env.RESEND_API_KEY = "re_test_provider_usage_only";
const oldFetch = globalThis.fetch;
const at = (seconds: number) => new Date(seconds * 1_000).toISOString();
const metrics = (sent: unknown = 3) => ({
  object: "metrics", start_date: at(100), end_date: at(200),
  metrics: ["sent"], dimensions: [], totals: { sent },
});

async function main(): Promise<void> {
  const { resendAccountUsage, resendUsageSince } = await import("@/lib/resend-usage");

  part("Invalid windows never reach the provider");
  let invalidRequests = 0;
  globalThis.fetch = async () => { invalidRequests += 1; return Response.json({}); };
  for (const [from, through] of [
    [0, Number.MAX_SAFE_INTEGER], [Number.NaN, 200_000], [100_000, 99_999],
    [-1, 200_000], [100_000.5, 200_000], [100_000, Number.POSITIVE_INFINITY],
  ]) {
    is("an invalid or impossible window is unknown", await resendUsageSince(from, through), { ok: false, reason: "unknown" });
  }
  is("invalid windows make no provider request", invalidRequests, 0);

  part("One official aggregate measures sends in the exact UTC window");
  const calls: { url: string; method: string; authorization: string; cache: RequestCache | undefined }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input), method: String(init?.method),
      authorization: String(new Headers(init?.headers).get("authorization")), cache: init?.cache,
    });
    return Response.json(metrics());
  };
  is("the provider sent total is evidence rather than created records or to recipients",
    await resendUsageSince(100_000, 200_000), { ok: true, basis: "provider_sent_metric", sent: 3, from: at(100), through: at(200) });
  const query = new URLSearchParams({ start_date: at(100), end_date: at(200), metrics: "sent", timezone: "UTC" });
  is("one GET asks only sent totals, with dimensions omitted and no pagination", calls, [{
    url: `https://api.resend.com/emails/metrics?${query}`, method: "GET",
    authorization: "Bearer re_test_provider_usage_only", cache: "no-store",
  }]);
  for (const sent of [0, 50_000, Number.MAX_SAFE_INTEGER]) {
    globalThis.fetch = async () => Response.json(metrics(sent));
    is("zero and the largest exact integer require explicit complete evidence",
      await resendUsageSince(100_000, 200_000),  { ok: true, basis: "provider_sent_metric", sent, from: at(100), through: at(200) });
  }

  part("Missing, executable or mismatched evidence never becomes zero");
  let getterCalls = 0;
  const getterTotals = Object.defineProperty({}, "sent", {
    get() { getterCalls += 1; return 0; },
  });
  const getterMetric = Object.defineProperty([], "0", {
    get() { getterCalls += 1; return "sent"; },
  });
  const throwingProxy = new Proxy({}, { getPrototypeOf() { throw new Error("synthetic trap"); } });
  for (const evidence of [
    {}, { ...metrics(), object: "list" }, { ...metrics(), totals: {} },
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, "3", null].map(sent => metrics(sent)),
    { ...metrics(), start_date: at(99) }, { ...metrics(), end_date: at(199) },
    { ...metrics(), start_date: "1970-01-01T00:01:40Z" },
    { ...metrics(), dimensions: ["period"] }, { ...metrics(), dimensions: undefined },
    { ...metrics(), metrics: [] }, { ...metrics(), metrics: ["received"] },
    { ...metrics(), metrics: ["sent", "received"] },
    { ...metrics(), totals: getterTotals }, { ...metrics(), metrics: getterMetric },
    { ...metrics(), totals: { sent: 3, received: 2 } }, { ...metrics(), data: [] },
    throwingProxy,
  ]) {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => evidence }) as Response;
    is("unproven same-window send usage is unknown", await resendUsageSince(100_000, 200_000), { ok: false, reason: "unknown" });
  }
  is("provider getters were not executed", getterCalls, 0);
  globalThis.fetch = async () => new Response("{broken");
  is("invalid JSON remains unknown", await resendUsageSince(100_000, 200_000), { ok: false, reason: "unknown" });

  part("Authorization, failure and a stalled body remain distinct");
  let requests = 0;
  for (const status of [401, 403]) {
    globalThis.fetch = async () => { requests += 1; return new Response("", { status }); };
    is("a send-only key cannot fabricate metrics", await resendUsageSince(100_000, 200_000), { ok: false, reason: "unauthorized" });
  }
  is("authorization is not retried", requests, 2);
  for (const status of [429, 503]) {
    globalThis.fetch = async () => new Response("", { status });
    is("a provider refusal is not absence", await resendUsageSince(100_000, 200_000), { ok: false, reason: "provider" });
  }
  globalThis.fetch = async () => { throw new Error("synthetic network loss"); };
  is("network loss is not absence", await resendUsageSince(100_000, 200_000), { ok: false, reason: "provider" });
  let bodySignal: AbortSignal | null = null;
  globalThis.fetch = async (_input, init) => {
    bodySignal = init?.signal as AbortSignal;
    return { ok: true, status: 200, json: () => new Promise(() => {}) } as Response;
  };
  is("a hung metrics body is bounded by the caller cutoff",
    await withCutoff(Date.now() + 250, () => resendUsageSince(100_000, 200_000)),
    { ok: false, reason: "provider" });
  is("the metrics request signal is aborted while reading its body", (bodySignal as AbortSignal | null)?.aborted, true);

  part("The account usage endpoint is authoritative but never admission");
  let accountRequest: { url: string; authorization: string; cache: RequestCache | undefined } | null = null;
  process.env.RESEND_READ_API_KEY = "re_test_full_read_only";
  globalThis.fetch = async (input, init) => {
    accountRequest = {
      url: String(input),
      authorization: String(new Headers(init?.headers).get("authorization")),
      cache: init?.cache,
    };
    return Response.json({
      object: "usage",
      emails: {
        daily: { used: 11, limit: 100, sent: 8, received: 3, resets_at: "2026-11-01T00:00:00.000Z" },
        monthly: { used: 104, limit: 50_000, sent: 80, received: 24, resets_at: "2026-12-01T00:00:00.000Z" },
      },
    });
  };
  is("official daily and monthly counters retain sent, received, limits and reset boundaries",
    await resendAccountUsage(),
    {
      ok: true,
      daily: { used: 11, limit: 100, sent: 8, received: 3, resetsAt: "2026-11-01T00:00:00.000Z" },
      monthly: { used: 104, limit: 50_000, sent: 80, received: 24, resetsAt: "2026-12-01T00:00:00.000Z" },
    });
  is("usage uses the separate full-access read key without cache",
    accountRequest,
    { url: "https://api.resend.com/usage", authorization: "Bearer re_test_full_read_only", cache: "no-store" });

  let usageGetterCalls = 0;
  const usageGetter = Object.defineProperty({}, "daily", {
    get() { usageGetterCalls += 1; return {}; },
  });
  for (const account of [
    {},
    { object: "usage", emails: usageGetter },
    { object: "usage", emails: {
      daily: { used: 12, limit: 100, sent: 8, received: 3, resets_at: "2026-11-01T00:00:00.000Z" },
      monthly: { used: 104, limit: 50_000, sent: 80, received: 24, resets_at: "2026-12-01T00:00:00.000Z" },
    } },
    { object: "usage", emails: {
      daily: { used: 11, limit: 100, sent: 8, received: 3, resets_at: "tomorrow" },
      monthly: { used: 104, limit: 50_000, sent: 80, received: 24, resets_at: "2026-12-01T00:00:00.000Z" },
    } },
  ]) {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => account }) as Response;
    is("malformed authoritative usage is unknown", await resendAccountUsage(), { ok: false, reason: "unknown" });
  }
  is("usage evidence getters were not executed", usageGetterCalls, 0);
  globalThis.fetch = async () => new Response("", { status: 401 });
  is("a send-only key cannot fabricate usage", await resendAccountUsage(), { ok: false, reason: "unauthorized" });
  delete process.env.RESEND_READ_API_KEY;

  part("Billing periods and body deadlines keep their own meaning");
  globalThis.fetch = async () => Response.json({
    object: "usage", emails: {
      daily: { used: 0, limit: null, sent: 0, received: 0, resets_at: "2026-11-02T00:00:00.000Z" },
      monthly: { used: 104, limit: 50_000, sent: 80, received: 24, resets_at: "2026-11-17T15:30:00.000Z" },
    },
  });
  is("a billing reset need not be the start of a calendar month", await resendAccountUsage(), {
    ok: true,
    daily: { used: 0, limit: null, sent: 0, received: 0, resetsAt: "2026-11-02T00:00:00.000Z" },
    monthly: { used: 104, limit: 50_000, sent: 80, received: 24, resetsAt: "2026-11-17T15:30:00.000Z" },
  });
  globalThis.fetch = async (_input, init) => {
    bodySignal = init?.signal as AbortSignal;
    return { ok: true, status: 200, json: () => new Promise(() => {}) } as Response;
  };
  is("a hung account usage body is bounded by the same cutoff",
    await withCutoff(Date.now() + 250, () => resendAccountUsage()),
    { ok: false, reason: "provider" });
  is("the account usage request signal is aborted during its body", (bodySignal as AbortSignal | null)?.aborted, true);
  delete process.env.RESEND_API_KEY;
  is("missing credentials never become zero", await resendUsageSince(100_000, 200_000), { ok: false, reason: "not_configured" });
  is("missing account credentials never become zero", await resendAccountUsage(), { ok: false, reason: "not_configured" });

  globalThis.fetch = oldFetch;
  done();
}
main().catch((error) => {
  globalThis.fetch = oldFetch;
  console.error(error);
  process.exit(1);
});
