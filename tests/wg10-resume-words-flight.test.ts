/**
 * Claude 5's GRAVE on #2728: the lesson page is a Server Component and the
 * lesson player (components/lesson-player.tsx) a client one, so every prop the
 * page gives the player crosses React's Flight, which refuses a function
 * ("Functions cannot be passed directly to Client Components"). With the
 * resume words as functions, every lesson with a hosted video failed to draw.
 *
 * Held here with the Flight server Next ships (tests/page-response.ts,
 * payloadOf), the player marked as a client reference as Next's bundler marks
 * it: the words the page gives it cross in all seven languages, and filled in
 * on the device they read exactly as the language's own sentence does.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { LessonPlayer } from "@/components/lesson-player";
import { COURSES_WORDS, type CoursesWords } from "@/lib/buyer-words/courses";
import * as rules from "@/lib/lesson-position-rules";
import { clientComponents, payloadOf } from "./page-response";
import { done, is, part } from "./check";

const PAGE = "app/[handle]/course/[product]/[lesson]/page.tsx";

type Built = { label: unknown; stopped: unknown; resume: unknown; startOver: unknown };
/** What the page gives the player: the shared builder once it exists, else the page's own words as they stood (functions). */
const built = (w: CoursesWords): Built => {
  const of = (rules as Record<string, unknown>).resumeWordsOf;
  return typeof of === "function"
    ? (of as (w: CoursesWords) => Built)(w)
    : { label: w.resumeLabel, stopped: w.resumeStopped, resume: w.resumeContinue, startOver: w.resumeStartOver };
};
/** A sentence with the time put in, as the player does on the device. */
const filled = (sentence: unknown, at: string): string => {
  const fill = (rules as Record<string, unknown>).sayAt;
  return typeof fill === "function" ? (fill as (s: unknown, at: string) => string)(sentence, at) : typeof sentence === "function" ? (sentence as (at: string) => string)(at) : String(sentence);
};

async function crosses(words: Built): Promise<string> {
  try {
    const element = createElement(LessonPlayer, { courseId: "course000001", lessonId: "lesson000001", learner: "a".repeat(32), words: words as never, src: "/v.mp4", controls: true });
    await payloadOf(element);
    return "ok";
  } catch (error) {
    return String((error as Error).message ?? error).slice(0, 80);
  }
}

async function main(): Promise<void> {
  clientComponents({ LessonPlayer });

  part("Control: plain words cross Flight, a function does not");
  is("plain text crosses", await crosses({ label: "a", stopped: "b", resume: "c", startOver: "d" }), "ok");
  is("a function is refused", (await crosses({ label: "a", stopped: () => "b", resume: "c", startOver: "d" })) !== "ok", true);

  part("The page builds the player's words with the shared builder");
  const page = readFileSync(PAGE, "utf8");
  is("the page's words are resumeWordsOf(w)", /const resumeWords = resumeWordsOf\(w\);/.test(page), true);

  part("Every language: the words cross, and read as the language's own sentence once filled in");
  for (const [language, w] of Object.entries(COURSES_WORDS)) {
    const words = built(w);
    is(`${language}: every word is plain text`, Object.values(words).every((v) => typeof v === "string"), true);
    is(`${language}: the words cross to the client player`, await crosses(words), "ok");
    is(`${language}: "stopped" filled in reads as before`, filled(words.stopped, "12:34"), w.resumeStopped("12:34"));
    is(`${language}: "resume" filled in reads as before`, filled(words.resume, "1:02:03"), w.resumeContinue("1:02:03"));
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
