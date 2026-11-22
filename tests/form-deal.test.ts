import { NextRequest } from "next/server";
import { formDealDraft, matchingFormDeals, formDealMatchKey } from "@/lib/form-deal";
import { parseForm } from "@/lib/forms";
import { readResponses, writeForm } from "@/lib/form-store";
import { claimHandle, ensureStatsId, ensureStoreId, setSitePages, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { DEFAULT_STAGES, dealFollowUps, DEFAULT_VIEW } from "@/lib/crm-rules";
import { readDeals } from "@/lib/crm";
import { listCounts } from "@/lib/contacts";
import { POST as submitForm } from "@/app/api/store/form/route";
import { POST as saveCrm } from "@/app/api/store/crm/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const form = parseForm({ id: "formlead01", name: "Project application", fields: [{ id: "email1", type: "email", label: "Email", required: true }, { id: "detail", type: "long", label: "Project", required: true }], offerList: false })!;
  part("Reviewable copy");
  const draft = formDealDraft(form, { at: 1_800_000_000, page: "pagelead01", answers: { email1: "LEAD@example.com", detail: "A new website" }, outcome: "", joined: false });
  is("prefill uses submitted email and source, never an invented value", [draft.title, draft.email, draft.note.includes("Project: A new website"), draft.note.startsWith("Form: Project application"), draft.truncated], ["Project application", "lead@example.com", true, true, false]);
  is("invalid email is left empty for review", formDealDraft(form, { at: 0, page: "", answers: { email1: "not an address" }, outcome: "", joined: false }).email, "");
  const long = formDealDraft(form, { at: 1, page: "", answers: { detail: "x".repeat(2000) }, outcome: "", joined: false });
  is("a long response is bounded and truncation is explicit", [long.note.length, long.truncated], [500, true]);

  part("Existing opportunity review");
  const knownDeals = [{ id: "deal000001", title: "First project", email: "Lead@Example.com", stage: "lead00" }, { id: "deal000002", title: "Another project", email: "other@example.com", stage: "won000" }];
  const matches = matchingFormDeals("  lead@example.com  ", knownDeals);
  is("email matching is normalized and does not match other contacts", matches.map(deal => deal.id), ["deal000001"]);
  is("blank or invalid email does not match unnamed opportunities", [matchingFormDeals("", [...knownDeals, { ...knownDeals[0], email: "" }]).length, matchingFormDeals("invalid", knownDeals).length], [0, 0]);
  is("the acknowledgment changes when email or matching opportunities change", [formDealMatchKey("lead@example.com", matches) === formDealMatchKey("LEAD@example.com", matches), formDealMatchKey("lead@example.com", matches) === formDealMatchKey("other@example.com", matches), formDealMatchKey("lead@example.com", matches) === formDealMatchKey("lead@example.com", knownDeals)], [true, false, false]);
  is("a closed opportunity remains visible for review", matchingFormDeals("other@example.com", knownDeals).map(deal => deal.id), ["deal000002"]);

  part("Submission to reviewed CRM deal");
  const owner = "formcrm@example.com";
  await claimHandle(owner, "formcrmshop", "Form CRM", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSitePages(owner, [{ id: "pagelead01", slug: "apply", title: "Apply", nav: false, target: "", from: 0 }]);
  const store = (await storeForEmail(owner))!;
  await writeForm(store.statsId!, form);
  const beforeCounts = await listCounts(store.listId);
  const body = new URLSearchParams({ handle: store.handle, form: form.id, page: "pagelead01", q_email1: "lead@example.com", q_detail: "A new website" });
  const submitted = await submitForm(new NextRequest("https://marktmorgen.com/api/store/form", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }));
  const responses = await readResponses(store.statsId, form.id);
  is("public submission stores one response and redirects", [submitted.status, responses.total], [303, 1]);
  is("submission alone creates no CRM opportunity", (await readDeals(store.statsId, DEFAULT_VIEW)).length, 0);
  const prefill = formDealDraft(form, responses.responses[0]);
  const session = await openSession(owner);
  const created = await saveCrm(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie: SESSION_COOKIE + "=" + session }, body: JSON.stringify({ action: "deal", deal: { title: prefill.title, email: prefill.email, note: prefill.note, stage: "lead00", cents: 125000, nextAction: "Review form response", dueDate: "2026-10-16", assignee: owner } }) }));
  const saved = await created.json();
  const deals = await readDeals(store.statsId, DEFAULT_VIEW);
  is("explicit reviewed save creates the opportunity in this store", [saved.ok, deals.length, deals[0]?.email, deals[0]?.cents, deals[0]?.nextAction, deals[0]?.note.includes("A new website"), deals[0]?.dueDate, deals[0]?.assignee], [true, 1, "lead@example.com", 125000, "Review form response", true, "2026-10-16", owner]);
  const queue = dealFollowUps(DEFAULT_STAGES, deals, "2026-10-16");
  is("the dated opportunity is ready in today's follow-up queue", [queue.today.map(deal => deal.id), queue.unplanned.length], [[deals[0].id], 0]);
  for (const [change, expected] of [[{ dueDate: "2026-02-30", nextAction: "Call" }, "date"], [{ dueDate: "2026-10-17", nextAction: "" }, "followup"], [{ assignee: "outsider@example.com" }, "assignee"]] as const) {
    const refused = await saveCrm(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie: SESSION_COOKIE + "=" + session }, body: JSON.stringify({ action: "deal", deal: { title: "Invalid follow-up", stage: "lead00", ...change } }) }));
    is("invalid follow-up cannot create another opportunity", [(await refused.json()).error, (await readDeals(store.statsId, DEFAULT_VIEW)).length], [expected, 1]);
  }
  is("creating a deal does not change the marketing list", await listCounts(store.listId), beforeCounts);
  const denied = await saveCrm(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "deal", deal: { title: "Unauthorized", stage: "lead00" } }) }));
  is("signed-out creation is refused without another deal", [denied.status, (await readDeals(store.statsId, DEFAULT_VIEW)).length], [401, 1]);
  part("Server-owned submission identity");
  const now = Date.now;
  const repeatedBody = new URLSearchParams(body); repeatedBody.set("id", "a".repeat(32));
  try {
    Date.now = () => 1_800_000_000_000;
    await Promise.all([0, 1].map(() => submitForm(new NextRequest("https://marktmorgen.com/api/store/form", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: repeatedBody.toString() }))));
  } finally { Date.now = now; }
  const latest = (await readResponses(store.statsId, form.id)).responses.slice(0, 2);
  is("identical same-second public submissions receive distinct persisted IDs", [latest.length, latest.every(response => /^[a-f0-9]{32}$/.test(response.id ?? "")), new Set(latest.map(response => response.id)).size, latest[0]?.at === latest[1]?.at], [2, true, 2, true]);
  is("the public sender cannot choose either submission identity", latest.some(response => response.id === "a".repeat(32)), false);
  is("distinct submission IDs do not create CRM opportunities automatically", (await readDeals(store.statsId, DEFAULT_VIEW)).length, 1);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
