/**
 * A teammate's pipeline restrictions read only from Redis's exact reply (CX-123 rule 24; sweep app1 finding 2,
 * docs/reviews/c5-sweep-app1.md on claude5/sweep-app-1). HGET answers exactly null for a teammate the store never
 * restricted (every pipeline "edit"), or the stored text. Anything else (no reply, an empty or sparse list, an
 * explicit undefined, a number, an object, two replies for one command, a Proxy) is unknown: lib/pipeline-access.ts
 * throws UnknownReplyError, the CRM route answers 503 "unavailable" and changes nothing, and the deals and forms
 * pages (which read it with .catch(() => null)) show no pipeline. Before this, a lost reply read as "no restriction",
 * so a teammate set to "none" could add deals to that pipeline and rewrite its stages.
 *
 * Rule 30 siblings in the same file: readAllPipelineAccess (HGETALL), copyPipelineAccess (a lost reply skipped the
 * copy, so a teammate moving their sign-in lost their restrictions) and writePipelineAccess (a lost "before" was
 * counted as nothing stored). Synthetic only.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/crm/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { DEFAULT_STAGES, FIRST_PIPELINE_ID } from "@/lib/crm-rules";
import { readStages } from "@/lib/crm";
import { copyPipelineAccess, readAllPipelineAccess, readPipelineAccess, writePipelineAccess } from "@/lib/pipeline-access";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Shape = "none" | "empty" | "sparse" | "undefined" | "number" | "object" | "two" | "proxy" | "nonlist";
const realPipeline = redis.pipeline.bind(redis);
let lose: Shape = "none";
let only: string = "HGET";
redis.pipeline = (async (commands: (string | number)[][]) => {
  const asks = commands.length === 1 && commands[0][0] === only && String(commands[0][1]).startsWith("nl:crm:pacc:");
  if (!asks || lose === "none") return realPipeline(commands);
  const real = (await realPipeline(commands)) as unknown[];
  switch (lose) {
    case "empty": return [];
    case "sparse": return Array(1);
    case "undefined": return [undefined];
    case "number": return [1];
    case "object": return [{ [FIRST_PIPELINE_ID]: "edit" }];
    case "two": return [real[0], null];
    case "proxy": return new Proxy([real[0]], {});
    case "nonlist": return { 0: real[0], length: 1 };
  }
}) as typeof redis.pipeline;

const SHAPES: Shape[] = ["empty", "sparse", "undefined", "number", "object", "two", "proxy", "nonlist"];
const unknown = async (run: () => Promise<unknown>) => run().then(() => "answered", (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`));

async function main(): Promise<void> {
  redis.clear();
  const owner = "paccu@example.com";
  await claimHandle(owner, "paccushop", "Pacc U Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestPaccUnk1", true);
  await setSubscription(owner, { customerId: "cus_PaccUnknown01", subscriptionId: "sub_PaccUnknown01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  await putMember(store, "sam@example.com", "support");
  await putMember(store, "kim@example.com", "support");
  const sam = `${SESSION_COOKIE}=${await openSession("sam@example.com")}`;
  const post = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: sam }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  await writePipelineAccess(statsId, "sam@example.com", { [FIRST_PIPELINE_ID]: "none" }, store);
  const renamed = DEFAULT_STAGES.map((stage, i) => (i === 0 ? { ...stage, name: "Taken over" } : stage));
  const deal = (title: string) => ({ action: "deal", deal: { title, email: "", cents: 1_000, stage: "lead00", note: "" } });

  part("Controls: the exact replies");
  is("the stored restriction reads back", await readPipelineAccess(statsId, "sam@example.com"), { [FIRST_PIPELINE_ID]: "none" });
  is("a teammate never restricted (HGET exactly null) edits every pipeline", await readPipelineAccess(statsId, "kim@example.com"), {});
  is("every teammate's restrictions", await readAllPipelineAccess(statsId), { "sam@example.com": { [FIRST_PIPELINE_ID]: "none" } });
  is("Sam, on 'none', is refused a deal and the stages: 403, 403", [(await post(deal("Mine now"))).status, (await post({ action: "stages", stages: renamed })).status], [403, 403]);

  for (const shape of SHAPES) {
    part(`HGET answered in an unknown shape (${shape})`);
    lose = shape;
    is(`(${shape}) reading the restriction throws UnknownReplyError, never "no restriction"`, await unknown(() => readPipelineAccess(statsId, "sam@example.com")), "unknown");
    const added = await post(deal(`Mine now ${shape}`));
    is(`(${shape}) adding a deal: 503 unavailable`, [added.status, added.body.ok, added.body.error], [503, false, "unavailable"]);
    const stages = await post({ action: "stages", stages: renamed });
    is(`(${shape}) rewriting the stages: 503 unavailable`, [stages.status, stages.body.error], [503, "unavailable"]);
    lose = "none";
    is(`(${shape}) the stages are unchanged`, (await readStages(statsId))[0].name, DEFAULT_STAGES[0].name);
  }
  lose = "none";
  is("the owner's restriction is still stored", await readPipelineAccess(statsId, "sam@example.com"), { [FIRST_PIPELINE_ID]: "none" });

  part("Rule 30: every teammate's restrictions (HGETALL)");
  only = "HGETALL";
  for (const shape of SHAPES) {
    lose = shape;
    is(`(${shape}) readAllPipelineAccess throws UnknownReplyError`, await unknown(() => readAllPipelineAccess(statsId)), "unknown");
  }
  lose = "none";

  part("Rule 30: moving a teammate's sign-in copies their restrictions or throws");
  only = "HGET";
  for (const shape of SHAPES) {
    lose = shape;
    const to = `sam-${shape}@example.com`;
    is(`(${shape}) copyPipelineAccess throws UnknownReplyError (the membership then stays on the old address)`, await unknown(() => copyPipelineAccess(store, "sam@example.com", to)), "unknown");
    lose = "none";
    is(`(${shape}) and the new address was not given "no restriction" silently`, await readPipelineAccess(statsId, to), {});
  }
  is("control: a copy over the exact reply carries the restriction", [await copyPipelineAccess(store, "sam@example.com", "sam-ok@example.com"), await readPipelineAccess(statsId, "sam-ok@example.com")], [undefined, { [FIRST_PIPELINE_ID]: "none" }]);
  is("control: copying a teammate never restricted (exactly null) writes nothing", [await copyPipelineAccess(store, "kim@example.com", "kim2@example.com"), await readAllPipelineAccess(statsId).then((all) => Object.hasOwn(all, "kim2@example.com"))], [undefined, false]);

  part("Rule 30: writing a restriction reads what was there exactly");
  for (const shape of SHAPES) {
    lose = shape;
    is(`(${shape}) writePipelineAccess throws UnknownReplyError before taking or giving room`, await unknown(() => writePipelineAccess(statsId, "sam@example.com", {}, store)), "unknown");
    lose = "none";
    is(`(${shape}) and the restriction is still there`, await readPipelineAccess(statsId, "sam@example.com"), { [FIRST_PIPELINE_ID]: "none" });
  }

  part("The pages read it failing closed");
  const deals = readFileSync("app/studio/deals/page.tsx", "utf8");
  const forms = readFileSync("app/studio/forms/page.tsx", "utf8");
  is("the deals and forms pages take a read that throws as null, which shows no pipeline", [deals.includes("readPipelineAccess(store.statsId, view.email).catch(() => null)"), forms.includes("readPipelineAccess(store.statsId, view.email).catch(() => null)")], [true, true]);
  done();
}
main();
