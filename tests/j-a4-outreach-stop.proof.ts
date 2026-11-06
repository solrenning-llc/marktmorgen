/**
 * A4 evidence on base 2bfa8ade8: the public Outreach stop response must never
 * promise a stored stop when Redis did not confirm the write.
 * Real draft writer, public POST, stop reader, SSR page, and next draft writer;
 * MemoryRedis plus synthetic page/model transports only. No email is sent.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/outreach/stop/route";
import StopPage from "@/app/outreach/stop/[token]/page";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { type PageReader, readStopLink, saveSender, startPitch } from "@/lib/outreach";
import { STOP_LINK } from "@/lib/outreach-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
let modelCalls = 0;
const unexpectedHosts: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "api.anthropic.com") {
    unexpectedHosts.push(url.hostname);
    return new Response("{}", { status: 404 });
  }
  modelCalls += 1;
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({
    subject: "A synthetic idea", body: "Hello, I make short cooking videos. Would a sponsored recipe video be of interest?",
  }) }] }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const reader: PageReader = async (url) => new URL(url).pathname === "/robots.txt" ? null : {
  url, html: "<html><body><h1>Synthetic Brand</h1><p>For partnerships and sponsors: partnerships@brand.example.com</p></body></html>",
};
const input = {
  goal: "sponsor" as const, country: "US", isCompany: true,
  page: "https://brand.example.com/contact", email: "partnerships@brand.example.com",
  company: "Synthetic Brand", about: "Synthetic cooking tools", notes: "I make short cooking videos and would feature their tools in a sponsored recipe.",
};

async function scenario(index: number, everyone: boolean, unknown: boolean): Promise<void> {
  part(`${everyone ? "global" : "own-store"} stop / ${unknown ? "unapplied unknown reply" : "healthy exact receipt"}`);
  redis.clear();
  modelCalls = 0;
  unexpectedHosts.length = 0;
  const email = `owner${index}@example.com`;
  const made = await claimHandle(email, `a4store${index}`, `A4 Store ${index}`, "");
  if (!made.ok) throw new Error("synthetic store creation failed");
  await ensureStatsId(email);
  await setSubscription(email, {
    customerId: "cus_A4Synthetic01", subscriptionId: "sub_A4Synthetic01", active: true,
    tier: "pro", trialEnds: 0, period: paidPeriod(Date.now(), { behind: 30, ahead: 300 }),
  });
  const store = await storeForEmail(email);
  if (!store) throw new Error("synthetic store missing");
  const sender = await saveSender(store, { name: `A4 Store ${index}`, address: "PO Box 100, Example City, US" });
  if (!sender) throw new Error("synthetic sender missing");
  const first = await startPitch(store, input, { reader });
  if (!first.ok) throw new Error(`real initial draft failed: ${first.reason}`);
  const token = first.pitch.stop;
  const initial = await readStopLink(token);
  is("real writer made a valid link and one model draft", {
    token: STOP_LINK.test(token), domain: initial?.domain, stopped: initial?.stopped, modelCalls,
  }, { token: true, domain: "brand.example.com", stopped: false, modelCalls: 1 });

  let observed = 0;
  let injected = 0;
  let saddCount = 0;
  let receipts: unknown[] = [];
  redis.pipeline = (async (commands: Commands) => {
    const stopWrites = commands.filter((c) => c[0] === "SADD" && String(c[1]).startsWith("nl:outreach:") && String(c[1]).includes("stop"));
    if (stopWrites.length) {
      observed += 1;
      saddCount += stopWrites.length;
      if (unknown) { injected += 1; return []; }
      const answer = await real(commands);
      receipts = answer.slice(0, stopWrites.length);
      return answer;
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let response: Response;
  try {
    const form = new FormData();
    form.set("p", token);
    form.set("scope", everyone ? "all" : "store");
    response = await POST(new Request("https://marktmorgen.com/api/outreach/stop", {
      method: "POST", body: form,
    }) as NextRequest);
  } finally {
    redis.pipeline = real;
  }
  is("only the stop-writing pipeline is intercepted, with exact healthy SADD controls", {
    observed, injected, saddCount, receipts,
  }, { observed: 1, injected: unknown ? 1 : 0, saddCount: everyone ? 2 : 1,
    receipts: unknown ? [] : everyone ? [1, 1] : [1] });
  const found = await readStopLink(token);
  is("the actual stop reader confirms the injected storage state", {
    stopped: found?.stopped, everyone: found?.everyone,
  }, { stopped: !unknown, everyone: !unknown && everyone });

  const location = response.headers.get("location");
  const redirect = location ? new URL(location) : null;
  const promised = redirect?.searchParams.get("done") === "1";
  const honestResponse = unknown
    ? response.status === 503 || response.status === 303 && redirect?.searchParams.get("done") === "0"
    : response.status === 303 && promised;
  is("the anonymous endpoint promises success only after a confirmed stop", honestResponse, true);
  const query = redirect ? Object.fromEntries(redirect.searchParams) : {};
  const html = renderToStaticMarkup(await StopPage({ params: Promise.resolve({token}), searchParams: Promise.resolve(query) }));
  const saysStopped = /cannot write to you again|Nobody here can write to you|can no longer prepare an email|No store on Marktmorgen can prepare an email/.test(html);
  is("the real SSR page never says an unrecorded stop is effective", saysStopped, !unknown);

  const beforeModel = modelCalls;
  const next = await startPitch(store, input, { reader });
  const modelDelta = modelCalls - beforeModel;
  const nextResult = next.ok ? "draft-created" : next.reason;
  // A truthful failure may permit another draft; the invariant applies when
  // the public response told this business that the stop had succeeded.
  is("a response claiming success forbids another real draft and another model call",
    promised ? { nextResult, modelDelta } : { noSuccessPromise: true },
    promised ? { nextResult: "stopped", modelDelta: 0 } : { noSuccessPromise: true });
  is("no transport other than the synthetic model was requested", unexpectedHosts, []);
  console.log("OBSERVED", JSON.stringify({scope:everyone ? "all" : "store", unknown,
    status:response.status, redirectDone:redirect?.searchParams.get("done"), found,
    saysStopped, nextResult, modelDelta, observed, injected, receipts}));
}

async function main(): Promise<void> {
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-synthetic-a4-only";
  for (const [index, everyone, unknown] of [[1,false,false],[2,true,false],[3,false,true],[4,true,true]] as const) {
    await scenario(index,everyone,unknown);
  }
  done();
}
void main();
