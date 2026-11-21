/**
 * Scored quizzes (lib/forms.ts, added 17 October 2026). What is checked:
 *
 *   - a scored quiz is read safely: points whole from 0 to MAX_POINTS,
 *     categories only when they exist, a score range on every result; a form
 *     that is not scored reads exactly as it did before;
 *   - negative, fractional or too-large points are refused, not changed;
 *   - the total and each category's part are the points of the options
 *     chosen, on the questions a person's answers led through only;
 *   - with no scored question answered, nothing is measured: no result;
 *   - the ranges must cover every total from 0 to the highest possible
 *     exactly once: gaps, overlaps, equal ranges, a range that ends below its
 *     start, one nobody can reach and a quiz with no points are each found;
 *   - a total on a boundary belongs to the range that includes it, and on a
 *     tie the first result in the creator's order wins;
 *   - the result page shows only a score that could be true for its result;
 *   - the studio refuses to save a quiz whose ranges are wrong, and says why;
 *   - a funnel file carries a scored quiz whole, and refuses one whose ranges
 *     are wrong;
 *   - sent from a store's page, the total and categories are kept with the
 *     answers, shown on the result page's address, put in the spreadsheet,
 *     and kept from the browser.
 */
import { NextRequest } from "next/server";
import { MAX_POINTS, badPoints, evenRanges, maxScore, outcomeOf, parseForm, readScoreQuery, responsesCsv, scoreOf, tierFor, tierIssueText, tierIssues, type FormDef } from "@/lib/forms";
import { readResponses } from "@/lib/form-store";
import { claimHandle, ensureStatsId, setSitePages, storeForEmail } from "@/lib/store";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as saveForms } from "@/app/api/store/forms/route";
import { POST as sendForm } from "@/app/api/store/form/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { readBundle } from "@/lib/funnel-bundle";

const quiz = {
  id: "scorequiz1",
  name: "Launch readiness",
  scoring: "points",
  categories: [
    { id: "catmnd", name: "Mindset" },
    { id: "catmkt", name: "Marketing" },
    { id: "catmnd", name: "Twice" },
    { id: "bad", name: "No id" },
  ],
  fields: [
    { id: "aaaaaa", type: "email", label: "Your email", required: true },
    { id: "bbbbbb", type: "choice", label: "Do you have an audience?", required: false, options: [{ id: "opt001", label: "No", points: 0, category: "catmkt" }, { id: "opt002", label: "Some", points: 5, category: "catmkt" }, { id: "opt003", label: "Yes", points: 10, category: "catmkt" }] },
    { id: "cccccc", type: "choices", label: "What have you done?", required: false, options: [{ id: "opt004", label: "Picked a topic", points: 2, category: "catmnd" }, { id: "opt005", label: "Set a date", points: 3, category: "catmnd" }, { id: "opt006", label: "Nothing yet", points: 0, category: "nope00" }] },
    { id: "dddddd", type: "scale", label: "How sure?", required: false },
  ],
  outcomes: [
    { id: "res001", title: "Start here", body: "", product: "", min: 0, max: 4 },
    { id: "res002", title: "Almost there", body: "", product: "", min: 5, max: 9 },
    { id: "res003", title: "Ready to launch", body: "", product: "", min: 10, max: 15 },
  ],
  offerList: false,
};

const withRanges = (form: FormDef, ranges: [number, number][]): FormDef => ({ ...form, outcomes: ranges.map(([min, max], i) => ({ id: `res00${i + 1}`, title: `R${i + 1}`, body: "", product: "", min, max })) });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("A scored quiz, read safely");
  const form = parseForm(quiz)!;
  is("scored, with the categories that are whole and once each", [form.scoring, form.categories], ["points", [{ id: "catmnd", name: "Mindset" }, { id: "catmkt", name: "Marketing" }]]);
  is("points and categories kept; a category that does not exist is dropped", form.fields[2].options.map((o) => [o.points, o.category ?? ""]), [[2, "catmnd"], [3, "catmnd"], [0, ""]]);
  is("each result keeps its range", form.outcomes.map((o) => [o.min, o.max]), [[0, 4], [5, 9], [10, 15]]);
  const voting = parseForm({ ...quiz, scoring: undefined })!;
  is("a form that is not scored has none of it", [voting.scoring, voting.categories, voting.fields[1].options[0], voting.outcomes[0]], [undefined, undefined, { id: "opt001", label: "No", outcome: "" }, { id: "res001", title: "Start here", body: "", product: "" }]);
  is("in a scored quiz an answer points at no result: the points decide", parseForm({ ...quiz, fields: [{ id: "bbbbbb", type: "choice", label: "Q", options: [{ id: "opt001", label: "A", outcome: "res001", points: 1 }, { id: "opt002", label: "B", points: 2 }] }] })!.fields[0].options[0].outcome, "");

  part("Points: whole, from 0, never negative");
  const withPoints = (points: unknown) => ({ ...quiz, fields: [{ id: "bbbbbb", type: "choice", label: "Q", options: [{ id: "opt001", label: "A", points }, { id: "opt002", label: "B", points: 1 }] }] });
  is("0 and the most are fine", [badPoints(withPoints(0)), badPoints(withPoints(MAX_POINTS))], [false, false]);
  is("negative, fractional, too many and words are refused", [badPoints(withPoints(-1)), badPoints(withPoints(1.5)), badPoints(withPoints(MAX_POINTS + 1)), badPoints(withPoints("5"))], [true, true, true, true]);
  is("a form that is not scored is not asked about points", badPoints({ ...withPoints(-1), scoring: undefined }), false);
  is("parsed alone, unreadable points count as 0", parseForm(withPoints(-3))!.fields[0].options[0].points, 0);

  part("The score");
  is("the most possible: a choice's best option, every option of several", maxScore(form), { total: 15, categories: { catmnd: 5, catmkt: 10 } });
  const all = scoreOf(form, { aaaaaa: "a@example.com", bbbbbb: "opt002", cccccc: ["opt004", "opt005", "opt006"], dddddd: 9 });
  is("the total, each category's part, and how many scored questions were answered", all, { total: 10, categories: { catmnd: 5, catmkt: 5 }, answered: 2 });
  is("an option in no category counts in the total only", scoreOf(form, { cccccc: ["opt006"] }), { total: 0, categories: { catmnd: 0, catmkt: 0 }, answered: 1 });
  is("a form that is not scored has no score", scoreOf(voting, { bbbbbb: "opt002" }), null);

  part("No answer, and the edges of a range");
  is("nothing scored was answered: no result, not the result for 0", [scoreOf(form, { aaaaaa: "a@example.com" })?.answered, outcomeOf(form, { aaaaaa: "a@example.com" })], [0, null]);
  is("answering with 0 points is measured: the result for 0", outcomeOf(form, { bbbbbb: "opt001" })?.id, "res001");
  is("a total on a boundary belongs to the range that includes it", [tierFor(form, 4)?.id, tierFor(form, 5)?.id, tierFor(form, 9)?.id, tierFor(form, 10)?.id, tierFor(form, 15)?.id], ["res001", "res002", "res002", "res003", "res003"]);
  is("the result follows the total", outcomeOf(form, { bbbbbb: "opt003", cccccc: ["opt005"] })?.id, "res003");
  const tie = withRanges(form, [[0, 15], [0, 15]]);
  is("two results for one total: the first in the creator's order, and the check says so", [tierFor(tie, 7)?.id, tierIssues(tie).map((i) => i.kind)], ["res001", ["overlap"]]);

  part("Branching: a skipped question's points do not count");
  const branching = parseForm({
    ...quiz,
    fields: [
      { id: "bbbbbb", type: "choice", label: "Selling yet?", required: true, options: [{ id: "opt001", label: "No", points: 0, next: "end" }, { id: "opt002", label: "Yes", points: 5 }] },
      { id: "cccccc", type: "choice", label: "How much?", required: false, options: [{ id: "opt003", label: "Some", points: 2 }, { id: "opt004", label: "A lot", points: 10 }] },
    ],
  })!;
  is("an answer after the quiz ended is not counted", scoreOf(branching, { bbbbbb: "opt001", cccccc: "opt004" })?.total, 0);
  is("on the way through, it is", scoreOf(branching, { bbbbbb: "opt002", cccccc: "opt004" })?.total, 15);

  part("Every total, exactly once");
  is("a quiz whose ranges cover 0 to 15 once is fine", tierIssues(form), []);
  is("a form that is not scored is never checked", tierIssues(voting), []);
  is("a gap at the start", tierIssues(withRanges(form, [[1, 15]])), [{ kind: "gap", from: 0, to: 0 }]);
  is("a gap in the middle", tierIssues(withRanges(form, [[0, 4], [7, 15]])), [{ kind: "gap", from: 5, to: 6 }]);
  is("a gap at the top", tierIssues(withRanges(form, [[0, 4], [5, 12]])), [{ kind: "gap", from: 13, to: 15 }]);
  is("an overlap, with both results named", tierIssues(withRanges(form, [[0, 6], [5, 15]])), [{ kind: "overlap", from: 5, to: 6, outcomes: ["res001", "res002"] }]);
  is("a range inside another overlaps it", tierIssues(withRanges(form, [[0, 15], [3, 4]])), [{ kind: "overlap", from: 3, to: 4, outcomes: ["res001", "res002"] }]);
  is("a range that ends below its start", tierIssues(withRanges(form, [[0, 15], [9, 3]])).map((i) => i.kind), ["inverted"]);
  is("a range nobody can reach", tierIssues(withRanges(form, [[0, 15], [16, 20]])), [{ kind: "unreachable", outcome: "res002" }]);
  is("a range past the top is fine when it starts within it", tierIssues(withRanges(form, [[0, 9], [10, 99]])), []);
  is("no results at all", tierIssues({ ...form, outcomes: [] }), [{ kind: "none" }]);
  const pointless = parseForm({ ...quiz, fields: [{ id: "bbbbbb", type: "choice", label: "Q", options: [{ id: "opt001", label: "A", points: 0 }, { id: "opt002", label: "B", points: 0 }] }], outcomes: [{ id: "res001", title: "All", min: 0, max: 0 }] })!;
  is("no answer carries points", tierIssues(pointless), [{ kind: "unscored" }]);
  is("said in words, with the results' titles", tierIssues(withRanges(form, [[0, 6], [5, 12]])).map((i) => tierIssueText(withRanges(form, [[0, 6], [5, 12]]), i)), [
    "“R1” and “R2” both cover scores 5 to 6. Each score needs exactly one result.",
    "No result covers scores 13 to 15. Widen a range so every score has a result.",
  ]);
  is("spreading evenly covers every total once", [evenRanges(15, 3), tierIssues(withRanges(form, evenRanges(15, 3).map((r) => [r.min, r.max])))], [[{ min: 0, max: 4 }, { min: 5, max: 9 }, { min: 10, max: 15 }], []]);
  is("more results than totals cannot each have their own: the check says so", tierIssues(withRanges(form, evenRanges(1, 3).map((r) => [r.min, r.max]))).map((i) => i.kind), ["overlap", "gap"]);

  part("The score the result page shows");
  const r2 = form.outcomes[1];
  is("a total its result's range holds, with the categories", readScoreQuery(form, r2, "7", "catmnd-2.catmkt-5"), { total: 7, top: 15, categories: [{ id: "catmnd", name: "Mindset", points: 2, top: 5 }, { id: "catmkt", name: "Marketing", points: 5, top: 10 }] });
  is("a total outside this result's range shows no score", readScoreQuery(form, r2, "12", ""), null);
  is("a total past the most possible, or not a number, shows none", [readScoreQuery(form, form.outcomes[2], "16", ""), readScoreQuery(form, r2, "-7", ""), readScoreQuery(form, r2, "7.5", "")], [null, null, null]);
  is("a category past its most, or unknown, is left out", readScoreQuery(form, r2, "7", "catmnd-9.zzzzzz-1.catmkt-x")?.categories, []);

  part("The file of answers");
  const csv = responsesCsv(form, [{ at: 0, page: "", answers: { aaaaaa: "a@example.com", bbbbbb: "opt002" }, outcome: "res002", joined: false, score: 5, scores: { catmnd: 0, catmkt: 5 } }]).split("\r\n");
  is("a score column, one for each category, then the result", [csv[0], csv[1]], ['"Sent","Your email","Do you have an audience?","What have you done?","How sure?","Score","Score: Mindset","Score: Marketing","Result"', '"1970-01-01T00:00:00.000Z","a@example.com","Some","","","5","0","5","Almost there"']);

  part("In a funnel file");
  const starter = FUNNEL_STARTERS.find((s) => s.bundle.forms.length > 0)!;
  const scoredFile = (outcomes: unknown[]) => {
    const copy = structuredClone(starter.bundle) as unknown as { forms: Record<string, unknown>[] };
    const { id: _id, ...rest } = quiz;
    void _id;
    copy.forms[0] = { ...rest, ref: copy.forms[0].ref, categories: [{ id: "catmnd", name: "Mindset" }, { id: "catmkt", name: "Marketing" }], fields: quiz.fields.map((f) => ({ ...f, options: (f.options ?? []).map((o) => ({ ...o, outcome: "", ...(o.category === "nope00" ? { category: undefined } : {}) })) })), outcomes };
    copy.forms[0].fields = (copy.forms[0].fields as { options: Record<string, unknown>[] }[]).map((f) => ({ ...f, options: f.options.map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))) }));
    return readBundle(copy, { maxBytes: 1_000_000 });
  };
  const carried = scoredFile(quiz.outcomes);
  is("a scored quiz travels whole", carried.ok ? [carried.bundle.forms[0].scoring, carried.bundle.forms[0].outcomes.map((o) => [o.min, o.max]), carried.bundle.forms[0].fields[1].options.map((o) => o.points)] : carried, ["points", [[0, 4], [5, 9], [10, 15]], [0, 5, 10]]);
  const broken = scoredFile([{ id: "res001", title: "Low", body: "", product: "", min: 0, max: 3 }]);
  is("one whose ranges leave a gap is refused", broken.ok ? "ok" : broken.error, "forms");

  part("Saved in the studio only when the ranges are right");
  const OWNER = "scores@example.com";
  await claimHandle(OWNER, "scoreshop", "Score Shop", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const save = async (body: unknown) => {
    const response = await saveForms(new NextRequest("https://marktmorgen.com/api/store/forms", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ form: body }) }));
    return { status: response.status, body: await response.json() };
  };
  const gap = await save({ ...quiz, id: undefined, outcomes: [{ id: "res001", title: "Low", min: 0, max: 4 }, { id: "res002", title: "High", min: 6, max: 15 }] });
  is("a gap: nothing saved, and the reason in words", [gap.status, gap.body.error, gap.body.issues], [400, "tiers", ["No result covers a score of 5. Widen a range so every score has a result."]]);
  const negative = await save({ ...quiz, id: undefined, fields: [quiz.fields[0], { ...quiz.fields[1], options: [{ id: "opt001", label: "No", points: -5 }, { id: "opt002", label: "Yes", points: 15 }] }] });
  is("negative points: nothing saved", [negative.status, negative.body.error], [400, "points"]);
  const saved = await save({ ...quiz, id: undefined });
  is("ranges that cover every total: saved", [saved.status, saved.body.ok, saved.body.form?.scoring], [200, true, "points"]);
  const formId = saved.body.form.id as string;

  part("Sent from a store's page");
  await setSitePages(OWNER, [{ id: "pagepage01", slug: "quiz", title: "Quiz", nav: false, target: "", from: 0 }]);
  const store = (await storeForEmail(OWNER))!;
  await writePage(store.statsId!, siteKey("pagepage01"), { ...parsePage({}), blocks: [{ id: "blk001", kind: "form", heading: "", form: formId }] } as never, ROOM);
  const post = (fields: [string, string][]) =>
    sendForm(new NextRequest("https://marktmorgen.com/api/store/form", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" }, body: new URLSearchParams(fields) }));
  const base: [string, string][] = [["handle", "scoreshop"], ["form", formId], ["page", "pagepage01"]];
  const answered = await post([...base, ["q_aaaaaa", "b@example.com"], ["q_bbbbbb", "opt003"], ["q_cccccc", "opt004"]]);
  is("on to the result, with the total and the categories", answered.headers.get("location"), `https://marktmorgen.com/@scoreshop/form/${formId}?p=pagepage01&r=res003&s=12&c=catmnd-2.catmkt-10`);
  const kept = await readResponses(store.statsId, formId);
  is("kept with the answers: the result, the total and the categories", [kept.responses[0]?.outcome, kept.responses[0]?.score, kept.responses[0]?.scores], ["res003", 12, { catmnd: 2, catmkt: 10 }]);
  const blank = await post([...base, ["q_aaaaaa", "c@example.com"]]);
  const keptBlank = (await readResponses(store.statsId, formId)).responses[0];
  is("nothing scored answered: the thank-you, no result and no score kept", [blank.headers.get("location"), keptBlank?.outcome, "score" in (keptBlank ?? {})], [`https://marktmorgen.com/@scoreshop/form/${formId}?p=pagepage01`, "", false]);

  part("Kept from the browser");
  const { readFileSync } = await import("node:fs");
  const blocks = readFileSync("components/sales-blocks.tsx", "utf8");
  is("the branching script gets options without their points or categories", blocks.includes("options: f.options.map(({ id, label, outcome, next }) => ({ id, label, outcome, ...(next ? { next } : {}) }))"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
