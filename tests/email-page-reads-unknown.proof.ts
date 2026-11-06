/**
 * Proof only (rule 24 candidates on the studio's email page; not in the CI
 * run, wired in tests/test-config.mjs): app/studio/email/page.tsx reads the
 * store's forms, contact fields, pipelines, saved groups and team with
 * `.catch(() => [])` / `{ members: [] }`. This draws the real page against a
 * synthetic store, healthy and then with each of those reads unknown (the
 * lib reader throwing, and a malformed reply that the lib still loosens), and
 * shows (a) what the page and the email studio's props say then, against the
 * healthy control, and (b) whether a save or a send the studio would make
 * from those props writes anything wrong, through the real mail route.
 *
 * Nothing real: the Redis stub, a stand-in fetch, no email, no payment.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import StudioEmailPage from "@/app/studio/email/page";
import { EmailStudio } from "@/components/email-studio";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { saveFlow, type Flow } from "@/lib/flows";
import { readFlowListStrict } from "@/lib/flow-list";
import { listSegments, saveSegment } from "@/lib/segments";
import { flowConfigurationIssues } from "@/lib/flow-review";
import { redisPipeline } from "@/lib/redis";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "email-reads-proof@example.com";
const MATE = "ana-teammate@example.com";
const FORM = "quizform01";
const STAGE = "stgqa1";
const WON = "stgwn1";
const FIELD = "fld001";
const NAMES = ["Quiz follow-up", "Deal nurture", "Hand to Ana"];

type Props = Parameters<typeof EmailStudio>[0];
type Mode = "healthy" | "throw" | "malformed";
type Read = "forms" | "fields" | "pipelines" | "segments" | "team";

/** The EmailStudio element the page hands over, found in the page's tree. */
function studioProps(node: ReactNode): Props | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = studioProps(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.type === EmailStudio) return el.props as unknown as Props;
  for (const value of Object.values(el.props ?? {})) {
    const found = studioProps(value as ReactNode);
    if (found) return found;
  }
  return null;
}

let keys: Record<Read, string>;
/** Which read is unknown now, and how. */
let fault: { read: Read; mode: Exclude<Mode, "healthy"> } | null = null;
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (fault) {
    const key = keys[fault.read];
    const reads = commands.filter((c) => c[1] === key && (c[0] === "GET" || c[0] === "HVALS" || c[0] === "HGET"));
    if (reads.length) {
      if (fault.mode === "throw") throw new Error("Redis request failed with status 503 (synthetic)");
      const answers = await original(commands);
      // A reply in a shape no reader should take as a list: a number where a string or an array belongs.
      return answers.map((answer, i) => (commands[i][1] === key && (commands[i][0] === "GET" || commands[i][0] === "HVALS" || commands[i][0] === "HGET") ? (fault!.read === "pipelines" || fault!.read === "team" ? "{not json" : 42) : answer));
    }
  }
  return original(commands);
}) as typeof redis.pipeline;

async function visit(): Promise<{ props: Props; html: string }> {
  const page = await StudioEmailPage({ searchParams: Promise.resolve({}) });
  const props = studioProps(page);
  if (!props) throw new Error("EmailStudio not found in the page");
  return { props, html: renderToStaticMarkup(page) };
}

/** The body the studio's save() posts for a sequence opened unchanged (toDraft then save, components/email-studio.tsx). */
function saveBodyOf(f: Flow) {
  const productTrigger = f.trigger === "product" || f.trigger === "finished" || f.trigger === "started" || f.trigger === "abandoned";
  return {
    action: "flow",
    flow: {
      id: f.id,
      name: f.name,
      trigger: f.trigger,
      productId: productTrigger ? f.productId : null,
      tag: f.trigger === "tagged" ? f.tag ?? "" : null,
      formId: f.trigger === "form" ? f.formId ?? "" : null,
      formOutcome: f.trigger === "form" ? f.formOutcome ?? "" : "",
      stageId: f.trigger === "stage" ? f.stageId ?? "" : "",
      active: f.active,
      steps: f.steps.map((s) => ({ id: s.id, delayHours: s.delayHours, subject: s.action ? "" : s.subject, body: s.action ? "" : s.body, ...(s.action ? { action: s.action } : {}), ...(s.when ? { when: s.when } : {}), ...(s.next ? { next: s.next } : {}) })),
      goal: f.goal ?? null,
    },
  };
}

let token = "";
async function post(body: Record<string, unknown>) {
  const response = await mailRoute(new NextRequest("https://local.example/api/store/mail", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://local.example", Host: "local.example", Cookie: `${SESSION_COOKIE}=${token}` },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function main(): Promise<void> {
  await claimHandle(OWNER, "emailreads", "Email Reads", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_EmailReads01", subscriptionId: "sub_EmailReads01", active: true, tier: "scale", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Email Reads", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const sid = store.statsId!;
  const list = store.listId!;
  keys = { forms: `nl:forms:${sid}`, fields: `nl:crm:fields:${sid}`, pipelines: `nl:crm:pipes:${sid}`, segments: `nl:mail:segs:${list}`, team: `nl:team:${store.sid}` };

  await redisPipeline([
    ["HSET", keys.forms, FORM, JSON.stringify({ id: FORM, name: "Which plan fits you", fields: [{ id: "email1", type: "email", label: "Your email", required: true }], outcomes: [], updatedAt: 1 })],
    ["SET", keys.fields, JSON.stringify([{ id: FIELD, name: "Budget", type: "text" }])],
    ["SET", keys.pipelines, JSON.stringify([{ id: "sales0", name: "Coaching", stages: [{ id: STAGE, name: "Qualified", kind: "open" }, { id: WON, name: "Signed", kind: "won" }, { id: "stglo1", name: "Gone", kind: "lost" }] }])],
    ["SET", keys.team, JSON.stringify({ members: [{ email: MATE, role: "admin", joinedAt: "2026-11-01" }], invites: [] })],
  ]);
  const savedSegment = await saveSegment(store, { name: "Spring buyers", who: "buyers" });
  const flows = [
    await saveFlow(store, { name: "Quiz follow-up", trigger: "form", formId: FORM, steps: [{ delayHours: 0, subject: "Your result", body: "Thanks for sending the quiz." }] }),
    await saveFlow(store, { name: "Deal nurture", trigger: "stage", stageId: STAGE, steps: [{ delayHours: 0, subject: "", body: "", action: { do: "field", field: FIELD, value: "high" } }, { delayHours: 24, subject: "", body: "", action: { do: "deal", stage: WON, title: "" } }] }),
    await saveFlow(store, { name: "Hand to Ana", trigger: "joined", steps: [{ delayHours: 0, subject: "", body: "", action: { do: "assign", assignee: MATE } }, { delayHours: 1, subject: "", body: "", action: { do: "rotate" } }] }),
  ];
  is("setup: the segment and the three sequences save through the real code", [savedSegment.ok, ...flows.map((r) => (r.ok ? true : r.reason))], [true, true, true, true]);
  const storedBefore = JSON.stringify(await readFlowListStrict(list));
  token = await openSession(OWNER);
  cookieValues.set(SESSION_COOKIE, token);

  part("(a) Healthy control");
  const healthy = await visit();
  const a = healthy.props.automation!;
  is("forms, fields, stages, saved groups, assignees as stored", [a.forms.map((f) => f.id), a.fields.map((f) => f.id), a.stages.map((s) => s.id), (healthy.props.segments ?? []).map((s) => s.name), healthy.props.assignees], [[FORM], [FIELD], [STAGE, WON, "stglo1"], ["Spring buyers"], [OWNER, MATE]]);
  is("no sequence card says a reference is gone", [healthy.html.includes("no longer in your"), healthy.html.includes("Review saved configuration")], [false, false]);
  const issuesOf = (p: Props) => NAMES.map((name) => p.flows.find((f) => f.name === name)!).map((f) => flowConfigurationIssues(f, { products: p.products, courses: p.courses ?? [], paidProducts: p.paidProducts, flows: p.flows, ...p.automation!, assignees: p.assignees }).length);
  is("issues per sequence (editor review, with assignees): none", issuesOf(healthy.props), [0, 0, 0]);

  const rows: string[] = [];
  for (const read of ["forms", "fields", "pipelines", "segments", "team"] as Read[]) {
    for (const mode of ["throw", "malformed"] as const) {
      part(`(a) ${read} unknown: ${mode}`);
      fault = { read, mode };
      const seen = await visit();
      fault = null;
      const p = seen.props;
      const said = {
        forms: p.automation!.forms.map((f) => f.id),
        fields: p.automation!.fields.map((f) => f.id),
        stages: p.automation!.stages.map((s) => s.id),
        segments: (p.segments ?? []).map((s) => s.name),
        assignees: p.assignees,
      };
      const unknownFlag = Object.keys(p).filter((k) => /automation.*(Failed|Unknown)|segments.*(Failed|Unknown)|team.*(Failed|Unknown)|assignees.*(Failed|Unknown)/i.test(k));
      const cards = { formGone: seen.html.includes("a form no longer in your store"), stageGone: seen.html.includes("a stage no longer in your pipelines"), review: (seen.html.match(/Review saved configuration/g) ?? []).length };
      const issues = issuesOf(p);
      console.log(`        props ${JSON.stringify(said)} cards ${JSON.stringify(cards)} issues ${JSON.stringify(issues)} unknown-flag props ${JSON.stringify(unknownFlag)}`);
      is("the page still draws (no error page): the read is swallowed", seen.html.length > 0, true);
      is("no prop tells the studio this read is unknown", unknownFlag, []);
      const expectSaid =
        read === "forms" ? { ...said, forms: [] } :
        read === "fields" ? { ...said, fields: [] } :
        read === "pipelines" ? { ...said, stages: mode === "throw" ? [] : ["lead00", "talk00", "offr00", "won000", "lost00"] } :
        read === "segments" ? { ...said, segments: [] } :
        { ...said, assignees: [OWNER] };
      is(read === "pipelines" && mode === "malformed" ? "said as the default stages (lib/crm.ts readPipelines falls back), not the creator's" : "said as empty, the same as a store that has none", said, expectSaid);
      if (read === "forms") is("the form sequence's card says its form is gone, and asks for a review", [cards.formGone, cards.review >= 1], [true, true]);
      if (read === "pipelines") is("the stage sequence's card says its stage is gone", cards.stageGone, true);
      if (read === "segments") is("saved groups: the picker is not drawn at all", seen.html.includes("Choose a group you saved"), false);
      if (read !== "segments") is("the editor review now lists false issues on sequences that are intact", issues.some((n) => n > 0), true);
      rows.push(`${read}/${mode}: issues ${JSON.stringify(issues)}`);

      part(`(b) ${read} unknown (${mode}): what the studio would save from these props`);
      const target = read === "forms" ? 0 : read === "fields" || read === "pipelines" ? 1 : read === "team" ? 2 : -1;
      const row = target >= 0 ? p.flows.find((f) => f.name === NAMES[target])! : null;
      if (row) {
        const body = saveBodyOf(row);
        // The save body comes from the flow row, never from the automation lists or the assignees.
        is("the save body keeps the trigger and every action reference", [body.flow.formId, body.flow.stageId, JSON.stringify(body.flow.steps.map((s) => s.action ?? null))], [target === 0 ? FORM : null, target === 1 ? STAGE : "", JSON.stringify(row.steps.map((s) => s.action ?? null))]);
        const later = await post(body);
        is("saved later (the read healthy again): accepted, the stored sequences unchanged", [later.status, later.body.ok, JSON.stringify(await readFlowListStrict(list)) === storedBefore], [200, true, true]);
        fault = { read, mode };
        const during = await post(body);
        fault = null;
        const after = JSON.stringify(await readFlowListStrict(list)) === storedBefore;
        console.log(`        saved during the same fault: ${during.status} ${JSON.stringify(during.body)}`);
        is("saved during the same fault: either refused or accepted unchanged, never a different sequence stored", after, true);
      } else {
        // Saved groups: what the studio posts is the composer's own state; the group list only draws a picker and a Remove button.
        const later = await post({ action: "segment-save", name: "Spring buyers", who: "buyers", productId: "", notProductId: "", narrow: null, label: "" });
        const segs = await listSegments(list);
        is("a group saved under the same name later: replaces it by name, one group, same id", [later.status, segs.length, segs[0]?.id === (savedSegment.ok ? savedSegment.segments[0].id : "")], [200, 1, true]);
        fault = { read, mode };
        const during = await post({ action: "segment-save", name: "Spring buyers", who: "leads", productId: "", notProductId: "", narrow: null, label: "" });
        fault = null;
        const segsAfter = await listSegments(list);
        console.log(`        saved during the same fault: ${during.status} ${JSON.stringify(during.body).slice(0, 160)} -> groups now ${JSON.stringify(segsAfter.map((s) => [s.id, s.name, s.who]))}`);
        if (mode === "throw") is("thrown: refused, nothing written", [during.status === 200, segsAfter.length], [false, 1]);
        else is("malformed (lib/segments.ts listSegments loosens it): a second group under the same name is written (lib-side, not the page)", segsAfter.length, 2);
        // Put the one group back for the next rounds.
        if (segsAfter.length > 1) await redisPipeline([["HDEL", keys.segments, ...segsAfter.filter((s) => s.who === "leads").map((s) => s.id)]]);
      }
    }
  }

  part("(b) pipelines malformed: what a creator who follows the warning would save, with the server reading the same fault");
  fault = { read: "pipelines", mode: "malformed" };
  const offered = (await visit()).props.automation!.stages.map((st) => st.id);
  const nurture = (await readFlowListStrict(list)).find((f) => f.name === NAMES[1])!;
  const onlyTrigger = saveBodyOf(nurture);
  onlyTrigger.flow.stageId = offered[0] ?? "";
  const first = await post(onlyTrigger);
  const both = saveBodyOf(nurture);
  both.flow.stageId = offered[0] ?? "";
  both.flow.steps = both.flow.steps.map((st) => (st.action?.do === "deal" ? { ...st, action: { ...st.action, stage: offered[3] ?? "" } } : st));
  const second = await post(both);
  fault = null;
  const stored = (await readFlowListStrict(list)).find((f) => f.name === NAMES[1])!;
  console.log(`        offered ${JSON.stringify(offered)}; trigger only: ${first.status} ${JSON.stringify(first.body).slice(0, 60)}; trigger and deal step: ${second.status} -> stored stageId ${stored.stageId}, deal stage ${JSON.stringify(stored.steps.find((st) => st.action?.do === "deal")?.action)}`);
  is("the editor offers the default stages, not the creator's", offered, ["lead00", "talk00", "offr00", "won000", "lost00"]);
  is("re-picking only the trigger: refused (the deal step's real stage is not in the defaults), nothing written", [first.body.ok, first.body.error], [false, "step"]);
  is("re-picking the trigger and the deal step from what is offered: accepted, and the sequence now points at stages no pipeline of the store has (lib/crm.ts readPipelines and lib/flows.ts saveFlow read loose too)", [second.body.ok, stored.stageId, (stored.steps.find((st) => st.action?.do === "deal")?.action as { stage?: string } | undefined)?.stage], [true, "lead00", "won000"]);
  await post(saveBodyOf(nurture));
  is("put back for the rest", JSON.stringify(await readFlowListStrict(list)) === storedBefore, true);

  part("(b) a send: saved groups and the team never reach who a broadcast goes to");
  const studio = (await import("node:fs")).readFileSync("components/email-studio.tsx", "utf8");
  is("a saved group only fills the composer's own choices (pick), which the send review shows before it goes", [studio.includes("function pick(segment: Segment) {"), studio.includes("Check before it goes out")], [true, true]);
  console.log(`\n        ${rows.join("\n        ")}`);
  done();
}

void main();
