/** A damaged stored question must not disappear before a quiz is graded. */
import { gradeQuiz, MAX_QUESTIONS, parseQuiz, readQuizFor, type Question } from "@/lib/quiz";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  redis.clear();
  const one: Question = { id: "question0001", text: "First question", kind: "single", choices: ["One", "Two"], correct: [0], explanation: "First explanation" };
  const two: Question = { ...one, id: "question0002", text: "Second question", correct: [1] };
  const record = { passPercent: 100, attempts: 3, required: true, questions: [one, two] };
  const answers = { [one.id]: [0] };
  const key = `nl:course:${"a".repeat(32)}:quiz:lesson000001`;
  const original = redis.pipeline.bind(redis);
  let reads = 0;
  redis.pipeline = async commands => {
    reads += commands.filter(command => command[0] === "GET" && command[1] === key).length;
    return original(commands);
  };
  try {
    part("The whole confirmed quiz remains the grading source");
    const complete = parseQuiz(JSON.stringify(record));
    if (!complete) throw Error("The valid quiz was not readable");
    is("both confirmed questions remain in order", complete.questions.map(question => question.id), [one.id, two.id]);
    is("answering only one of two questions cannot pass", gradeQuiz(complete, answers), { right: 1, total: 2, percent: 50, passed: false, marks: { [one.id]: true, [two.id]: false } });
    is("answering both still passes", gradeQuiz(complete, { ...answers, [two.id]: [1] }).passed, true);
    const damaged: unknown[] = [null, false, 0, "unreadable question", {},
      { ...two, id: "broken" }, { ...two, id: null }, { ...two, text: " " },
      { ...two, choices: ["Only one"] }, { ...two, choices: ["", "Two"] },
      { ...two, correct: [] }, { ...two, correct: [2] }, { ...two, correct: [0, 1] }];
    part("No unreadable question is silently dropped");
    for (const bad of damaged) {
      is("a broken question after a valid one refuses the record", parseQuiz(JSON.stringify({ ...record, questions: [one, bad] })), null);
      is("a broken question before a valid one also refuses the record", parseQuiz(JSON.stringify({ ...record, questions: [bad, one] })), null);
      await original([["SET", key, JSON.stringify({ ...record, questions: [one, bad] })]]);
      reads = 0;
      const kept = await readQuizFor("a".repeat(32), "lesson000001");
      is("the real stored reader never supplies a shorter passing quiz", kept ? gradeQuiz(kept, answers).passed : null, null);
      is("validation adds no read or automatic retry", reads, 1);
    }
    part("Existing legacy options and caps stay intact");
    is("legacy unlimited attempts remain readable", parseQuiz(JSON.stringify({ ...record, attempts: 0 }))?.attempts, 0);
    is("legacy numeric text fields remain readable", parseQuiz(JSON.stringify({ ...record, attempts: "3", passPercent: "100" }))?.passPercent, 100);
    is("optional explanations remain optional", parseQuiz(JSON.stringify({ ...record, questions: [{ ...one, explanation: undefined }] }))?.questions[0].explanation, "");
    is("the existing default single-choice kind remains readable", parseQuiz(JSON.stringify({ ...record, questions: [{ ...one, kind: undefined }] }))?.questions[0].kind, "single");
    is("a confirmed empty record remains unavailable", parseQuiz(JSON.stringify({ ...record, questions: [] })), null);
    const legacyBank = Array.from({ length: MAX_QUESTIONS + 1 }, (_, index) => ({ ...one, id: `question${String(index).padStart(4, "0")}` }));
    is("the preexisting cap on a fully readable legacy bank is unchanged", parseQuiz(JSON.stringify({ ...record, questions: legacyBank }))?.questions.length, MAX_QUESTIONS);
    is("an unreadable tail beyond that cap cannot certify the record", parseQuiz(JSON.stringify({ ...record, questions: [...legacyBank, null] })), null);
    await original([["SET", key, JSON.stringify(record)]]); reads = 0;
    is("the stored valid quiz still has both questions", (await readQuizFor("a".repeat(32), "lesson000001"))?.questions.length, 2);
    is("a valid read still uses its single existing GET", reads, 1);
  } finally { redis.pipeline = original; }
  done();
}
void main().catch(error => { console.error(error); process.exit(1); });
