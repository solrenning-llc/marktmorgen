/** Independent Codex P stage-recovery proof; setup adapted from the author fixture. Synthetic data only. */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/takedown/route";
import { addProduct, addStoreLink, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReport } from "@/lib/takedown-rules";
import { fileReport, openReport } from "@/lib/takedown";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const ORIGIN = "https://marktmorgen.com";
type Sent = { to: string[] | string; subject: string; text: string; key: string };
const sent: Sent[] = [];
/** Every key a send was tried under, whether the provider took it or not. */
const tried: string[] = [];
/**
 * "refused": the provider answers 422, a confirmed refusal, so the same email may be sent again.
 * "unknown": it answers 500, which may follow acceptance, so lib/resend-fallback-transport.ts never posts that email again.
 */
let senderDown: false | "refused" | "unknown" = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    tried.push(key);
    if (senderDown) return new Response(JSON.stringify({ message: "unavailable" }), { status: senderDown === "refused" ? 422 : 500 });
    sent.push({ ...(JSON.parse(String(init?.body)) as Omit<Sent, "key">), key });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

// A read that fails, or that answers nothing, for one key: what a timeout or a lost record looks like.
const realPipeline = redis.pipeline;
let fault: { key: string; mode: "empty" | "undefined" | "set-unapplied" } | null = null;
redis.pipeline = async (commands: (string | number)[][]) => {
  const hit = fault;
  if (hit && commands.some(c => c[1] === hit.key && c[0] === (hit.mode === "set-unapplied" ? "SET" : "GET"))) {
    if (commands.length !== 1) throw Error("proof requires a singleton stage command");
    if (hit.mode === "undefined") return [undefined];
    return []; // No GET result, or no confirmed/applied SET. Never alter another key.
  }
  return realPipeline(commands);
};

const NOTICE = {
  kind: "copyright",
  url: `${ORIGIN}/@unknownshop`,
  work: "My song 'Harbor Lights', played on this page from a SoundCloud upload I did not make.",
  original: "https://example.com/harbor-lights",
  name: "Rita Owner",
  email: "rita@example.com",
  contact: "+1 555 0100",
  signature: "Rita Owner",
  goodFaith: true,
  accurate: true,
};

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";

  const owner = "unknown@example.com";
  await claimHandle(owner, "unknownshop", "Unknown Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestUnknown001", true);
  await setSubscription(owner, { customerId: "cus_Unknown001", subscriptionId: "sub_Unknown001", active: true, period: paidPeriod() });
  const link = await addStoreLink(owner, "My mixtape", "https://soundcloud.com/someone/a-track");
  if (!link.ok) throw new Error("setup: link");
  // More products than the store's first page, so one of them is read from its own record, not the store's.
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const made = await addProduct(owner, `Song Pack ${i + 1}`, "", "9", null);
    if (!made.ok) throw new Error(`setup: product ${i + 1}`);
    ids.push(made.product.id);
  }
  const store = () => storeForEmail(owner).then((s) => s!);
  const onHead = new Set((await store()).catalog.head.map((l) => l.id));
  const far = ids.find((id) => !onHead.has(id));
  const near = ids.find((id) => onHead.has(id));
  if (!far || !near) throw new Error("setup: a product off the first page, and one on it");
  const read = readReport(NOTICE);
  if (!read.ok) throw new Error("setup: notice");
  if ((await fileReport(read.report, "7.7.7.7", ORIGIN)) !== "sent") throw new Error("setup: filed");
  const token = sent[0].text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
  const opened = await openReport(token);
  if (!opened?.store) throw new Error("setup: opened");
  const report = opened.report;
  sent.length = 0;
  tried.length = 0;

  const ask = (action: unknown) => POST(new NextRequest(`${ORIGIN}/api/takedown`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "marktmorgen.com" }, body: JSON.stringify({ token, action }),
  }));
  const answer = async (action: unknown) => {
    const response = await ask(action);
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, error: body.error ?? null, done: body.done ?? null };
  };
  part("Unknown stage reads must not erase a pending creator notice");
  const id = link.store.links[0].id;
  const key = `nl:report:${report.id}:n:link-${id}`;
  senderDown = "refused";
  const first = await answer({ type: "link", id });
  senderDown = false;
  is("control: confirmed provider refusal leaves a durable unsent notice", [first.status, first.error, typeof (await realPipeline([["GET", key]]))[0], sent.length], [500, "notice_unsent", "string", 0]);
  for (const mode of ["empty", "undefined"] as const) {
    fault = {key, mode};
    const retry = await answer({type:"link", id});
    fault = null;
    is(`${mode}: unknown stage read remains an error to retry, never nothing`, [retry.status, retry.error, sent.length], [500, "error", 0]);
  }
  const healthy = await answer({type:"link", id});
  is("control: the same persisted pending notice delivers when readable", [healthy.status, sent.length], [200, 1]);

  part("Unapplied stage writes must stop before destructive content removal");
  const made = await addStoreLink(owner, "Second track", "https://example.com/second-track");
  if(!made.ok) throw Error("setup: second link");
  const second = made.store.links.find(l=>l.title === "Second track")!.id;
  const secondKey = `nl:report:${report.id}:n:link-${second}`;
  sent.length = 0;
  tried.length = 0;
  senderDown = "refused";
  fault = {key:secondKey,mode:"set-unapplied"};
  const uncertain = await answer({type:"link",id:second});
  fault = null;
  senderDown = false;
  const surviving = (await store()).links.some(l=>l.id===second);
  const stored = (await realPipeline([["GET",secondKey]]))[0];
  console.log("unapplied stage writes observation", JSON.stringify({status:uncertain.status,error:uncertain.error,surviving,stored,attempts:tried.length}));
  is("unknown initial stage ACK stops with a storage error", [uncertain.status,uncertain.error], [500,"error"]);
  is("content is preserved until its recovery record is confirmed", surviving, true);
  const recovered = await answer({type:"link",id:second});
  is("healthy retry can still remove content and deliver its notice", [recovered.status,sent.length], [200,1]);
  done();
}
main().catch((error: unknown)=>{console.error(error);process.exit(1)});
