/**
 * A lesson's quiz drafted with AI (lib/quiz-draft.ts and lib/ai.ts,
 * writeQuiz, added 10 October 2026). What is checked:
 *
 *   - what the model sends is read safely: a question with no text, repeated
 *     answers, too few answers, or no right answer among them is left out,
 *     never repaired by guess; several right answers make it a question with
 *     several; never more than asked for;
 *   - the answers are shuffled so the right one is never in the same place
 *     two questions in a row, and the right answers stay right;
 *   - the writer is handed the lesson's text and the creator's words, asked
 *     for that many questions in the store's language, and counted as one job;
 *     with neither text nor words it is not asked at all.
 */
import { readDrafted, shuffleAnswers } from "@/lib/quiz-draft";
import { writeQuiz } from "@/lib/ai";
import { claimHandle, ensureStatsId, setLanguage, storeForEmail, setSubscription } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const asked: { system: string; prompt: string }[] = [];
let reply = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    const body = JSON.parse(String(init?.body)) as { system: string; messages: { content: string }[] };
    asked.push({ system: body.system, prompt: body.messages[0].content });
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }));
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

const q = (text: string, choices: string[], correct: number[]) => ({ text, choices, correct, explanation: "Because the lesson says so." });

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-quiz-draft-only-a-stand-in";

  part("Read safely");
  const read = readDrafted(
    [
      q("What feeds a starter?", ["Flour and water", "Sugar and milk", "Salt and oil"], [0]),
      q("", ["A", "B"], [0]),
      q("Same answers twice", ["Rye", "rye", "Spelt"], [0]),
      q("Too few answers", ["Only one"], [0]),
      q("No right answer among them", ["One", "Two", "Three"], [7]),
      q("All of them right", ["One", "Two"], [0, 1]),
      q("Which signs show a starter is ready?", ["It doubles", "It smells sweet-sour", "It turns blue"], [1, 0]),
      q("A third good one, past the count", ["Yes", "No"], [0]),
    ],
    2,
  );
  is("only questions that can be asked as they are, up to the count", read.map((x) => x.text), ["What feeds a starter?", "Which signs show a starter is ready?"]);
  is("several right answers make a question with several", read[1] ? [read[1].kind, read[1].correct] : null, ["multiple", [0, 1]]);
  is("never more than asked for", readDrafted([q("A", ["x", "y"], [0]), q("B", ["x", "y"], [0]), q("C", ["x", "y"], [0])], 2).length, 2);
  is("nothing that is not a list is read as questions", [readDrafted(null, 5), readDrafted({ text: "x" }, 5)], [[], []]);
  is(
    "an empty choice cannot shift the model's correct answer onto another choice",
    readDrafted([q("Which answer is right?", ["  ", "The right answer", "A wrong answer"], [1])], 1),
    [],
  );
  is(
    "one out-of-range correct position rejects the whole drafted question",
    readDrafted([q("Which answers are right?", ["One", "Two", "Three", "Four"], [0, 9])], 1),
    [],
  );
  is(
    "one non-number correct position rejects the whole drafted question",
    readDrafted([{ ...q("Which answers are right?", ["One", "Two", "Three", "Four"], [0]), correct: [0, "1"] }], 1),
    [],
  );
  is(
    "a correct position beyond the kept choices cannot turn multiple into single",
    readDrafted([q("Which answers are right?", ["One", "Two", "Three", "Four", "Five", "Six", "Seven"], [0, 6])], 1),
    [],
  );

  part("The right answer moves around");
  const same = Array.from({ length: 12 }, (_, i) => ({ ...q(`Question ${i}`, ["Right", "Wrong one", "Wrong two", "Wrong three"], [0]), kind: "single" as const }));
  let seed = 7;
  const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const shuffled = shuffleAnswers(same, random);
  const places = shuffled.map((x) => x.correct[0]);
  is("never in the same place two questions in a row", places.every((place, i) => i === 0 || place !== places[i - 1]), true);
  is("and not always in one place", new Set(places).size > 1, true);
  is("the right answer stays the right one", shuffled.every((x) => x.choices[x.correct[0]] === "Right" && x.choices.length === 4), true);
  const several = shuffleAnswers([{ ...q("Pick two", ["A", "B", "C", "D"], [0, 2]), kind: "multiple" as const }], random)[0];
  is("and several right answers stay right", several.correct.map((at) => several.choices[at]).sort(), ["A", "C"]);

  part("Asked of the writer");
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await ensureStatsId("owner@example.com");
  await setLanguage("owner@example.com", "es");
  const store = (await storeForEmail("owner@example.com"))!;
  const input = { course: "Sourdough at Home", lesson: "Your first starter", text: "Mix equal weights of flour and water. Feed it every day.", notes: "", count: 3 };
  reply = JSON.stringify({ questions: [q("¿Qué se mezcla?", ["Harina y agua", "Azúcar y leche", "Sal y aceite"], [0]), q("¿Cada cuánto se alimenta?", ["Cada día", "Cada semana", "Cada mes"], [0])] });
  const drafted = await writeQuiz(store, input);
  is("the questions come back, shuffled, the right answers kept", drafted.ok ? drafted.value.map((x) => x.choices[x.correct[0]]) : drafted.reason, ["Harina y agua", "Cada día"]);
  is("the lesson's text and its name are handed over", [asked[0].prompt.includes("Mix equal weights of flour and water."), asked[0].prompt.includes("Lesson: Your first starter")], [true, true]);
  is("in the store's language, that many questions, from the lesson only", [asked[0].system.includes("Write in Spanish"), asked[0].system.includes("Exactly 3 questions"), asked[0].system.includes("answerable from it alone")], [true, true, true]);
  is("with answers of the same length asked for", asked[0].system.includes("about the same length"), true);
  const nothing = await writeQuiz(store, { ...input, text: "", notes: "" });
  is("with no lesson text and no words, nothing is asked", [nothing.ok ? "asked" : nothing.reason, asked.length], ["notes", 1]);
  const fromNotes = await writeQuiz(store, { ...input, text: "", notes: "Starter: flour and water, fed daily." });
  is("a video lesson's main points, typed by the creator, are enough", [fromNotes.ok, asked.at(-1)?.prompt.includes("What the creator wants the quiz to check:\nStarter: flour and water, fed daily.")], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
