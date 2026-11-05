/** Independent review controls for refusing partially readable stored quizzes. */
import { MAX_QUESTIONS, parseQuiz, readQuizFor, type Question } from "@/lib/quiz";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  redis.clear();
  const question = (index: number): Question => ({
    id: `question${String(index).padStart(4, "0")}`,
    text: `Question ${index}`,
    kind: "single",
    choices: ["First", "Second"],
    correct: [index % 2],
    explanation: "Why",
  });
  const valid = Array.from({ length: MAX_QUESTIONS + 2 }, (_, index) => question(index));
  const record = (questions: unknown) => JSON.stringify({ passPercent: 70, attempts: 3, required: false, questions });

  part("Every stored entry is evidence, including entries beyond the display cap");
  is("a fully readable oversized legacy bank keeps the existing cap", parseQuiz(record(valid))?.questions.length, MAX_QUESTIONS);
  for (const at of [0, MAX_QUESTIONS - 1, MAX_QUESTIONS, MAX_QUESTIONS + 1]) {
    const damaged = [...valid];
    damaged[at] = { ...question(at), correct: [99] };
    is(`an unreadable entry at ${at} refuses the whole record`, parseQuiz(record(damaged)), null);
  }
  is("a non-array question collection remains unavailable", parseQuiz(record({ 0: question(0) })), null);
  is("a malformed JSON record remains unavailable", parseQuiz("{not-json"), null);

  part("The real reader does not retry or repair a damaged record");
  const storeId = "b".repeat(32);
  const lessonId = "lesson000002";
  const key = `nl:course:${storeId}:quiz:${lessonId}`;
  const original = redis.pipeline.bind(redis);
  let gets = 0;
  redis.pipeline = async commands => {
    gets += commands.filter(command => command[0] === "GET" && command[1] === key).length;
    return original(commands);
  };
  try {
    const damaged = [...valid];
    damaged[MAX_QUESTIONS + 1] = null;
    await original([["SET", key, record(damaged)]]);
    is("the stored reader refuses damage after the cap", await readQuizFor(storeId, lessonId), null);
    is("the refusal uses the existing single GET", gets, 1);
    is("the damaged record is not rewritten", await original([["GET", key]]), [record(damaged)]);
  } finally {
    redis.pipeline = original;
  }
  done();
}

void main().catch(error => { console.error(error); process.exit(1); });
