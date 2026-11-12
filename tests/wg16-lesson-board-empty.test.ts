/**
 * 656 [WG16], unit 13: two more empty places on the public store use the one
 * pattern (components/empty-state.tsx), with a real heading (WCAG 1.3.1,
 * 2.4.10). A lesson with nothing in it said one muted sentence under the
 * lesson's h1; the leaderboard with no points said one muted sentence under
 * the page's h1. Each now has a heading and the same sentence. The headings are
 * words every buyer language already has ("Nothing here yet"), so nothing new
 * is translated, and no action: the lesson already has its next and previous
 * links, and points come from likes on the community's feed.
 */
import { readFileSync } from "node:fs";
import { wordsIn } from "@/lib/buyer-words";
import { communityWords } from "@/lib/buyer-words/community";
import { coursesWords } from "@/lib/buyer-words/courses";
import { done, is, part } from "./check";

part("The words already exist in every buyer language");
for (const language of ["en", "es", "fr", "de", "it", "nl", "pt"] as const) {
  is(`${language}: an empty lesson has a heading and its sentence`, Boolean(wordsIn(language).nothingYet.trim() && coursesWords(language).emptyLesson.trim()), true);
  const c = communityWords(language);
  is(`${language}: an empty leaderboard has a heading and its sentences`, Boolean(c.nothingHereYet.trim() && c.nobodyPoints.trim() && c.noPointsPeriod.trim()), true);
}

part("A lesson with nothing in it");
const lesson = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
is("uses the one pattern, with the general heading and the lesson's sentence", /<EmptyState\s+title=\{said\.w\.nothingYet\}\s+body=\{w\.emptyLesson\}/.test(lesson), true);
is("no bare sentence left", lesson.includes("{w.emptyLesson}</p>"), false);

part("A leaderboard with no points");
const board = readFileSync("app/[handle]/community/leaderboard/page.tsx", "utf8");
is("uses the one pattern, with the community's heading and the period's sentence", /<EmptyState\s+title=\{w\.nothingHereYet\}\s+body=\{period === "all" \? w\.nobodyPoints : w\.noPointsPeriod\}/.test(board), true);
is("no bare sentence left", /<p className="st-muted mt-6">\s*\{period === "all" \? w\.nobodyPoints : w\.noPointsPeriod\}/.test(board), false);

done();
