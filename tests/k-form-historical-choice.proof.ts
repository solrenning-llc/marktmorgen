/** Valid persisted answers across a real definition edit; no malformed Redis reply. */
import assert from "node:assert/strict";
import { parseForm, type FormDef, type FormResponse } from "@/lib/forms";
import { addResponse, readForm, readResponses, writeForm } from "@/lib/form-store";
import { responseTexts } from "@/lib/form-response-pdf";
import { store as redis } from "@/tests/redis-stub";
import { ROOM } from "@/tests/data-room";

type Failure = { name: string; actual: unknown; expected: unknown };
const STATS = "historical-choice", FORM = "history001", FIELD = "choice";
const ANSWERED = "a".repeat(32), UNANSWERED = "b".repeat(32), CHOICE = "opt001";
const scenarioNames = ["baseline", "removed-choice", "genuinely-unanswered", "restored-current-label"] as const;
const COMMANDS_PER_SCENARIO = 40;

export async function auditHistoricalChoice() {
  // Admit all local application/inspection commands before the first fixture write.
  assert.equal(scenarioNames.length, 4);
  const commands = new Map<string, number>(scenarioNames.map(name => [name, 0]));
  const pipeline = redis.pipeline.bind(redis), fetchBefore = globalThis.fetch;
  const failures: Failure[] = [], observations: Record<string, unknown>[] = [];
  let scenario: string = scenarioNames[0], checks = 0, forbiddenFetches = 0;
  const check = (name: string, actual: unknown, expected: unknown) => {
    checks++;
    try { assert.deepEqual(actual, expected); }
    catch { failures.push({ name: `${scenario}: ${name}`, actual, expected }); }
  };
  redis.clear();
  redis.pipeline = async batch => {
    const before = commands.get(scenario);
    assert.notEqual(before, undefined, "only a pre-admitted scenario may run");
    assert.ok(before! + batch.length <= COMMANDS_PER_SCENARIO, "admit commands before sending a batch");
    commands.set(scenario, before! + batch.length);
    return pipeline(batch);
  };
  globalThis.fetch = (async () => { forbiddenFetches++; throw Error("No HTTP or provider operation is admitted"); }) as typeof fetch;
  const answer: FormResponse = { id: ANSWERED, at: 1_800_000_000, page: "history-page", answers: { [FIELD]: CHOICE }, outcome: "", joined: false };
  const absent: FormResponse = { ...answer, id: UNANSWERED, answers: {} };
  const initial = parseForm({
    id: FORM, name: "Choice history", fields: [{ id: FIELD, type: "choice", label: "Your choice", required: false, options: [
      { id: CHOICE, label: "Original option A", outcome: "" },
      { id: "opt002", label: "Option B", outcome: "" },
      { id: "opt003", label: "Option C", outcome: "" },
    ] }], offerList: false, updatedAt: 1,
  });
  assert.ok(initial, "the real form parser must accept the initial definition");
  const paragraph = (form: FormDef, response: FormResponse) => {
    const texts = responseTexts({ form, response, storeName: "Synthetic shop", sentLine: "Synthetic submission", lang: "en" });
    const question = texts.findIndex(item => item.role === "H2" && item.text === "Your choice");
    assert.notEqual(question, -1, "the real response text includes the known question");
    return texts[question + 1]?.text;
  };
  const known = async () => {
    const form = await readForm(STATS, FORM);
    assert.ok(form, "confirmed form read");
    const result = await readResponses(STATS, FORM);
    const answered = result.responses.find(item => item.id === ANSWERED);
    const unanswered = result.responses.find(item => item.id === UNANSWERED);
    assert.ok(answered && unanswered, "both actual stored identities must remain readable");
    // Inspection is also counted under the same per-scenario ceiling.
    const [list] = await redis.pipeline([["LRANGE", `nl:form:r:${STATS}:${FORM}`, 0, -1]]);
    assert.ok(Array.isArray(list), "the native fixture list is readable");
    const raw = list.find(item => typeof item === "string" && (JSON.parse(item) as FormResponse).id === ANSWERED);
    assert.equal(typeof raw, "string");
    return { form, answered, unanswered, total: result.total, raw: raw as string };
  };
  try {
    check("real writer accepts the initial definition", await writeForm(STATS, initial), true);
    await addResponse(STATS, FORM, answer, ROOM);
    await addResponse(STATS, FORM, absent, ROOM);
    const before = await known();
    check("form identity is confirmed", before.form.id, FORM);
    check("response identity is confirmed", before.answered.id, ANSWERED);
    check("raw stored choice is the selected option ID", (JSON.parse(before.raw) as FormResponse).answers[FIELD], CHOICE);
    check("known option is rendered with its current label", paragraph(before.form, before.answered), "Original option A");
    check("both actual responses are counted", before.total, 2);
    observations.push({ scenario, formId: before.form.id, responseId: before.answered.id, rawAnswer: before.answered.answers[FIELD], text: paragraph(before.form, before.answered) });

    scenario = scenarioNames[1];
    const edited = parseForm({ ...before.form, updatedAt: 2, fields: [{ ...before.form.fields[0], options: before.form.fields[0].options.filter(option => option.id !== CHOICE) }] });
    assert.ok(edited, "removing one of three options must retain a valid two-option form");
    check("real writer accepts the valid definition edit", await writeForm(STATS, edited), true);
    const after = await known();
    const removedText = paragraph(after.form, after.answered);
    check("two valid options remain", after.form.fields[0].options.length, 2);
    check("the same form identity is kept", after.form.id, before.form.id);
    check("the same answered response identity is kept", after.answered.id, before.answered.id);
    check("raw stored choice is still the original option ID", (JSON.parse(after.raw) as FormResponse).answers[FIELD], CHOICE);
    check("editing the definition did not rewrite the answer record", after.raw, before.raw);
    check("confirmed response read retains the stored choice", after.answered.answers[FIELD], CHOICE);
    check("a retained answer is not certified as No answer", removedText === "No answer.", false);
    check("uninterpretable historical choice is explicitly distinguished", typeof removedText === "string" && /unavailable|uninterpretable|could not be interpreted|cannot be interpreted|no longer|changed|not (?:a )?current/i.test(removedText), true);
    check("the removed label is not invented from an ID-only record", typeof removedText === "string" && removedText.includes("Original option A"), false);
    observations.push({ scenario, formId: after.form.id, responseId: after.answered.id, rawAnswer: after.answered.answers[FIELD], rawRecordUnchanged: after.raw === before.raw, currentOptions: after.form.fields[0].options.map(option => option.id), text: removedText });

    scenario = scenarioNames[2];
    const missing = await known();
    check("the unanswered control is its own persisted response", missing.unanswered.id, UNANSWERED);
    check("the unanswered control really has no choice value", Object.hasOwn(missing.unanswered.answers, FIELD), false);
    check("genuine absence retains the existing wording", paragraph(missing.form, missing.unanswered), "No answer.");
    check("editing did not lose either response", missing.total, 2);
    observations.push({ scenario, responseId: missing.unanswered.id, hasChoice: Object.hasOwn(missing.unanswered.answers, FIELD), text: paragraph(missing.form, missing.unanswered) });

    scenario = scenarioNames[3];
    const restored = parseForm({ ...initial, updatedAt: 3, fields: [{ ...initial.fields[0], options: initial.fields[0].options.map(option => option.id === CHOICE ? { ...option, label: "Current option A" } : option) }] });
    assert.ok(restored, "the real parser accepts a restored current option");
    check("writer accepts the restored definition", await writeForm(STATS, restored), true);
    const current = await known();
    check("the restored definition has three options", current.form.fields[0].options.length, 3);
    check("response identity remains stable after restoration", current.answered.id, ANSWERED);
    check("restoration did not rewrite the answer record", current.raw, before.raw);
    check("a known current option remains renderable", paragraph(current.form, current.answered), "Current option A");
    observations.push({ scenario, responseId: current.answered.id, rawAnswer: current.answered.answers[FIELD], text: paragraph(current.form, current.answered) });
    assert.equal(forbiddenFetches, 0);
    return { checks, failures, observations, bounds: { scenarios: scenarioNames.length, commandsPerScenario: COMMANDS_PER_SCENARIO, commandCeiling: scenarioNames.length * COMMANDS_PER_SCENARIO }, commands: Object.fromEntries(commands), forbiddenFetches };
  } finally { redis.pipeline = pipeline; globalThis.fetch = fetchBefore; }
}
