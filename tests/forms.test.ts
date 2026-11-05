/**
 * Forms, surveys and quizzes (lib/forms.ts, added 13 October 2026). What is
 * checked:
 *
 *   - a form is read safely: known kinds of question, choices with two
 *     options at least, results pointed at only when they exist;
 *   - answers are read against the form: required ones present, an address
 *     that is one, choices among the options, a scale from 1 to 10;
 *   - a quiz's result is the one the most answers point at, the first on a tie;
 *   - the file of answers cannot run a formula in a spreadsheet;
 *   - sent from a store's page, the answers are kept, and the person goes on:
 *     to the next step of a funnel, or to their result;
 *   - a product's page cannot hold a form.
 */
import { NextRequest } from "next/server";
import { outcomeOf, parseForm, readAnswers, responsesCsv, safeCell } from "@/lib/forms";
import { readResponses } from "@/lib/form-store";
import { addProduct, claimHandle, ensureStatsId, setSitePages, storeForEmail } from "@/lib/store";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { writePageFunnel } from "@/lib/page-funnel-store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as saveForms } from "@/app/api/store/forms/route";
import { POST as sendForm } from "@/app/api/store/form/route";
import { store as redis } from "./redis-stub";
import { personKey } from "@/lib/person-key";
import { redisPipeline } from "@/lib/redis";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const quiz = {
  id: "quizquiz01",
  name: "Which plan",
  fields: [
    { id: "aaaaaa", type: "email", label: "Your email", required: true },
    { id: "bbbbbb", type: "choice", label: "How much time?", required: true, options: [{ id: "opt001", label: "An hour", outcome: "res001" }, { id: "opt002", label: "A day", outcome: "res002" }] },
    { id: "cccccc", type: "choices", label: "What do you cook?", required: false, options: [{ id: "opt003", label: "Bread", outcome: "res002" }, { id: "opt004", label: "Soup", outcome: "res001" }, { id: "opt005", label: "Cake", outcome: "nope00" }] },
    { id: "dddddd", type: "scale", label: "How sure?", required: false },
    { id: "eeeeee", type: "choice", label: "One option only", required: false, options: [{ id: "opt006", label: "Lonely", outcome: "" }] },
    { id: "ffffff", type: "password", label: "Not a kind", required: false },
  ],
  outcomes: [
    { id: "res001", title: "Quick meals", body: "", product: "" },
    { id: "res002", title: "Weekend baking", body: "", product: "" },
  ],
  offerList: true,
};

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("A form, read safely");
  const form = parseForm(quiz)!;
  is("the questions that mean something, in order", form.fields.map((f) => f.id), ["aaaaaa", "bbbbbb", "cccccc", "dddddd"]);
  is("an answer points only at a result that exists", form.fields[2].options.map((o) => o.outcome), ["res002", "res001", ""]);
  is("the list offered only with an email question", [form.offerList, parseForm({ ...quiz, fields: quiz.fields.slice(1) })?.offerList], [true, false]);
  is("no name, no form; no question, no form", [parseForm({ ...quiz, name: " " }), parseForm({ ...quiz, fields: [] })], [null, null]);

  part("Answers, read against it");
  const sent = (values: Record<string, string[]>) => readAnswers(form, (name) => values[name] ?? []);
  is("a required question left empty", sent({ q_aaaaaa: ["a@example.com"] }), { ok: false, error: "required", field: "bbbbbb" });
  is("an address that is not one", sent({ q_aaaaaa: ["nope"], q_bbbbbb: ["opt001"] }), { ok: false, error: "email", field: "aaaaaa" });
  is("a choice it does not offer", sent({ q_aaaaaa: ["a@example.com"], q_bbbbbb: ["opt999"] }), { ok: false, error: "invalid", field: "bbbbbb" });
  is("a scale past 10", sent({ q_aaaaaa: ["a@example.com"], q_bbbbbb: ["opt001"], q_dddddd: ["11"] }), { ok: false, error: "invalid", field: "dddddd" });
  const good = sent({ q_aaaaaa: ["A@Example.com"], q_bbbbbb: ["opt001"], q_cccccc: ["opt003", "opt004", "opt004"], q_dddddd: ["7"], q_zzzzzz: ["kept nowhere"] });
  is("everything else, kept as the form asks it", good, { ok: true, answers: { aaaaaa: "a@example.com", bbbbbb: "opt001", cccccc: ["opt003", "opt004"], dddddd: 7 }, email: "a@example.com" });

  part("A quiz's result");
  if (!good.ok) throw new Error("no answers");
  is("the result the most answers point at; the first on a tie", [outcomeOf(form, good.answers)?.id, outcomeOf(form, { bbbbbb: "opt002", cccccc: ["opt003"] })?.id, outcomeOf(form, {})], ["res001", "res002", null]);

  part("The file of answers");
  is("a cell that would be a formula is not one", [safeCell("=SUM(A1)"), safeCell("+1"), safeCell("plain"), safeCell('says "hi", twice')], ["'=SUM(A1)", "'+1", "plain", '"says ""hi"", twice"']);
  const csv = responsesCsv(form, [{ at: 0, page: "", answers: good.answers, outcome: "res001", joined: true }]);
  is("a row with the options' words, the result and the list", csv.split("\r\n")[1], "1970-01-01T00:00:00.000Z,a@example.com,An hour,Bread; Soup,7,Quick meals,\"Yes, once they confirm by email\"");

  part("Sent from a store's page");
  const OWNER = "forms@example.com";
  await claimHandle(OWNER, "formshop", "Form Shop", "");
  await ensureStatsId(OWNER);
  const course = await addProduct(OWNER, "Course", "", "99", null);
  if (!course.ok) throw new Error("no product");
  const session = await openSession(OWNER);
  const saved = await (
    await saveForms(new NextRequest("https://marktmorgen.com/api/store/forms", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ form: { ...quiz, id: undefined } }) }))
  ).json();
  is("saved with an id of its own", [saved.ok, typeof saved.form?.id], [true, "string"]);
  const formId = saved.form.id as string;
  await setSitePages(OWNER, [{ id: "pagepage01", slug: "quiz", title: "Quiz", nav: false, target: "", from: 0 }]);
  const store = (await storeForEmail(OWNER))!;
  await writePage(store.statsId!, siteKey("pagepage01"), { ...parsePage({}), blocks: [{ id: "blk001", kind: "form", heading: "", form: formId }] } as never, ROOM);

  const post = (fields: [string, string][]) => {
    const body = new URLSearchParams(fields);
    return sendForm(new NextRequest("https://marktmorgen.com/api/store/form", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.5" }, body }));
  };
  const base: [string, string][] = [["handle", "formshop"], ["form", formId], ["page", "pagepage01"]];
  const missing = await post([...base, ["q_aaaaaa", "b@example.com"]]);
  is("a required question left empty: back to the page, saying so", missing.headers.get("location"), `https://marktmorgen.com/@formshop/quiz?form=${formId}&status=required#form-${formId}`);
  const answered = await post([...base, ["q_aaaaaa", "b@example.com"], ["q_bbbbbb", "opt002"]]);
  is("answered: on to the result", answered.headers.get("location"), `https://marktmorgen.com/@formshop/form/${formId}?p=pagepage01&r=res002`);
  const kept = await readResponses(store.statsId, formId);
  is("and the answers are kept, with the result", [kept.total, kept.responses[0]?.outcome, kept.responses[0]?.answers.aaaaaa], [1, "res002", "b@example.com"]);
  const trap = await post([...base, ["q_aaaaaa", "c@example.com"], ["q_bbbbbb", "opt001"], ["website", "spam"]]);
  is("a robot filling the hidden field is told it worked, and nothing is kept", [trap.status, (await readResponses(store.statsId, formId)).total], [303, 1]);

  // Revisor 2 (#2287): anybody can type an address into a form, so a form sent with a deleted person's address is not
  // their return, and the mark of their deletion stays.
  const deletedMark = `nl:crm:erased:${store.statsId}:${personKey(store.statsId!, "d@example.com")}`;
  await redisPipeline([["SET", deletedMark, String(Date.now() - 60_000), "EX", 3600]]);
  const typed = await post([...base, ["q_aaaaaa", "d@example.com"], ["q_bbbbbb", "opt002"]]);
  is("a form sent with a deleted person's address is kept, and their deletion mark stays", [typed.status, (await redisPipeline([["EXISTS", deletedMark]]))[0]], [303, 1]);
  await redisPipeline([["DEL", deletedMark]]);

  part("A step of a funnel");
  await writePageFunnel(store.statsId!, { id: "funnel0001", name: "Survey", slug: "survey", steps: [{ kind: "page", id: "pagepage01" }, { kind: "product", id: course.product.id }], on: true, since: 1 }, [], ROOM);
  const plain = await (
    await saveForms(new NextRequest("https://marktmorgen.com/api/store/forms", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ form: { name: "Survey", fields: [{ id: "gggggg", type: "short", label: "Your name", required: true }] } }) }))
  ).json();
  await writePage(store.statsId!, siteKey("pagepage01"), { ...parsePage({}), blocks: [{ id: "blk001", kind: "form", heading: "", form: plain.form.id }] } as never, ROOM);
  const onward = await post([["handle", "formshop"], ["form", plain.form.id], ["page", "pagepage01"], ["f", "funnel0001"], ["q_gggggg", "Dana"]]);
  is("a form with no result leads straight on to the next step", onward.headers.get("location"), `https://marktmorgen.com/@formshop/p/course-${course.product.id}?f=funnel0001`);

  part("Not on a product's page");
  const { readFileSync } = await import("node:fs");
  const route = readFileSync("app/api/store/page/route.ts", "utf8");
  is("a product's page refuses a form block", route.includes('page.blocks.some((block) => block.kind === "form")'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
