/**
 * CX-123 rule 24, BAIXA items of the tolerant-reads inventory: the questions a
 * store's pages could not answer (lib/answers.ts missedQuestions) feed two AI
 * requests, the page review (app/api/store/ai/route.ts, kind "review") and the
 * funnel draft and research (lib/funnel-ai.ts readFunnelFacts). When that list
 * cannot be read, it was taken as "no questions" (`.catch(() => [])`), so the
 * model and the creator were told nothing about them, as if there were none.
 * Now an unread list is unknown: readFunnelFacts keeps it as null, both prompts
 * say it could not be read, and the research's limits say so to the creator.
 * The same flow's description read (readAbout) no longer becomes an empty
 * description, which the draft's checks would call a product with nothing
 * said about it: an unread description refuses the request before any model
 * call (rule 30). Synthetic store; the model is a stand-in for fetch.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setProductAbout, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as AI } from "@/app/api/store/ai/route";
import { funnelType } from "@/lib/funnel-types";
import { readFunnelFacts, researchLimits } from "@/lib/funnel-ai";
import { keepAnswer } from "@/lib/answers";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Command = (string | number)[];
const asked: { system: string; content: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  const body = JSON.parse(String(init?.body)) as { system: string; messages: { content: string }[] };
  asked.push({ system: body.system, content: body.messages[0].content });
  return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }));
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
let missedKey = "";
let aboutKey = "";
let breakMissed = false;
let breakAbout = false;
redis.pipeline = (async (batch: Command[]) => {
  if (breakMissed && batch.length === 1 && batch[0][0] === "LRANGE" && batch[0][1] === missedKey) return ["OK"];
  if (breakAbout && batch.length === 1 && batch[0][0] === "GET" && batch[0][1] === aboutKey) return [];
  return real(batch);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  const OWNER = "unreadquestions@example.com";
  await claimHandle(OWNER, "unreadq", "Unread Questions", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_UnreadQ01", subscriptionId: "sub_UnreadQ01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const starter = await addProduct(OWNER, "Pricing Checklist", "A one-page checklist for pricing design work.", "9", null);
  const main = await addProduct(OWNER, "Pricing Course", "Six lessons on pricing and pitching.", "99", null);
  if (!starter.ok || !main.ok) throw new Error("no products");
  const store = (await storeForEmail(OWNER))!;
  missedKey = `nl:ask:missed:${store.statsId}`;
  aboutKey = `nl:product:about:${store.statsId}:${main.product.id}`;
  await keepAnswer(store, "h1", "x", { productId: main.product.id, question: "Is there a printable workbook?", now: Date.now() });
  const type = funnelType("first-purchase")!;
  const picked = { starter: starter.product.id, main: main.product.id };
  const session = await openSession(OWNER);
  const post = (body: Record<string, unknown>) =>
    AI(new NextRequest("https://marktmorgen.com/api/store/ai", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const lastPrompt = () => asked.at(-1)?.content ?? "";

  part("The list read: its questions reach the funnel and the review");
  const read = await readFunnelFacts(store, type, picked);
  is("the funnel's facts hold the kept question", read.ok ? read.facts.unanswered?.map((row) => row.question) : read.error, ["Is there a printable workbook?"]);
  is("the research's limits say nothing about an unread list", read.ok ? researchLimits(read.facts).some((line) => /could not be read just now/.test(line)) : null, false);
  asked.length = 0;
  await post({ kind: "funnel", type: type.id, products: picked, audience: "", offer: "", proof: "", notes: "", emails: false });
  is("the draft's prompt names the question", lastPrompt().includes("Is there a printable workbook?"), true);
  asked.length = 0;
  await post({ kind: "review", product: main.product.id, page: { blocks: [] }, notes: "" });
  is("the review's prompt names the question", lastPrompt().includes("Is there a printable workbook?"), true);

  part("The list unread: unknown, never 'no questions'");
  breakMissed = true;
  const unread = await readFunnelFacts(store, type, picked);
  is("the funnel's facts keep the list unknown (null), not empty", read.ok && unread.ok ? unread.facts.unanswered : "refused", null);
  is("the research's limits say the questions could not be read", unread.ok ? researchLimits(unread.facts).some((line) => /questions visitors asked[^.]*could not be read just now/i.test(line)) : null, true);
  asked.length = 0;
  await post({ kind: "funnel", type: type.id, products: picked, audience: "", offer: "", proof: "", notes: "", emails: false });
  is("the draft's prompt says the questions could not be read", /Questions visitors asked these pages[^\n]*could not be read just now/.test(lastPrompt()), true);
  is("and names no question", lastPrompt().includes("Is there a printable workbook?"), false);
  asked.length = 0;
  await post({ kind: "review", product: main.product.id, page: { blocks: [] }, notes: "" });
  is("the review's prompt says the questions could not be read", /visitors asked this page[^\n]*could not be read just now/.test(lastPrompt()), true);
  is("and names no question", lastPrompt().includes("Is there a printable workbook?"), false);
  breakMissed = false;

  part("A description unread: refused before any model call, never an empty description");
  const flagged = await setProductAbout(OWNER, main.product.id, true);
  if (!flagged.ok) throw new Error("about flag");
  const withAbout = (await storeForEmail(OWNER))!;
  breakAbout = true;
  const refused = await readFunnelFacts(withAbout, type, picked).then(() => "read", (error) => (error instanceof UnknownReplyError ? "unknown" : String(error)));
  is("the facts are not read with the description taken as empty", refused, "unknown");
  breakAbout = false;
  const whole = await readFunnelFacts(withAbout, type, picked);
  is("once it reads again, the facts are read", whole.ok, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
